// A product's checks: the commands that prove it works (type check, lint, tests, build). Petrina
// runs them itself, so "the tests pass" is evidence, never an agent's word. Commands are argument
// arrays, never a shell, and they run in the task's working copy without credentials.

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CheckRun, ProductCheck } from "@petrina/core";
import { CLEANUP_INCOMPLETE, descendantsKnown, lostExit } from "./process-tree.js";
import { machineInterruption } from "./check-interruption.js";

/** Long enough for a full test suite or build, short enough that a hung one never holds a task. */
export const CHECK_TIMEOUT_MS = 20 * 60_000;
const OUTPUT_KEPT = 6000;
export const CHECK_EXIT_UNREPORTED = "The check ended, but the system did not report its exit, so whether it passed is unknown.";

/** The scripts that usually prove a JavaScript project works, in the order they are worth running. */
const SCRIPTS: readonly [string, string][] = [
  ["typecheck", "Type check"],
  ["check-types", "Type check"],
  ["lint", "Lint"],
  ["test", "Tests"],
  ["build", "Build"],
];

function packageManager(root: string): string {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Suggest checks from what the repository already declares. The coordinator can change them. */
export function detectChecks(root: string): ProductCheck[] {
  const checks: ProductCheck[] = [];
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const pm = packageManager(root);
      const seen = new Set<string>();
      for (const [script, name] of SCRIPTS) {
        if (typeof scripts[script] !== "string" || seen.has(name)) continue;
        // npm's placeholder test script fails on purpose: it proves nothing.
        if (script === "test" && /no test specified/i.test(String(scripts[script]))) continue;
        seen.add(name);
        checks.push({ name, argv: [pm, "run", script] });
      }
    } catch {
      // An unreadable package.json suggests nothing.
    }
  }
  if (existsSync(join(root, "Cargo.toml"))) checks.push({ name: "Rust tests", argv: ["cargo", "test"] });
  if (existsSync(join(root, "go.mod"))) checks.push({ name: "Go vet", argv: ["go", "vet", "./..."] }, { name: "Go tests", argv: ["go", "test", "./..."] });
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) checks.push({ name: "Python tests", argv: ["python3", "-m", "pytest", "-q"] });
  return checks;
}

/** Plain text for the window: no colour codes, only the end of long output. */
export function tidyOutput(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal colour codes
  const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
  return plain.length > OUTPUT_KEPT ? `…\n${plain.slice(-OUTPUT_KEPT)}` : plain;
}

export function commandText(argv: readonly string[]): string {
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

/** Split a command the coordinator typed into arguments, honouring quotes. Never run through a shell. */
export function parseCommand(text: string): string[] {
  const argv: string[] = [];
  let word = "";
  let quote: string | undefined;
  let inWord = false;
  for (const ch of text.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) argv.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) argv.push(word);
  return argv;
}

/**
 * Run the checks side by side, so the wait is the slowest check rather than the sum of them, and
 * report what really happened, in the order given. Stopping the task stops every check.
 */
export type CheckProgress = { index: number; at: number } & ({ kind: "started" } | { kind: "finished"; run: CheckRun });

/** Recognise conventional static commands; opaque commands keep their declared order. */
export function staticCheck(check: ProductCheck): boolean {
  return /^(?:type[ -]?check|lint)(?:\s|$)/i.test(check.name)
    || check.argv.some((arg) => /^(?:typecheck|type-check|lint|eslint|biome|clippy|mypy|pyright)$/.test(arg))
    || (check.argv.some((arg) => /(?:^|[\\/])tsc(?:\.cmd)?$/.test(arg)) && check.argv.includes("--noEmit"));
}

export function orderedChecks(checks: readonly ProductCheck[]): ProductCheck[] {
  const commands = checks.filter((check) => check.argv.length);
  return [...commands.filter(staticCheck), ...commands.filter((check) => !staticCheck(check))];
}

/** An early static failure is complete failing evidence; skipped work never counts as a pass. */
export function expectedCheckCommands(checks: readonly ProductCheck[], results: readonly CheckRun[]): string[] {
  const ordered = orderedChecks(checks);
  const failed = ordered.findIndex((check) => staticCheck(check) && results.some((run) => !run.ok && run.command === commandText(check.argv)));
  return (failed < 0 ? ordered : ordered.slice(0, failed + 1)).map((check) => commandText(check.argv));
}

