import { expect, it } from "vitest";
import { checkEvidence } from "../../fixtures/check-evidence.js";

it.each(["definition", "tree", "tracked-files", "command-order", "executor", "environment", "declaration"] as const)("retains raw results but refuses acceptance when the %s changes", async kind => {
  const f = await checkEvidence();
  f.scope.work.checkReturns = 2;
  const run = f.run();
  const result = await f.record([run], batch => {
    if (kind === "definition") batch.after.attempt.input.definition = "4".repeat(64);
    else if (kind === "tree") batch.after.attempt.input.tree = "4".repeat(40);
    else if (kind === "tracked-files") batch.finalState.trackedChanged = true;
    else if (kind === "command-order") batch.expected = ["another-command", run.command];
    else if (kind === "executor") batch.after.attempt.executor = { ...batch.after.attempt.executor!, platform: "changed" };
    else if (kind === "environment") batch.after.attempt.identity!.executor = "4".repeat(64);
    else batch.live.valid = () => false;
  });
  expect(result.kind).toBe("blocked");
  expect(f.scope.work.checks?.results).toEqual([run]);
  expect(f.scope.work.checks?.current).toBe(false);
  expect(f.scope.work.checks?.environment).toBeUndefined();
  expect(f.scope.work.checkReturns).toBe(2);
  expect(f.task.findings).toEqual([]);
  expect(f.task.journey!.at(-1)!.checkAttempts![0]!.passed).toBe(false);
  expect(f.scope.work.approvedSha).toBeUndefined();
});

it("cannot close a repair episode after its declaration changes during the awaited close", async () => {
  const f = await checkEvidence();
  f.scope.work.checkReturns = 2;
  let current = true;
  f.host.closeEpisode = async () => { current = false; };
  const result = await f.record([f.run()], batch => { batch.after.valid = () => current; });
  expect(result.kind).toBe("blocked");
  expect(f.scope.work.checkReturns).toBe(2);
  expect(f.scope.work.checks?.current).toBe(false);
});

it.each([false, true])("does not borrow a definition for a legacy %s pass when retaining product results", async withHook => {
  const f = await checkEvidence();
  if (withHook) { f.declaration.hooks.push("pre-commit"); f.declaration.expected.push("git hook run --ignore-missing pre-commit"); }
  const runs = [f.run(), ...(withHook ? [f.run(7, "Pre-commit hook", "git hook run --ignore-missing pre-commit")] : [])];
  await f.record(runs);
  const saved = f.scope.work.checks!;
  delete saved.definition;
  const original = structuredClone(saved);
  expect(f.controller.applies(f.scope, f.state, f.declaration)).toBe(false);
  expect(f.controller.retainedProductResults(f.scope, f.state, f.observation("before-checks"), f.declaration)).toBeUndefined();
  expect(saved).toEqual(original);
});

it("revalidates an opaque hook pass while retaining only the bound product command result", async () => {
  const f = await checkEvidence();
  const declaration = { commands: ["test-product"], expected: ["test-product", "git hook run --ignore-missing pre-commit"], hooks: ["pre-commit"] };
  const runs = [f.run(), f.run(0, "Pre-commit hook", declaration.expected[1]!)];
  await f.record(runs, batch => { batch.commands = declaration.expected; batch.expected = declaration.expected; });
  expect(f.controller.applies(f.scope, f.state, declaration)).toBe(false);
  expect(f.controller.retainedProductResults(f.scope, f.state, f.observation("before-checks"), declaration)).toEqual([runs[0]]);
  expect(f.scope.work.checks?.results).toEqual(runs);
});
