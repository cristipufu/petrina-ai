import { runChecks as nativeChecks } from "../../src/check-runner.js";
import { checkCommandOutcome as outcome, type CheckRun } from "@petrina/core";
export { powerLogSleep, heldMachineRecords } from "../../../platform/test/fixtures/machine-records.js";
export const checkCommandOutcome = (run?: CheckRun) => outcome(run);
/** Ordinary checks never query this host's power history. */
export function runChecks(...[cwd, checks, env, timeoutMs, signal, logs, processes, progress, records = async () => "", ...callbacks]: Parameters<typeof nativeChecks>): ReturnType<typeof nativeChecks> {
 return nativeChecks(cwd, checks, env, timeoutMs, signal, logs, processes, progress, records, ...callbacks);
}
