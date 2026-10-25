import { recordedBuild, journeyState } from "../../fixtures/journey.js";

import { describe, expect, it } from "vitest";

import { beginAgentStep, beginPetrinaStep, beginYouStep, endAgentStep, endPetrinaStep, endYouStep, JOURNEY_WORDS as W, journeyProblems, journeyView, journeyViewKey, petrinaMoment, type JourneyTask, type JourneyView } from "../../../src/journey.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../../../src/library.js";
import { addRole, libraryRoles, NO_ROLE_CHANGES, ROLE_STARTS } from "../../../src/roles.js";
import type { State, Task } from "../../../src/model.js";

function emptyState(limit = 2): State {
  return {
    now: 0,
    seq: 0,
    products: [{ id: "p", name: "Product", repo: "acme/product", tone: "blue", delivery: "pull-request", approveDelivery: true }],
    roles: BUILT_IN_ROLES,
    tools: KNOWN_TOOLS,
    profiles: DEFAULT_PROFILES,
    tasks: [],
    inbox: [],
    pool: { limit, paused: false, toolCaps: {} },
    planner: "sonnet-medium",
  };
}

const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });

const boxes = (view: JourneyView) => view.nodes.map((node) => `${node.name}: ${node.state}`);

describe("recorded the way the engine records", () => {
  function atBuild(): Task & JourneyTask { return recordedBuild(); }

  it("keeps the first tester pass ahead, but leaves it out of fix rounds once the change was tried", () => {
    const task = atBuild();
    const stages = [...task.plan!.stages];
    stages.splice(task.stageIndex + 1, 0, { id: "try", title: "Try the change", kind: "do", roleId: "tester", profileIds: ["opus-high"] });
    const planned = { ...task, plan: { ...task.plan!, stages } };
    expect(journeyView(planned, contextOf(emptyState())).nodes.find((node) => node.state === "next")?.name).toBe("Tester");
    const fixing = { ...planned, fixing: true, testedPatch: "already-tried" };
    const ahead = journeyView(fixing, contextOf(emptyState())).nodes.filter((node) => node.state === "next" || node.state === "ahead");
    expect(ahead.some((node) => node.roleId === "tester")).toBe(false);
    expect(ahead[0]?.name).toBe("Code reviewers");
  });

  it("shows the delivery check after the final tester pass, without a phantom repeat of the reviewers", () => {
    const task = atBuild();
    const at = task.journey!.at(-1)!.startedAt;
    endAgentStep(task, { outcome: W.built, reason: W.readyForReview }, at + 1);
    const stages = [...task.plan!.stages];
    const index = task.stageIndex + 1;
    stages.splice(index, 0, { id: "try", title: "Try the change", kind: "do", roleId: "tester", profileIds: ["opus-high"] });
    const retesting = { ...task, plan: { ...task.plan!, stages }, stageIndex: index, retest: true, testedPatch: "earlier-code" };
    beginAgentStep(retesting, "tester", "opus-high", at + 2, BUILT_IN_ROLES);
    const view = journeyView(retesting, contextOf(emptyState()));
    expect(view.nodes.filter((node) => ["now", "next", "ahead"].includes(node.state)).map((node) => `${node.name}: ${node.state}`)).toEqual(["Tester: now", "Your delivery check: next", "Publish delivery: ahead"]);
  });

  it("shows an acceptance repair's test, then the reviews still owed; a repair of final testing returns to the delivery check", () => {
    const task = atBuild();
    const stages = [...task.plan!.stages];
    const index = task.stageIndex + 1;
    stages.splice(index, 0, { id: "try", title: "Try the change", kind: "do", roleId: "tester", profileIds: ["opus-high"] });
    const early = { ...task, plan: { ...task.plan!, stages }, fixing: true, testedPatch: "earlier-code", repair: { products: ["p"], index: 0, returnStage: index, kind: "acceptance" as const } };
    const ahead = (view: Task) => journeyView(view, contextOf(emptyState())).nodes.filter((node) => ["next", "ahead"].includes(node.state)).map((node) => node.name);
    expect(ahead(early)).toEqual(["Tester", "Code reviewers", "Your delivery check", "Publish delivery"]);
    expect(ahead({ ...early, repair: { ...early.repair, final: true } })).toEqual(["Tester", "Your delivery check", "Publish delivery"]);
    // A review repair still leaves acceptance, already tried, out of the fix round.
    expect(ahead({ ...early, repair: { ...early.repair, kind: "review" } })).toEqual(["Code reviewers", "Your delivery check", "Publish delivery"]);
    // The repair is finished and its test has not started yet, as while paused or waiting for a slot: that test is next.
    const { repair: _done, ...finished } = early;
    const checking = { ...finished, stageIndex: index, fixing: false, repairCheck: true, state: "paused" as const };
    expect(ahead(checking)).toEqual(["Tester", "Code reviewers", "Your delivery check", "Publish delivery"]);
    expect(journeyViewKey(checking, contextOf(emptyState()))).not.toBe(journeyViewKey({ ...checking, repairCheck: false }, contextOf(emptyState())));
    // Failing product checks before that test send the work back first: the test, then the reviews, still follow.
    expect(ahead({ ...early, repair: { ...early.repair, kind: "checks" }, repairCheck: true })).toEqual(["Tester", "Code reviewers", "Your delivery check", "Publish delivery"]);
    // A task saved before repairs recorded their route, at a delivery check Petrina added: its reviews never ran, so they
    // follow its test, as the engine routes it. At a planned check, final testing goes straight there.
    const gate = stages.find((stage) => stage.kind === "gate" && stage.gate === "delivery")!;
    const older = { ...checking, repairCheck: false, retest: true, proofDeliveryGate: gate.id };
    expect(ahead(older)).toEqual(["Tester", "Code reviewers", "Your delivery check", "Publish delivery"]);
    expect(ahead({ ...older, proofDeliveryGate: undefined })).toEqual(["Tester", "Your delivery check", "Publish delivery"]);
    expect(journeyViewKey(older, contextOf(emptyState()))).not.toBe(journeyViewKey({ ...older, proofDeliveryGate: undefined }, contextOf(emptyState())));
  });

  it("a stuck step shows its failed box, a Stuck step and a new box for the next attempt", () => {
    const task = atBuild();
    const t = task.journey!.at(-1)!.startedAt;
    endAgentStep(task, { outcome: W.stuck, reason: W.stuckReason, tone: "stuck", end: "failed" }, t + 100);
    beginYouStep(task, "stuck", t + 100);
    const state = emptyState();
    let view = journeyView({ ...task, state: "failed", statusLine: "Stuck. Needs you" }, contextOf(state));
    expect(boxes(view)).toEqual(["Planner: done", "Builder: failed", "Stuck: you", "Builder (again): next", "Code reviewers: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]);
    expect(view.nodes[1]).toMatchObject({ reason: "stuck", tone: "stuck" });

    endYouStep(task, { outcome: W.triedAgain, reason: W.tryAgain }, t + 200);
    beginAgentStep(task, "builder", "opus-high", t + 300, BUILT_IN_ROLES);
    view = journeyView({ ...task, state: "running" }, contextOf(state));
    expect(boxes(view).slice(0, 4)).toEqual(["Planner: done", "Builder: failed", "Stuck: done", "Builder (again): now"]);
    expect(view.nodes[2]).toMatchObject({ reason: "you asked to try again", startedAt: t + 100, endedAt: t + 200 });
    expect(journeyProblems({ ...task, state: "running" })).toEqual([]);
  });

  it("keeps the delivery check ahead when Petrina gets stuck before asking it", () => {
    const task = recordedBuild();
    endAgentStep(task, { outcome: W.built, reason: W.readyForReview }, 2);
    task.stageIndex = 2;
    beginYouStep(task, "stuck", task.journey!.at(-1)!.endedAt!);
    const view = journeyView({ ...task, state: "failed" }, contextOf(journeyState()));
    expect(boxes(view).slice(-3)).toEqual(["Stuck: you", "Your delivery check: next", "Publish delivery: ahead"]);
  });

  it.each([
    ["check-finder", "Code reviewers", "review-chain"],
    ["guide-keeper", "Builder (fixes)", "do"],
  ] as const)("keeps the main work ahead while the %s helps", (roleId, next, kind) => {
    const task = recordedBuild();
    endAgentStep(task, { outcome: "Finished", reason: "ready" }, 2);
    if (kind === "review-chain") task.stageIndex = 1;
    // The Guide keeper runs before the builder begins its requested fixes.
    const helping = { ...task, fixing: roleId === "guide-keeper" };
    beginAgentStep(helping, roleId, "opus-high", 3, BUILT_IN_ROLES);
    const view = journeyView(helping, contextOf(journeyState()));
    expect(view.nodes.find((node) => node.state === "now")).toMatchObject({ roleId });
    expect(view.nodes.find((node) => node.state === "next")).toMatchObject({ name: next });
  });

  it("a port after main moved gets one reviewer, named as a port review, and main moving on is no round", () => {
    const task = atBuild();
    const state = emptyState();
    const stages = task.plan!.stages;
    const build = task.stageIndex;
    const review = stages.findIndex((stage) => stage.kind === "review-chain");
    const t = task.journey!.at(-1)!.startedAt;
    endAgentStep(task, { outcome: W.built, reason: W.readyForReview }, t + 100);
    // Round 2 starts by putting the work on top of main, which conflicts: the builder gets it back.
    task.stageIndex = review;
    task.rounds = { ...task.rounds, [stages[review]!.id]: 2 };
    petrinaMoment(task, "update", { outcome: W.mainMoved(1), reason: W.conflicts(), tone: "back" }, t + 110);
    task.stageIndex = build;
    task.updating = { from: "a", onto: "b", head: "c", files: ["greeting.txt"] };
    // A saved head alone (including an older task) does not prove the feature completed review.
    const unreviewed = journeyView({ ...task, state: "running" }, contextOf(state));
    expect(unreviewed.nodes.some((node) => node.name === "Code reviewer (port)")).toBe(false);
    expect(unreviewed.nodes.find((node) => node.roleId === "code-reviewer")!.team).toHaveLength(stages[review]!.profileIds.length);
    task.reviewedTree = "the code that passed ordinary review";
    let view = journeyView({ ...task, state: "running" }, contextOf(state));
    expect(boxes(view).slice(2, 5)).toEqual(["Update branch: done", "Builder (update): next", "Code reviewer (port): ahead"]);
    // The faint port review names the one reviewer the engine picks: on a tool other than the builder's.
    const builderTool = state.profiles.find((profile) => profile.id === stages[build]!.profileIds[0])?.toolId;
    const port = view.nodes.find((node) => node.name === "Code reviewer (port)")!;
    expect(port.team).toBeUndefined();
    expect(stages[review]!.profileIds).toContain(port.profileId);
    if (stages[review]!.profileIds.some((id) => state.profiles.find((profile) => profile.id === id)?.toolId !== builderTool)) {
      expect(state.profiles.find((profile) => profile.id === port.profileId)?.toolId).not.toBe(builderTool);
    }

    beginAgentStep(task, "builder", stages[build]!.profileIds[0]!, t + 120, BUILT_IN_ROLES);
    endAgentStep(task, { outcome: W.broughtUpToDate, reason: W.upToDate }, t + 200);
    delete task.updating;
    task.portReview = { from: "a", head: "c", onto: "b", files: ["greeting.txt"] };
    task.stageIndex = review;
    beginPetrinaStep(task, "checks", t + 200);
    endPetrinaStep(task, { outcome: W.checks(0, 2), reason: W.checksPassed }, t + 210);
    beginAgentStep(task, "code-reviewer", port.profileId!, t + 210, BUILT_IN_ROLES, [port.profileId!]);
    view = journeyView({ ...task, state: "running" }, contextOf(state));
    expect(boxes(view).slice(2, 7)).toEqual(["Update branch: done", "Builder (update): done", "Automated checks (port): done", "Code reviewer (port): now", "Your delivery check: next"]);
    expect(journeyProblems({ ...task, state: "running" })).toEqual([]);
  });

  it("names the port reviewer away from the latest builder's actual tool", () => {
    const task = atBuild();
    task.reviewedTree = "the code that passed ordinary review";
    const state = emptyState();
    const build = task.plan!.stages[task.stageIndex]!;
    const planned = state.profiles.find((profile) => profile.id === build.profileIds[0])!;
    const actual = state.profiles.find((profile) => profile.toolId !== planned.toolId)!;
    endAgentStep(task, { outcome: W.broughtUpToDate, reason: W.upToDate }, task.journey!.at(-1)!.startedAt + 1);
    task.builderSession = { stageId: build.id, profileId: actual.id, toolId: actual.toolId, model: actual.modelId ?? actual.model, sessionId: "latest-port" };
    task.portReview = { from: "a", head: "c", onto: "b", files: ["greeting.txt"] };
    task.stageIndex = task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
    const port = journeyView(task, contextOf(state)).nodes.find((node) => node.name === "Code reviewer (port)")!;
    expect(state.profiles.find((profile) => profile.id === port.profileId)?.toolId).toBe(planned.toolId);
    expect(port.team).toBeUndefined();
  });

  it("names an added reviewer when it is chosen to review the port", () => {
    const task = atBuild();
    task.reviewedTree = "the code that passed ordinary review";
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find((start) => start.id === "security")!.draft);
    const state = { ...emptyState(), roles: libraryRoles(added.changes) };
    const review = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
    const builder = task.plan!.stages[task.stageIndex]!.profileIds[0]!;
    const builderTool = state.profiles.find((profile) => profile.id === builder)!.toolId;
    const reviewer = state.profiles.find((profile) => profile.toolId !== builderTool)!.id;
    task.plan = { ...task.plan!, stages: task.plan!.stages.map((stage) => stage === review ? { ...stage, profileIds: [builder, reviewer], roleIds: ["code-reviewer", added.roleId] } : stage) };
    task.updating = { from: "a", onto: "b", head: "c", files: ["greeting.txt"] };
    const port = journeyView(task, contextOf(state)).nodes.find((node) => node.name === "Security specialist (port)")!;
    expect(port).toMatchObject({ roleId: added.roleId, profileId: reviewer });
    expect(port.team).toBeUndefined();
  });

  it.each(["update", "saved port"] as const)("keeps every planned reviewer, including an added role, during a %s without review proof", (kind) => {
    const task = atBuild();
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find((start) => start.id === "security")!.draft);
    const state = { ...emptyState(), roles: libraryRoles(added.changes) };
    const review = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
    const builder = task.plan!.stages[task.stageIndex]!.profileIds[0]!;
    const builderTool = state.profiles.find((profile) => profile.id === builder)!.toolId;
    const reviewer = state.profiles.find((profile) => profile.toolId !== builderTool)!.id;
    const planned = { ...review, profileIds: [builder, reviewer], roleIds: ["code-reviewer", added.roleId] };
    task.plan = { ...task.plan!, stages: task.plan!.stages.map((stage) => stage === review ? planned : stage) };
    if (kind === "update") task.updating = { from: "a", onto: "b", head: "c", files: ["greeting.txt"] };
    else {
      endAgentStep(task, { outcome: W.broughtUpToDate, reason: W.upToDate }, task.journey!.at(-1)!.startedAt + 1);
      task.portReview = { from: "a", head: "c", onto: "b", files: ["greeting.txt"] };
      task.stageIndex = task.plan.stages.indexOf(planned);
    }
    const view = journeyView(task, contextOf(state));
    expect(view.nodes.some((node) => node.name.includes("(port)"))).toBe(false);
    const ordinary = view.nodes.find((node) => node.stageId === review.id)!;
    expect(ordinary).toMatchObject({ roleId: "code-reviewer", team: [builder, reviewer] });
    expect(planned.roleIds).toEqual(["code-reviewer", added.roleId]);
    expect(task.reviewedTree).toBeUndefined();
  });

  it("picking up the same step continues its box", () => {
    const task = atBuild();
    const open = task.journey!.at(-1)!;
    expect(beginAgentStep(task, "builder", "opus-high", open.startedAt + 5_000, BUILT_IN_ROLES)).toBe(open);
    expect(task.journey!.filter((step) => step.roleId === "builder")).toHaveLength(1);
  });
});
