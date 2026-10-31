// Programs a test runs itself, Git above all: asynchronous, each under a deadline of its own, with bounded
// cleanup of everything it started. No Engine dependency: the stand-ins for GitHub and the agents use it too.
//
// A synchronous child call holds its whole test worker until the runtime reports the child's exit. Under load
// that report can be lost, and then no timer in the worker runs again: not the test's own deadline, not another
// test. Here every wait ends on a timer the worker schedules itself, and a command only succeeds once its exit
// is reported and its output is complete. Closed output alone proves nothing.
import type { ProcessListRead } from "@petrina/platform/process-tree";
import { CLEANUP_MS } from "./command-budgets.js";
import {
  host,
  readProcesses,
  startCommand,
  stopOwned,
  type Cleanup,
  type Start,
  type Started,
} from "./command-cleanup.js";
import { SLOW } from "./slow.js";
import { testGitEnv } from "./test-git-env.js";

export { CLEANUP_MS, startCommand };
export type { Cleanup, Start, Started };

/** Git's allowance per command; like the fixtures' other hang-catching limits, it stretches on a busy machine. */
export const GIT_TIMEOUT_MS = 30_000;

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
  /** A private starter for lifecycle adapters and their contract tests. */
  start?: Start;
  /** Runner tests only: a private stand-in for the system's process list. */
  processList?: ProcessListRead;
  /** Observe decoded output while the command runs. Callbacks stay synchronous. */
  onOutput?: (text: string, stream: "stdout" | "stderr") => undefined;
  /** Stream to onOutput without also retaining a second unbounded copy. Requires the observer. */
  retainOutput?: boolean;
  /** Capture and observe output, or inherit the caller's descriptors without buffering. Default: capture. */
  output?: "capture" | "inherit";
}

export interface CommandResult {
  /** The reported exit code; 128 plus the signal's number when a signal ended the program. */
  code: number;
  signal?: string;
  stdout: string;
  stderr: string;
  outputRetained?: false;
}

export type FailureReason = "start" | "timeout" | "cancelled" | "unreadable" | "exit";

/** Local observations only: timestamps do not establish when a process was born. */
export interface CommandExecutionSnapshot {
  readonly observedAt: number;
  readonly exitPromiseReported: boolean;
  readonly exitPromiseCode?: number;
  readonly untracked: boolean;
  /** Omitted when the native record is unavailable; null means it was observed without an end record. */
  readonly nativeExitCode?: number | null;
  readonly nativeSignalCode?: string | null;
  /** Omitted for streams the command did not capture. Cancellation never supplies an EOF observation. */
  readonly stdoutEOF?: boolean;
  readonly stderrEOF?: boolean;
}

/** Failure evidence, separate from the reported outcome and conservative cleanup decision. */
export interface CommandExecutionObservation {
  readonly pid?: number;
  readonly startedObservedAt: number;
  readonly atFailure: CommandExecutionSnapshot;
  readonly afterCleanup: CommandExecutionSnapshot;
}

