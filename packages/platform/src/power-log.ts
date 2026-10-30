import { execFile } from "node:child_process";
import { machineInterruption as observeInterruption, type MachineRecords } from "./machine-records.js";

export { powerInterruption } from "./power-interval.js";
export { readMachineRecords, type MachineRecords } from "./machine-records.js";

type PowerLogCommand = (file: string, args: readonly string[], options: {
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  signal?: AbortSignal
}, done: (error: Error | null, stdout: string) => void) => unknown;

/** Bounded read-only use of the installed Mac power log; unavailable records prove no cause. */
export async function readMachinePowerRecords(execute: PowerLogCommand = execFile, platform = process.platform, signal?: AbortSignal): Promise<string> {
  if (platform !== "darwin" || signal?.aborted) return "";
  // Busy Macs can take over ten seconds to read the log. This is evidence collection,
  // not a readiness probe; allow it to finish before deciding whether repair is appropriate.
  return new Promise<string>((resolve) => execute(
    "/usr/bin/pmset",
    [
    "-g",
    "log"
  ],
    {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    signal
  },
    (
    error,
    stdout
  ) => resolve(error || signal?.aborted ? "" : stdout)
  ));
}

/** Production's source. A test that needs this Mac's own records passes it explicitly. */
export const livePowerRecords: MachineRecords =(signal) => readMachinePowerRecords(execFile, process.platform, signal);


/** Native default source; the portable policy always receives its source explicitly. */
export function machineInterruption(startedAt?: number, endedAt?: number, signal?: AbortSignal, source: MachineRecords = livePowerRecords) {
  return observeInterruption(startedAt, endedAt, signal, source);
}
