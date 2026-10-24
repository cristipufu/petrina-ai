import { spawn, type ChildProcess } from "node:child_process";
import { processHost } from "./process-host.js";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { descendants, descendantsKnown, parseProcessState, processList, type ObservedProcess, type ProcessState } from "./process-tree.js";

export class AgentBrowser {
  private closing?: Promise<void>;
  private constructor(readonly directory: string, private readonly child: ChildProcess, readonly mcp: McpServer, private readonly lifecycle: { used: boolean; closedUnused: boolean }, private readonly registration?: string, private readonly onLog?: (text: string) => void) {}

  /**
   * `parent` registers the session folder for recovery after a crash. `root` holds session folders:
   * the standard one unless a test fixture supplies its own, which startup recovery must use too.
   * `onLog` receives the helper's output and a failed cleanup's private note; without it the note goes to standard error.
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
      return new AgentBrowser(directory, child, { type: "http", name: `petrina-browser-${secret.slice(0, 8)}`, url, headers: [{ name: "Authorization", value: `Bearer ${secret}` }] }, lifecycle, registration, onLog);
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
        // The folder and its registration stay until this confirms every browser process stopped.
        await stopBrowser(this.child, this.directory, this.lifecycle);
        await rm(this.directory, { recursive: true, force: true });
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

/** The first words of a failed cleanup attempt's private note: one line in the task's log, engine.log or a test's output. */
export const CLEANUP_NOTE = "Browser cleanup incomplete:";
const NOTE_BYTES = 4096, NOTE_PROCESSES = 16;

/**
 * One bounded line of private evidence: fixed words, counts and process numbers, never command text, paths,
 * page addresses or browser contents. At most 16 processes, those still present first, with total and omitted counts.
 */
export function cleanupNote(heading: string, facts: readonly (readonly [string, string | number])[], processes: readonly ObservedProcess[]): string {
  const word = (value: string | number) => String(value).replace(/[^A-Za-z0-9:+,-]/g, "_") || "_";
  const order: readonly ProcessState[] = ["running", "finished", "unknown", "absent"];
  const sorted = [...processes].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.pid - b.pid);
  const head = `${heading} ${facts.map(([name, value]) => `${word(name)}=${word(value)}`).join(" ")}`;
  for (let shown = Math.min(sorted.length, NOTE_PROCESSES); ; shown--) {
    const entries = sorted.slice(0, shown).map(({ pid, state, sources }) => `${pid}:${state}:${sources.map(word).join("+")}`);
    const line = `${head} processes=${sorted.length} shown=${shown} omitted=${sorted.length - shown}${shown ? ` owned=${entries.join(",")}` : ""}`;
    if (Buffer.byteLength(line) <= NOTE_BYTES || !shown) return line.slice(0, NOTE_BYTES);
  }
}

/** Why an attempt could not confirm that its browser stopped. */
type Reason = "still-running" | "finished-unreleased" | "state-unknown" | "list-unreadable" | "still-listed";

/** Cleanup could not confirm that every browser process stopped. Its note is private evidence for a log, never for the app. */
class StopUnconfirmed extends Error {
  declare readonly reasons: readonly Reason[];
  declare readonly note: string;
  constructor(reasons: readonly Reason[], note: string) {
    super("The headless browser did not stop.");
    // Off the error's listed properties: the note reaches a log once, as its own line, not inside a printed error.
    Object.defineProperties(this, { reasons: { value: reasons }, note: { value: note } });
  }
}

/**
 * What one stop attempt has learned. Every process it finds stays a target until the attempt ends; a later
 * attempt or startup recovery finds ownership afresh through the session folder, never from these numbers.
 */
class Attempt {
  private readonly started = Date.now();
  private readonly owners = new Map<number, Set<string>>();
  private readonly lists = { early: "not-taken", tree: "not-taken" };
  private readonly folders: string[] = [];
  /** The latest folder scan's complete list when it was readable: the states the attempt is judged by. */
  private latest?: string;
  /** The latest readable folder scan showed nothing of this session still running. */
  clear = false;
  stage = "startup-recovery";
  helper = "not-tracked";