/** A command that did not end with a reported successful exit and complete output. */
export class CommandFailure extends Error {
  declare readonly execution?: CommandExecutionObservation;
  constructor(
    message: string,
    readonly reason: FailureReason,
    readonly stdout = "",
    readonly stderr = "",
    readonly cleanup: Cleanup = "none",
    readonly code?: number,
    readonly signal?: string,
    execution?: CommandExecutionObservation,
  ) {
    super(message);
    this.name = "CommandFailure";
    if (execution !== undefined) this.execution = execution;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
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
  if (!(timeoutMs > 0 && timeoutMs <= 2_147_483_647)) {
    return Promise.reject(
      new RangeError(`${what} needs a deadline between 1 and 2147483647 ms, not ${timeoutMs}`),
    );
  }
  if (options.output !== undefined && options.output !== "capture" && options.output !== "inherit") {
    return Promise.reject(new RangeError(`${what} needs capture or inherit output`));
  }
  if (options.output === "inherit" && options.onOutput) {
    return Promise.reject(new RangeError(`${what} needs captured output for an output observer`));
  }
  if (options.retainOutput === false && !options.onOutput) {
    return Promise.reject(new RangeError(`${what} needs an output observer when output is not retained`));
  }
  if (options.signal?.aborted) {
    return Promise.reject(new CommandFailure(`${what} was cancelled before it started, in ${where}`, "cancelled"));
  }
  const windows = !host.groups;
  let child: Started;
  try {
    child = (options.start ?? startCommand)([...argv], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
      stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
      detached: host.ownedSpawn.detached,
      ...(options.output ? { output: options.output } : {}),
    });
  } catch (error) {
    return Promise.reject(new CommandFailure(`${what} could not start in ${where}: ${messageOf(error)}`, "start"));
  }
  const startedObservedAt = Date.now();
  let startedPid: number | undefined;
  try {
    startedPid = child.pid;
  } catch {
    /* Diagnostic ownership evidence is unavailable. */
  }
  return new Promise<CommandResult>((resolve, reject) => {
    const output = ["", ""];
    const streams = [child.stdout, child.stderr];
    const closed = streams.map((stream) => stream === undefined);
    let exit: number | undefined;
    // The runtime gave up on the program's exit: it no longer tracks it, so its number may be free.
    let untracked = false;
    let settled = false;
    const readers = streams.flatMap((stream, index) => (stream ? [{ reader: stream.getReader(), index }] : []));
    const observe = (): CommandExecutionSnapshot => {
      const observedAt = Date.now();
      let nativeExitCode: number | null | undefined;
      let nativeSignalCode: string | null | undefined;
      // Diagnostic reads must not change the failure when a runtime cannot supply its record.
      try {
        nativeExitCode = child.exitCode;
      } catch {
        /* Unavailable remains absent. */
      }
      try {
        nativeSignalCode = child.signalCode;
      } catch {
        /* Unavailable remains absent. */
      }
      return {
        observedAt,
        exitPromiseReported: exit !== undefined,
        ...(exit !== undefined ? { exitPromiseCode: exit } : {}),
        untracked,
        ...(nativeExitCode !== undefined ? { nativeExitCode } : {}),
        ...(nativeSignalCode !== undefined ? { nativeSignalCode } : {}),
        ...(streams[0] !== undefined ? { stdoutEOF: closed[0]! } : {}),
        ...(streams[1] !== undefined ? { stderrEOF: closed[1]! } : {}),
      };
    };
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    };
    const finish = () => {
      if (settled || exit === undefined || !closed.every(Boolean)) return;
      settle();
      resolve({
        code: exit,
        ...(child.signalCode ? { signal: child.signalCode } : {}),
        stdout: output[0]!,
        stderr: output[1]!,
        ...(options.retainOutput === false ? { outputRetained: false as const } : {}),
      });
    };
    const fail = (reason: FailureReason, detail: string) => {
      if (settled) return;
      const atFailure = observe();
      settle();
      const open = ["output", "error output"].filter((_, index) => !closed[index]);
      const seen =
        exit !== undefined
          ? `It exited with ${exit}${open.length ? `, but its ${open.join(" and ")} stayed open` : ""}.`
          : open.length || !readers.length
            ? "Its exit was never reported."
            : "Its output closed, but its exit was never reported.";
      // The output is still read while cleanup runs: its end shows that whatever held it has gone too. Whether the
      // exit was reported is read live: it can arrive meanwhile.
      // The native end record can arrive without the promise notification. It releases
      // ownership of the program number; it does not establish a successful outcome.
      const isReported = () =>
        exit !== undefined || untracked || child.exitCode != null || child.signalCode != null;
      void stopOwned(child, isReported, outputEnded, windows, options.processList ?? readProcesses).then((cleanup) => {
        const afterCleanup = observe();
        for (const { reader } of readers) void reader.cancel().catch(() => undefined);
        const stopped =
          cleanup === "confirmed"
            ? "Everything found that it started has stopped."
            : "Some of what it started may still be running.";
        const partial = [output[0], output[1]].filter(Boolean).join("\n");
        const message = `${what} ${detail}, in ${where}. ${seen} ${stopped}${partial ? `\n${partial}` : ""}`;
        const observation: CommandExecutionObservation = {
          ...(startedPid !== undefined ? { pid: startedPid } : {}),
          startedObservedAt,
          atFailure,
          afterCleanup,
        };
        reject(
          new CommandFailure(
            message,
            reason,
            output[0],
            output[1],
            cleanup,
            exit,
            child.signalCode ?? undefined,
            observation,
          ),
        );
      });
    };
    const cancel = () => fail("cancelled", "was cancelled");
    // The deadline is the worker's own timer: it fires whatever the program, its output or its exit report do.
    const timer = setTimeout(() => fail("timeout", `did not finish within ${seconds(timeoutMs)}`), timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    let ended = () => {};
    const outputEnded = new Promise<void>((resolveEnded) => {
      ended = resolveEnded;
    });
    if (closed.every(Boolean)) ended();
    readers.forEach(({ reader, index }) => {
      const decoder = new TextDecoder();
      void (async () => {
        const append = (text: string) => {
          if (options.retainOutput !== false) output[index] += text;
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
      })().catch((error) =>
        fail("unreadable", `could not have its ${index ? "error output" : "output"} read (${messageOf(error)})`),
      );
    });
    child.exited.then(
      (code) => {
        exit = code;
        finish();
      },
      (error) => {
        untracked = true;
        fail("unreadable", `could not have its exit read (${messageOf(error)})`);
      },
    );
    // A controlled starter can abort synchronously before the listener is attached. All
    // cleanup resources are initialized now; do not accept its result after that cancellation.
    if (options.signal?.aborted) cancel();
  });
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
    const where = options.cwd ?? process.cwd();
    throw new CommandFailure(
      `git ${args.join(" ")} failed (${result.signal ?? result.code}) in ${where}:\n${said}`,
      "exit",
      result.stdout,
      result.stderr,
      "none",
      result.code,
      result.signal,
    );
  }
  return options.raw ? result.stdout : result.stdout.trim();
}

/** Git's trimmed output in `cwd`. A non-zero exit fails with everything Git said. */
export const git = (cwd: string, ...args: string[]): Promise<string> => gitWith({ cwd }, ...args);

/**
 * The commit a ref names in a repository, or undefined only when Git confirms there is none: `rev-parse --verify
 * --quiet` exits 1 and says nothing. Every other answer, a broken repository or a failed command, fails.
 */
export async function commitAt(
  gitDir: string,
  ref: string,
  options: Pick<GitOptions, "env" | "timeoutMs"> = {},
): Promise<string | undefined> {
  const args = ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
  const result = await runGit(args, options);
  if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return undefined;
  const said = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new CommandFailure(
    `git ${args.join(" ")} failed (${result.signal ?? result.code}):\n${said}`,
    "exit",
    result.stdout,
    result.stderr,
    "none",
    result.code,
    result.signal,
  );
}
