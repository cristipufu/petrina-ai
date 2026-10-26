import { expect, it } from "vitest";
import { type WorkChoice } from "@petrina/core";
import { executionFor } from "../../../src/index.js";
import { sourceChoice, sourceFixture, sourceTask } from "../../fixtures/sources.js";

it("clears a mismatched link error when corrected to a default and permits approval before setup", async () => {
  const f = sourceFixture(), task = sourceTask(), scope = executionFor(task);
  const wrong: WorkChoice = { ...sourceChoice(), delivery: "pull-request", startFrom: { kind: "pull-request", value: "https://github.com/someone/other/pull/7" } };
  task.workChoice = wrong;
  await f.selections.propose(task, [wrong]);
  expect(task.workError).toContain("someone/other");
  expect(() => f.selections.confirm(task)).toThrow("someone/other");
  expect(scope.work.worktree).toBeUndefined(); expect(f.calls).toHaveLength(0);
  f.scripts.validBranch = async () => true;
  await f.selections.propose(task, [{ ...wrong, startFrom: { kind: "default" } }]);
  expect(task.workError).toBeUndefined(); expect(scope.work.worktree).toBeUndefined();
  expect(f.item.body).not.toContain("someone/other");
  f.selections.confirm(task);
  expect(scope.work.source?.confirmed).toBe(true); expect(task.confirmWork).toBe(false);
});

it("requires confirmation when the same PR number has a new working repository on a redone plan", async () => {
  const f = sourceFixture(), task = sourceTask(), scope = executionFor(task);
  const choice: WorkChoice = { ...sourceChoice(), delivery: "pull-request", startFrom: { kind: "pull-request", value: "7" } };
  f.scripts.pullRequest = async () => ({ number: 7, url: "https://github.com/acme/shop/pull/7", state: "open", headRepo: "acme/shop", branch: "review-work" });
  task.workChoice = choice;
  scope.work.source = { ...await f.effects.resolve(task, choice), confirmed: true };
  const approved = structuredClone(scope.work.source);
  expect(approved.confirmed).toBe(true);
  // The saved approved identity is input; no SQLite restart or native query is claimed here.
  f.scripts.pullRequest = async () => ({ number: 7, url: "https://github.com/acme/shop/pull/7", state: "open", headRepo: "contributor/demo", branch: "review-work" });
  await f.selections.propose(task, [choice]);
  expect(task.error).toBeUndefined(); expect(scope.work.source).toEqual(approved);
  expect(task.proposedSource?.confirmed).toBe(false);
  expect(task.proposedSource?.destination.repo).toBe("contributor/demo");
  expect(task.confirmWork).toBe(true); expect(scope.work.worktree).toBeUndefined();
});

it("shows a planner unknown proposal in the existing plan check and keeps explicit choices until approval", async () => {
  const f = sourceFixture(), task = sourceTask(), scope = executionFor(task);
  const original: WorkChoice = { ...sourceChoice(), delivery: "pull-request" };
  task.workChoice = original; task.selectedProducts = [original];
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  await f.selections.propose(task, [{ ...sourceChoice("Shop API"), delivery: "pull-request" }]);
  expect(scope.work.worktree).toBeUndefined(); expect(task.delivery).toBe("pull-request");
  expect(task.workChoice).toEqual(original); expect(task.workError).toContain("Needs adding");
  expect(() => f.selections.confirm(task)).toThrow();
  await f.selections.propose(task, [original], true); f.selections.confirm(task);
  expect(task.error).toBeUndefined(); expect(task.confirmWork).toBe(false);
});

for (const startFrom of [{ kind: "branch", name: "release-2.x" }, { kind: "pull-request", value: "7" }] as const)
  it(`keeps a release with a ${startFrom.kind} choice stopped for correction`, async () => {
    const f = sourceFixture(), task = sourceTask(), scope = executionFor(task);
    task.delivery = "release"; scope.work.delivery = "release";
    const choice: WorkChoice = { ...sourceChoice(), startFrom, delivery: "release" };
    await f.selections.propose(task, [choice]);
    expect(task.workError).toContain("Releases start from the default branch");
    expect(task.delivery).toBe("release"); expect(scope.work.worktree).toBeUndefined();
    expect(f.calls).toEqual([]); expect(() => f.selections.confirm(task)).toThrow("Releases start from the default branch");
  });

it("keeps an unchanged default plan editable until it is approved", async () => {
  const f = sourceFixture(), task = sourceTask(), scope = executionFor(task);
  const original = sourceChoice(); task.workChoice = original;
  f.scripts.validBranch = async () => true; f.scripts.requireBranch = async () => {};
  await f.selections.propose(task, [original]);
  expect(scope.work.worktree).toBeUndefined();
  expect(scope.work.source).toMatchObject({ confirmed: true, start: { kind: "default", branch: "main" } });
  await f.selections.propose(task, [sourceChoice("shop", "release-2.x")]);
  expect(scope.work.worktree).toBeUndefined();
  expect(task.proposedSource?.start).toMatchObject({ kind: "branch", branch: "release-2.x" });
  expect(scope.work.source?.start).toMatchObject({ kind: "default", branch: "main" }); expect(task.confirmWork).toBe(true);
  f.selections.confirm(task);
  expect(task.error).toBeUndefined(); expect(scope.work.source?.start).toMatchObject({ kind: "branch", branch: "release-2.x" });
});

for (const fork of [false, true]) it(`updates the original ${fork ? "fork" : "same-repository"} PR from a link`, async () => {
  const f = sourceFixture(), task = sourceTask(), scope = executionFor(task);
  f.scripts.pullRequest = async () => ({ number: 7, url: "https://github.com/acme/shop/pull/7", state: "open", headRepo: fork ? "contributor/demo" : "acme/shop", branch: "review-work" });
  const choice: WorkChoice = { ...sourceChoice(), delivery: "pull-request", startFrom: { kind: "pull-request", value: "https://github.com/acme/shop/pull/7" } };
  task.workChoice = choice;
  await f.selections.propose(task, [choice]);
  expect(scope.work.worktree).toBeUndefined(); expect(scope.work.source).toBeUndefined();
  expect(task.proposedSource?.destination.repo).toBe(fork ? "contributor/demo" : "acme/shop");
  expect(task.plan?.stages.find(stage => stage.roleId === "release-manager")?.title).toBe("Update PR #7");
  f.selections.confirm(task);
  expect(scope.work.source?.destination.kind).toBe("update-pr"); expect(f.calls).toEqual(["pr:acme/shop:7"]);
});
