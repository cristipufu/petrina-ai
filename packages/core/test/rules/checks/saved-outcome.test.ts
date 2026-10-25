import { expect, it } from "vitest";
import type { CheckRun } from "../../../src/model.js";
import { CHECK_EXIT_UNREPORTED, checkCommandOutcome, checkOutcome, unreportedCheckExit } from "../../../src/check-outcome.js";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
const CLEANUP_INCOMPLETE = "Unconfirmed cleanup from the native adapter";
const run = (name: string, output = ""): CheckRun => ({ name, command: `check ${name}`, ok: true, ms: 150, startedAt: 1, endedAt: 151, output, logComplete: true });
const outcome = (run: CheckRun) => checkCommandOutcome(run);

it("preserves saved outcomes and descriptions without treating their words as execution facts", () => {
  const passed = run("Pass", CHECK_EXIT_UNREPORTED);
  const quoted = { ...run("Failure", `A command quoted: ${CHECK_EXIT_UNREPORTED}`), ok: false };
  const failed = { ...run("Failure", `${CHECK_EXIT_UNREPORTED}\nActual later failure`), ok: false };
  const unknown = { ...run("Unknown", `${CHECK_EXIT_UNREPORTED}\n${CLEANUP_INCOMPLETE}`), ok: false, cleanupIncomplete: true };
  expect(outcome(passed)).toBe("unknown");
  expect(outcome(quoted)).toBe("unknown");
  expect(outcome(failed)).toBe("unknown");
  expect(outcome(unknown)).toBe("unfinished");
  expect([passed, quoted, failed, unknown].map(checkOutcome).map(entry => entry.reportedOk)).toEqual([true, false, false, false]);
  expect([passed, quoted, failed, unknown].map(unreportedCheckExit)).toEqual([false, false, false, false]);
  expect(unknown.output).toBe(`${CHECK_EXIT_UNREPORTED}\n${CLEANUP_INCOMPLETE}`);
});

it.each([0, 7])("uses the native exit %s even when its output contains the older unknown-exit sentence", code => {
  const current = { ...run("Native", CHECK_EXIT_UNREPORTED), ok: code === 0, execution: completeCheckExecution(code) };
  expect(outcome(current)).toBe(code === 0 ? "passed" : "failed");
  expect(unreportedCheckExit(current)).toBe(false);
});
