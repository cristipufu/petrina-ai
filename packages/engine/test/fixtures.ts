// Lightweight private repositories, processes and fake-agent records. No Engine dependency.
import { ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { State } from "@petrina/core";
import type { Scenario } from "./fake-agent.js";
import { updateGitHub, type FakeGitHub } from "./fake-gh.js";
import { shortTempParent, TEST_BROWSERS } from "./temp-parent.js";
import type { MachineRecords } from "../src/check-interruption.js";
import { runChecks as runProductChecks } from "../src/checks.js";
import { PromptReader, type PromptRecord } from "./prompt-records.js";
import { commitAt, git } from "./commands.js";
import { currentSlow } from "./slow.js";
import { processList } from "../src/process-tree.js";
import { writeFixtureJson } from "./fixture-json.js";
export { testGitEnv } from "./test-git-env.js";
export { SLOW, currentSlow } from "./slow.js";
export { CommandFailure, commitAt, git, gitWith, runCommand, runGit } from "./commands.js";

/** The real CLI parser with the canonical fixture launch policy; no native account readers. */
export const CLI = join(import.meta.dir, "cli.ts");
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

/** A product with a GitHub-like origin: a bare repository and a clone of it, on main. */
export async function makeProduct(root: string): Promise<string> {
  const seed = await repositorySeed(undefined, true);
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  mkdirSync(root, { recursive: true });
  cpSync(seed.origin, origin, { recursive: true });
  cpSync(seed.clone, clone, { recursive: true });
  await git(clone, "remote", "set-url", "origin", origin);
  return clone;
}

/** Reuse only the immutable starting commit. Each fixture copies its objects, refs and config. */
interface RepositorySeed { readonly path: string; readonly origin: string; readonly clone: string; readonly head: string }
// Concurrent fixtures asking for one recipe share its preparation while it runs. Only a completed seed is
// ever handed out; a failed one leaves no entry and no folder behind, so the next fixture prepares it afresh.
const repositorySeeds = new Map<string, Promise<RepositorySeed>>();
const seedFolders = new Set<string>();
export function repositorySeed(version?: string, versionFile = false, objectFormat?: "sha1" | "sha256"): Promise<RepositorySeed> {
  const key = JSON.stringify([version ?? "", versionFile, objectFormat]);
  const saved = repositorySeeds.get(key);
  if (saved) return saved;
  const path = tempDir("petrina-repository-seed-");
  seedFolders.add(path);
  const preparing = prepareSeed(path, version, versionFile, objectFormat).catch((error: unknown) => {
    if (repositorySeeds.get(key) === preparing) repositorySeeds.delete(key);
    removeDir(path);
    // A folder that could not be removed yet stays for the exit cleanup.
    if (!existsSync(path)) seedFolders.delete(path);
    throw new Error(`Could not prepare the starting repository in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  });
  repositorySeeds.set(key, preparing);
  return preparing;
}

async function prepareSeed(path: string, version: string | undefined, versionFile: boolean, objectFormat: "sha1" | "sha256" | undefined): Promise<RepositorySeed> {
  const source = join(path, "source"), origin = join(path, "origin.git"), clone = join(path, "clone");
  mkdirSync(source);
  await git(source, "init", "-q", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  writeFileSync(join(source, "README.md"), "# Demo\n");
  if (versionFile) writeFileSync(join(source, "VERSION"), "1.0.0\n");
  if (version) writeFileSync(join(source, "package.json"), `${JSON.stringify({ name: "demo", version }, null, 2)}\n`);
  await git(source, "add", ".");
  await git(source, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init");
  if (versionFile) await git(path, "clone", "-q", "--bare", "--no-hardlinks", source, origin);
  else {
    await git(path, "init", "-q", "--bare", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []), origin);
    await git(source, "push", "-q", origin, "main");
  }
  // Files check out exactly as tests write them, whatever line endings this machine's own Git settings ask for: Git for
  // Windows converts text to CRLF by default. Copies of the clone carry its settings and their linked working copies
  // share them, so Petrina's own Git keeps files as written there too. A test exercising conversion sets its own.
  await git(path, "clone", "-q", "--no-hardlinks", "-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "core.autocrlf=false", "-c", "core.eol=lf", origin, clone);
  if (versionFile) await git(clone, "remote", "set-url", "origin", ADDRESS);
  else {
    // Worlds originally pushed an initial commit to a bare repository by path, without tracking
    // refs or upstream configuration. Product fixtures are real clones and keep those defaults.
    await git(clone, "remote", "remove", "origin");
    await git(clone, "remote", "add", "origin", ADDRESS);
  }
  return Object.freeze({ path, origin, clone, head: await git(source, "rev-parse", "HEAD") });
}
// Standalone diagnostic scripts import these helpers too. The parallel runner owns cleanup when
// Bun's isolated workers bypass exit hooks; ordinary scripts clean their seeds on exit.
process.on("exit", () => { for (const path of seedFolders) removeDir(path); });

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
  const timer = setInterval(() => void report().catch(() => undefined), 15_000);
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
  private readonly inputs: PromptReader;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.inputs = new PromptReader(dir);
  }

  scenario(value: Scenario): void {
    writeFixtureJson(join(this.dir, "scenario.json"), value);
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
    return this.inputs.read().filter((entry) => !role || entry.role === role);
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

/**
 * The commit a working copy's HEAD names at this moment, read from Git's own files without starting a program:
 * for callbacks the engine calls synchronously, such as its announcements, where a Git command cannot be awaited.
 * Reads linked worktrees, detached heads and packed refs; anything else fails rather than guess.
 */
export function headNow(worktree: string): string {
  let gitDir = join(worktree, ".git");
  if (statSync(gitDir).isFile()) gitDir = resolve(worktree, /^gitdir: (.+)$/m.exec(readFileSync(gitDir, "utf8"))?.[1]?.trim() ?? "");
  const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const ref = /^ref: (refs\/.+)$/.exec(head)?.[1];
  // A loose ref wins over packed-refs; one packed away between the two reads is found there.
  const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } };
  const sha = !ref ? head : read(join(common, ref))?.trim() ?? read(join(common, "packed-refs"))?.split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? "";
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new Error(`Could not read the HEAD of ${worktree} from Git's files (${head})`);
  return sha;
}

/** A ref's commit on the stand-in GitHub, or undefined when Git confirms the ref is absent. */
export const remoteRef = (remote: string, ref: string): Promise<string | undefined> => commitAt(remote, ref);

/** Wait until a file exists (the fake gh writes one when it starts holding). */
export async function waitForFile(path: string, ms = 60_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > ms * currentSlow()) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(30);
  }
}

/**
 * A stand-in for a process-list helper whose exit a test reports itself. Its output has ended, as a real
 * helper's has when its reported success is a complete list, so the read takes that success as one.
 */
export function finishedHelper(): ChildProcess {
  return Object.defineProperty(new ChildProcess(), "stdout", { value: { readableEnded: true } });
}

/**
 * A real defunct process in its own group. Its Bun parent pauses before the test ends the child,
 * so it cannot collect the exit until release resumes it. The parent then reaps its own child:
 * neither shell job control, an extra interpreter nor a container's PID 1 is responsible for cleanup.
 */
export async function defunctProcess(beforeRead?: (holderPid: number) => void): Promise<{ pid: number; holderPid: number; self: string; release(): Promise<void> }> {
  if (process.platform === "win32") throw new Error("Defunct processes are a POSIX-only boundary; use the Windows termination controls on Windows.");
  const root = tempDir("petrina-defunct-"), record = join(root, "child");
  const sleep = Bun.which("sleep");
  if (!sleep) { removeDir(root); throw new Error("The native process fixture requires the system's sleep program."); }
  const program = `
    const { writeFileSync, renameSync } = require("node:fs");
    const child = Bun.spawn([${JSON.stringify(sleep)}, "120"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const exited = child.exited;
    try {
      writeFileSync(${JSON.stringify(record + ".tmp")}, String(child.pid));
      renameSync(${JSON.stringify(record + ".tmp")}, ${JSON.stringify(record)});
      process.kill(process.pid, "SIGSTOP");
      await exited;
    } finally { child.kill("SIGKILL"); await exited; }
  `;
  const holder = Bun.spawn([process.execPath, "-e", program], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const holderExited = holder.exited;
  let pid: number | undefined, released: Promise<void> | undefined;
  const present = (id: number) => {
    try { process.kill(id, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const childNumber = () => existsSync(record) ? Number(readFileSync(record, "utf8")) || undefined : undefined;
  const holderPaused = async () => {
    const rows = (await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], 4_000 * currentSlow()))?.split("\n").map(line => line.trim().split(/\s+/));
    return rows?.some(([id, , , state]) => Number(id) === holder.pid && state?.startsWith("T"));
  };
  const release = () => released ??= (async () => {
    try {
      if (pid === undefined) {
        const saved = await waitFor(() => {
          const id = childNumber();
          return id ? { id } : holder.exitCode !== null ? {} : undefined;
        }, "the owned child's complete cleanup record or failed setup's exit", 5_000);
        pid = saved.id;
      }
      if (pid !== undefined) try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      // A setup failure may precede the pause. Sending CONT too soon would be lost when the
      // parent reaches STOP, so observe that boundary before letting it reap and exit normally.
      if (holder.exitCode === null) {
        await waitFor(holderPaused, "the owned holder's pause before cleanup", 5_000);
        // Bun's subprocess kill handle does not deliver CONT to a stopped child.
        // This is the live owned holder, observed paused above, never a saved process number.
        process.kill(holder.pid, "SIGCONT");
      }
      await waitFor(() => holder.exitCode !== null, "the owned holder to reap its child and exit", 5_000);
    } finally {
      if (holder.exitCode === null) {
        try { process.kill(holder.pid, "SIGCONT"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        holder.kill("SIGKILL");
      }
      await holderExited;
    }
    if (pid !== undefined) await waitFor(() => !present(pid!) && !present(-pid!), "the owned defunct process and group to be collected", 5_000);
    removeDir(root);
  })();
  try {
    beforeRead?.(holder.pid);
    pid = await waitFor(childNumber, "the owned child's complete process record", 5_000);
    const target = pid;
    await waitFor(async () => {
      const rows = (await processList(["-A", "-o", "pid=,ppid=,pgid=,stat=,comm="], 4_000 * currentSlow()))?.split("\n").map(line => line.trim().split(/\s+/));
      const parent = rows?.find(([id]) => Number(id) === holder.pid), child = rows?.find(([id]) => Number(id) === target);
      return parent && parent[3]?.startsWith("T") && child && Number(child[1]) === holder.pid && Number(child[2]) === target;
    }, "the owned holder to pause before its child ends", 10_000);
    process.kill(target, "SIGKILL");
    const self = await waitFor(async () => {
      const rows = (await processList(["-A", "-o", "pid=,pgid=,stat="], 4_000 * currentSlow()))?.split("\n").map(line => line.trim().split(/\s+/));
      return rows?.some(([id, group, state]) => Number(id) === target && Number(group) === target && state?.startsWith("Z") && present(target))
        ? rows.find(([id]) => Number(id) === process.pid)?.join(" ") : undefined;
    }, "the real owned process and group to remain defunct", 10_000);
    return { pid: target, holderPid: holder.pid, self, release };
  } catch (error) { await release(); throw error; }
}

/** Synthetic failures' sleep evidence: no records, and this Mac's power log is never read. */
export const noMachineRecords: MachineRecords = async () => "";

/**
 * Production's check runs, except that sleep evidence comes from the records a test passes, else none.
 * A test that needs this Mac's real power log passes `livePowerRecords` explicitly.
 */
export function runChecks(...[cwd, checks, env, timeoutMs, signal, logDirectory, processList, onProgress, machineRecords = noMachineRecords, ...callbacks]: Parameters<typeof runProductChecks>): ReturnType<typeof runProductChecks> {
  return runProductChecks(cwd, checks, env, timeoutMs, signal, logDirectory, processList, onProgress, machineRecords, ...callbacks);
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
