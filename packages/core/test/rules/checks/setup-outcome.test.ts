import { expect, it } from "vitest";
import { checkInputApplicability, checkSetupOutcome, recordedCheckBatch } from "../../../src/check-environment.js";
import type { CheckExecution, CheckSetupAttempt } from "../../../src/model.js";
import { setupAttempt, setupRequirement, setupRun, setupWork } from "../../fixtures/check-setup.js";

it("requires an actual baseline even for an explicitly empty setup manifest and never creates a command", () => {
  const attempt = setupAttempt();
  expect(checkSetupOutcome(undefined).kind).toBe("unobserved");
  expect(checkSetupOutcome(attempt)).toMatchObject({ kind: "verified", observations: [] });
  expect(attempt.results).toEqual([]);
  const { afterInput: _after, restoration: _restoration, ...withoutCommandEffects } = attempt;
  expect(checkSetupOutcome(withoutCommandEffects).kind).toBe("verified");
  const missing = { ...attempt, executor: undefined };
  expect(checkSetupOutcome(missing).kind).toBe("unavailable"); expect(missing.executor).toBeUndefined();
  expect(checkSetupOutcome({ ...attempt, observationFailure: { kind: "executor", message: "The native API was unavailable" } })).toEqual({ kind: "unavailable", reason: "The native API was unavailable" });
});

for (const lifecycle of ["pending", "running", "stopped"] as const) it(`keeps a ${lifecycle} setup observation separate from completion`, () => {
  expect(checkSetupOutcome({ ...setupAttempt(), lifecycle })).toEqual({ kind: lifecycle });
});

it("requires every declared native pass, complete separate outputs and confirmed unchanged inputs", () => {
  const attempt = setupAttempt([setupRequirement]);
  expect(checkSetupOutcome(attempt)).toMatchObject({ kind: "verified", observations: [{ requirementId: setupRequirement.id }] });
  expect(checkSetupOutcome({ ...attempt, results: [] }).kind).toBe("incomplete");
  expect(checkSetupOutcome({ ...attempt, afterInput: undefined }).kind).toBe("incomplete");
  expect(checkSetupOutcome({ ...attempt, restoration: "restored" }).kind).toBe("incomplete");
  expect(checkSetupOutcome({ ...attempt, restoration: "unconfirmed" }).kind).toBe("incomplete");
  expect(checkSetupOutcome({ ...attempt, afterInput: { ...attempt.afterInput!, trackedChanged: true } }).kind).toBe("outdated");
  expect(checkSetupOutcome({ ...attempt, results: [{ requirementId: setupRequirement.id, run: { ...setupRun(), outputIdentity: undefined } }] }).kind).toBe("incomplete");
});

it("an actual nonzero requirement is unmet, with later membership unexecuted rather than a product failure", () => {
  const later = { id: "later", name: "Later identity", argv: ["later"] }, attempt = setupAttempt([setupRequirement, later]);
  attempt.results = [{ requirementId: setupRequirement.id, run: setupRun(7) }];
  expect(checkSetupOutcome(attempt)).toEqual({ kind: "unmet", requirementId: setupRequirement.id, code: 7 });
  expect(checkSetupOutcome({ ...attempt, results: [...attempt.results, { requirementId: later.id, run: setupRun(0, later) }] }).kind).toBe("incomplete");
});

it.each([
  { timedOut: true }, { cancelled: true }, { exit: { status: "unreported" } }, { exit: { status: "rejected" } },
  { stdout: "read-error" }, { stderr: "incomplete" }, { cleanup: "unconfirmed" }, { outputCleanup: "unconfirmed" },
] as Partial<CheckExecution>[])("does not turn incomplete native prerequisite facts into verified setup (%#)", change => {
  const run = setupRun(); run.execution = { ...run.execution!, ...change };
  const attempt = setupAttempt([setupRequirement]); attempt.results = [{ requirementId: setupRequirement.id, run }];
  expect(checkSetupOutcome(attempt).kind).toBe("incomplete");
});

it("keeps native startup unavailable and contradictory reported success incomplete", () => {
  const run = setupRun(); run.ok = false; run.execution = { ...run.execution!, started: false, exit: { status: "unreported" }, stdout: "incomplete", stderr: "incomplete", failure: { kind: "start", message: "missing compiler" } };
  const attempt = setupAttempt([setupRequirement]); attempt.results = [{ requirementId: setupRequirement.id, run }];
  expect(checkSetupOutcome(attempt).kind).toBe("unavailable");
  const contradictory = setupRun(7); contradictory.ok = true;
  expect(checkSetupOutcome({ ...attempt, results: [{ requirementId: setupRequirement.id, run: contradictory }] }).kind).toBe("incomplete");
});

it("rejects mismatched membership, executor, source and declaration without altering the saved observations", () => {
  const attempt = setupAttempt([setupRequirement]);
  expect(checkSetupOutcome({ ...attempt, results: [{ ...attempt.results[0]!, requirementId: "different" }] }).kind).toBe("incomplete");
  expect(checkSetupOutcome({ ...attempt, results: [{ requirementId: setupRequirement.id, run: { ...setupRun(), executor: undefined } }] }).kind).toBe("incomplete");
  expect(checkSetupOutcome(attempt, "d".repeat(64))).toEqual({ kind: "outdated", reason: "requirements-changed" });
  expect(checkSetupOutcome({ ...attempt, afterInput: { ...attempt.afterInput!, definition: "d".repeat(64) } })).toEqual({ kind: "outdated", reason: "inputs-changed" });
  expect(checkSetupOutcome(attempt, undefined, { id: "rerun", kind: "explicit-rerun", at: 5 })).toEqual({ kind: "outdated", reason: "explicit-rerun" });
  expect(attempt.results[0]!.run.executor).toBeDefined(); expect(attempt.input.definition).toBe("3".repeat(64));
});