  /** A helper's own process list only adds stopping targets: an empty one says nothing about the folder. */
  listed(source: "early" | "tree", pids: readonly number[] | undefined): void {
    this.lists[source] = pids === undefined ? "unavailable" : String(pids.length);
    this.own(pids ?? [], source);
  }

  targets(): number[] {
    return [...this.owners.keys()];
  }

  /** Processes whose command still names the session folder, or undefined when the list cannot be read. */
  async scan(directory: string): Promise<number[] | undefined> {
    const found = await processesUsing(directory);
    this.folders.push(found ? String(found.pids.length) : "unavailable");
    this.latest = found?.list;
    if (!found) return undefined;
    this.own(found.pids, "folder");
    // A later scan that still finds a process outweighs an earlier clear one, even once that process is stopped.
    this.clear = !found.pids.some(alive);
    return found.pids;
  }

  /** The failure when completion is not confirmed: a tracked process remains, or the latest readable scan did not show the folder clear. */
  judge(confirmed: boolean): StopUnconfirmed | undefined {
    const processes = this.targets().map((pid) => ({ pid, state: this.state(pid), sources: [...this.owners.get(pid)!] }));
    const reasons: Reason[] = [];
    if (processes.some(({ state }) => state === "running")) reasons.push("still-running");
    if (processes.some(({ state }) => state === "finished")) reasons.push("finished-unreleased");
    if (processes.some(({ state }) => state === "unknown")) reasons.push("state-unknown");
    if (!confirmed && this.folders.includes("unavailable")) reasons.push("list-unreadable");
    else if (!confirmed && !reasons.length) reasons.push("still-listed");
    if (!reasons.length) return undefined;
    const facts: [string, string | number][] = [["stage", this.stage], ["elapsed", `${Date.now() - this.started}ms`], ["helper", this.helper], ["early", this.lists.early], ["tree", this.lists.tree]];
    this.folders.forEach((scan, index) => facts.push([`folder${index + 1}`, scan]));
    facts.push(["confirmed", confirmed ? "yes" : "no"], ["reasons", reasons.join(",")]);
    return new StopUnconfirmed(reasons, cleanupNote(CLEANUP_NOTE, facts, processes));
  }

  private own(pids: readonly number[], source: string): void {
    for (const pid of pids) {
      if (pid === process.pid) continue;
      const sources = this.owners.get(pid) ?? new Set<string>();
      this.owners.set(pid, sources.add(source));
    }
  }

  /** A process that still exists but is missing from the latest complete list cannot be told apart from a newer one. */
  private state(pid: number): ProcessState {
    if (!alive(pid)) return "absent";
    const state = this.latest === undefined ? "unknown" : parseProcessState(this.latest, pid);
    return state === "absent" ? "unknown" : state;
  }
}

/** How the helper ended, recorded apart from what its browser processes did. */
function helperState(child: ChildProcess, closed: boolean, lifecycle: { used: boolean; closedUnused: boolean }): string {
  const ended = child.signalCode !== null ? `signal-${child.signalCode}` : child.exitCode !== null ? `exit-${child.exitCode}` : "running";
  return [ended, closed ? "closed" : "close-unconfirmed", lifecycle.used ? "used" : lifecycle.closedUnused ? "acknowledged-unused" : "unused"].join(",");
}

