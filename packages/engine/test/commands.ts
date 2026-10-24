// Programs a test runs itself, Git above all: asynchronous, each under a deadline of its own, with bounded
// cleanup of everything it started. No Engine dependency: the stand-ins for GitHub and the agents use it too.
//
// A synchronous child call holds its whole test worker until the runtime reports the child's exit. Under load
// that report can be lost, and then no timer in the worker runs again: not the test's own deadline, not another
// test. Here every wait ends on a timer the worker schedules itself, and a command only succeeds once its exit
// is reported and its output is complete. Closed output alone proves nothing.
import { parseDescendants, type ProcessListRead } from "../src/process-tree.js";
import { SLOW } from "./slow.js";
import { testGitEnv } from "./test-git-env.js";
import { execFile } from "node:child_process";
import { createProcessHost } from "../src/process-host.js";

/** Git's allowance per command; like the fixtures' other hang-catching limits, it stretches on a busy machine. */
export const GIT_TIMEOUT_MS = 30_000;
/** Stopping a failed command and confirming that everything it started has ended has its own short bound, stretched like the others. */
export const CLEANUP_MS = 5_000;

/** The parts of a started program the runner uses. Runner tests pass private stand-ins through `start`. */
export interface Started {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /**
   * The runtime's own record of the exit: null until it collects the program, which frees its number. A stand-in
   * without it gives cleanup no such record.
   */
  readonly exitCode?: number | null;
  readonly signalCode: string | null;
  kill(signal?: NodeJS.Signals): void;
}
export type Start = (argv: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; stdin: "ignore" | Blob; detached: boolean }) => Started;

// A private reference: a test that replaces Bun.spawn or node's child_process to watch or redirect its own
// commands never intercepts repository preparation, another test's programs or their cleanup.
const spawn = Bun.spawn.bind(Bun);
const execute = execFile.bind(undefined);
const host = createProcessHost(process.platform, (command, args, options, done) => execute(command, [...args], options, error => done(error)));
const start: Start = (argv, options) => spawn(argv, { ...options, stdout: "pipe", stderr: "pipe", windowsHide: true }) as unknown as Started;

/**
 * A cleanup helper's output, or undefined unless it exits 0 with its output complete within `ms`. Its own timer
 * ends the wait whatever the helper or the runtime report; a helper still running then is stopped.
 */
function helper(argv: string[], ms: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true }); }
    catch { return resolve(undefined); }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
      resolve(undefined);
    }, ms);
    Promise.all([child.exited, new Response(child.stdout as ReadableStream<Uint8Array>).text()])
      .then(([code, text]) => code === 0 ? text : undefined, () => undefined)
      .then((text) => { clearTimeout(timer); resolve(text); });
  });
}

/** Every process with its parent, its process group and its state. */
const readProcesses: ProcessListRead = (timeout) => helper(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);

export interface CommandOptions {
  cwd?: string;
  /** Default: this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** What the program reads; without it, its input is closed. */
  input?: string | Uint8Array;
  /** Covers starting, input, running, output and the exit report. Default: Git's stretched allowance. */
  timeoutMs?: number;
  /** Stops the command and everything it started; the command fails. */
  signal?: AbortSignal;
  /** Runner tests only: a private stand-in for the started program. */
  start?: Start;
  /** Runner tests only: a private stand-in for the system's process list. */
  processList?: ProcessListRead;
  /** Observe decoded output while the command runs. Callbacks stay synchronous. */
  onOutput?: (text: string, stream: "stdout" | "stderr") => undefined;
}

export interface CommandResult {
  /** The reported exit code; 128 plus the signal's number when a signal ended the program. */
  code: number;
  signal?: string;
  stdout: string;
  stderr: string;
}

/**
 * `confirmed`: cleanup paused the program's process group the moment it began, everything it then found stayed in that
 * group and showed paused, and all of that and whatever held the program's output have ended. `unconfirmed`: some of
 * what it started may still be running, because cleanup could not pause or see it all. A program that left both the
 * group and the program's tree before cleanup began, or as its pause took effect, and closed its output, is beyond any
 * list.
 */
