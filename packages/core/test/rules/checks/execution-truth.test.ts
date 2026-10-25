import { expect, it } from "vitest";
import type { CheckExecution } from "../../../src/model.js";
import { checkExecutionPassed } from "../../../src/check-outcome.js";

const complete = (): CheckExecution => ({ started: true, exit: { status: "reported", code: 0 }, stdout: "eof", stderr: "eof", timedOut: false, cancelled: false, cleanup: "not-requested", outputCleanup: "not-requested" });

it.each(["not-requested", "confirmed"] as const)("accepts complete successful execution with cleanup %s without inventing a tree scan", cleanup => {
  expect(checkExecutionPassed({ ...complete(), cleanup })).toBe(true);
});

it.each([
  ["not started", { started: false }],
  ["failed exit", { exit: { status: "reported", code: 7 } }],
  ["unknown exit", { exit: { status: "unreported" } }],
  ["rejected exit", { exit: { status: "rejected" } }],
  ["invalid exit", { exit: { status: "invalid" } }],
  ["missing reported code", { exit: { status: "reported" } }],
  ["signalled exit", { exit: { status: "reported", code: 0, signal: "SIGTERM" } }],
  ["stdout incomplete", { stdout: "incomplete" }],
  ["stderr incomplete", { stderr: "incomplete" }],
  ["stdout unreadable", { stdout: "read-error" }],
  ["stderr unreadable", { stderr: "read-error" }],
  ["timeout", { timedOut: true }],
  ["cancelled", { cancelled: true }],
  ["failed observer", { failure: { kind: "observer", message: "Could not record ownership" } }],
  ["unconfirmed processes", { cleanup: "unconfirmed" }],
  ["unconfirmed output", { outputCleanup: "unconfirmed" }],
] satisfies readonly (readonly [string, Partial<CheckExecution>])[])("refuses %s without promoting other complete facts", (_name, changed) => {
  expect(checkExecutionPassed({ ...complete(), ...changed })).toBe(false);
});

it("does not infer successful execution from absent historical observations", () => {
  expect(checkExecutionPassed(undefined)).toBe(false);
});

it.each(["started", "exit", "stdout", "stderr", "timedOut", "cancelled", "cleanup", "outputCleanup"] as const)("refuses a saved observation missing %s", field => {
  const facts = complete();
  Reflect.deleteProperty(facts, field);
  expect(checkExecutionPassed(facts)).toBe(false);
});
