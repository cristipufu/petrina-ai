// Native execution and durable output of a product's declared check commands.
import { createHash, randomUUID } from "node:crypto";
import { processHost } from "@petrina/platform/process-host";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CheckRun, ProductCheck } from "@petrina/core";
import { commandText, staticCheck, tidyOutput, CHECK_EXIT_UNREPORTED } from "@petrina/core";
import { CLEANUP_INCOMPLETE, descendantsKnown, lostExit, waitForProcessesToEnd } from "@petrina/platform/process-tree";
import { livePowerRecords, machineInterruption, type MachineRecords } from "@petrina/platform/power-log";

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
        ok: !run.error && run.postStartError === undefined && !run.timedOut && !signal?.aborted && run.code === 0,
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
function runOne(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal, log?: CheckLog, processList?: (timeout: number) => Promise<string | undefined>, onSpawn?: (pid: number) => void): Promise<{ code: number | null; output: string; timedOut: boolean; outputComplete: boolean; cleanupIncomplete?: boolean; exitUnreported?: boolean; exitSignal?: string; error?: string; postStartError?: string }> {
  return new Promise((resolve) => {
    const windows = !processHost.groups;
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
      // A callback or observation can fail after spawn succeeded. That is owned work
      // with an unknown outcome: stop it before returning, preserving the actual error.
      const afterLaunch = error !== undefined && child !== undefined;
      if (afterLaunch) stopping ??= stopAll(child!.pid, windows, processList);
      clearTimeout(timer);
      clearTimeout(grace);
      watch.abort();
      signal?.removeEventListener("abort", stop);
      for (const reader of readers) void reader.cancel().catch(() => undefined);
      const result = { code, ...(child?.signalCode ? { exitSignal: child.signalCode } : {}), output: `${cut ? "…\n" : ""}${kept}`, timedOut, outputComplete, ...(exitUnreported ? { exitUnreported: true } : {}), ...(error !== undefined ? afterLaunch ? { postStartError: error } : { error } : {}) };
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
      onSpawn?.(child.pid);
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
    return processHost.stopTree?.(pid, 3000) ?? false;
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
  // A defunct leader and its group retain their numbers. Confirm every remaining member from
  // a complete state snapshot; accepting the signal or ignoring the leader alone proves too little.
  const stopped = await waitForProcessesToEnd(targets.filter((target) => !leaderEnded || target !== pid), 1_000);
  return workers !== undefined && stopped.ended;
}
