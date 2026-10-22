import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { descendants, descendantsKnown, processList } from "./process-tree.js";

export class AgentBrowser {
  private closing?: Promise<void>;
  private constructor(readonly directory: string, private readonly child: ChildProcess, readonly mcp: McpServer, private readonly lifecycle: { used: boolean; closedUnused: boolean }, private readonly registration?: string) {}

  /**
   * `parent` registers the session folder for recovery after a crash. `root` holds session folders:
   * the standard one unless a test fixture supplies its own, which startup recovery must use too.
   */
  static async start(parent: string | undefined, env: NodeJS.ProcessEnv, onLog?: (text: string) => void, root = browserTempRoot()): Promise<AgentBrowser> {
    // A short, uncrowded parent also leaves room for macOS browser sockets.
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await realpath(await mkdtemp(join(root, "petrina-browser-")));
    const registration = parent ? join(parent, `${randomUUID()}.json`) : undefined;
    if (parent) {
      try {
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await writeFile(registration!, JSON.stringify(directory), { mode: 0o600 });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
    const secret = randomUUID();
    const clean = { ...env, TMPDIR: directory, TMP: directory, TEMP: directory };
    // Playwright itself also reads debug, remote-service and test settings, including
    // npm aliases. None may override this session's bundled, isolated headless browser.
    for (const key of Object.keys(clean)) {
      const setting = key.replace(/^npm_(?:package_)?config_/i, "").toUpperCase();
      if (/^(PLAYWRIGHT_|SELENIUM_|PW(?:DEBUG|TEST|MCP|_))/.test(setting)) delete clean[key as keyof typeof clean];
    }
    // Start Bun beside the source, away from crowded system temp folders. The helper
    // changes to the capture folder itself before it handles any browser requests.
    const child = spawn(process.execPath, [join(import.meta.dir, "browser-server.ts"), directory, secret, String(process.pid)], { cwd: import.meta.dir, env: clean, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lifecycle = { used: false, closedUnused: false };
    child.stderr?.on("data", (data: Buffer) => onLog?.(data.toString()));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The headless browser server did not start.")), 30_000);
        let output = "";
        child.stdout!.on("data", (data: Buffer) => {
          output += data.toString();
          for (let end; (end = output.indexOf("\n")) >= 0;) {
            const line = output.slice(0, end);
            output = output.slice(end + 1);
            try {
              const message = JSON.parse(line) as { url?: string; used?: boolean; closedUnused?: boolean };
              if (message.used === true) lifecycle.used = true;
              if (message.closedUnused === true && !lifecycle.used) lifecycle.closedUnused = true;
              if (typeof message.url === "string") { clearTimeout(timer); resolve(message.url); }
            } catch { reject(new Error("The headless browser server could not start.")); }
          }
        });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("The headless browser server stopped.")); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      return new AgentBrowser(directory, child, { type: "http", name: `petrina-browser-${secret.slice(0, 8)}`, url, headers: [{ name: "Authorization", value: `Bearer ${secret}` }] }, lifecycle, registration);
    } catch (error) {
      child.kill();
      await rm(directory, { recursive: true, force: true });
      if (registration) await rm(registration, { force: true });
      throw error;
    }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      try {
        // Playwright starts Chromium in its own process group. Killing only this
        // controller, including when it never answers, leaves that browser running.
        // Its session folder still identifies the browser after the controller exits.
        await stopBrowser(this.child, this.directory, this.lifecycle);
        await rm(this.directory, { recursive: true, force: true });
        if (this.registration) await rm(this.registration, { force: true });
      } catch (error) {
        // Do not discard the remaining ownership marker or turn a failed cleanup into
        // a cached success. A later stop may retry once the process list is available.
        this.closing = undefined;
        throw error;
      }
    })();
  }
}

/** Stop the controller and every browser process this session started. Resolves only once they are gone. */
async function stopBrowser(child: ChildProcess, directory: string, lifecycle: { used: boolean; closedUnused: boolean }): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = new Promise<void>((resolve) => {
    // close follows stdout draining, so the helper's final unused acknowledgement is known.
    if ((child.exitCode !== null || child.signalCode !== null) && child.stdout?.readableEnded) resolve();
    else child.once("close", () => resolve());
  });
  const unused = () => lifecycle.closedUnused && !lifecycle.used && child.exitCode === 0 && child.signalCode === null;
  if (unused()) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    // exit can precede the final stdout acknowledgement. close observes the drained pipe.
    await within(exited, 1_500);
    if (unused()) return;
    if (process.platform === "win32") throw new Error("The headless browser did not stop.");
    await reap(directory, undefined);
    return;
  }
  if (process.platform === "win32") {
    // Once an unexpected exit loses the parent relationship, taskkill cannot prove
    // that its browsers stopped. Keep the marker and report incomplete cleanup.
    child.stdin?.end();
    if (await within(exited, 4_000)) {
      if (child.exitCode !== 0 || child.signalCode !== null) throw new Error("The headless browser did not stop.");
    } else {
      const stopped = await new Promise<boolean>((resolve) => execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 3_000 }, (error) => resolve(!error)));
      if (!await within(exited, 1_000)) child.kill("SIGKILL");
      await exited;
      if (!stopped) throw new Error("The headless browser did not stop.");
    }
    return;
  }
  // Listed while the controller is alive. Asking it to stop does not wait on that list:
  // a controller that never answers is still alive afterwards and is listed again before it is killed.
  let early: number[] | undefined;
  let earlyKnown = false;
  if (lifecycle.used) void descendants([pid]).then((found) => { early = found; earlyKnown = found !== undefined; });
  child.stdin?.end();
  const graceful = await within(exited, 4_000);
  if (graceful && unused()) return;
  if (!graceful) {
    const again = await descendantsKnown([pid], 1_200);
    const owned = earlyKnown || again ? [...new Set([...(early ?? []), ...(again ?? [])])] : undefined;
    forceKill([pid, ...(owned ?? [])]);
    await exited;
    await reap(directory, owned);
    return;
  }
  await reap(directory, earlyKnown ? early : undefined);
}

