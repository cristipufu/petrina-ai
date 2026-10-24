import { expect, it } from "vitest";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, type WorkChoice } from "@petrina/core";
import { executionFor } from "../../../src/index.js";
import { pending, sourceChoice, sourceFixture, sourceTask } from "../../fixtures/sources.js";

it("checkpoints in-flight validation, blocks approval, and records the completed proposal", async () => {
  const task = sourceTask(), f = sourceFixture(), wait = pending<boolean>();
  f.scripts.validBranch = () => wait.promise;
  f.scripts.requireBranch = async () => {};
  const work = f.selections.propose(task, [sourceChoice("shop", "topic")]);
  expect(task.workValidating).toBe(true);
  expect(f.checkpoints).toHaveLength(1); expect(f.checkpoints[0]!.workValidating).toBe(true);
  expect(() => f.selections.confirm(task)).toThrow("Wait for every product choice");
  wait.resolve(true); await work;
  expect(task.workValidating).toBe(false); expect(task.workError).toBeUndefined();
  expect(task.proposedSource?.start.branch).toBe("topic"); expect(task.confirmWork).toBe(true);
  expect(f.item.body).toContain("from topic");
  expect(f.checkpoints).toHaveLength(2); expect(f.checkpoints.at(-1)!.proposedSource).toEqual(task.proposedSource);
});

it.each([false, true])("ignores a superseded single-product result (failed: %s) without releasing newer validation", async failed => {
  const task = sourceTask(), f = sourceFixture(), old = pending<boolean>(), latest = pending<boolean>();
  f.scripts.validBranch = name => name === "old" ? old.promise : latest.promise;
  f.scripts.requireBranch = async () => {};
  const first = f.selections.propose(task, [sourceChoice("shop", "old")]);
  const second = f.selections.propose(task, [sourceChoice("shop", "latest")]);
  const checkpoints = f.checkpoints.length;
  if (failed) old.reject(new Error("Old failure")); else old.resolve(true);
  await first;
  expect(task.workValidating).toBe(true); expect(task.proposedSource).toBeUndefined();
  expect(task.workError).toContain("Checking the product"); expect(f.checkpoints).toHaveLength(checkpoints);
  latest.resolve(true); await second;
  expect(task.workValidating).toBe(false); expect(task.workError).toBeUndefined();
  expect(task.proposedSource?.start.branch).toBe("latest");
  expect(f.checkpoints).toHaveLength(checkpoints + 1);
});

it.each([false, true])("ignores a superseded shared result (failed: %s), retaining newer rows and flags", async failed => {
  const task = sourceTask(), f = sourceFixture(), first = pending<boolean>(), second = pending<boolean>();
  f.scripts.validBranch = name => name === "main" ? first.promise : second.promise;
  f.scripts.requireBranch = async () => {};
  const old = f.selections.propose(task, [sourceChoice(), sourceChoice("api")], true);
  const rows = task.workRows;
  expect(f.calls).toEqual(["valid:main", "valid:trunk"]);
  f.scripts.validBranch = async () => true;
  await f.selections.propose(task, [sourceChoice("api")], true);
  const current = structuredClone(task), checkpoints = f.checkpoints.length;
  if (failed) first.reject(new Error("Obsolete failure")); else first.resolve(true);
  second.resolve(true); await old;
  expect(task.workRows).not.toBe(rows); expect(task).toEqual(current);
  expect(f.checkpoints).toHaveLength(checkpoints);
  expect(task.workRows?.map(row => row.choice.productId)).toEqual(["api"]);
});

it.each(["shop", "api"])("resolves shared rows concurrently with ordered, independent failures in %s", async failing => {
  const task = sourceTask(), f = sourceFixture(), first = pending<boolean>(), second = pending<boolean>(), finished = pending<void>();
  task.selectedProducts = [];
  task.approveDelivery = false;
  f.scripts.validBranch = name => name === "main" ? first.promise : second.promise;
  f.scripts.requireBranch = async () => { finished.resolve(); };
  const work = f.selections.propose(task, [sourceChoice(), sourceChoice("api")], true);
  expect(f.calls).toEqual(["valid:main", "valid:trunk"]);
  const failedIndex = failing === "shop" ? 0 : 1, succeededIndex = 1 - failedIndex;
  (failing === "shop" ? second : first).resolve(true);
  await finished.promise;
  expect(task.workValidating).toBe(true);
  (failing === "shop" ? first : second).reject(new Error("The branch is unavailable"));
  await work;
  expect(task.workRows?.map(row => row.choice.productId)).toEqual(["shop", "api"]);
  expect(task.workRows?.[succeededIndex]?.source?.product.id).toBe(failing === "shop" ? "api" : "shop");
  expect(task.workRows?.[succeededIndex]?.error).toBeUndefined();
  expect(task.workRows?.[failedIndex]?.error).toBe("The branch is unavailable");
  expect(task.workError).toBe("The branch is unavailable"); expect(task.workValidating).toBe(false);
  expect(task.approveDelivery).toBe(true); expect(task.approvalExplanation).toContain("Shop asks before shipping");
  expect(f.item.body).toContain("The branch is unavailable");
});

