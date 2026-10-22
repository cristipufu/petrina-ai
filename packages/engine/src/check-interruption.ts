import { execFile } from "node:child_process";
import type { CheckRun } from "@petrina/core";

/** Match recorded sleep intervals, never a timeout, idle gap or a Builder explanation. */
export function powerInterruption(startedAt: number | undefined, endedAt: number | undefined, records: string): CheckRun["interruption"] | undefined {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return;
  const events = records.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})\s+(Sleep|Wake|DarkWake)\s+(.+)$/);
    if (!match) return [];
    const at = Date.parse(match[1]!);
    return Number.isFinite(at) ? [{ at, kind: match[2]!, text: match[3]!.trim() }] : [];
  }).sort((a, b) => a.at - b.at);
  for (const [index, event] of events.entries()) {
    if (event.kind !== "Sleep" || !event.text.startsWith("Entering Sleep state")) continue;
    const seconds = event.text.match(/\b(\d+) secs\b/);
    const wake = events.slice(index + 1).find((entry) => entry.kind === "Wake" || entry.kind === "DarkWake");
    const end = seconds ? event.at + Number(seconds[1]) * 1000 : wake?.at;
    if (end !== undefined && end > event.at && event.at < endedAt && end > startedAt) return { source: "macOS power log", at: event.at, event: event.text.slice(0, 400) };
  }
}

/**
 * Where an engine or a check run gets the machine's sleep records: the raw records, or "" when they are
 * unavailable. The caller's stop signal cancels the read. Production uses the installed Mac power log.
 */
export type MachineRecords = (signal?: AbortSignal) => Promise<string>;

type PowerLogCommand = (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean; signal?: AbortSignal }, done: (error: Error | null, stdout: string) => void) => unknown;

/** Bounded read-only use of the installed Mac power log; unavailable records prove no cause. */
export async function readMachinePowerRecords(execute: PowerLogCommand = execFile, platform = process.platform, signal?: AbortSignal): Promise<string> {
  if (platform !== "darwin" || signal?.aborted) return "";
  // Busy Macs can take over ten seconds to read the log. This is evidence collection,
  // not a readiness probe; allow it to finish before deciding whether repair is appropriate.
  return new Promise<string>((resolve) => execute("/usr/bin/pmset", ["-g", "log"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal }, (error, stdout) => resolve(error || signal?.aborted ? "" : stdout)));
}

/** Production's source. A test that needs this Mac's own records passes it explicitly. */
export const livePowerRecords: MachineRecords =(signal) => readMachinePowerRecords(execFile, process.platform, signal);

/** One snapshot from a source. A failed read, or one that ends after a stop, is unavailable evidence. */
export async function readMachineRecords(source: MachineRecords, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return "";
  let records = "";
  try { records = await source(signal); } catch { /* Unavailable: it proves no cause. */ }
  return signal?.aborted ? "" : records;
}

export async function machineInterruption(startedAt?: number, endedAt?: number, signal?: AbortSignal, source: MachineRecords = livePowerRecords): Promise<CheckRun["interruption"] | undefined> {
  if (startedAt === undefined || endedAt === undefined || signal?.aborted) return;
  return powerInterruption(startedAt, endedAt, await readMachineRecords(source, signal));
}
