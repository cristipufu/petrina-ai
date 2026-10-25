import { expect, it } from "vitest";
import type { CheckRun } from "../../../src/model.js";
import { CHECK_EXIT_UNREPORTED, checkCommandOutcome } from "../../../src/check-outcome.js";
const CLEANUP_INCOMPLETE = "Unconfirmed cleanup from the native adapter";
const run = (name: string, output = ""): CheckRun => ({ name, command: `check ${name}`, ok: true, ms: 150, startedAt: 1, endedAt: 151, output, logComplete: true });
const outcome = (run: CheckRun) => checkCommandOutcome(run, CLEANUP_INCOMPLETE);

it("recognizes the saved unknown-exit explanation without reclassifying passes or quoted command output", () => {
  expect(outcome(run("Pass", CHECK_EXIT_UNREPORTED))).toBe("passed");
  expect(outcome({ ...run("Failure", `A command quoted: ${CHECK_EXIT_UNREPORTED}`), ok: false })).toBe("failed");
  expect(outcome({ ...run("Failure", `${CHECK_EXIT_UNREPORTED}\nActual later failure`), ok: false })).toBe("failed");
  expect(outcome({ ...run("Unknown", `${CHECK_EXIT_UNREPORTED}\n${CLEANUP_INCOMPLETE}`), ok: false, cleanupIncomplete: true })).toBe("unknown");
});
