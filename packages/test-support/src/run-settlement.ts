import { CommandFailure, type CommandResult } from "./commands.js";
import type { ProcessOutcome } from "./run-process.js";

type CanonicalRun = CommandResult | ProcessOutcome;
export type RunObservation<T extends CanonicalRun> = { kind: "completed"; result: T; safeToDispose: true }
  | { kind: "rejected"; error: CommandFailure; safeToDispose: true }
  | { kind: "rejected"; error: unknown; safeToDispose: false };

/** Fulfillment is the canonical runner's reported exit and complete output, independently of exit code. */
export async function observeRun<T extends CanonicalRun>(effects: { run(): Promise<T> }): Promise<RunObservation<T>> {
  try { return { kind: "completed", result: await effects.run(), safeToDispose: true }; }
  catch (error) {
    return error instanceof CommandFailure && error.cleanup === "confirmed"
      ? { kind: "rejected", error, safeToDispose: true }
      : { kind: "rejected", error, safeToDispose: false };
  }
}

/** Shared disposal authority for actual canonical commands using one private test environment. */
export function runSettlements() {
  let pending = 0, uncertain = false;
  const safeToDispose = () => pending === 0 && !uncertain;
  return {
    get safeToDispose() { return safeToDispose(); },
    async observe<T extends CanonicalRun>(effects: { run(): Promise<T> }): Promise<RunObservation<T>> {
      // The effect may synchronously re-enter disposal before it returns a promise.
      pending++;
      try {
        const observation = await observeRun(effects);
        if (!observation.safeToDispose) uncertain = true;
        return observation;
      } finally { pending--; }
    },
    async dispose(owned: { close(): void | boolean | Promise<void | boolean> }): Promise<boolean> {
      if (!safeToDispose()) return false;
      return await owned.close() !== false;
    },
  };
}
export type RunSettlements = ReturnType<typeof runSettlements>;