it.each(["number", "link"] as const)("accepts an equivalent confirmed PR %s without requesting another confirmation", async kind => {
  const task = sourceTask(), f = sourceFixture(), scope = executionFor(task);
  const link = "https://github.com/acme/shop/pull/7";
  f.scripts.pullRequest = async () => ({ number: 7, url: link, headRepo: "acme/shop", branch: "work", state: "open" });
  const original: WorkChoice = { ...sourceChoice(), startFrom: { kind: "pull-request", value: kind === "number" ? link : "7" } };
  scope.work.source = { ...await f.effects.resolve(task, original), confirmed: true, initialSha: "saved-start" };
  task.workChoice = original;
  await f.selections.propose(task, [{ ...original, startFrom: { kind: "pull-request", value: kind === "number" ? "7" : link } }]);
  expect(task.confirmWork).toBe(false); expect(task.proposedSource).toBeUndefined();
  expect(scope.work.source.confirmed).toBe(true); expect(scope.work.source.initialSha).toBe("saved-start");
  expect(f.calls).toEqual(["pr:acme/shop:7", "pr:acme/shop:7"]);
});

it.each(["branch", "repository"] as const)("requires confirmation when a previously approved PR changes its %s", async changed => {
  const task = sourceTask(), f = sourceFixture(), scope = executionFor(task);
  const choice: WorkChoice = { ...sourceChoice(), startFrom: { kind: "pull-request", value: "7" } };
  f.scripts.pullRequest = async () => ({ number: 7, url: "https://github.com/acme/shop/pull/7", headRepo: "acme/shop", branch: "work", state: "open" });
  scope.work.source = { ...await f.effects.resolve(task, choice), confirmed: true };
  task.workChoice = choice;
  const original = structuredClone(scope.work.source);
  f.scripts.pullRequest = async () => ({ number: 7, url: "https://github.com/acme/shop/pull/7", headRepo: changed === "repository" ? "contributor/shop" : "acme/shop", branch: changed === "branch" ? "new-work" : "work", state: "open" });
  await f.selections.propose(task, [choice]);
  expect(scope.work.source).toEqual(original); expect(task.proposedSource?.confirmed).toBe(false);
  expect(task.proposedSource?.destination[changed === "branch" ? "branch" : "repo"]).toBe(changed === "branch" ? "new-work" : "contributor/shop");
  expect(task.confirmWork).toBe(true); expect(scope.work.worktree).toBeUndefined();
});

it.each(["default", "number", "link"] as const)("clears a mismatched PR error when corrected to %s before preparation", async corrected => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async () => true;
  f.scripts.pullRequest = async () => ({ number: 7, url: "https://github.com/acme/shop/pull/7", headRepo: "acme/shop", branch: "work", state: "open" });
  const wrong: WorkChoice = { ...sourceChoice(), startFrom: { kind: "pull-request", value: "https://github.com/someone/other/pull/7" } };
  task.workChoice = wrong;
  await f.selections.propose(task, [wrong]);
  expect(task.workError).toContain("someone/other");
  expect(() => f.selections.confirm(task)).toThrow("someone/other");
  expect(f.calls).toEqual([]);
  await f.selections.propose(task, [{ ...wrong, startFrom: corrected === "default" ? { kind: "default" } : { kind: "pull-request", value: corrected === "number" ? "7" : "https://github.com/acme/shop/pull/7" } }]);
  expect(task.workError).toBeUndefined(); expect(f.item.body).not.toContain("someone/other");
  f.selections.confirm(task);
  expect(executionFor(task).work.source?.confirmed).toBe(true);
  expect(executionFor(task).work.worktree).toBeUndefined(); expect(task.confirmWork).toBe(false);
  expect(f.notes).toHaveLength(1);
});

