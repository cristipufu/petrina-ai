import { describe, expect, it } from "vitest";
import {
  applyTakeOverHandChanges,
  invalidateHandEditedRepositoryWork,
  takeOverBranchProblem,
} from "../../../src/index.js";
import { repairTask } from "../../fixtures/tasks.js";

describe("take-over workflow rules", () => {
  it("reports plain-language branch problems for busy, detached-reviewer, and primary working copies", () => {
    expect(
      takeOverBranchProblem({ worktree: "/work/main", branch: "petrina/task" }, "/work/main", {
        busy: "a rebase",
        branch: "petrina/task",
      }),
    ).toContain("middle of a rebase");
    expect(
      takeOverBranchProblem({ worktree: "/work/main", branch: "petrina/task" }, "/work/reviewer", {
        branch: "other",
      }),
    ).toContain("reviewer's working copy switched to a branch");
    expect(
      takeOverBranchProblem({ worktree: "/work/main", branch: "petrina/task" }, "/work/main", {
        branch: "wrong-branch",
      }),
    ).toContain("no longer on the task's branch");
    expect(
      takeOverBranchProblem({ worktree: "/work/main", branch: "petrina/task" }, "/work/main", {
        branch: "petrina/task",
      }),
    ).toBeUndefined();
  });

  it("deduplicates blocking tamper findings, invalidates repository check caches, and schedules rereview when needed", () => {
    const task = repairTask(true);
    task.stageIndex = 2;
    const workA = task.repositories![0]!;
    workA.checks = { at: 100, current: true, results: [] };
    workA.reviewedTree = "tree-1";
    workA.checkedSha = "sha-1";
    workA.checkedPatch = "patch-1";

    invalidateHandEditedRepositoryWork(task, workA);
    expect(workA.checks.current).toBe(false);
    expect(workA.reviewedTree).toBeUndefined();
    expect(workA.checkedSha).toBeUndefined();
    expect(workA.checkedPatch).toBeUndefined();
    expect(task.handChanges).toBe(true);

    let seq = 0;
    const outcomes = applyTakeOverHandChanges(
      task,
      [
        { productId: "a", sha: "head-a", problems: ["Removed test case in auth.test.ts"] },
        { productId: "a", sha: "head-a", problems: ["Removed test case in auth.test.ts"] },
      ],
      { now: 900, nextFindingId: () => `finding-${++seq}` },
    );

    expect(outcomes).toHaveLength(2);
    expect(workA.tamper).toEqual({
      at: 900,
      sha: "head-a",
      problems: ["Removed test case in auth.test.ts"],
    });
    expect(task.findings).toEqual([
      {
        id: "finding-1",
        productIds: ["a"],
        text: "Removed test case in auth.test.ts",
        severity: "blocking",
        raisedBy: "petrina",
        confirmedBy: [],
        status: "open",
      },
    ]);
    expect(task.rereview).toBe("review");
  });
});
