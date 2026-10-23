// Lightweight private repositories, processes and fake-agent records. No Engine dependency.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { State } from "@petrina/core";
import type { Scenario } from "./fake-agent.js";
import { updateGitHub, type FakeGitHub } from "./fake-gh.js";
import { shortTempParent, TEST_BROWSERS } from "./temp-parent.js";
import type { MachineRecords } from "../src/check-interruption.js";
import { runChecks as runProductChecks } from "../src/checks.js";
import { testGitEnv } from "./test-git-env.js";
import { readPrompts, type PromptRecord } from "./prompt-records.js";
export { testGitEnv } from "./test-git-env.js";

/**
 * How much longer the time limits are on this machine. A Windows runner takes several times longer to start
 * every engine, agent and git process these tests drive, and so does a machine busy with other work. The limits
 * only catch hangs, so they stretch there; what a test asserts about time (the engine stopping within 10
 * seconds, say) stays as it is.
 */
export let SLOW = Math.max(process.platform === "win32" ? 3 : 1, busy());
let lastLoadSample = Date.now();

/** Keep waits in a test worker proportional as its own parallel work makes the machine busier. */
export function currentSlow(): number {
  const now = Date.now();
  if (now - lastLoadSample >= 1_000) {
    SLOW = Math.max(SLOW, process.platform === "win32" ? 3 : 1, busy());
    lastLoadSample = now;
  }
  return SLOW;
}

/**
 * How much busier than its cores this machine is right now, as a factor for deadlines (1 to 8). Petrina builds
 * itself, so its tests often run while its own agents work on the same machine: a deadline that only holds on
 * an idle machine would fail them for nothing. Windows reports no load, and has its own factor above.
 */
function busy(): number {
  const [load] = loadavg();
  // A test worker often starts several Bun, Git and engine processes at once. On a many-core Mac,
  // waiting until load exceeds the core count misses that I/O and process-start contention. Start
  // stretching waits once the machine is near full, then scale faster as its run queue grows.
  const ratio = (load ?? 0) / Math.max(1, cpus().length);
  return Math.min(8, Math.max(1, Math.ceil(1 + Math.max(0, ratio - 0.75) * 4)));
}

export const CLI = join(import.meta.dir, "../src/cli.ts");
export const HARNESS = join(import.meta.dir, "harness.ts");

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A fixture's own parent for temporary browser folders, instead of the user's standard one. Run
 * folders can be too long for macOS browser sockets, so the runner owns a short folder for these and
 * reclaims it even after an interrupted run; a standalone script gets one in the system's short
 * temporary folder. Pass it to every engine, browser and recovery of the fixture, and remove it once
 * they have stopped. It is spelled as browser sessions and recovery canonicalize their folders: on
 * Windows only native resolution expands a short name such as RUNNER~1 to the full one.
 */
export function testBrowserRoot(): string {
  const owned = process.env[TEST_BROWSERS];
  return realpathSync.native(mkdtempSync(owned ? `${owned}${sep}` : join(shortTempParent(), "pb-")));
}

/** Windows keeps files open a moment after a process ends: cleaning up is best effort. */
export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left for the system's temp cleanup.
  }
}

