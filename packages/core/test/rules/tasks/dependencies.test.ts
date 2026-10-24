import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILES } from "../../../src/library.js";
import { assignFutureProfile, appendFutureReviewer, blockingDependencies, validateTaskDependencies } from "../../../src/task-transitions.js";
import { request } from "../../fixtures/task-request.js";

describe("shared dependency and future plan rules", () => {
  it("checks lazy dependency chains without changing existing dependencies on rejection", () => {
    const a = request({}, "a"), b = request({}, "b"), c = request({}, "c");
    b.after = ["c"]; c.after = ["a"];
    const records = new Map([a, b, c].map((task) => [task.id, task]));
    expect(() => validateTaskDependencies("a", ["b"], (id) => records.get(id))).toThrow("each other");
    expect(a.after).toBeUndefined();
    expect(() => validateTaskDependencies("a", ["missing"], (id) => records.get(id))).toThrow("Unknown task");
    expect(() => validateTaskDependencies("a", ["a"], (id) => records.get(id))).toThrow("itself");
    expect(validateTaskDependencies("c", ["a", "a"], (id) => records.get(id))).toEqual(["a"]);
  });

  it("keeps a delivered shared pull request blocking until its landing is settled", () => {
    const dependency = request({}, "dependency");
    dependency.state = "done";
    dependency.repositories = [{ productId: "a", delivery: "pull-request", completedStages: [], pr: { number: 1, url: "https://example.test/1", state: "open", openedAt: 100 } }];
    const task = request(); task.after = [dependency.id];
    expect(blockingDependencies(task, () => dependency)).toEqual([dependency]);
    dependency.repositories![0]!.pr!.state = "merged";
    expect(blockingDependencies(task, () => dependency)).toEqual([]);
    dependency.repositories![0]!.pr!.state = "closed";
    expect(blockingDependencies(task, () => dependency)).toHaveLength(1);
    dependency.repositories![0]!.landingAccepted = { at: 200 };
    expect(blockingDependencies(task, () => dependency)).toEqual([]);
  });

  it("preserves partially specified reviewer roles and refuses to change current or past work", () => {
    const task = request();
    task.stageIndex = 0;
    task.plan = { rationale: "A focused review", plannerProfileId: "sonnet-medium", stages: [
      { id: "build", kind: "do", roleId: "builder", title: "Build", profileIds: ["sol-high"] },
      { id: "review", kind: "review-chain", roleId: "code-reviewer", title: "Review", profileIds: ["sol-high", "opus-high"], roleIds: ["security-reviewer"], maxRounds: 2 },
    ] };
    expect(assignFutureProfile(task, DEFAULT_PROFILES, "build", "profileIds", 0, "opus-high")).toBeUndefined();
    expect(appendFutureReviewer(task, DEFAULT_PROFILES, "review", "sol-xhigh")).toBe("Review");
    expect(task.plan!.stages[1]!.roleIds).toEqual(["security-reviewer", "code-reviewer", "code-reviewer"]);
    expect(assignFutureProfile(task, DEFAULT_PROFILES, "review", "profileIds", 0, "missing")).toBeUndefined();
    expect(assignFutureProfile(task, DEFAULT_PROFILES, "review", "profileIds", 1, "sol-xhigh")).toBe("Review");
    expect(task.plan!.stages[1]!.profileIds).toEqual(["sol-high", "sol-xhigh", "sol-xhigh"]);
    expect(task.plan!.stages[1]!.assignments?.[1]).toEqual({ profileId: "sol-xhigh", by: "coordinator", reason: "Chosen by you." });
    expect(task.plan!.stages[1]!.assignments?.[2]).toEqual({ profileId: "sol-xhigh", by: "coordinator", reason: "Added to the review by you." });
  });
});
