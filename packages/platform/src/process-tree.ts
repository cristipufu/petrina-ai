import { confirmStoppedProcesses } from "./agent-stop.js";
import { ProcessObservations, readObservation, type ProcessListRead } from "./process-observations.js";
import { stoppedProcessStates, parseDescendants, parseChildState, type ChildState, type ObservedProcess } from "./process-snapshots.js";
export { parseDescendants, parseChildState, parseProcessState, type ChildState, type ProcessState, type ObservedProcess } from "./process-snapshots.js";
export type { ProcessListRead } from "./process-observations.js";
import { execFile } from "node:child_process";

export { CLEANUP_INCOMPLETE } from "./process-snapshots.js";

/** Descendants of these exact processes, captured before stopping their parents loses the relationship. */
export function descendants(roots: readonly number[], timeout = 4_000): Promise<number[] | undefined> {
  return readProcessList(timeout).then((stdout) => stdout === undefined ? undefined : parseDescendants(stdout, roots));
}

/** Retry failed or unconfirmed snapshots within a fixed budget. `undefined` means none was usable. */
export function descendantsKnown(roots: readonly number[], budget = 3_200, read: ProcessListRead = readProcessList,
  attempts: readonly number[] = [1_000, 2_000], requirePaused = false): Promise<number[] | undefined> {
  return observations.descendantsKnown(roots, budget, read, attempts, requirePaused);
}

/** Every process with its parent and its state, so one read serves both descendants and a child's state. */
export function readProcessList(timeout: number): Promise<string | undefined> {
  return processList(["-A", "-o", "pid=,ppid=,stat="], timeout);
}

/**
 * One `ps` read that always settles by its deadline. The runtime's own timeout only signals the helper;
 * its callback still waits for an exit the system may never report: under load a finished child can
 * stay defunct with its exit lost, and a stop sequence waiting on that read would never end. An own
 * timer resolves the read as failed at the deadline and kills the helper, whatever the runtime reports.
 * A list counts only once its output ended: at its own timeout the runtime closes the output before
 * signalling, and a helper that still exits cleanly is reported as a success with its list cut short.
 */
export function processList(args: readonly string[], timeout: number, maxBuffer?: number, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  const budget = Math.ceil(timeout);
  return new Promise<string | undefined>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile("ps", [...args], { timeout: budget, ...(maxBuffer ? { maxBuffer } : {}), ...(env ? { env } : {}) }, (error, stdout) => {
      // Settle before cancelling the fallback, so nothing here can leave the read unsettled.
      resolve(error || child.stdout?.readableEnded === false ? undefined : stdout);
      clearTimeout(timer);
    });
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
      resolve(undefined);
    }, budget + 100);
  }).catch(() => undefined); // A sandbox can reject the spawn synchronously.
}

const WINDOWS_COMMAND_LIST = [
  "$PSModuleAutoLoadingPreference='None'",
  "$ErrorActionPreference='Stop'",
  "foreach ($p in ([wmisearcher]'SELECT ProcessId,ParentProcessId,CommandLine FROM Win32_Process').Get()) "
    + "{ [string]$p.ProcessId + ' ' + [string]$p.ParentProcessId + ' R ' + ([string]$p.CommandLine -replace '[\\r\\n]+',' ') }",
].join("; ");

/** Every running process on Windows with its command line, formatted for folder-scoped snapshots. */
export function windowsCommandList(timeout = 10_000, maxBuffer = 32 * 1024 * 1024): Promise<string | undefined> {
  const budget = Math.ceil(timeout);
  return new Promise<string | undefined>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_COMMAND_LIST],
      { timeout: budget, maxBuffer, windowsHide: true },
      (error, stdout) => {
        resolve(error || child.stdout?.readableEnded === false ? undefined : stdout);
        clearTimeout(timer);
      },
    );
    try { child.stdin?.end(); } catch { /* Stand-in handle without an open input pipe. */ }
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
      resolve(undefined);
    }, budget + 100);
  }).catch(() => undefined);
}

const observations = new ProcessObservations(() => Date.now());