it("keeps the original choice until approval and permits changing an unprepared default source", async () => {
  const task = sourceTask(), f = sourceFixture(), scope = executionFor(task);
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  const original = sourceChoice(); task.workChoice = original;
  await f.selections.propose(task, [original]);
  expect(task.confirmWork).toBe(false); expect(scope.work.source?.confirmed).toBe(true);
  const previous = structuredClone(scope.work.source);
  const changed = sourceChoice("shop", "topic");
  await f.selections.propose(task, [changed]);
  expect(task.workChoice).toEqual(original); expect(scope.work.source).toEqual(previous); expect(task.confirmWork).toBe(true);
  f.selections.confirm(task);
  expect(task.workChoice).toEqual(changed); expect(scope.work.source?.start.branch).toBe("topic");
  expect(task.confirmWork).toBe(false); expect(task.proposedSource).toBeUndefined();
  expect(f.notes).toHaveLength(1);
});

it.each(["unknown", "multiple", "branch", "delivery"] as const)("keeps explicit choices until approval of a planner %s proposal", async proposed => {
  const task = sourceTask(), f = sourceFixture();
  const original: WorkChoice = { ...sourceChoice(), delivery: "pull-request" };
  task.workChoice = original; task.selectedProducts = [original];
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  const choice: WorkChoice = { productId: proposed === "unknown" ? "Shop API" : "shop", startFrom: proposed === "branch" ? { kind: "branch", name: "topic" } : { kind: "default" }, delivery: proposed === "delivery" ? "local" : "pull-request" };
  await f.selections.propose(task, proposed === "multiple" ? [original, choice] : [choice]);
  expect(executionFor(task).work.worktree).toBeUndefined(); expect(task.delivery).toBe("pull-request");
  expect(task.workChoice).toEqual(original);
  if (proposed === "unknown" || proposed === "multiple") {
    expect(task.workError).toContain(proposed === "unknown" ? "Needs adding" : "already included");
    expect(() => f.selections.confirm(task)).toThrow();
    await f.selections.propose(task, [original], true);
  } else expect(task.proposedSource?.destination).toMatchObject({ branch: proposed === "branch" ? "topic" : "main", mode: choice.delivery });
  f.selections.confirm(task);
  expect(executionFor(task).work.source).toMatchObject({ confirmed: true, destination: { branch: proposed === "branch" ? "topic" : "main", mode: proposed === "delivery" ? "local" : "pull-request" } });
  expect(task.workError).toBeUndefined(); expect(task.confirmWork).toBe(false); expect(f.notes).toHaveLength(1);
});

it("refuses to change an existing working copy, preserving its confirmed destination", async () => {
  const task = sourceTask(), f = sourceFixture(), scope = executionFor(task);
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  scope.work.source = { ...await f.effects.resolve(task, sourceChoice()), confirmed: true };
  scope.work.worktree = "owned-working-copy";
  await f.selections.propose(task, [sourceChoice("shop", "topic")]);
  const before = structuredClone(task);
  expect(() => f.selections.confirm(task)).toThrow("This task already has a working copy");
  expect(task).toEqual(before); expect(f.notes).toEqual([]);
});

it("preserves omitted coordinator products and identifies planner additions and changed choices", async () => {
  const task = sourceTask(), f = sourceFixture();
  task.selectedProducts = [sourceChoice(), sourceChoice("api")];
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  await f.selections.propose(task, [{ ...sourceChoice(), delivery: "pull-request" }, sourceChoice("acme/extra")]);
  expect(task.workRows?.map(row => [row.choice.productId, row.change])).toEqual([["shop", "changed"], ["acme/extra", "added"], ["api", "omitted"]]);
  expect(task.workRows?.[0]?.previous).toEqual(sourceChoice());
  expect(task.workRows?.[1]?.error).toBe("Unexpected repository lookup: acme/extra");
  expect(task.approvePlan).toBe(true);
});

it("discovers a proposed repository without cloning and requires an explicitly confirmed folder", async () => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.repository = async repo => ({ repo, defaultBranch: "develop" });
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  await f.selections.propose(task, [{ ...sourceChoice("new"), repo: "acme/new" }], true);
  const row = task.workRows![0]!;
  expect(row.source?.product).toMatchObject({ id: "new", repo: "acme/new", defaultBranch: "develop" });
  expect(row.addition).toBeUndefined(); expect(row.error).toContain("confirm this product’s name and permanent folder");
  expect(f.calls).toEqual(["repo:acme/new", "valid:develop", "exists:acme/new:develop"]);
  expect(() => f.selections.confirm(task)).toThrow("Correct every product");
});