export async function runChecks(
  cwd: string,
  checks: readonly ProductCheck[],
  env: NodeJS.ProcessEnv,
  timeoutMs = CHECK_TIMEOUT_MS,
  signal?: AbortSignal,
  logDirectory?: string,
  // A stand-in process list, so a test can fail one read. Absent, the live list is read.
  processList?: (timeout: number) => Promise<string | undefined>,
  onProgress?: (event: CheckProgress) => void,
): Promise<CheckRun[]> {
  if (signal?.aborted) return [];
  const ordered = checks.map((check, index) => ({ check, index })).filter(({ check }) => check.argv.length);
  const runs: CheckRun[] = [];
  // Commands share one working copy. Serial execution avoids output/cache races; static
  // failures return immediately without starting tests or builds that cannot prove a pass.
  for (const { check, index } of [...ordered.filter(({ check }) => staticCheck(check)), ...ordered.filter(({ check }) => !staticCheck(check))]) {
      if (signal?.aborted) break;
      const log = logDirectory ? await checkLog(logDirectory) : undefined;
      const started = Date.now();
      onProgress?.({ kind: "started", index, at: started });
      const run = await runOne(check.argv, cwd, env, timeoutMs, signal, log, processList);
      const endedAt = Date.now();
      const result = { name: check.name, command: commandText(check.argv), startedAt: started, endedAt, ms: endedAt - started, ...await log?.close() };
      const output = [
        run.error ? `Could not start: ${run.error}` : run.timedOut ? `${run.output}\nStopped after ${Math.round(timeoutMs / 60_000)} minutes without finishing.` : run.exitUnreported ? `${run.output}\n${CHECK_EXIT_UNREPORTED}` : run.output,
        ...(run.cleanupIncomplete ? [CLEANUP_INCOMPLETE] : []),
      ].filter(Boolean).join("\n");
      const finished: CheckRun = {
        ...result,
        ok: !run.error && !run.timedOut && !signal?.aborted && run.code === 0,
        ...(log ? { logComplete: run.outputComplete && !result.logError } : {}),
        ...(signal?.aborted ? { interrupted: true } : {}),
        ...(run.timedOut ? { timedOut: true } : {}),
        ...(run.cleanupIncomplete ? { cleanupIncomplete: true } : {}),
        output: tidyOutput(output),
      };
      // Cancellation already explains an incomplete check. Do not delay stopping the task
      // with a power-log read; a stop during evidence collection cancels that read too.
      if (!finished.ok && !finished.interrupted) finished.interruption = await machineInterruption(started, endedAt, signal);
      if (signal?.aborted) finished.interrupted = true;
      onProgress?.({ kind: "finished", index, at: Date.now(), run: finished });
      runs.push(finished);
      if (!finished.ok && staticCheck(check)) break;
  }
  return runs;
}

interface CheckLog {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<Pick<CheckRun, "logPath" | "logFileIdentity" | "logFileLength" | "logFileBeginning" | "logError">>;
}

/** How much of a check log its recorded fingerprint covers: bounded recognition, not every later byte. */
const CHECK_LOG_BEGINNING = 4096;

/** SHA-256 of the first bytes of an opened log (the whole file when shorter), read by position. */
export async function checkLogBeginning(file: FileHandle, size: number): Promise<string> {
  const buffer = Buffer.alloc(Math.min(size, CHECK_LOG_BEGINNING));
  for (let filled = 0; filled < buffer.length;) {
    const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, filled);
    if (!bytesRead) throw new Error("The diagnostic ended before its recorded length.");
    filled += bytesRead;
  }
  return createHash("sha256").update(buffer).digest("hex");
}

