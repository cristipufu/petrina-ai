import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { isCompiledBinary } from "@petrina/platform/compiled-runtime";
import type { ProcessDeadline } from "@petrina/platform/process-capabilities";
import { browserProcesses, type BrowserProcessControl } from "@petrina/platform/browser-processes";
import { BrowserCleanupAttempt, StopUnconfirmed, reapBrowser, type BrowserCleanupClock, type BrowserCleanupReason } from "./browser-cleanup.js";
export { CLEANUP_NOTE, cleanupNote } from "./browser-cleanup.js";

const startupDeadline: ProcessDeadline = (expired, ms) => {
  const timer = setTimeout(expired, ms);
  return () => clearTimeout(timer);
};
export interface BrowserStartupEffects {
  /** Transfer one native helper handle; the caller retains it until stop and output close are confirmed. */
  launch?(directory: string, secret: string, owner: number, env: NodeJS.ProcessEnv): ChildProcess;
  arm?: ProcessDeadline;
}
export class BrowserStartupCleanupError extends Error {
  constructor(cause: unknown) {
    super("Petrina could not confirm that a failed browser helper stopped. Its output folder was kept for recovery.", { cause });
    this.name = "BrowserStartupCleanupError";
  }
}

const cleanupClock = { now: () => Date.now(), pause: (ms: number) => Bun.sleep(ms) };

export function defaultBrowserServerLaunch(
  directory: string,
  secret: string,
  ownerPid: number,
  execPath: string = process.execPath,
  metaDir: string = import.meta.dir,
): { command: string; args: string[]; cwd: string } {
  if (isCompiledBinary(metaDir)) {
    return {
      command: execPath,
      args: ["__internal-browser-server", directory, secret, String(ownerPid)],
      cwd: directory,
    };
  }
  return {
    command: execPath,
    args: [join(metaDir, "browser-server.ts"), directory, secret, String(ownerPid)],
    cwd: metaDir,
  };
}

export class AgentBrowser {
  private closing?: Promise<void>;
  private constructor(
    readonly directory: string,
    private readonly child: ChildProcess,
    readonly mcp: McpServer,
    private readonly lifecycle: {
    used: boolean;
    closedUnused: boolean
  },
    private readonly registration?: string,
    private readonly onLog?: (text: string) => void,
    private readonly processes: BrowserProcessControl = browserProcesses
  ) {}