/** Share only a snapshot started after the request's last known child observation. */
export function sharedRead(read: ProcessListRead, timeout: number, since: number): Promise<string | undefined> {
  return observations.sharedRead(read, timeout, since);
}

/** Every process with its group and state, for confirming a forced stop including defunct members. */
export const readProcessGroups: ProcessListRead = (timeout) => processList(["-A", "-o", "pid=,pgid=,stat="], timeout);

/** Interpret a final snapshot relative to the native process making this observation. */
export function presentStates(list: string | undefined, present: readonly number[]): { ended: boolean; processes: ObservedProcess[] } {
  return stoppedProcessStates(list, present, process.pid);
}

/**
 * Wait within the existing stop allowance. Existence alone cannot distinguish a zombie group from
 * running work; obtain one bounded group snapshot while waiting. Silence or failed inspection is
 * never proof that a target still answering to a signal has ended.
 */
export async function waitForProcessesToEnd(targets: readonly number[], ms: number, read: ProcessListRead = readProcessGroups): Promise<{
  ended: boolean;
  processes: ObservedProcess[]
}> {
  return confirmStoppedProcesses(targets, ms, {
    now: () => Date.now(), sleep: ms => Bun.sleep(ms), selfPid: process.pid,
    possiblyPresent(target) {
      try {
        process.kill(target, 0);
        return true;
      }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    },
    readGroups: timeout => read(timeout),
  });
}

/**
 * A bounded read of one child's state. Existence alone is no evidence: a defunct child still has its
 * number until the runtime collects it, so the process list's state column decides.
 */
export async function childState(pid: number, timeout = 3_000, read: ProcessListRead = readProcessList): Promise<ChildState> {
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return "ended"; }
  // Windows has no defunct processes: a child that still exists is running.
  if (process.platform === "win32") return "running";
  const stdout = await readObservation(read, timeout);
  return stdout === undefined ? "unknown" : parseChildState(stdout, pid);
}

/** How long a child observed gone or defunct may still get its exit reported before the exit counts as lost. */
export const EXIT_GRACE_MS = 5_000;
/** The first state read waits this long after the output closed: an ordinary exit is reported within moments of it. */
export const EXIT_POLL_MS = 1_000;
/** Later reads back off to this interval while the child keeps running without its pipes. */
export const EXIT_POLL_MAX_MS = 8_000;
const STATE_READ_MS = 3_000;

/**
 * Watch a child whose exit the runtime has not reported. Closed pipes prove
 * nothing by themselves: a valid command can close or redirect its output and keep working inside its
 * allowance. Bounded state reads decide: a child still running is left alone and read again later, one
 * whose state cannot be read gets the benefit of the doubt, and one observed gone or defunct is given a
 * short grace for the exit to arrive, after which the watch resolves `lost`. Under load the runtime can
 * drop a child's exit, leaving it defunct forever; this is the only way such a wait ends. Aborting the
 * signal (the exit arrived, or the deadline did) ends the watch as `stopped` and clears its timers.
 * Watches share their reads: however many children close their output together, one helper runs at a time.
 */
export function lostExit(pid: number, signal: AbortSignal, read: ProcessListRead = readProcessList): Promise<"lost" | "stopped"> {
  return new Promise((resolve) => {
    // A read started before this watch could predate the child: only join observations started from here on.
    const since = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      resolve("stopped");
    };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    const pause = (ms: number) => new Promise<void>((wake) => { timer = setTimeout(wake, ms); });
    void (async () => {
      let delay = EXIT_POLL_MS;
      while (!signal.aborted) {
        await pause(delay);
        if (signal.aborted) return;
        const state = await childState(pid, STATE_READ_MS, (timeout) => sharedRead(read, timeout, since));
        if (signal.aborted) return;
        if (state === "ended") {
          await pause(EXIT_GRACE_MS);
          if (signal.aborted) return;
          signal.removeEventListener("abort", stop);
          resolve("lost");
          return;
        }
        delay = Math.min(delay * 2, EXIT_POLL_MAX_MS);
      }
    })();
  });
}
