import { expect, it } from "vitest";
import { checkDecisionLabel, checkProblem, deliveryCheckProblem } from "../../../src/check-evidence.js";
import { recordedCheckBatch } from "../../../src/check-environment.js";
import { shipsUnasked } from "../../../src/delivery-policy.js";
import { gateStatus, gateTitle } from "../../../src/flow.js";
import { setupAttempt, setupRequirement, setupRun, setupWork } from "../../fixtures/check-setup.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

it("shows a first-ever setup failure as unverified without inventing a product result", () => {
  const attempt = setupAttempt([setupRequirement]);
  attempt.results = [{ requirementId: setupRequirement.id, run: setupRun(7) }];
  expect(checkProblem({ checkSetup: attempt })).toBe("unverified");
  expect(recordedCheckBatch({ checkSetup: attempt })).toMatchObject({ kind: "blocked", setup: { kind: "unmet" }, productFailures: [] });
  expect(checkProblem({ checkSetupInvalidated: { id: "first-rerun", kind: "explicit-rerun", at: 5 } })).toBe("unverified");
});

it("retains actual old code failures beneath a setup blocker without calling it an eligible current failure", () => {
  const work = setupWork([setupRun(7)]);
  work.checkSetup!.executor = undefined;
  expect(checkProblem(work)).toBe("failing");
  expect(recordedCheckBatch(work)).toMatchObject({ kind: "blocked", productFailures: [work.checks!.results[0]!] });
  expect(work.checks!.results[0]!.ok).toBe(false);
});

it("does not describe an explicitly stale or malformed saved currency flag as verified", () => {
  const work = setupWork([setupRun()]);
  expect(recordedCheckBatch(work).kind).toBe("passed");
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, current: false } }).kind).toBe("blocked");
  expect(recordedCheckBatch({ ...work, checks: { ...work.checks!, current: "yes" } } as never).kind).toBe("blocked");
});

for (const shared of [false, true]) it(`requires recorded setup plus a bound full batch for ${shared ? "shared" : "single-product"} low-risk delivery`, () => {
  const state = stateFixture();
  for (const product of state.products) product.shipLowRisk = true;
  const task = taskFixture(state, { risk: { level: "low", why: "Copy" }, approveDelivery: false, acceptancePassed: true });
  const first = setupWork(shared ? [setupRun()] : []), second = setupWork([setupRun()]);
  if (shared) task.repositories = state.products.map((product, index) => ({ productId: product.id, delivery: "local", completedStages: [], ...JSON.parse(JSON.stringify(index ? second : first)) }));
  const allowed = () => shipsUnasked(task, { products: state.products, product: state.products[0], ...first, checks: first.checks });
  expect(allowed()).toBe(true); // Shared opt-in still requires a nonempty real batch; single-owner no-check opt-in keeps its baseline.
  const owner = shared ? task.repositories![1]! : first;
  const original = owner.checkSetup;
  owner.checkSetup = undefined;
  expect(allowed()).toBe(false);
  owner.checkSetup = original;
  owner.checkSetupInvalidated = { id: "rerun", kind: "explicit-rerun", at: 5 };
  expect(allowed()).toBe(false);
  expect(owner.checks!.results).toEqual(shared ? second.checks!.results : []);
});

it("a setup-only pass never hides a real incomplete product command, even when it reports success", () => {
  const work = setupWork([{ ...setupRun(), execution: undefined }]);
  expect(recordedCheckBatch(work).kind).toBe("blocked");
  expect(checkProblem(work)).toBe("unverified");
  expect(work.checks!.results[0]!.ok).toBe(true);
});


it("keeps published stale, failed and malformed history visible while only unfinished owners need delivery authority", () => {
  const state = stateFixture(), first = setupWork([setupRun(7)]), second = setupWork([setupRun()]);
  const task = taskFixture(state, { repositories: [
    { productId: "shop", delivery: "local", completedStages: [], ...first, landed: { branch: "main", sha: "already-published" } },
    { productId: "billing", delivery: "local", completedStages: [], ...second },
  ] });
  const published = task.repositories![0]!, unfinished = task.repositories![1]!;
  published.checks!.current = false;
  const history = JSON.stringify(published);
  expect(checkProblem(task)).toBe("failing");
  expect(deliveryCheckProblem(task)).toBeUndefined();
  expect(checkDecisionLabel(task)).toBeUndefined();
  expect(gateTitle(task, "delivery")).toBe(`Ready to ship “${task.title}”`);
  expect(gateStatus(task, "delivery")).toBe("Reviews done. Waiting for your OK to ship");
  expect(JSON.stringify(published)).toBe(history);
  published.checks!.results = [null as never];
  expect(checkProblem(task)).toBe("unverified");
  expect(deliveryCheckProblem(task)).toBeUndefined();
  expect(published.checks!.results).toEqual([null]);
  unfinished.checks!.current = false;
  expect(deliveryCheckProblem(task)).toBe("unverified");
  expect(gateTitle(task, "delivery")).toContain("checks unverified");
  unfinished.checks!.current = true;
  delete unfinished.checkSetup;
  expect(deliveryCheckProblem(task)).toBe("unverified");
});
