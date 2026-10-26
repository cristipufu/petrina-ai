// Native execution and durable output of a product's declared check commands.
import { createHash, randomUUID } from "node:crypto";
import { processHost } from "@petrina/platform/process-host";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import type { CheckExecution, CheckRun, ProductCheck } from "@petrina/core";
import { checkExecutionPassed, checkOutcome, commandText, staticCheck, tidyOutput, CHECK_EXIT_UNREPORTED } from "@petrina/core";
import { CLEANUP_INCOMPLETE, descendantsKnown, lostExit, waitForProcessesToEnd } from "@petrina/platform/process-tree";
import { livePowerRecords, machineInterruption, type MachineRecords } from "@petrina/platform/power-log";
import { checkOutputCapture, observeCheckExecutor } from "./check-environment.js";

/** Long enough for a full test suite or build, short enough that a hung one never holds a task. */
export const CHECK_TIMEOUT_MS = 20 * 60_000;
const OUTPUT_KEPT = 6000;
export type CheckProgress = { index: number; at: number } & ({ kind: "started" } | { kind: "finished"; run: CheckRun });

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
  // Where a failed check's sleep evidence comes from: the engine's own source. Absent, the Mac's power log.
  machineRecords: MachineRecords = livePowerRecords,
  onSpawn?: (pid: number) => void,
  onLog?: (facts: Pick<CheckRun, "logPath" | "logFileIdentity" | "logFileLength" | "logFileBeginning">) => void,
  // Extra runs recheck admission after log creation, immediately before synchronous spawn.
  beforeStart?: () => boolean,
): Promise<CheckRun[]> {
  if (signal?.aborted) return [];
  const ordered = checks.map((check, index) => ({ check, index })).filter(({ check }) => check.argv.length);
  const runs: CheckRun[] = [];
  // Commands share one working copy. Serial execution avoids output/cache races; static
  // failures return immediately without starting tests or builds that cannot prove a pass.
  for (const { check, index } of [...ordered.filter(({ check }) => staticCheck(check)), ...ordered.filter(({ check }) => !staticCheck(check))]) {
      if (signal?.aborted) break;
      const log = logDirectory ? await checkLog(logDirectory) : undefined;
      let admitted = true;
      try {
        admitted = beforeStart?.() ?? true;
        if (admitted && log) onLog?.(log.created);
      } catch (error) { await log?.close(); throw error; }
      if (!admitted) { await log?.close(); break; }
      const started = Date.now();
      onProgress?.({ kind: "started", index, at: started });
      const run = await runOne(check.argv, cwd, env, timeoutMs, signal, log, processList, onSpawn);
      const endedAt = Date.now();
      const result = { name: check.name, command: commandText(check.argv), startedAt: started, endedAt, ms: endedAt - started, ...await log?.close() };
      const output = [
        run.postStartError !== undefined ? [run.output, `Stopped after launch: ${run.postStartError}`, "The command outcome was not recorded."].filter(Boolean).join("\n")
          : run.error ? `Could not start: ${run.error}` : run.timedOut ? `${run.output}\nStopped after ${Math.round(timeoutMs / 60_000)} minutes without finishing.` : run.exitUnreported ? `${run.output}\n${CHECK_EXIT_UNREPORTED}` : run.output,
        ...(run.cleanupIncomplete ? [CLEANUP_INCOMPLETE] : []),
      ].filter(Boolean).join("\n");
      const finished: CheckRun = {
        ...result,
        ok: !signal?.aborted && checkExecutionPassed(run.execution), execution: run.execution,
        ...(run.executor !== undefined ? { executor: run.executor } : {}),
        ...(run.executorError !== undefined ? { executorError: run.executorError } : {}),
        ...(run.outputIdentityError !== undefined ? { outputIdentityError: run.outputIdentityError } : {}),
        ...(log ? { logComplete: run.outputComplete && !result.logError } : {}),
        ...(signal?.aborted || run.postStartError !== undefined ? { interrupted: true } : {}),
        ...(run.timedOut ? { timedOut: true } : {}),
        ...(run.exitSignal ? { exitSignal: run.exitSignal } : {}),
        ...(run.cleanupIncomplete ? { cleanupIncomplete: true } : {}),
        output: tidyOutput(output),
      };
      // Cancellation already explains an incomplete check. Do not delay stopping the task
      // with a power-log read; a stop during evidence collection cancels that read too.
      if (!finished.ok && !finished.interrupted) finished.interruption = await machineInterruption(started, endedAt, signal, machineRecords);
      if (signal?.aborted) finished.interrupted = true;
      const outcome = checkOutcome(finished);
      if (run.outputIdentity && (outcome.kind === "passed" || outcome.kind === "failed")) finished.outputIdentity = run.outputIdentity;
      onProgress?.({ kind: "finished", index, at: Date.now(), run: finished });
      runs.push(finished);
      if (!finished.ok && staticCheck(check)) break;
  }
  return runs;
}

