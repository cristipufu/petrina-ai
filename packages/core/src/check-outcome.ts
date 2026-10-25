import type { CheckRun } from "./model.js";

export const CHECK_EXIT_UNREPORTED = "The check ended, but the system did not report its exit, so whether it passed is unknown.";

/** Older runs keep the runner's unknown-exit explanation rather than a separate flag. */
export function unreportedCheckExit(run: CheckRun, cleanupIncomplete: string): boolean {
  const ending = run.output.trimEnd();
  return !run.ok && [CHECK_EXIT_UNREPORTED, `${CHECK_EXIT_UNREPORTED}\n${cleanupIncomplete}`]
    .some((explanation) => ending === explanation || ending.endsWith(`\n${explanation}`));
}
export const checkCommandOutcome = (run: CheckRun | undefined, cleanupIncomplete: string) => !run ? "unavailable" : unreportedCheckExit(run, cleanupIncomplete) ? "unknown" : run.interruption || run.interrupted || run.cleanupIncomplete || run.timedOut ? "unfinished" : run.ok ? "passed" : "failed";
