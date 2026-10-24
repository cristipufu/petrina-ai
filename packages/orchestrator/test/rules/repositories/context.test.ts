import { expect, it } from "vitest";
import { detachRepositoryState, executionFor, executionOf, repositoryView, restoreRepositoryState, scopesFor, taskView } from "../../../src/index.js";
import { repairTask } from "../../fixtures/tasks.js";

it.each([false, true])("enumerates canonical owners without copying execution state (shared: %s)", shared => {
  const task = repairTask(shared);
  const contexts = scopesFor(task);
  expect(contexts.map(context => context.work.productId)).toEqual(shared ? ["a", "b"] : ["a"]);
  expect(contexts.every(context => context.task === task)).toBe(true);
  expect(contexts[0]!.work).toBe(shared ? task.repositories![0] : task.repository);
  task.excludedRepositories = [{ productId: "removed", delivery: "local", completedStages: [] }];
  expect(scopesFor(task).map(context => context.work.productId)).not.toContain("removed");
  expect(scopesFor(task, { includeExcluded: true }).at(-1)!.work).toBe(task.excludedRepositories[0]);
});

it("retains an operation's owner while the visible repository changes", () => {
  const task = repairTask(), bound = executionFor(task, "a");
  bound.work.report = { summary: "Shop report", changes: [] };
  task.repositories![1]!.report = { summary: "API report", changes: [] };
  task.activeProductId = "b";
  expect(executionOf(bound)).toBe(bound);
  expect(executionOf(task).work).toBe(task.repositories![1]);
  expect(repositoryView(bound).report?.summary).toBe("Shop report");
  expect(taskView(task).report?.summary).toBe("API report");
  expect(bound.work).toBe(task.repositories![0]);
});

it("refuses an unapproved product, including an explicitly empty approved map", () => {
  const task = repairTask();
  expect(() => executionFor(task, "foreign")).toThrow("outside the approved task");
  task.repositories = [];
  // A stale single-product field cannot turn an empty approved map into an owner.
  task.repository = { productId: "a", delivery: "local" };
  expect(scopesFor(task)).toEqual([]);
  expect(() => executionFor(task)).toThrow("outside the approved task");
  expect(taskView(task)).toBe(task);
});

it.each([false, true])("projects the selected execution without changing canonical task defaults (shared: %s)", shared => {
  const task = repairTask(shared), work = executionFor(task, "a").work;
  work.worktree = "owned-workspace"; work.delivery = "release";
  const before = structuredClone(task), view = repositoryView({ task, work });
  expect(view.repository).toBeUndefined();
  expect(view.worktree).toBe("owned-workspace"); expect(view.delivery).toBe("release");
  expect(view.workChoice).toEqual(task.workChoice);
  expect(task).toEqual(before); expect(view).not.toBe(task);
});

it.each([false, true])("restores legacy execution fields into their actual owner once (shared: %s)", shared => {
  const task = repairTask(shared);
  if (shared) task.activeProductId = "b";
  const legacy = { ...task, prAge: 20, worktree: "legacy-workspace", report: { summary: "Saved report", changes: [] } };
  restoreRepositoryState(legacy);
  expect(executionFor(legacy).work.worktree).toBe("legacy-workspace");
  expect(executionFor(legacy).work.report?.summary).toBe("Saved report");
  expect(Object.hasOwn(legacy, "worktree")).toBe(false);
  expect(Object.hasOwn(legacy, "report")).toBe(false);
  expect(Object.hasOwn(legacy, "prAge")).toBe(false);
  if (shared) expect(executionFor(legacy, "a").work.worktree).toBeUndefined();
  const before = structuredClone(legacy);
  restoreRepositoryState(legacy);
  expect(legacy).toEqual(before);
});

it("detaches stale projections while retaining requested defaults and repository records", () => {
  const task = repairTask(), first = task.repositories![0]!;
  const legacy = { ...task, worktree: "stale-view", repository: { productId: "stale", delivery: "local" as const } };
  detachRepositoryState(legacy);
  expect(legacy.repository).toBeUndefined(); expect(Object.hasOwn(legacy, "worktree")).toBe(false);
  expect(legacy.productId).toBe("a"); expect(legacy.delivery).toBe(task.delivery);
  expect(legacy.workChoice).toBe(task.workChoice); expect(legacy.repositories![0]).toBe(first);
});