it.each([{}, { ...setupAttempt(), endedAt: undefined }, { ...setupAttempt(), position: "unknown" },
  { ...setupAttempt([setupRequirement]), results: [null] }, { ...setupAttempt(), input: {} },
  { ...setupAttempt([setupRequirement]), results: [{ requirementId: setupRequirement.id, run: { ...setupRun(), output: undefined } }] },
].map(value => [value]))("malformed setup history cannot authorize reuse (%#)", value => {
  expect(checkSetupOutcome(value as CheckSetupAttempt).kind).toBe("incomplete");
});

it("records a baseline-bound empty full batch, but absence or incomplete old rows never becomes a pass", () => {
  expect(recordedCheckBatch(setupWork()).kind).toBe("passed");
  expect(recordedCheckBatch({}).kind).toBe("blocked");
  const work = setupWork([setupRun()]);
  expect(recordedCheckBatch(work).kind).toBe("passed");
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, environment: undefined } }).kind).toBe("blocked");
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, sha: undefined, tree: undefined } }).kind).toBe("blocked");
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, results: [{ ...setupRun(), executor: undefined }] } }).kind).toBe("blocked");
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, results: [{ ...setupRun(), execution: undefined }] } }).kind).toBe("blocked");
});

it("a setup blocker preserves the earlier real product failure without granting repair or clearing an episode", () => {
  const failed = setupRun(7), work = setupWork([failed]);
  expect(recordedCheckBatch(work).kind).toBe("product-failed");
  const unmet = setupAttempt([setupRequirement]); unmet.results = [{ requirementId: setupRequirement.id, run: setupRun(7) }];
  const result = recordedCheckBatch({ ...work, checkSetup: unmet });
  expect(result.kind).toBe("blocked");
  if (result.kind !== "blocked") throw new Error("The setup failure must block first");
  expect(result.productFailures).toEqual([failed]); expect(result.setup.kind).toBe("unmet");
  expect(work.checks!.results[0]).toBe(failed); expect(failed.ok).toBe(false);
});

it("requires the setup observation and saved batch to cover comparable code and the exact definition", () => {
  const work = setupWork();
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, definition: "d".repeat(64) } }).kind).toBe("blocked");
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, tree: "d".repeat(40) } }).kind).toBe("blocked");
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, definition: undefined } }).kind).toBe("blocked");
  expect(recordedCheckBatch({ ...work, checkSetup: { ...work.checkSetup!, input: { ...work.checkSetup!.input, sha: undefined, tree: undefined }, afterInput: undefined } }).kind).toBe("blocked");
  // A squash changes the commit but not its code; it does not excuse a changed tree or definition.
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, sha: "d".repeat(40) } }).kind).toBe("passed");
  expect(checkInputApplicability({ ...work.checks!, tree: undefined }, { ...work.checkSetup!.input, tree: undefined })).toEqual({ kind: "matches", basis: "same-commit" });
  expect(checkInputApplicability({ ...work.checks!, tree: undefined }, { ...work.checkSetup!.input, tree: undefined, sha: "d".repeat(40) }).kind).toBe("changed");
});

it.each([undefined, null, {}, { at: 3 }, { at: 3, results: null }, { at: 3, results: {} },
  { ...setupWork().checks, results: [null] }, { ...setupWork().checks, results: [undefined] },
  { ...setupWork().checks, results: new Array(1) },
].map(value => [value]))("malformed saved batch membership cannot throw or become passed (%#)", value => {
  const result = recordedCheckBatch({ ...setupWork(), checks: value as ReturnType<typeof setupWork>["checks"] });
  expect(result.kind).toBe("blocked");
});

it("retains a complete old failure beside a malformed row without treating the partial batch as authority", () => {
  const failed = setupRun(7), work = setupWork();
  const result = recordedCheckBatch({ ...work, checks: { ...work.checks!, results: [failed, null as unknown as typeof failed] } });
  expect(result.kind).toBe("blocked");
  if (result.kind !== "blocked") throw new Error("Malformed membership must remain blocked");
  expect(result.productFailures).toEqual([failed]);
});


it.each([false, 0, "", null, undefined, {}, { kind: "unknown", message: "detail" }, { kind: "executor", message: 7 },
  { kind: "executor", message: "detail", future: true },
].map(value => [value]))("a present malformed setup failure cannot verify an otherwise complete baseline (%#)", value => {
  const attempt = { ...setupAttempt(), observationFailure: value } as unknown as CheckSetupAttempt;
  expect(checkSetupOutcome(attempt).kind).toBe("incomplete");
  expect(Object.prototype.hasOwnProperty.call(attempt, "observationFailure")).toBe(true);
});


it.each([null, false, 0, "", {}, { trackedChanged: false }].map(value => [value]))("a present malformed after-input cannot verify an empty baseline (%#)", value => {
  expect(checkSetupOutcome({ ...setupAttempt(), afterInput: value } as unknown as CheckSetupAttempt).kind).toBe("incomplete");
});

it.each([null, false, 0, "", "unknown"].map(value => [value]))("a present malformed restoration cannot verify an empty baseline (%#)", value => {
  expect(checkSetupOutcome({ ...setupAttempt(), restoration: value } as unknown as CheckSetupAttempt).kind).toBe("incomplete");
});
