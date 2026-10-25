import { powerInterruption, type MachineInterruption } from "./power-interval.js";

export type MachineRecords = (signal?: AbortSignal) => Promise<string>;

/** One snapshot from a source. A failed read, or one that ends after a stop, is unavailable evidence. */
export async function readMachineRecords(source: MachineRecords, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return "";
  let records = "";
  try { records = await source(signal); } catch { /* Unavailable: it proves no cause. */ }
  return signal?.aborted ? "" : records;
}

export async function machineInterruption(startedAt: number | undefined, endedAt: number | undefined, signal: AbortSignal | undefined, source: MachineRecords): Promise<MachineInterruption | undefined> {
  if (startedAt === undefined || endedAt === undefined || signal?.aborted) return;
  return powerInterruption(startedAt, endedAt, await readMachineRecords(source, signal));
}