/** Stop the controller and every browser process this session started. Resolves only once they are gone. */
async function stopBrowser(child: ChildProcess, directory: string, lifecycle: { used: boolean; closedUnused: boolean }): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const attempt = new Attempt();
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
    if (!processHost.groups) throw new Error("The headless browser did not stop.");
    attempt.stage = "exited-before-close";
    attempt.helper = helperState(child, closed, lifecycle);
    await reap(directory, undefined, attempt);
    return;
  }
  if (processHost.stopTree) {
    // Once an unexpected exit loses the parent relationship, taskkill cannot prove
    // that its browsers stopped. Keep the marker and report incomplete cleanup.
    child.stdin?.end();
    if (await within(exited, 4_000)) {
      if (child.exitCode !== 0 || child.signalCode !== null) throw new Error("The headless browser did not stop.");
    } else {
      const stopped = await processHost.stopTree(pid, 3_000);
      if (!await within(exited, 1_000)) child.kill("SIGKILL");
      await exited;
      if (!stopped) throw new Error("The headless browser did not stop.");
    }
    return;
  }
  // Listed while the controller is alive. Asking it to stop does not wait on that list:
  // a controller that never answers is still alive afterwards and is listed again before it is killed.
  // The list ends by its own deadline, and what it finds stays a target for the rest of this attempt.
  const early = lifecycle.used ? descendants([pid]) : undefined;
  child.stdin?.end();
  attempt.stage = "closed-within-wait";
  const graceful = await within(exited, 4_000);
  if (graceful && unused()) return;
  if (!graceful) {
    attempt.stage = "forced-after-wait";
    const [listed, again] = await Promise.all([early, descendantsKnown([pid], 1_200)]);
    if (early) attempt.listed("early", listed);
    attempt.listed("tree", again);
    const owned = listed !== undefined || again !== undefined ? [...new Set([...(listed ?? []), ...(again ?? [])])] : undefined;
    forceKill([pid, ...(owned ?? [])]);
    await exited;
    attempt.helper = helperState(child, true, lifecycle);
    await reap(directory, owned, attempt);
    return;
  }
  const listed = await early;
  if (early) attempt.listed("early", listed);
  attempt.helper = helperState(child, true, lifecycle);
  await reap(directory, listed, attempt);
}

/**
 * Kill any browser still using this session's folder, then wait until it is actually gone. Success needs the
 * latest readable folder scan in this attempt to show nothing of the session left, and every process the
 * attempt found gone; unknown ownership is never success. Windows keeps its earlier recovery rule.
 */
async function reap(directory: string, owned: number[] | undefined, attempt: Attempt): Promise<void> {
  const marked = await attempt.scan(directory);
  // Both ownership sources agree that there is nothing to reap.
  if (owned !== undefined && !owned.length && marked !== undefined && !marked.length) return;
  const still = () => attempt.targets().filter(alive);
  if (still().length) forceKill(still());
  await untilGone(attempt.targets(), 1_000);
  const left = await attempt.scan(directory);
  if (left?.length) forceKill(left.filter(alive));
  // Commands can stop naming the folder before their processes are released. Every tracked
  // target still gets the existing final wait, even when the folder scan itself is clear.
  if (still().length) await untilGone(attempt.targets(), 1_000);
  const remaining = await attempt.scan(directory);
  // A process can finish between the first wait and the final scan. Judge the final
  // ownership evidence, keeping every earlier target; a provisional timeout is not a sticky failure.
  const failure = attempt.judge(!processHost.groups ? owned !== undefined || marked !== undefined || remaining !== undefined : attempt.clear);
  if (failure) throw failure;
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

/**
 * Processes whose command still names this session's folder, with the complete list whose state column
 * tells running from finished processes, or undefined when the list cannot be read.
 */
function processesUsing(directory: string): Promise<{ pids: number[]; list: string } | undefined> {
  const column = process.platform === "linux" ? "args=" : "command=";
  return processList(["-axww", "-o", `pid=,ppid=,stat=,${column}`], 2_000, 32 * 1024 * 1024).then((stdout) => {
    if (stdout === undefined) return undefined;
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^(\d+)\s+(.*)$/.exec(line.trim());
      if (match && namesSession(match[2]!, directory)) pids.push(Number(match[1]));
    }
    return { pids, list: stdout };
  });
}

export function browserTempRoot(): string {
  return process.platform === "darwin" ? join(homedir(), ".petrina", "b") : join(tmpdir(), "petrina-browsers");
}

/** What a failed startup recovery tells the coordinator, per reason. The private note stays in the log. */
const UNCONFIRMED: Record<Reason, string> = {
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
export async function recoverBrowserTemps(registry: string, root = browserTempRoot(), log: (note: string) => void = (note) => console.error(note)): Promise<void> {
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
      try { await reap(directory, undefined, new Attempt()); }
      catch (error) {
        if (!(error instanceof StopUnconfirmed) || !processHost.groups) throw error;
        log(error.note);
        throw new Error(["Petrina could not confirm that a background browser from an earlier session stopped.", ...error.reasons.map((reason) => UNCONFIRMED[reason])].join(" "));
      }
      await rm(directory, { recursive: true, force: true });
    }
    await rm(registration, { force: true });
  }
  await rm(registry, { recursive: true, force: true });
}