/** Stream all output to disk; at most one chunk from each pipe waits in memory. */
async function checkLog(directory: string): Promise<CheckLog> {
  let file;
  const path = join(resolve(directory), `${Date.now()}-${randomUUID()}.log`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Exclusive and private. Read access lets close() fingerprint this same file.
    file = await open(path, "wx+", 0o600);
  } catch (error) {
    return { write: async () => {}, close: async () => ({ logError: String(error) }) };
  }
  const handle = file;
  let pending = Promise.resolve();
  let logError: string | undefined;
  return {
    write(bytes) {
      // stdout and stderr share one file position. Serialize writes and apply backpressure
      // to their readers, rather than collecting an unbounded queue of output in memory.
      pending = pending.then(async () => { if (!logError) await handle.writeFile(bytes); }).catch((error) => { logError ??= String(error); });
      return pending;
    },
    async close() {
      await pending;
      let facts: Pick<CheckRun, "logFileIdentity" | "logFileLength" | "logFileBeginning"> = {};
      try {
        const info = await handle.stat({ bigint: true });
        if (info.isFile()) {
          facts = { logFileIdentity: { device: info.dev.toString(), inode: info.ino.toString() } };
          // A freed file number can be reused, so readers also recognise the settled length and beginning.
          const length = Number(info.size);
          facts = { ...facts, logFileLength: length, logFileBeginning: await checkLogBeginning(handle, length) };
        } else logError ??= "The diagnostic is not a regular file.";
      } catch (error) {
        logError ??= String(error);
      }
      try { await handle.close(); } catch (error) { logError ??= String(error); }
      return { logPath: path, ...facts, ...(logError ? { logError } : {}) };
    },
  };
}

/**
 * One command, with only the end of its output kept while it runs, so a noisy check never fills
 * memory. It gets a process group of its own: a timeout or a stopped task ends everything it started.
 */
function runOne(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal, log?: CheckLog, processList?: (timeout: number) => Promise<string | undefined>): Promise<{ code: number | null; output: string; timedOut: boolean; outputComplete: boolean; cleanupIncomplete?: boolean; exitUnreported?: boolean; error?: string }> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    let kept = "";
    let cut = false;
    let timedOut = false;
    let done = false;
    let outputComplete = false;
    let exitSeen = false;
    let exitUnreported = false;
    let endedPipes = 0;
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // Ends the watch for a lost exit once the exit is reported or the check is settled.
    const watch = new AbortController();
    let stopping: Promise<boolean> | undefined;
    const readers: { cancel(): Promise<void> }[] = [];
    const finish = (code: number | null, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      watch.abort();
      signal?.removeEventListener("abort", stop);
      for (const reader of readers) void reader.cancel().catch(() => undefined);
      const result = { code, output: `${cut ? "…\n" : ""}${kept}`, timedOut, outputComplete, ...(exitUnreported ? { exitUnreported: true } : {}), ...(error ? { error } : {}) };
      // The parent can exit before detached workers. Do not release the working copy until their stop settles.
      void (stopping ?? Promise.resolve(true)).then((clean) => resolve({ ...result, ...(!clean ? { cleanupIncomplete: true } : {}) }));
    };
    const stop = () => {
      stopping ??= stopAll(child?.pid, windows, processList);
      grace ??= setTimeout(() => finish(null), 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      // Out of time, it is settled a moment later whatever the process reports, so one check never holds the rest.
      grace ??= setTimeout(() => finish(null), 5000);
    }, timeoutMs);
    try {
      child = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: !windows, windowsHide: true });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const keep = (text: string) => {
      kept += text;
      if (kept.length > OUTPUT_KEPT * 2) {
        kept = kept.slice(-OUTPUT_KEPT * 2);
        cut = true;
      }
    };
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      readers.push(reader);
      try {
        while (!done) {
          const next = await reader.read();
          if (next.done) endedPipes += 1;
          if (next.done || done) break;
          keep(decoder.decode(next.value, { stream: true }));
          await log?.write(next.value);
        }
        if (!done) keep(decoder.decode());
      } catch {
        // A timeout or stop closes the pipes too.
      } finally {
        reader.releaseLock();
      }
    };
    // Bun can emit node:child_process exit/close inside spawn(), losing both the result and buffered output.
    // Its native handle retains the exit promise and stream bytes even when the command has already ended.
    const output = Promise.all([drain(child.stdout), drain(child.stderr)]).then(() => { outputComplete = endedPipes === 2; });
    // A background program can keep the pipes open after the check exits: don't wait on it for long.
    void child.exited.then((code) => {
      exitSeen = true;
      watch.abort();
      if (!done) grace ??= setTimeout(() => finish(code), 5000);
    }, () => undefined);
    // The mirror case: the output closed, but under load the system may never report the exit. Closed
    // output alone proves nothing (a check can redirect its output and keep working within its deadline),
    // so bounded state reads watch the child: only one observed gone or defunct without a reported exit
    // settles as unknown, instead of holding until its deadline. A still-running check keeps its allowance.
    const pid = child.pid;
    void output.then(() => {
      // A child without a process number (a test stand-in that already ended) has no state to read.
      if (done || exitSeen || typeof pid !== "number") return;
      return lostExit(pid, watch.signal, processList).then((state) => {
        if (state !== "lost" || done || exitSeen) return;
        exitUnreported = true;
        // The check itself is gone or defunct: stop what it started, without waiting on the defunct leader.
        stopping ??= stopAll(pid, windows, processList, true);
        finish(null);
      });
    }, () => undefined);
    void Promise.all([child.exited, output]).then(
      ([code]) => finish(code),
      (error) => finish(null, error instanceof Error ? error.message : String(error)),
    );
  });
}