/** Use Bun's native result and a deadline: the Node synchronous wrapper can stall after Git has exited. */
export const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: testGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 30_000 * SLOW, killSignal: "SIGKILL" });
  const output = result.stdout.toString();
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${result.signalCode ?? result.exitCode}):\n${[output, result.stderr.toString()].filter(Boolean).join("\n")}`);
  return output.trim();
};

/** A product with a GitHub-like origin: a bare repository and a clone of it, on main. */
export function makeProduct(root: string): string {
  const seed = repositorySeed(undefined, true);
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  mkdirSync(root, { recursive: true });
  cpSync(seed.origin, origin, { recursive: true });
  cpSync(seed.clone, clone, { recursive: true });
  git(clone, "remote", "set-url", "origin", origin);
  return clone;
}

/** Reuse only the immutable starting commit. Each fixture copies its objects, refs and config. */
interface RepositorySeed { path: string; origin: string; clone: string; head: string }
const repositorySeeds = new Map<string, RepositorySeed>();
export function repositorySeed(version?: string, versionFile = false, objectFormat?: "sha1" | "sha256"): RepositorySeed {
  const key = JSON.stringify([version ?? "", versionFile, objectFormat]);
  const saved = repositorySeeds.get(key);
  if (saved) return saved;
  const path = tempDir("petrina-repository-seed-");
  const source = join(path, "source"), origin = join(path, "origin.git"), clone = join(path, "clone");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  writeFileSync(join(source, "README.md"), "# Demo\n");
  if (versionFile) writeFileSync(join(source, "VERSION"), "1.0.0\n");
  if (version) writeFileSync(join(source, "package.json"), `${JSON.stringify({ name: "demo", version }, null, 2)}\n`);
  git(source, "add", ".");
  git(source, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init");
  if (versionFile) git(path, "clone", "-q", "--bare", "--no-hardlinks", source, origin);
  else {
    git(path, "init", "-q", "--bare", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []), origin);
    git(source, "push", "-q", origin, "main");
  }
  git(path, "clone", "-q", "--no-hardlinks", "-c", "user.email=test@example.com", "-c", "user.name=Test", origin, clone);
  if (versionFile) git(clone, "remote", "set-url", "origin", ADDRESS);
  else {
    // Worlds originally pushed an initial commit to a bare repository by path, without tracking
    // refs or upstream configuration. Product fixtures are real clones and keep those defaults.
    git(clone, "remote", "remove", "origin");
    git(clone, "remote", "add", "origin", ADDRESS);
  }
  const seed = { path, origin, clone, head: git(source, "rev-parse", "HEAD") };
  repositorySeeds.set(key, seed);
  return seed;
}
// Standalone diagnostic scripts import these helpers too. The parallel runner owns cleanup when
// Bun's isolated workers bypass exit hooks; ordinary scripts clean their seeds on exit.
process.on("exit", () => { for (const seed of repositorySeeds.values()) removeDir(seed.path); });

/**
 * Stops at once, saying why, when this machine holds back programs written a moment ago. Take-over
 * tests write small stand-ins for the launcher and the agent's app and run them. macOS checks each
 * new program before its first run, and when that check hangs, every one of those tests would
 * otherwise wait out its timeout.
 */
export function newProgramsStart(): Promise<void> {
  return (checked ??= startsNewProgram(10_000));
}

let checked: Promise<void> | undefined;

async function startsNewProgram(ms: number): Promise<void> {
  if (process.platform === "win32") return;
  const dir = tempDir("petrina-new-program-");
  const file = join(dir, "new-program");
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const proc = Bun.spawn([file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const startedAt = Date.now();
  let started = false;
  while (!started && Date.now() - startedAt <= ms * currentSlow()) {
    started = await Promise.race([proc.exited.then(() => true), Bun.sleep(50).then(() => false)]);
  }
  if (!started) proc.kill("SIGKILL");
  removeDir(dir);
  if (!started) {
    throw new Error(
      `This machine did not start a program written a moment ago within ${ms / 1000} seconds, so these tests can't run here. ` +
        "On macOS that is its check of new programs not finishing: allow the app the tests run from (your terminal) in " +
        "System Settings > Privacy & Security > Developer Tools, or restart the Mac, and run them again.",
    );
  }
}

export async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > ms * currentSlow()) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Leave context before a test's own timeout, without changing what it waits for or its deadline. */
export async function traceTaskWait<T>(label: string | undefined, state: () => State | Promise<State>, taskId: string, wait: () => Promise<T>): Promise<T> {
  if (!label) return wait();
  const started = Date.now();
  let finished = false;
  const report = async () => {
    try {
      const current = await state();
      if (finished) return;
      const task = current.tasks.find((entry) => entry.id === taskId);
      console.warn(`Still waiting: ${label}`, JSON.stringify({
        elapsedMs: Date.now() - started, taskId, state: task?.state, status: task?.statusLine, error: task?.error,
        stage: task?.plan?.stages[task.stageIndex]?.title, rounds: task?.rounds,
        agents: [task?.agent, ...(task?.helpers ?? [])].filter(Boolean),
        inbox: current.inbox.filter((item) => item.taskId === taskId).map((item) => ({ kind: item.kind, title: item.title })),
        tools: current.setup?.checks,
      }));
    } catch { /* Diagnostics must not replace the test's result. */ }
  };
  // This only reports progress; it is not a hang deadline and never ends or retries the wait.
  const timer = setInterval(() => void report(), 15_000);
  timer.unref();
  try { return await wait(); }
  finally { finished = true; clearInterval(timer); }
}

/** The first line a process writes to stdout. */
export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!;
}


export interface Open {
  session: string;
  how: "new" | "resume" | "load";
  tool: string;
  background: boolean;
  logins: boolean;
  quiet: boolean;
  sandbox?: unknown;
  autoMode?: true;
  refused?: true;
}


/** A fake dir for one test: scenario, prompts, markers and the fake GitHub. */
export class Fakes {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  scenario(value: Scenario): void {
    writeFileSync(join(this.dir, "scenario.json"), JSON.stringify(value));
  }

  github(change: (state: FakeGitHub) => void): void {
    const path = join(this.dir, "github.json");
    updateGitHub(path, change);
  }

  marked(name: string): boolean {
    return existsSync(join(this.dir, name));
  }

