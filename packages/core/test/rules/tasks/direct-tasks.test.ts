import { describe, expect, it } from "vitest";
import { checksCurrent } from "../../../src/check-activity.js";
import { copyNoLongerNeeded, needsPullRequestCheck } from "../../../src/cleanup.js";
import { combinedBacklogInput } from "../../../src/combine-backlog.js";
import {
  activeCheckDiscoveryTask,
  checkDiscoveryTaskInput,
  directCapableRoles,
  directTaskProblem,
  hasNoProductChanges,
  isDirectCapableRole,
  prepareDirectTask,
} from "../../../src/direct-tasks.js";
import type { DeepMutable } from "../../../src/flow.js";
import { HISTORY_STATUSES, historyItem, historyStatus } from "../../../src/history.js";
import type { Role, TaskState } from "../../../src/model.js";
import { profileReferences } from "../../../src/profiles.js";
import { publishingResult, publishingWords } from "../../../src/publishing-result.js";
import { displayTask } from "../../../src/repositories.js";
import { roleForTask } from "../../../src/roles.js";
import { Simulator } from "../../../src/sim.js";
import { nextSteps } from "../../../src/summary.js";
import { workflowFixture } from "../../fixtures/workflow.js";

const { state: initial, task: stored } = workflowFixture();

describe("direct single-agent task rules", () => {
  it("selects direct-capable roles by result contract rather than role name", () => {
    const customReviewerNamedBuilder: Role = {
      ...initial.roles.find((role) => role.result === "findings")!,
      id: "builder-named-reviewer",
      name: "Builder",
      added: true,
    };
    const customNotesRole: Role = {
      ...initial.roles.find((role) => role.result === "notes")!,
      id: "investigator",
      name: "Investigator",
      added: true,
    };
    const editingNotesHelper: Role = { ...customNotesRole, id: "editing-notes-helper", canEdit: true };
    const removedNotesRole: Role = { ...customNotesRole, id: "removed-investigator", removed: true };
    const roles = [...initial.roles, customReviewerNamedBuilder, customNotesRole, editingNotesHelper, removedNotesRole];

    expect(isDirectCapableRole(customReviewerNamedBuilder)).toBe(false);
    expect(isDirectCapableRole(customNotesRole)).toBe(true);
    expect(isDirectCapableRole(editingNotesHelper)).toBe(false);
    expect(isDirectCapableRole(removedNotesRole)).toBe(false);

    const eligibleIds = directCapableRoles(roles).map((role) => role.id);
    expect(eligibleIds).toContain("researcher");
    expect(eligibleIds).toContain("builder");
    expect(eligibleIds).toContain("check-finder");
    expect(eligibleIds).toContain("investigator");
    expect(eligibleIds).not.toContain("editing-notes-helper");
    expect(eligibleIds).not.toContain("planner");
    expect(eligibleIds).not.toContain("code-reviewer");
    expect(eligibleIds).not.toContain("verifier");
    expect(eligibleIds).not.toContain("release-manager");
    expect(eligibleIds).not.toContain("builder-named-reviewer");
    expect(eligibleIds).not.toContain("removed-investigator");

    expect(directTaskProblem({ roleId: "researcher", profileId: "opus-high" }, [], initial)).toContain("one registered product");
    expect(directTaskProblem({ roleId: "researcher", profileId: "opus-high" }, ["shop", "docs"], initial)).toContain("one registered product");
    expect(directTaskProblem({ roleId: "builder-named-reviewer", profileId: "opus-high" }, ["shop"], { ...initial, roles })).toContain("role");
    expect(directTaskProblem({ roleId: "researcher", profileId: "missing-profile" }, ["shop"], initial)).toContain("agent profile");
    expect(directTaskProblem({ roleId: "researcher", profileId: "opus-high" }, ["shop"], initial)).toBeUndefined();
  });

  it("builds a one-stage pipeline for read-only roles and freezes role and profile references", () => {
    const task = JSON.parse(JSON.stringify(stored)) as DeepMutable<TaskState>;
    task.productId = "shop";
    task.selectedProducts = [{ productId: "shop", startFrom: { kind: "default" }, delivery: "pull-request" }];
    task.approvePlan = true;
    task.approveDelivery = true;

    prepareDirectTask(task, { roleId: "researcher", profileId: "opus-high" }, initial);

    expect(task.approvePlan).toBe(false);
    expect(task.stageIndex).toBe(0);
    expect(task.plan?.stages.map((stage) => [stage.kind, stage.roleId])).toEqual([["do", "researcher"]]);
    expect(roleForTask([], "researcher", task)?.name).toBe("Researcher");
    expect(profileReferences({ ...initial, tasks: [displayTask({ ...task, state: "queued" })], routines: [] }, "opus-high")).toContain(
      `task “${task.title}”`,
    );

    prepareDirectTask(task, { roleId: "check-finder", profileId: "opus-high" }, initial);
    const runningDiscovery = displayTask({
      ...task,
      state: "running",
      agent: { roleId: "check-finder", profileId: "opus-high", since: 10, step: 0 },
      checkActivity: { phase: "preparing", productId: "shop", since: 10, slots: 1 },
    });
    expect(nextSteps(initial, runningDiscovery)).toBeUndefined();
    expect(checksCurrent(runningDiscovery, initial.roles)).toBe(false);
    expect(activeCheckDiscoveryTask([{ ...runningDiscovery, state: "backlog" }], initial.roles, "shop")).toBeUndefined();
    expect(activeCheckDiscoveryTask([{ ...runningDiscovery, state: "paused" }], initial.roles, "shop")).toBeUndefined();
    expect(activeCheckDiscoveryTask([runningDiscovery], initial.roles, "shop")).toBe(runningDiscovery.id);
  });

  it("appends only delivery stages for roles that can edit the product", () => {
    const task = JSON.parse(JSON.stringify(stored)) as DeepMutable<TaskState>;
    task.productId = "shop";
    task.selectedProducts = [{ productId: "shop", startFrom: { kind: "default" }, delivery: "pull-request" }];
    task.delivery = "pull-request";
    task.approveDelivery = true;

    prepareDirectTask(task, { roleId: "builder", profileId: "opus-high" }, initial);
    expect(task.plan?.stages.map((stage) => [stage.kind, stage.roleId])).toEqual([
      ["do", "builder"],
      ["gate", "release-manager"],
      ["do", "release-manager"],
    ]);

    task.approveDelivery = false;
    task.delivery = "release";
    prepareDirectTask(task, { roleId: "builder", profileId: "opus-high" }, initial);
    expect(task.plan?.stages.map((stage) => [stage.kind, stage.roleId])).toEqual([
      ["do", "builder"],
      ["do", "release-manager"],
    ]);
  });

  it("reports finished no-change direct tasks across history and publishing summaries", () => {
    const finishedStored: TaskState = {
      ...stored,
      state: "done",
      delivery: "pull-request",
      noProductChanges: true,
      repository: {
        productId: "shop",
        delivery: "pull-request",
        cleanup: { pullRequest: "none" },
      },
    };
    const finished = displayTask(finishedStored);
    const item = historyItem(finished);
    expect(hasNoProductChanges(finished)).toBe(true);
    expect(historyStatus(item)).toBe("no-changes");
    expect(HISTORY_STATUSES[historyStatus(item)]).toBe("No product changes");
    expect(item.noProductChanges).toBe(true);
    expect(item.cleanup).toBeUndefined();
    expect(needsPullRequestCheck(finished)).toBe(false);
    expect(copyNoLongerNeeded(finished)).toBe(true);
    const result = publishingResult(
      finishedStored,
      { productId: "shop", delivery: "pull-request", completedStages: [] },
      false,
    );
    expect(result).toEqual({ kind: "no-changes", landed: null });
    expect(publishingWords(result)).toBe("no product changes");
  });

  it("preserves matching single-agent backlog choices when combining and rejects mixed modes", () => {
    const makeBacklog = (id: string, title: string, direct?: { roleId: string; profileId: string }) => {
      const entry = JSON.parse(JSON.stringify(stored)) as DeepMutable<TaskState>;
      entry.id = id;
      entry.title = title;
      entry.description = `Details for ${title}`;
      entry.productId = "shop";
      entry.selectedProducts = [{ productId: "shop", startFrom: { kind: "default" }, delivery: "pull-request" }];
      entry.state = "backlog";
      entry.column = "backlog";
      delete entry.startedAt;
      if (direct) prepareDirectTask(entry, direct, initial);
      return displayTask(entry);
    };

    const directA = makeBacklog("b-1", "Audit auth flow", { roleId: "researcher", profileId: "opus-high" });
    const directB = makeBacklog("b-2", "Audit session cookies", { roleId: "researcher", profileId: "opus-high" });
    const directBuilder = makeBacklog("b-3", "Fix typo", { roleId: "builder", profileId: "opus-high" });
    const planned = makeBacklog("b-4", "Add SSO", undefined);
    const checkA = makeBacklog("b-5", "Find checks 1", { roleId: "check-finder", profileId: "opus-high" });
    const checkB = makeBacklog("b-6", "Find checks 2", { roleId: "check-finder", profileId: "opus-high" });

    const combined = combinedBacklogInput([directA, directB], ["b-1", "b-2"], "Combined auth audit");
    expect(combined.direct).toEqual({ roleId: "researcher", profileId: "opus-high" });

    expect(() => combinedBacklogInput([directA, planned], ["b-1", "b-4"], "Mixed")).toThrow("same execution mode");
    expect(() => combinedBacklogInput([directA, directBuilder], ["b-1", "b-3"], "Mismatched role")).toThrow(
      "same execution mode",
    );
    expect(() => combinedBacklogInput([checkA, checkB], ["b-5", "b-6"], "Duplicate checks")).toThrow(
      "Check-discovery tasks",
    );
  });

  it("deduplicates and executes single-node check discovery and direct tasks in the offline Simulator", () => {
    const sim = new Simulator(JSON.parse(JSON.stringify({ ...initial, tasks: [], inbox: [], pool: { ...initial.pool, paused: true } })));
    const product = sim.getState().products[0]!;
    sim.setProductChecks(product.id, [{ name: "Manual check", command: "bun run lint" }]);

    // Cancelling a queued check-discovery run preserves coordinator-saved checks.
    const cancelledId = sim.discoverProductChecks(product.id);
    sim.cancel(cancelledId);
    expect(sim.getState().products.find((entry) => entry.id === product.id)?.checksBy).toBe("coordinator");
    expect(sim.getState().products.find((entry) => entry.id === product.id)?.checks?.[0]?.name).toBe("Manual check");

    const firstId = sim.discoverProductChecks(product.id);
    const secondId = sim.discoverProductChecks(product.id);
    expect(secondId).toBe(firstId);
    expect(activeCheckDiscoveryTask(sim.getState().tasks, sim.getState().roles, product.id)).toBe(firstId);
    sim.setPoolPaused(false);

    const researchId = sim.addTask({
      productId: product.id,
      title: "Audit caching layer",
      description: "Summarize how cache keys are invalidated.",
      direct: { roleId: "researcher", profileId: sim.getState().profiles[0]!.id },
    });

    for (let step = 0; step < 80; step++) {
      const state = sim.getState();
      const discoveryDone = state.tasks.find((task) => task.id === firstId)?.state === "done";
      const researchDone = state.tasks.find((task) => task.id === researchId)?.state === "done";
      if (discoveryDone && researchDone) break;
      sim.tick();
    }

    const after = sim.getState();
    const updatedProduct = after.products.find((entry) => entry.id === product.id)!;
    expect(updatedProduct.checksBy).toBe("finder");
    expect((updatedProduct.checks?.length ?? 0) > 0).toBe(true);
    expect(activeCheckDiscoveryTask(after.tasks, after.roles, product.id)).toBeUndefined();

    const discoveryTask = after.tasks.find((task) => task.id === firstId)!;
    expect(discoveryTask.state).toBe("done");
    expect(discoveryTask.noProductChanges).toBe(true);
    expect(discoveryTask.statusLine).toBe("Completed · No product changes");
    expect(historyStatus(historyItem(discoveryTask))).toBe("no-changes");

    const researchTask = after.tasks.find((task) => task.id === researchId)!;
    expect(researchTask.state).toBe("done");
    expect(researchTask.noProductChanges).toBe(true);
    expect(researchTask.handedBack?.length).toBe(1);

    const request = checkDiscoveryTaskInput(product, after);
    expect(request.direct?.roleId).toBe("check-finder");
  });
});
