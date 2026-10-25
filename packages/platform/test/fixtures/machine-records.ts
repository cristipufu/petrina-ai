import type { MachineRecords } from "../../src/machine-records.js";

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