/** End a check and everything it started. `leaderEnded`: the check itself was observed gone or defunct, so only what it started is waited for. */
async function stopAll(pid: number | undefined, windows: boolean, processList?: (timeout: number) => Promise<string | undefined>, leaderEnded = false): Promise<boolean> {
  if (!pid) return true;
  if (windows) {
    return new Promise<boolean>((resolve) => execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, (error) => resolve(!error)));
  }
  // Detached workers outlive both the check and its process group, so take a bounded snapshot
  // while the parent is still alive. Failure must remain distinguishable from an empty process tree.
  const workers = await descendantsKnown([pid], 3_200, processList);
  const targets = [-pid, ...(workers ?? []).reverse(), pid];
  for (const target of targets) {
    try { process.kill(target, "SIGKILL"); } catch { /* Already gone. */ }
  }
  // A signal being accepted does not mean the worker has exited. Keep the copy reserved until
  // the group and the captured detached workers are gone, or report that cleanup is incomplete.
  // A defunct leader keeps its number until the runtime collects it: it is not a running process.
  const alive = () => targets.filter((target) => !leaderEnded || target !== pid).some((target) => {
    try { process.kill(target, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  });
  for (const end = Date.now() + 1_000; alive() && Date.now() < end;) await Bun.sleep(20);
  return workers !== undefined && !alive();
}

/** Whether two sets of checks run the same commands (names and reasons aside). */
export function sameCommands(a: readonly ProductCheck[], b: readonly ProductCheck[]): boolean {
  return a.length === b.length && a.every((check, index) => commandText(check.argv) === commandText(b[index]!.argv));
}

/** How many sets of CI and build files a product remembers the checks for. */
export const CHECKS_SEEN = 6;

/** The checks for a working copy: the coordinator's, else those found for its CI and build files, else the latest found. */
export function checksFor(product: { checks?: readonly ProductCheck[]; checksBy?: string; checksSeen?: readonly { fingerprint: string; checks: readonly ProductCheck[] }[] }, root: string): readonly ProductCheck[] {
  if (product.checksBy === "coordinator") return product.checks ?? [];
  const fingerprint = checksFingerprint(root);
  return product.checksSeen?.find((entry) => entry.fingerprint === fingerprint)?.checks ?? product.checks ?? [];
}

/** The files a product's checks come from: CI workflows and build files at the root. */
const CI_FOLDERS = [".github/workflows", ".gitlab", ".circleci", ".azure-pipelines"];
const BUILD_FILE = /^(package\.json|bun\.lockb?|Cargo\.toml|go\.mod|pyproject\.toml|pytest\.ini|setup\.cfg|Package\.swift|Makefile|Justfile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|global\.json|Directory\.Build\.props|.+\.sln|.+\.csproj|.+\.fsproj|azure-pipelines\.ya?ml|\.gitlab-ci\.ya?ml|turbo\.json|nx\.json)$/;

/** A fingerprint of what the Check finder bases its answer on. It changes when CI or build files do. */
export function checksFingerprint(root: string): string {
  const hash = createHash("sha256");
  const add = (path: string, name: string) => {
    try {
      if (statSync(path).isFile()) hash.update(`${name}\0`).update(readFileSync(path)).update("\0");
    } catch {
      // Gone or unreadable: it simply doesn't count.
    }
  };
  let entries: string[] = [];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return "";
  }
  for (const name of entries) if (BUILD_FILE.test(name)) add(join(root, name), name);
  for (const folder of CI_FOLDERS) {
    try {
      for (const name of readdirSync(join(root, folder)).sort()) add(join(root, folder, name), `${folder}/${name}`);
    } catch {
      // No such folder.
    }
  }
  return hash.digest("hex").slice(0, 16);
}
