import { parseDescendants } from "./process-snapshots.js";

/** One bounded observation; failure (including a thrown or rejected query) means unavailable. */
export type ProcessListRead = (timeout: number) => Promise<string | undefined>;
export type ProcessClock = () => number;
type SharedReads = { current?: { startedAt: number; result: Promise<string | undefined> }; next?: Promise<string | undefined> };

/** Failed inspection is unavailable evidence, whether the adapter throws now or rejects later. */
export async function readObservation(read: ProcessListRead, timeout: number): Promise<string | undefined> {
  try { return await read(timeout); } catch { return undefined; }
}

/** Observation policy consumes a clock and queries; it never reads the OS or schedules a timer. */
export class ProcessObservations {
  private readonly reads = new WeakMap<ProcessListRead, SharedReads>();
  constructor(private readonly now: ProcessClock) {}

  async descendantsKnown(roots: readonly number[], budget: number, read: ProcessListRead,
    attempts: readonly number[] = [1_000, 2_000], requirePaused = false): Promise<number[] | undefined> {
    const started = this.now();
    for (const attempt of attempts) {
      const left = budget - (this.now() - started);
      if (left < 50) break;
      const stdout = await readObservation(read, Math.min(attempt, left));
      if (stdout !== undefined && (!requirePaused || pausedOrGone(stdout, roots))) return parseDescendants(stdout, roots);
    }
    return undefined;
  }

  /** Join a current observation or queue one begun after an older observation finishes. */
  sharedRead(read: ProcessListRead, timeout: number, since: number): Promise<string | undefined> {
    let state = this.reads.get(read);
    if (!state) this.reads.set(read, (state = {}));
    const shared = state;
    const start = (): Promise<string | undefined> => {
      const startedAt = this.now();
      let accept!: (value: string | undefined) => void;
      const result: Promise<string | undefined> = new Promise<string | undefined>(resolve => { accept = resolve; })
        .finally(() => { if (shared.current?.result === result) shared.current = undefined; });
      // A native starter or observer can call back synchronously. Publish ownership first.
      shared.current = { startedAt, result };
      void readObservation(read, timeout).then(accept);
      return result;
    };
    if (!shared.current) return start();
    if (shared.current.startedAt >= since) return shared.current.result;
    shared.next ??= shared.current.result.then(() => {
      shared.next = undefined;
      return shared.current?.result ?? start();
    });
    return shared.next;
  }
}

export function pausedOrGone(stdout: string, pids: readonly number[]): boolean {
  for (const line of stdout.split("\n")) {
    const [pid, , state] = line.trim().split(/\s+/);
    if (pids.includes(Number(pid)) && !state?.startsWith("T") && !state?.startsWith("Z")) return false;
  }
  return true;
}