/** Kill any browser still using this session's folder, then wait until it is actually gone. */
async function reap(directory: string, owned: number[] | undefined): Promise<void> {
  const marked = await processesUsing(directory);
  // Both ownership sources agree that there is nothing to reap. Unknown scans
  // still follow the full recovery path and can never become a false success.
  if (owned !== undefined && !owned.length && marked !== undefined && !marked.length) return;
  let targets = [...new Set([...(owned ?? []), ...(marked ?? [])])].filter((pid) => pid !== process.pid);
  const still = () => targets.filter(alive);
  if (still().length) forceKill(still());
  await untilGone(targets, 1_000);
  const left = await processesUsing(directory);
  if (left?.length) {
    targets = [...new Set([...targets, ...left])];
    forceKill(left.filter(alive));
    await untilGone(targets, 1_000);
  }
  const remaining = await processesUsing(directory);
  // A process can finish between the first wait and the final scan. Judge the final
  // ownership evidence, keeping every earlier target; a provisional timeout is not a sticky failure.
  if (targets.some(alive) || remaining?.some(alive) || (owned === undefined && marked === undefined && remaining === undefined)) {
    throw new Error("The headless browser did not stop.");
  }
}

function forceKill(pids: readonly number[]): void {
  for (const pid of pids) {
    // A detached browser is the leader of its own group; helpers stay in that group.
    // A pid that is not a leader has no group of that id.
    try { process.kill(-pid, "SIGKILL"); } catch { /* Not a process group leader. */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function untilGone(pids: readonly number[], ms: number): Promise<boolean> {
  const targets = [...new Set(pids)];
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (!targets.some(alive)) return true;
  return !targets.some(alive);
}

function within(done: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    done.then(() => { clearTimeout(timer); resolve(true); });
  });
}

function namesSession(command: string, directory: string): boolean {
  return command.includes(`${directory}/`) || command.includes(`${directory} `) || command.endsWith(directory);
}

/** Processes whose command still names this session's folder, or undefined when the list cannot be read. */
function processesUsing(directory: string): Promise<number[] | undefined> {
  const column = process.platform === "linux" ? "args=" : "command=";
  return processList(["-axww", "-o", `pid=,${column}`], 2_000, 32 * 1024 * 1024).then((stdout) => {
    if (stdout === undefined) return undefined;
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^(\d+)\s+(.*)$/.exec(line.trim());
      if (match && namesSession(match[2]!, directory)) pids.push(Number(match[1]));
    }
    return pids;
  });
}

export function browserTempRoot(): string {
  return process.platform === "darwin" ? join(homedir(), ".petrina", "b") : join(tmpdir(), "petrina-browsers");
}

/**
 * Reap each registered browser before startup; only the session's own temp folder is eligible.
 * `root` is the parent the engine's sessions started in: a folder elsewhere is never reaped.
 */
export async function recoverBrowserTemps(registry: string, root = browserTempRoot()): Promise<void> {
  let entries: Dirent[];
  try { entries = await readdir(registry, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const tempRoot = await realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return resolve(root);
  });
  for (const entry of entries) {
    const registration = join(registry, entry.name);
    // Older output folders and links are not registrations. Remove only the entry
    // inside this engine's registry, without reading or following an outside link.
    if (!entry.isFile()) {
      await rm(registration, { recursive: entry.isDirectory(), force: true });
      continue;
    }
    let text: string;
    try {
      text = await readFile(registration, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A partial registration has no trusted session path; remove only that marker.
      await rm(registration, { force: true });
      continue;
    }
    let directory: unknown;
    try { directory = JSON.parse(text); }
    catch {
      // A partial registration has no trusted session path; remove only that marker.
      await rm(registration, { force: true });
      continue;
    }
    if (typeof directory === "string" && dirname(directory) === tempRoot && /^petrina-browser-[A-Za-z0-9]+$/.test(basename(directory))) {
      // If ps cannot be read or the process tree cannot be stopped, reap throws and
      // the marker stays for the next startup to retry.
      await reap(directory, undefined);
      await rm(directory, { recursive: true, force: true });
    }
    await rm(registration, { force: true });
  }
  await rm(registry, { recursive: true, force: true });
}