  /**
   * `parent` registers the session folder for recovery after a crash. `root` holds session folders:
   * the standard one unless a test fixture supplies its own, which startup recovery must use too.
   * `onLog` receives the helper's output and a failed cleanup's private note; without it the note goes to standard error.
   */
  static async start(parent: string | undefined, env: NodeJS.ProcessEnv, onLog?: (text: string) => void, root = browserTempRoot(), processes: BrowserProcessControl = browserProcesses, startup: BrowserStartupEffects = {}): Promise<AgentBrowser> {
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
    let child: ChildProcess | undefined;
    let closed = Promise.resolve();
    const arm: ProcessDeadline = startup.arm ? (expired, ms) => startup.arm!(expired, ms) : startupDeadline;
    const lifecycle = { used: false, closedUnused: false };
    try {
      const helperLaunch = defaultBrowserServerLaunch(directory, secret, process.pid);
      child = startup.launch
        ? startup.launch(directory, secret, process.pid, clean)
        : spawn(helperLaunch.command, helperLaunch.args, {
            cwd: helperLaunch.cwd,
            env: clean,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
      const helper = child;
      closed = (helper.exitCode !== null || helper.signalCode !== null) && helper.stdout?.readableEnded && helper.stderr?.readableEnded
        ? Promise.resolve() : new Promise<void>(resolve => helper.once("close", () => resolve()));
      child.stderr?.on("data", (data: Buffer) => onLog?.(data.toString()));
      const url = await new Promise<string>((resolve, reject) => {
        let settled = false;
        let cancel = () => {};
        const finish = (value: string | Error) => {
          if (settled) return;
          settled = true;
          cancel();
          if (typeof value === "string") resolve(value);
          else reject(value);
        };
        cancel = arm(() => finish(new Error("The headless browser server did not start.")), 30_000);
        // An injected deadline may settle synchronously; its returned handle still needs disposal.
        if (settled) cancel();
        let output = "";
        helper.stdout!.on("data", (data: Buffer) => {
          output += data.toString();
          for (let end; (end = output.indexOf("\n")) >= 0;) {
            const line = output.slice(0, end);
            output = output.slice(end + 1);
            try {
              const message = JSON.parse(line) as { url?: string; used?: boolean; closedUnused?: boolean };
              if (message.used === true) lifecycle.used = true;
              if (message.closedUnused === true && !lifecycle.used) lifecycle.closedUnused = true;
              if (typeof message.url === "string") finish(message.url);
            } catch { finish(new Error("The headless browser server could not start.")); }
          }
        });
        helper.once("exit", () => finish(new Error("The headless browser server stopped.")));
        helper.once("error", (error) => finish(error));
      });
      return new AgentBrowser(
        directory,
        child,
        {
        type: "http",
        name: `petrina-browser-${secret.slice(
        0,
        8
      )}`,
        url,
        headers: [{
        name: "Authorization",
        value: `Bearer ${secret}`
      }]
      },
        lifecycle,
        registration,
        onLog,
        processes
      );
    } catch (error) {
      if (child) {
        const helper = child;
        const exited = new Promise<number>(resolve => helper.once("exit", code => resolve(code ?? 0)));
        const stopped = await stopOwnedProcess({
          exited, get exitCode() { return helper.exitCode; }, get signalCode() { return helper.signalCode; },
          kill(signal) { return helper.kill(signal); },
        }, { graceMs: 1_000, forceMs: 1_000 }, arm);
        if (stopped !== "confirmed" || !await within(closed, 1_000)) throw new BrowserStartupCleanupError(error);
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
        // The folder and its registration stay until this confirms every browser process stopped.
        await stopBrowser(this.child, this.directory, this.lifecycle, this.processes);
        await rm(this.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        if (this.registration) await rm(this.registration, { force: true });
      } catch (error) {
        // Do not discard the remaining ownership marker or turn a failed cleanup into
        // a cached success. A later stop may retry once the process list is available.
        if (error instanceof StopUnconfirmed) {
          // The log also holds programs' raw output, which may not have ended its line.
          if (this.onLog) this.onLog(`\n${error.note}\n`);
          else console.error(error.note);
        }
        this.closing = undefined;
        throw error;
      }
    })();
  }
}

/** How the helper ended, recorded apart from what its browser processes did. */
function helperState(child: ChildProcess, closed: boolean, lifecycle: { used: boolean; closedUnused: boolean }): string {
  const ended = child.signalCode !== null ? `signal-${child.signalCode}` : child.exitCode !== null ? `exit-${child.exitCode}` : "running";
  return [ended, closed ? "closed" : "close-unconfirmed", lifecycle.used ? "used" : lifecycle.closedUnused ? "acknowledged-unused" : "unused"].join(",");
}

/** Stop the controller and every browser process this session started. Resolves only once they are gone. */
async function stopBrowser(child: ChildProcess, directory: string, lifecycle: {
  used: boolean;
  closedUnused: boolean
}, processes: BrowserProcessControl): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const attempt = new BrowserCleanupAttempt(processes, cleanupClock);
  const exited = new Promise<void>((resolve) => {
    // close follows stdout draining, so the helper's final unused acknowledgement is known.
    if ((child.exitCode !== null || child.signalCode !== null) && child.stdout?.readableEnded) resolve();
    else child.once("close", () => resolve());
  });
  const unused = () => lifecycle.closedUnused && !lifecycle.used && child.exitCode === 0 && child.signalCode === null;
  if (unused()) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    // exit can precede the final stdout acknowledgement. close observes the drained pipe.
    const closed = await within(exited, 1_500);
    if (unused()) return;
    if (!processes.groups) throw new Error("The headless browser did not stop.");
    attempt.stage = "exited-before-close";
    attempt.helper = helperState(child, closed, lifecycle);
    await reapBrowser(directory, undefined, attempt, processes, cleanupClock);
    return;
  }
  if (processes.stopTree) {
    // Once an unexpected exit loses the parent relationship, taskkill cannot prove
    // that its browsers stopped. Keep the marker and report incomplete cleanup.
    child.stdin?.end();
    if (await within(exited, 4_000)) {
      if (child.exitCode !== 0 || child.signalCode !== null) throw new Error("The headless browser did not stop.");
    } else {
      const stopped = await processes.stopTree(pid, 3_000);
      const clean = await within(exited, 1_000) && child.exitCode === 0 && child.signalCode === null;
      if (!clean && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      if (!stopped && !clean) throw new Error("The headless browser did not stop.");
    }
    if (lifecycle.used) await reapBrowser(directory, [], attempt, processes, cleanupClock);
    return;
  }
  // Listed while the controller is alive. Asking it to stop does not wait on that list:
  // a controller that never answers is still alive afterwards and is listed again before it is killed.
  // The list ends by its own deadline, and what it finds stays a target for the rest of this attempt.
  const early = lifecycle.used ? processes.descendants([pid]) : undefined;
  child.stdin?.end();
  attempt.stage = "closed-within-wait";
  const graceful = await within(exited, 4_000);
  if (graceful && unused()) return;
  if (!graceful) {
    attempt.stage = "forced-after-wait";
    const [listed, again] = await Promise.all([early, processes.descendantsKnown([pid], 1_200)]);
    if (early) attempt.listed("early", listed);
    attempt.listed("tree", again);
    const owned = listed !== undefined || again !== undefined ? [...new Set([...(listed ?? []), ...(again ?? [])])] : undefined;
    processes.forceKill([pid, ...(owned ?? [])]);
    await exited;
    attempt.helper = helperState(child, true, lifecycle);
    await reapBrowser(directory, owned, attempt, processes, cleanupClock);
    return;
  }
  const listed = await early;
  if (early) attempt.listed("early", listed);
  attempt.helper = helperState(child, true, lifecycle);
  await reapBrowser(directory, listed, attempt, processes, cleanupClock);
}

function within(done: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function browserTempRoot(): string {
  return process.platform === "darwin" ? join(homedir(), ".petrina", "b") : join(tmpdir(), "petrina-browsers");
}

/** What a failed startup recovery tells the coordinator, per reason. The private note stays in the log. */
const UNCONFIRMED: Record<BrowserCleanupReason, string> = {
  "still-running": "Some of its programs are still running.",
  "finished-unreleased": "Some of its programs have finished, but the system has not released them yet.",
  "state-unknown": "Petrina could not read the state of some of its programs.",
  "list-unreadable": "Petrina could not read the list of running programs.",
  "still-listed": "Its programs were still listed the last time Petrina checked.",
};

/**
 * Reap each registered browser before startup; only the session's own temp folder is eligible.
 * `root` is the parent the engine's sessions started in: a folder elsewhere is never reaped.
 * A failed attempt's private note goes to `log`: standard error, which the engine saves in engine.log.
 */
export async function recoverBrowserTemps(registry: string, root = browserTempRoot(), log: (note: string) => void = (note) => console.error(note), processes: BrowserProcessControl = browserProcesses, clock: BrowserCleanupClock = cleanupClock): Promise<void> {
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
      // the marker stays for the next startup to retry. Windows keeps its earlier wording.
      try { await reapBrowser(directory, undefined, new BrowserCleanupAttempt(processes, clock), processes, clock); }
      catch (error) {
        if (!(error instanceof StopUnconfirmed) || !processes.groups) throw error;
        log(error.note);
        throw new Error([
          "Petrina could not confirm that a background browser from an earlier session stopped.",
          ...error.reasons.map((reason) => UNCONFIRMED[reason])
        ].join(" "));
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
    await rm(registration, { force: true });
  }
  await rm(registry, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