export type Cleanup = "none" | "confirmed" | "unconfirmed";
export type FailureReason = "start" | "timeout" | "cancelled" | "unreadable" | "exit";

/** A command that did not end with a reported successful exit and complete output. */
export class CommandFailure extends Error {
  constructor(message: string, readonly reason: FailureReason, readonly stdout = "", readonly stderr = "", readonly cleanup: Cleanup = "none", readonly code?: number, readonly signal?: string) {
    super(message);
    this.name = "CommandFailure";
  }
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} seconds`;

/**
 * Run a program to its reported exit, whatever its exit code, keeping its output streams apart and exactly as
 * written. It fails, after stopping everything it started, when it cannot start, when its deadline or `signal`
 * comes first (a lost exit report included), or when its output cannot be read.
 */
export function runCommand(argv: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS * SLOW;
  const where = options.cwd ?? process.cwd();
  const what = argv.join(" ");
  // A timer outside this range fires at once or never: neither is a deadline.
  if (!(timeoutMs > 0 && timeoutMs <= 2_147_483_647)) return Promise.reject(new RangeError(`${what} needs a deadline between 1 and 2147483647 ms, not ${timeoutMs}`));
  if (options.signal?.aborted) return Promise.reject(new CommandFailure(`${what} was cancelled before it started, in ${where}`, "cancelled"));
  const windows = !host.groups;
  let child: Started;
  try {
    child = (options.start ?? start)([...argv], { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env ?? process.env, stdin: options.input === undefined ? "ignore" : new Blob([options.input]), detached: host.ownedSpawn.detached });
  } catch (error) {
    return Promise.reject(new CommandFailure(`${what} could not start in ${where}: ${messageOf(error)}`, "start"));
  }
  return new Promise<CommandResult>((resolve, reject) => {
    const output = ["", ""], closed = [false, false];
    let exit: number | undefined;
    // The runtime gave up on the program's exit: it no longer tracks it, so its number may be free.
    let untracked = false;
    let settled = false;
    const readers = [child.stdout, child.stderr].map((stream) => stream.getReader());
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    };
    const finish = () => {
      if (settled || exit === undefined || !closed.every(Boolean)) return;
      settle();
      resolve({ code: exit, ...(child.signalCode ? { signal: child.signalCode } : {}), stdout: output[0]!, stderr: output[1]! });
    };
    const fail = (reason: FailureReason, detail: string) => {
      if (settled) return;
      settle();
      const open = ["output", "error output"].filter((_, index) => !closed[index]);
      const seen = exit !== undefined ? `It exited with ${exit}${open.length ? `, but its ${open.join(" and ")} stayed open` : ""}.`
        : open.length ? "Its exit was never reported." : "Its output closed, but its exit was never reported.";
      // The output is still read while cleanup runs: its end shows that whatever held it has gone too. Whether the
      // exit was reported is read live: it can arrive meanwhile.
      void stopOwned(child, () => exit !== undefined || untracked, outputEnded, windows, options.processList ?? readProcesses).then((cleanup) => {
        for (const reader of readers) void reader.cancel().catch(() => undefined);
        const stopped = cleanup === "confirmed" ? "Everything found that it started has stopped." : "Some of what it started may still be running.";
        const partial = [output[0], output[1]].filter(Boolean).join("\n");
        reject(new CommandFailure(`${what} ${detail}, in ${where}. ${seen} ${stopped}${partial ? `\n${partial}` : ""}`, reason, output[0], output[1], cleanup, exit, child.signalCode ?? undefined));
      });
    };
    const cancel = () => fail("cancelled", "was cancelled");
    // The deadline is the worker's own timer: it fires whatever the program, its output or its exit report do.
    const timer = setTimeout(() => fail("timeout", `did not finish within ${seconds(timeoutMs)}`), timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    let ended = () => {};
    const outputEnded = new Promise<void>((resolve) => { ended = resolve; });
    readers.forEach((reader, index) => {
      const decoder = new TextDecoder();
      void (async () => {
        const append = (text: string) => {
          output[index] += text;
          if (text) options.onOutput?.(text, index ? "stderr" : "stdout");
        };
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          append(decoder.decode(next.value, { stream: true }));
        }
        append(decoder.decode());
        closed[index] = true;
        if (closed.every(Boolean)) ended();
        finish();
      })().catch((error) => fail("unreadable", `could not have its ${index ? "error output" : "output"} read (${messageOf(error)})`));
    });
    child.exited.then((code) => { exit = code; finish(); }, (error) => { untracked = true; fail("unreadable", `could not have its exit read (${messageOf(error)})`); });
    // A controlled starter can abort synchronously before the listener is attached. All
    // cleanup resources are initialized now; do not accept its result after that cancellation.
    if (options.signal?.aborted) cancel();
  });
}

/**
 * Stop a failed command's program and everything it started, all within CLEANUP_MS × SLOW, and say whether that is
 * confirmed. While the runtime has not collected the program, its group is paused at once, before any look, so nothing
 * in it can start anything while cleanup looks; that group is stopped in the end unless a list shows its number as
 * someone else's. Each list decides afresh what else is the command's (`lookAt`), and only that is signalled by
 * number, right after the list showed it: paused and looked at again until a look shows everything found paused, then
 * stopped, so nothing paused is left paused. Without a list only that group and the program's own handle are stopped.
 * Confirmed needs the group paused first, nothing found outside it, that paused look, nothing found and nothing in the
 * group running in a later list, and the output ended.
 */
function stopOwned(child: Started, reported: () => boolean, outputEnded: Promise<void>, windows: boolean, read: ProcessListRead): Promise<Cleanup> {
  return new Promise<Cleanup>((resolve) => {
    const budget = CLEANUP_MS * SLOW, end = Date.now() + budget;
    const bound = setTimeout(() => resolve("unconfirmed"), budget);
    (windows ? stopWindows(child, reported, end) : stopUnix(child, reported, read, end))
      // Whatever still holds the output is still running, found or not.
      .then(async (cleanup) => cleanup === "confirmed" && await ended(outputEnded, end) ? cleanup : "unconfirmed")
      .catch((): Cleanup => "unconfirmed")
      .then((cleanup) => { clearTimeout(bound); resolve(cleanup); });
  });
}

/** Whether the output ends by `end`. */
function ended(output: Promise<void>, end: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, end - Date.now()));
    void output.then(() => { clearTimeout(timer); resolve(true); });
  });
}

/** A complete list always shows this process; anything else, an empty answer included, is no list. */
const listed = (list: string | undefined): list is string => list !== undefined && list.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === process.pid);
const rowsOf = (list: string) => list.split("\n").map((line) => line.trim().split(/\s+/)).filter(([id]) => Number(id) > 0);

const signal = (targets: readonly number[], name: NodeJS.Signals) => {
  for (const target of targets) try { process.kill(target, name); } catch { /* Already gone. */ }
};

/** One list, and what it shows as the command's. */
interface Look {
  list: string;
  /** The program is listed as this process's own child, and its exit was not reported before the list was read. */
  owned: boolean;
  /** The program's number is listed under another parent. */
  foreign: boolean;
  /** A member of the program's group besides it, not yet ended, is listed: it keeps the group's number from reuse. */
  kept: boolean;
  /** Everything the list shows as the command's, the program included. */
  mine: number[];
}

/**
 * What one list shows as the command's. Its program, while listed as this process's own child with its exit still
 * unreported when the list was read: listed under another parent, or after that report, its number may have been
 * reused, and neither the group it leads nor anything under it is the command's. Its group's members, while that
 * program or a member not yet ended keeps the number from reuse. Whatever cleanup paused by number that the list
 * shows not yet ended, wherever it moved since: once paused, even before the pause takes effect, it cannot run on to
 * its end and give its number away. And everything under any of those.
 */
function lookAt(list: string, pid: number, reportedBefore: boolean, paused: ReadonlySet<number>): Look {
  const rows = rowsOf(list);
  const program = rows.find(([id]) => Number(id) === pid);
  const owned = !reportedBefore && program !== undefined && Number(program[1]) === process.pid;
  const members = program === undefined || owned ? rows.filter(([id, , pgid]) => Number(pgid) === pid && Number(id) !== pid) : [];
  const held = rows.filter(([id, , , state]) => paused.has(Number(id)) && !state?.startsWith("Z")).map(([id]) => Number(id));
  const roots = [...(owned ? [pid] : []), ...members.map(([id]) => Number(id)), ...held];
  const kept = members.some(([, , , state]) => !state?.startsWith("Z"));
  return { list, owned, foreign: program !== undefined && Number(program[1]) !== process.pid, kept, mine: [...new Set([...roots, ...parseDescendants(list, roots)])] };
}

const stateIn = (look: Look, id: number) => rowsOf(look.list).find(([row]) => Number(row) === id)?.[3];

async function stopUnix(child: Started, reported: () => boolean, read: ProcessListRead, end: number): Promise<Cleanup> {
  const pid = child.pid;
  const handle = () => { if (!reported()) try { child.kill("SIGKILL"); } catch { /* Already gone. */ } };
  // The runtime records no exit until it collects the program, and the program's number, with the group it leads,
  // stays the command's meanwhile. Where it collects on a thread of its own, the record can lag for a moment, but a
  // member of the group still keeps its number. Paused at once, nothing in that group can start anything while
  // cleanup looks, and what it paused keeps the group's number in use until cleanup stops it.
  const pausedFirst = pid !== undefined && !reported() && child.exitCode === null && child.signalCode === null;
  if (pausedFirst) signal([-pid], "SIGSTOP");
  const paused = new Set<number>(), found = new Set<number>();
  // Something of the command's found outside its group was not paused with it, and ran while cleanup looked.
  let outside = false;
  /** A list, read within `until`, and what it shows as the command's; undefined when the read fails. */
  const look = async (until: number): Promise<Look | undefined> => {
    const before = reported();
    const list = await read(Math.max(100, Math.min(1_500 * SLOW, until - Date.now())));
    if (!listed(list)) return undefined;
    const shown = lookAt(list, pid!, before, paused);
    for (const id of shown.mine) found.add(id);
    if (rowsOf(list).some(([id, , pgid]) => shown.mine.includes(Number(id)) && Number(pgid) !== pid)) outside = true;
    return shown;
  };
  if (pid === undefined) { handle(); return "unconfirmed"; }
  let current: Look | undefined;
  // Signals by number go out right after the list that shows their targets, and never to one that has ended. The
  // program itself is reached through its group and its handle: it leads its group for as long as it runs.
  const targets = () => current?.mine.filter((id) => id !== pid && !stateIn(current!, id)?.startsWith("Z")) ?? [];
  // Paused at once, the group stays the command's unless a list shows its number as someone else's: it can only be
  // reused once the group has emptied.
  const group = () => (current ? (current.owned && !reported()) || current.kept || (pausedFirst && !current.foreign) : pausedFirst) ? [-pid] : [];
  let seen = false, fresh = true;
  try {
    // The first look gets half the budget, and a second try when a read fails.
    const until = Date.now() + (end - Date.now()) / 2;
    for (let attempt = 0; attempt < 2 && !current && Date.now() < until; attempt++) current = await look(until);
    // One that ended, or left the command, before it was seen paused may have started something unseen.
    if (current?.owned && !stateIn(current, pid)?.startsWith("Z")) for (let attempt = 0; attempt < 4 && Date.now() < end; attempt++) {
      // After a failed read nothing new is known: what the last list showed is already paused.
      if (fresh) {
        signal([...group(), ...targets()], "SIGSTOP");
        for (const id of targets()) paused.add(id);
      }
      const next = await look(end);
      fresh = next !== undefined;
      if (!next) continue;
      current = next;
      const states = [...found].map((id) => next.mine.includes(id) ? stateIn(next, id) : undefined);
      if (states.every((state) => state?.startsWith("T"))) { seen = pausedFirst && !outside && next.owned; break; }
      if (states.some((state) => state === undefined || state.startsWith("Z"))) break;
    }
  } finally {
    // Without a list only the group paused at once, and the program through its handle, are stopped.
    signal(targets().reverse(), "SIGKILL");
    signal(group(), "SIGKILL");
    handle();
  }
  if (!seen) return "unconfirmed";
  while (Date.now() < end) {
    const list = await read(Math.max(100, Math.min(1_500 * SLOW, end - Date.now())));
    // A defunct process has ended. Without a state column, a watched process cannot be shown to have ended.
    if (listed(list) && !rowsOf(list).some(([id, , pgid, state]) => (found.has(Number(id)) || Number(pgid) === pid) && !state?.startsWith("Z"))) return "confirmed";
    await Bun.sleep(50);
  }
  return "unconfirmed";
}

/**
 * Windows ends the program's whole tree with taskkill, under its own deadline. Once the exit was reported the
 * program's number may already belong to someone else, so nothing is signalled by it and cleanup stays
 * unconfirmed: what still holds the output cannot be found. Only the program's own reported exit confirms it.
 */
async function stopWindows(child: Started, reported: () => boolean, end: number): Promise<Cleanup> {
  const pid = child.pid;
  if (pid === undefined || reported()) return "unconfirmed";
  const killed = await host.stopTree?.(pid, Math.max(100, Math.min(2_500 * SLOW, (end - Date.now()) / 2))) ?? false;
  // The handle stops the program itself even when taskkill failed or ran out of time.
  try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([child.exited.then(() => true, () => false), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, end - Date.now())); })]);
  clearTimeout(timer);
  return exited && killed ? "confirmed" : "unconfirmed";
}

export type GitOptions = Pick<CommandOptions, "cwd" | "env" | "input" | "timeoutMs" | "signal"> & {
  /** Keep Git's output exactly as written; by default it is trimmed. */
  raw?: boolean;
};

/** Git in the tests' private environment (`testGitEnv()` unless `env` is given), to its reported exit, whatever the code. */
export function runGit(args: readonly string[], options: GitOptions = {}): Promise<CommandResult> {
  return runCommand(["git", ...args], { ...options, env: options.env ?? testGitEnv() });
}

/** Git's output. A non-zero exit fails with everything Git said. */
export async function gitWith(options: GitOptions, ...args: string[]): Promise<string> {
  const result = await runGit(args, options);
  if (result.code !== 0) {
    const said = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new CommandFailure(`git ${args.join(" ")} failed (${result.signal ?? result.code}) in ${options.cwd ?? process.cwd()}:\n${said}`, "exit", result.stdout, result.stderr, "none", result.code, result.signal);
  }
  return options.raw ? result.stdout : result.stdout.trim();
}

/** Git's trimmed output in `cwd`. A non-zero exit fails with everything Git said. */
export const git = (cwd: string, ...args: string[]): Promise<string> => gitWith({ cwd }, ...args);

/**
 * The commit a ref names in a repository, or undefined only when Git confirms there is none: `rev-parse --verify
 * --quiet` exits 1 and says nothing. Every other answer, a broken repository or a failed command, fails.
 */
export async function commitAt(gitDir: string, ref: string, options: Pick<GitOptions, "env" | "timeoutMs"> = {}): Promise<string | undefined> {
  const args = ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
  const result = await runGit(args, options);
  if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return undefined;
  throw new CommandFailure(`git ${args.join(" ")} failed (${result.signal ?? result.code}):\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`, "exit", result.stdout, result.stderr, "none", result.code, result.signal);
}