interface CheckLog {
  created: Pick<CheckRun, "logPath" | "logFileIdentity" | "logFileLength" | "logFileBeginning">;
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
    return { created: {}, write: async () => {}, close: async () => ({ logError: String(error) }) };
  }
  const handle = file;
  const created = await handle.stat({ bigint: true });
  let pending = Promise.resolve();
  let logError: string | undefined;
  return {
    created: { logPath: path, logFileIdentity: { device: created.dev.toString(), inode: created.ino.toString() }, logFileLength: 0, logFileBeginning: createHash("sha256").update("").digest("hex") },
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
type NativeCheckResult = { code: number | null; output: string; timedOut: boolean; outputComplete: boolean; execution: CheckExecution; cleanupIncomplete?: boolean; exitUnreported?: boolean; exitSignal?: string; error?: string; postStartError?: string }
  & Pick<CheckRun, "executor" | "executorError" | "outputIdentity" | "outputIdentityError">;

function runOne(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal, log?: CheckLog, processList?: (timeout: number) => Promise<string | undefined>, onSpawn?: (pid: number) => void): Promise<NativeCheckResult> {
  return new Promise((resolve) => {
    const executor = observeCheckExecutor(), identity = checkOutputCapture();
    const windows = !processHost.groups;
    const execution: CheckExecution = { started: false, exit: { status: "unreported" }, stdout: "incomplete", stderr: "incomplete", timedOut: false, cancelled: false, cleanup: "not-requested", outputCleanup: "not-requested" };
    let kept = "", cut = false, settling = false, exitSeen = false, exitUnreported = false;
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let completion: Promise<number> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const watch = new AbortController();
    let stopping: Promise<boolean> | undefined;
    const pipes: { stream?: ReadableStream<Uint8Array>; reader?: ReadableStreamDefaultReader<Uint8Array>; errored?: boolean }[] = [{}, {}];
    const fields = ["stdout", "stderr"] as const;
    const message = (error: unknown) => error instanceof Error ? error.message : String(error);
    const stopWork = () => stopping ??= child ? stopAll(child, windows, processList).catch(() => false) : Promise.resolve(true);
    const closeOutput = async (): Promise<boolean> => {
      if (!child || fields.every(field => execution[field] === "eof")) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.all(pipes.map(async (pipe, index) => {
            if (execution[fields[index]!] === "eof") return true;
            try {
              if (pipe.reader) {
                // Only an error observed before this cancellation independently proves closure.
                // cancel() can close the logical reader and still fail to release its resource.
                const alreadyErrored = pipe.errored === true;
                try { await pipe.reader.cancel(); return true; }
                catch { return alreadyErrored; }
              }
              // A locked pipe is not owned by us and cancellation cannot prove it closed.
              if (pipe.stream) { await pipe.stream.cancel(); return true; }
            } catch { /* Unavailable output closure remains unconfirmed. */ }
            return false;
          })).then(closed => closed.every(Boolean)),
          new Promise<boolean>(done => { timer = setTimeout(() => done(false), 5_000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const finish = (code: number | null, error?: string, kind: NonNullable<CheckExecution["failure"]>["kind"] = "observer") => {
      if (settling) return;
      settling = true;
      if (error !== undefined) execution.failure ??= { kind: execution.started ? kind : "start", message: tidyOutput(error) };
      // Both reader and child ownership settle before this result can release the worktree.
      if (error !== undefined && child) stopWork();
      clearTimeout(timer); clearTimeout(grace); watch.abort();
      signal?.removeEventListener("abort", stop);
      const needsOutputCleanup = child !== undefined && !fields.every(field => execution[field] === "eof");
      void Promise.allSettled([stopping ?? Promise.resolve(true), closeOutput()]).then(([processes, output]) => {
        const clean = processes.status === "fulfilled" && processes.value;
        let closed = output.status === "fulfilled" && output.value;
        for (const pipe of pipes) try { pipe.reader?.releaseLock(); } catch { closed = false; }
        if (stopping) execution.cleanup = clean ? "confirmed" : "unconfirmed";
        if (needsOutputCleanup || !closed) execution.outputCleanup = closed ? "confirmed" : "unconfirmed";
        execution.cancelled ||= signal?.aborted ?? false;
        const exitSignal = execution.exit.signal;
        const afterLaunch = error !== undefined && execution.started;
        const facts = { ...execution, exit: { ...execution.exit }, ...(execution.failure ? { failure: { ...execution.failure } } : {}) };
        resolve({ code, execution: facts, ...executor, ...identity.finish(fields.every(field => execution[field] === "eof")), output: `${cut ? "…\n" : ""}${kept}`, timedOut: execution.timedOut,
          outputComplete: fields.every(field => execution[field] === "eof"),
          ...(exitSignal ? { exitSignal } : {}), ...(exitUnreported ? { exitUnreported: true } : {}),
          ...(!clean || !closed ? { cleanupIncomplete: true } : {}),
          ...(error !== undefined ? afterLaunch ? { postStartError: error } : { error } : {}),
        });
      });
    };
    const stop = () => {
      execution.cancelled ||= signal?.aborted ?? false;
      stopWork();
      grace ??= setTimeout(() => finish(null), 5000);
    };
    const timer = setTimeout(() => {
      execution.timedOut = true;
      stop();
    }, timeoutMs);
    const validExit = (code: number) => Number.isSafeInteger(code) && code >= 0;
    const observeExit = (code: number) => {
      exitSeen = true; watch.abort();
      const exitSignal = child?.signalCode;
      execution.exit = { status: validExit(code) ? "reported" : "invalid", ...(validExit(code) ? { code } : {}), ...(exitSignal ? { signal: exitSignal } : {}) };
      if (!validExit(code)) { finish(null, "The system reported an invalid check exit.", "exit"); return; }
      // A held pipe is incomplete execution, not a successful check with a shortened log.
      if (!settling) grace ??= setTimeout(() => finish(code, "The check exited before its output finished.", "output"), 5000);
    };
    let startupError: unknown, startFailed = false;
    try {
      child = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: !windows, windowsHide: true });
      execution.started = true;
      // Observe completion even when registration or acquiring an output reader fails.
      completion = child.exited;
      void completion.then(observeExit, error => {
        execution.exit = { status: "rejected" };
        finish(null, message(error), "exit");
      });
      onSpawn?.(child.pid);
    } catch (error) { startupError = error; startFailed = true; }
    // Acquire each pipe independently: failure on the first never leaves the second unowned.
    let readError: unknown, readFailed = false;
    if (child) for (const [index, field] of fields.entries()) {
      const pipe = pipes[index]!;
      try {
        pipe.stream = child[field];
        const reader = pipe.stream.getReader(); pipe.reader = reader;
        // Observe errors immediately, independently from a later cancellation attempt.
        pipe.errored = false;
        void reader.closed.then(() => undefined, () => { pipe.errored = true; });
      } catch (error) { execution[field] = "read-error"; if (!readFailed) readError = error; readFailed = true; }
    }
    if (startFailed || !child) { finish(null, message(startupError)); return; }
    if (readFailed) { finish(null, message(readError), "read"); return; }
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const keep = (text: string) => {
      kept += text;
      if (kept.length > OUTPUT_KEPT * 2) { kept = kept.slice(-OUTPUT_KEPT * 2); cut = true; }
    };
    const drain = async (index: number) => {
      const reader = pipes[index]!.reader!, field = fields[index]!, decoder = new TextDecoder();
      try {
        while (!settling) {
          const next = await reader.read();
          if (settling) break;
          if (next.done) { execution[field] = "eof"; break; }
          identity.add(field, next.value);
          keep(decoder.decode(next.value, { stream: true }));
          await log?.write(next.value);
        }
        if (!settling) keep(decoder.decode());
      } catch (error) {
        if (!settling) { execution[field] = "read-error"; finish(null, message(error), "read"); }
      }
    };
    const output = Promise.all([drain(0), drain(1)]);
    const pid = child.pid;
    void output.then(() => {
      if (settling || exitSeen || typeof pid !== "number") return;
      return lostExit(pid, watch.signal, processList).then(state => {
        if (state !== "lost" || settling || exitSeen) return;
        exitUnreported = true;
        execution.failure ??= { kind: "exit", message: CHECK_EXIT_UNREPORTED };
        stopping ??= stopAll(child!, windows, processList, true).catch(() => false);
        finish(null);
      });
    }, () => undefined);
    void Promise.all([completion!, output]).then(([code]) => {
      if (validExit(code)) finish(code);
    }, () => undefined);
  });
}

/** End a check and everything it started. `leaderEnded`: the check itself was observed gone or defunct, so only what it started is waited for. */
async function stopAll(child: Bun.Subprocess<"ignore", "pipe", "pipe">, windows: boolean, processList?: (timeout: number) => Promise<string | undefined>, leaderEnded = false): Promise<boolean> {
  const pid = child.pid;
  const collected = () => child.exitCode !== undefined && child.exitCode !== null || Boolean(child.signalCode);
  // Once collected, a saved PID/group is no longer stop authority. In particular, output held
  // by an unknown descendant after this exit cannot be turned into a confirmed tree cleanup.
  if (!pid || collected()) return false;
  if (windows) {
    return processHost.stopTree?.(pid, 3000) ?? false;
  }
  // Detached workers outlive both the check and its process group, so take a bounded snapshot
  // while the parent is still alive. Failure must remain distinguishable from an empty process tree.
  const workers = await descendantsKnown([pid], 3_200, processList);
  if (collected()) return false;
  // Detached workers first: killing the leader must not collect its identity before those signals.
  const targets = [...(workers ?? []).reverse(), -pid, pid];
  for (const target of targets.filter(target => target !== pid)) {
    if (collected()) return false;
    try { process.kill(target, "SIGKILL"); } catch { /* Already gone. */ }
  }
  if (!collected()) try { child.kill("SIGKILL"); } catch { /* An owned signal is not completion evidence. */ }
  // A signal being accepted does not mean the worker has exited. Keep the copy reserved until
  // the group and the captured detached workers are gone, or report that cleanup is incomplete.
  // A defunct leader and its group retain their numbers. Confirm every remaining member from
  // a complete state snapshot; accepting the signal or ignoring the leader alone proves too little.
  const stopped = await waitForProcessesToEnd(targets.filter((target) => !leaderEnded || target !== pid), 1_000);
  return workers !== undefined && stopped.ended;
}
