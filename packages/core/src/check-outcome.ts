import type { CheckExecution, CheckRun } from "./model.js";

/** Success needs complete native observations; absent or contradictory facts establish no pass. */
export function checkExecutionPassed(execution: CheckExecution | undefined): boolean {
  return execution !== undefined && execution.started === true && execution.exit?.status === "reported" && execution.exit.code === 0
    && !execution.exit.signal && execution.stdout === "eof" && execution.stderr === "eof"
    && execution.timedOut === false && execution.cancelled === false && !execution.failure
    && (execution.cleanup === "not-requested" || execution.cleanup === "confirmed")
    && (execution.outputCleanup === "not-requested" || execution.outputCleanup === "confirmed");
}

export const CHECK_EXIT_UNREPORTED = "The check ended, but the system did not report its exit, so whether it passed is unknown.";

/** Older runs keep the runner's unknown-exit explanation rather than a separate flag. */
export function unreportedCheckExit(run: CheckRun, cleanupIncomplete: string): boolean {
  const ending = run.output.trimEnd();
  return !run.ok && [CHECK_EXIT_UNREPORTED, `${CHECK_EXIT_UNREPORTED}\n${cleanupIncomplete}`]
    .some((explanation) => ending === explanation || ending.endsWith(`\n${explanation}`));
}
export const checkCommandOutcome = (run: CheckRun | undefined, cleanupIncomplete: string) => !run ? "unavailable" : unreportedCheckExit(run, cleanupIncomplete) ? "unknown" : run.interruption || run.interrupted || run.cleanupIncomplete || run.timedOut ? "unfinished" : run.ok ? "passed" : "failed";
