import { execFile } from "node:child_process";

export const CLEANUP_INCOMPLETE = "Petrina could not confirm every child process stopped. Some may still be running.";

/** Descendants of these exact processes, captured before stopping their parents loses the relationship. */
export function descendants(roots: readonly number[], timeout = 4_000): Promise<number[] | undefined> {
  return readProcessList(timeout).then((stdout) => stdout === undefined ? undefined : parseDescendants(stdout, roots));
}

/** Retry failed or unconfirmed snapshots within a fixed budget. `undefined` means none was usable. */
export async function descendantsKnown(
  roots: readonly number[],
  budget = 3_200,
  read: (timeout: number) => Promise<string | undefined> = readProcessList,
  attempts: readonly number[] = [1_000, 2_000],
  requirePaused = false,
): Promise<number[] | undefined> {
  const started = Date.now();
  for (const attempt of attempts) {
    const left = budget - (Date.now() - started);
    if (left < 50) break;
    const stdout = await read(Math.min(attempt, left));
    if (stdout !== undefined && (!requirePaused || pausedOrGone(stdout, roots))) return parseDescendants(stdout, roots);
  }
  return undefined;
}

/** A delayed successful read is unsafe if any known owner could still fork when it was listed. */
function pausedOrGone(stdout: string, pids: readonly number[]): boolean {
  for (const line of stdout.split("\n")) {
    const [pid, , state] = line.trim().split(/\s+/);
    if (pids.includes(Number(pid)) && !state?.startsWith("T") && !state?.startsWith("Z")) return false;
  }
  return true;
}

/** Parse one successful `ps` snapshot. An empty list is a valid result. */
export function parseDescendants(stdout: string, roots: readonly number[]): number[] {
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length) for (const pid of children.get(queue.shift()!) ?? []) if (!found.has(pid)) found.add(pid), queue.push(pid);
  return [...found].filter((pid) => !roots.includes(pid));
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
  return new Promise<string | undefined>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile("ps", [...args], { timeout, ...(maxBuffer ? { maxBuffer } : {}), ...(env ? { env } : {}) }, (error, stdout) => {
      // Settle before cancelling the fallback, so nothing here can leave the read unsettled.
      resolve(error || child.stdout?.readableEnded === false ? undefined : stdout);
      clearTimeout(timer);
    });
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
      resolve(undefined);
    }, timeout + 100);
  }).catch(() => undefined); // A sandbox can reject the spawn synchronously.
}

/** A process-list read: the live one, or a test's stand-in. */
export type ProcessListRead = (timeout: number) => Promise<string | undefined>;

/** The read under way and the one queued behind it, per reader, so watchers asking together share them. */
type SharedReads = { current?: { startedAt: number; result: Promise<string | undefined> }; next?: Promise<string | undefined> };
const sharedReads = new WeakMap<ProcessListRead, SharedReads>();

/**
 * A process-list read shared among the watchers asking at once. Many commands can close their output
 * together (a parallel suite's Git reads, a batch of product checks), and under the load that delays exit
 * reports each would otherwise start its own helper at the same moment, on a machine already slow to start
 * programs. One read per reader runs at a time. A read that started at or after `since`, the moment the
 * asker's child was last known to exist, is joined; an older read in flight could predate that child and
 * show it gone, so such an asker waits for the next read, which starts once the current one ends.
 */
export function sharedRead(read: ProcessListRead, timeout: number, since: number): Promise<string | undefined> {
  let state = sharedReads.get(read);
  if (!state) sharedReads.set(read, (state = {}));
  const shared = state;
  const start = (): Promise<string | undefined> => {
    const startedAt = Date.now();
    const result: Promise<string | undefined> = read(timeout).catch(() => undefined).finally(() => { if (shared.current?.result === result) shared.current = undefined; });
    shared.current = { startedAt, result };
    return result;
  };
  if (!shared.current) return start();
  if (shared.current.startedAt >= since) return shared.current.result;
  shared.next ??= shared.current.result.then(() => { shared.next = undefined; return shared.current?.result ?? start(); });
  return shared.next;
}

/**
 * What the system says about a child whose exit the runtime has not reported: still `running`, `ended`
 * (gone, or defunct: finished but never collected), or `unknown` when the state could not be read.
 */
export type ChildState = "running" | "ended" | "unknown";

/** What one snapshot lists for a process: `running`, `finished` (defunct, not yet collected), `absent`, or `unknown`. */
export type ProcessState = "running" | "finished" | "absent" | "unknown";

/** One process's state from a process list snapshot. A complete list that lacks it says it is gone. */
export function parseProcessState(stdout: string, pid: number): ProcessState {
  for (const line of stdout.split("\n")) {
    const [id, , state] = line.trim().split(/\s+/);
    if (Number(id) !== pid) continue;
    // An older snapshot without a state column cannot tell a defunct process from a running one.
    return state === undefined ? "unknown" : state.startsWith("Z") ? "finished" : "running";
  }
  return "absent";
}

/** One child's state from a process list snapshot: gone and defunct both mean it ended. */
export function parseChildState(stdout: string, pid: number): ChildState {
  const state = parseProcessState(stdout, pid);
  return state === "finished" || state === "absent" ? "ended" : state;
}

/**
 * A bounded read of one child's state. Existence alone is no evidence: a defunct child still has its
 * number until the runtime collects it, so the process list's state column decides.
 */
export async function childState(pid: number, timeout = 3_000, read: ProcessListRead = readProcessList): Promise<ChildState> {
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return "ended"; }
  // Windows has no defunct processes: a child that still exists is running.
  if (process.platform === "win32") return "running";
  const stdout = await read(timeout);
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
    const stop = () => { clearTimeout(timer); resolve("stopped"); };
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