it("detects repository aliases as duplicates in original row order", async () => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  await f.selections.propose(task, [sourceChoice(), { ...sourceChoice("alias"), repo: "ACME/SHOP" }], true);
  expect(task.workRows?.map(row => row.choice.productId)).toEqual(["shop", "shop"]);
  expect(task.workRows?.[0]?.error).toBeUndefined(); expect(task.workRows?.[1]?.error).toContain("already included");
  expect(task.workError).toContain("already included");
  expect(() => f.selections.confirm(task)).toThrow("Correct every product");
});

it("rejects separately registered product rows that name the same repository", async () => {
  const task = sourceTask(), f = sourceFixture();
  f.products[1] = { ...f.products[1]!, repo: "ACME/SHOP" };
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  await f.selections.propose(task, [sourceChoice(), sourceChoice("api")], true);
  expect(task.workRows?.[0]?.error).toBeUndefined(); expect(task.workRows?.[1]?.error).toContain("already included");
  expect(task.workError).toContain("already included");
});

it.each(["builder", "code-reviewer"])("leaves confirmation unchanged when the approved plan has no %s coverage", async missing => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  await f.selections.propose(task, [sourceChoice(), sourceChoice("api")], true);
  task.plan!.stages = task.plan!.stages.filter(stage => stage.roleId !== missing);
  const before = structuredClone(task);
  expect(() => f.selections.confirm(task)).toThrow("Every product needs a builder and review coverage");
  expect(task).toEqual(before); expect(f.notes).toEqual([]);
});

it("confirms shared execution identities and per-product coverage without checkpointing outside the approval transaction", async () => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  const choices = [{ ...sourceChoice(), builderProfileId: "alternate" }, { ...sourceChoice("api"), lead: true }];
  await f.selections.propose(task, choices, true);
  const checkpoints = f.checkpoints.length;
  f.selections.confirm(task);
  expect(task.repositories?.map(work => [work.productId, work.source?.confirmed, work.preparation])).toEqual([["shop", true, "waiting"], ["api", true, "waiting"]]);
  expect(task.plan?.products).toEqual([{ productId: "shop", builderProfileId: "alternate", reviewerProfileIds: ["reviewer"] }, { productId: "api", builderProfileId: "builder", reviewerProfileIds: ["reviewer"] }]);
  expect(task.productId).toBe("api"); expect(task.leadProductId).toBe("api"); expect(task.plan?.leadProductId).toBe("api");
  expect(task.activeProductId).toBe("shop"); expect(task.repository).toBeUndefined(); expect(task.confirmWork).toBe(false);
  expect(task.plan?.stages.at(-1)?.title).toBe("Deliver across 2 products");
  expect(f.notes).toHaveLength(1); expect(f.checkpoints).toHaveLength(checkpoints);
});

it("uses a task-owned builder role after it is removed from the library", async () => {
  const task = sourceTask(), f = sourceFixture();
  const role = { ...BUILT_IN_ROLES.find(role => role.result === "build")!, id: "saved-maintenance" };
  task.maintenance = { role, routineId: "routine", routineName: "Routine", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", profile: DEFAULT_PROFILES[0]!, product: { id: "shop", name: "Shop", repo: "acme/shop", tone: "blue" } };
  task.plan!.stages[0]!.roleId = role.id;
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  await f.selections.propose(task, [sourceChoice(), sourceChoice("api")], true);
  f.selections.confirm(task);
  expect(task.plan!.products?.map(product => product.builderProfileId)).toEqual(["builder", "builder"]);
  expect(task.repositories).toHaveLength(2); expect(task.confirmWork).toBe(false);
});

it.each([true, false])("checks a new product's folder through the native contract (absolute: %s)", async absolute => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  const choice = { ...sourceChoice("new"), repo: "acme/new" };
  const source = await f.effects.resolve(task, choice, { id: "new", name: "New", repo: "acme/new", path: "chosen-folder", defaultBranch: "main" });
  task.workRows = [{ choice, source, addition: { productId: "new", name: "New", path: "chosen-folder" } }];
  f.scripts.isAbsoluteFolder = path => { expect(path).toBe("chosen-folder"); return absolute; };
  const before = structuredClone(task);
  if (absolute) {
    f.selections.confirm(task);
    expect(task.repositories?.[0]?.source?.product.path).toBe("chosen-folder");
    expect(task.repositories?.[0]?.source?.confirmed).toBe(true);
  } else {
    expect(() => f.selections.confirm(task)).toThrow("confirm folders for additions");
    expect(task).toEqual(before);
  }
  expect(f.calls).toContain("folder:chosen-folder");
});