  /** Every complete prompt the fake agents received, in publication order. */
  prompts(role?: string): string[] {
    return this.received(role).map((entry) => entry.text);
  }

  /** Every complete prompt in publication order, with the conversation it went to. */
  received(role?: string): PromptRecord[] {
    return readPrompts(this.dir).filter((entry) => !role || entry.role === role);
  }

  /**
   * How each conversation was opened, as which tool: whether its agent ran in the agents' environment (in the
   * background, with the coordinator's logins and nothing that asks), Claude Code's sandbox settings if it was
   * sent them, and whether it refused them.
   */
  opens(): Open[] {
    return this.lines("opens.jsonl");
  }

  /** Every setting Petrina gave a conversation, in order. */
  settings(session: string): string[] {
    return this.lines<{ session: string; configId: string; value: string }>("config.jsonl")
      .filter((entry) => entry.session === session)
      .map((entry) => `${entry.configId}=${entry.value}`);
  }

  /** The tool loses every conversation it had (cleared history, a tool update). */
  forgetConversations(): void {
    removeDir(join(this.dir, "conversations"));
  }

  private lines<T>(name: string): T[] {
    const path = join(this.dir, name);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  /** The opening prompt of each agent of a role (the ones that say who they are). */
  openings(role: string): string[] {
    return this.prompts(role).filter((text) => /You are the [A-Za-z ]+ in Petrina/.test(text));
  }
}


export const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");
export const FAKE_GH = join(import.meta.dir, "fake-gh.ts");
export const REPO = "acme/demo";
export const ADDRESS = "https://github.com/acme/demo.git";

/** A ref on the stand-in GitHub, or undefined. */
export const remoteRef = (remote: string, ref: string): string | undefined => {
  try {
    return git(process.cwd(), "--git-dir", remote, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`) || undefined;
  } catch {
    return undefined;
  }
};


/** Wait until a file exists (the fake gh writes one when it starts holding). */
export async function waitForFile(path: string, ms = 60_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > ms * currentSlow()) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(30);
  }
}

/**
 * A real defunct process: finished, but never collected by its parent, which is what a child whose exit
 * the runtime lost looks like to the system. `release` ends the parent, so the system collects it.
 */
export async function defunctProcess(): Promise<{ pid: number; release(): Promise<void> }> {
  const holder = Bun.spawn(["sh", "-c", "sleep 0.05 & echo $!; exec sleep 300"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const reader = holder.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  const pid = Number(text.trim());
  if (!pid) throw new Error(`No defunct process was started: ${JSON.stringify(text)}`);
  return {
    pid,
    async release() {
      holder.kill("SIGKILL");
      await holder.exited;
    },
  };
}

/** Synthetic failures' sleep evidence: no records, and this Mac's power log is never read. */
export const noMachineRecords: MachineRecords = async () => "";

/**
 * Production's check runs, except that sleep evidence comes from the records a test passes, else none.
 * A test that needs this Mac's real power log passes `livePowerRecords` explicitly.
 */
export function runChecks(...[cwd, checks, env, timeoutMs, signal, logDirectory, processList, onProgress, machineRecords = noMachineRecords]: Parameters<typeof runProductChecks>): ReturnType<typeof runProductChecks> {
  return runProductChecks(cwd, checks, env, timeoutMs, signal, logDirectory, processList, onProgress, machineRecords);
}

/** A macOS power-log line recording sleep from `at` for `seconds`, for a test's own records. */
export function powerLogSleep(at: number, seconds: number): string {
  const time = new Date(at).toISOString();
  return `${time.slice(0, 10)} ${time.slice(11, 19)} +0000 Sleep               Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:100%) ${seconds} secs`;
}

/**
 * Sleep records that wait for the test: `reads` holds each read's stop signal, `started(n)` resolves once n
 * reads have begun and `answer` settles every open read. A stopped read settles with `whenStopped`, so a test
 * can prove late evidence is discarded.
 */
export function heldMachineRecords(whenStopped = ""): { source: MachineRecords; reads: (AbortSignal | undefined)[]; started(count?: number): Promise<void>; answer(records: string): void } {
  const reads: (AbortSignal | undefined)[] = [];
  const open: ((records: string) => void)[] = [];
  const waiting: { count: number; resolve(): void }[] = [];
  return {
    reads,
    source: (signal) => new Promise<string>((resolve) => {
      reads.push(signal);
      open.push(resolve);
      signal?.addEventListener("abort", () => resolve(whenStopped), { once: true });
      for (const waiter of waiting.filter((entry) => reads.length >= entry.count)) { waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(); }
    }),
    started: (count = 1) => reads.length >= count ? Promise.resolve() : new Promise<void>((resolve) => { waiting.push({ count, resolve }); }),
    answer: (records) => { for (const resolve of open.splice(0)) resolve(records); },
  };
}
