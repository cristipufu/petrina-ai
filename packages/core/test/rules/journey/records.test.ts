import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { planningJourney } from "../../fixtures/journey.js";

import { describe, expect, it } from "vitest";

import { beginAgentStep, endAgentStep, JOURNEY_WORDS as W, journeyView, journeyViewKey, legacyJourney, portReviewerIndex, recordStepResult, stopCheckProgress, type JourneyTask } from "../../../src/journey.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../../../src/library.js";

import type { State, Task } from "../../../src/model.js";
import type { DeepMutable } from "../../../src/flow.js";

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

describe("a task's journey", () => {
  it("records exactly which open findings were assigned to a Builder fix round", () => {
    const task: JourneyTask = {
      plan: { stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["codex"] }], rationale: "", plannerProfileId: "planner" },
      stageIndex: 0, rounds: {}, sub: 0, fixing: true, journey: [],
      findings: [
        { id: "open", text: "Fix this", severity: "blocking", raisedBy: "reviewer", confirmedBy: [], status: "open" },
        { id: "fixed", text: "Already fixed", severity: "blocking", raisedBy: "reviewer", confirmedBy: [], status: "fixed" },
        { id: "old", text: "Pre-existing", severity: "pre-existing", raisedBy: "reviewer", confirmedBy: [], status: "open" },
      ],
    };
    const step = beginAgentStep(task, "builder", "codex", 10, BUILT_IN_ROLES);
    expect(step.findingIds).toEqual(["open"]);
  });

  it("uses result contracts for renamed build, test, delivery, planner and verifier roles", () => {
    const state = emptyState();
    const kinds = ["build", "checks", "delivery", "plan", "votes"];
    const roles = state.roles.map(role => kinds.includes(role.result) ? { ...role, id: `renamed-${role.id}`, name: `Renamed ${role.name}` } : role);
    const roleId = (kind: string) => roles.find(role => role.result === kind)!.id;
    const task = JSON.parse(JSON.stringify({ ...taskFixture(state), startedAt: 0, state: "running", stageIndex: 0, sub: 0, rounds: {}, fixing: true, journey: [], builderSession: undefined, delivery: "pull-request", plan: {
      rationale: "Roles follow their result", plannerProfileId: "sol-high", stages: [
        { id: "build", kind: "do", title: "Build", roleId: roleId("build"), profileIds: ["sol-high"] },
        { id: "test", kind: "do", title: "Test", roleId: roleId("checks"), profileIds: ["opus-high"] },
        { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
        { id: "gate", kind: "gate", title: "Delivery check", roleId: roleId("delivery"), profileIds: [], gate: "delivery" },
        { id: "deliver", kind: "do", title: "Deliver", roleId: roleId("delivery"), profileIds: [] },
      ] }, findings: [{ id: "fix", text: "Fix this bug", severity: "blocking", status: "open", raisedBy: "opus-high", confirmedBy: [] }] })) as DeepMutable<Task>;
    const context = { ...contextOf(state), roles };
    expect(beginAgentStep(task, roleId("build"), "sol-high", 100, roles).findingIds).toEqual(["fix"]);
    expect(portReviewerIndex(task, ["sol-high", "opus-high"], id => state.profiles.find(profile => profile.id === id)?.toolId, roles)).toBe(1);
    const frozen = { ...roles.find(role => role.result === "build")!, id: "saved-maintenance" };
    task.maintenance = { routineId: "routine", routineName: "Routine", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", role: frozen, profile: state.profiles[0]!, product: JSON.parse(JSON.stringify(state.products[0]!)) };
    task.plan!.stages[0]!.roleId = frozen.id;
    expect(portReviewerIndex(task, ["sol-high", "opus-high"], id => state.profiles.find(profile => profile.id === id)?.toolId, roles)).toBe(1);
    task.testedPatch = "earlier";
    expect(journeyView(task, context).nodes.some(node => node.state === "next" && node.roleId === roleId("checks"))).toBe(false);
    endAgentStep(task, { outcome: W.built }, 101);
    task.stageIndex = 1; task.retest = true; task.fixing = false;
    beginAgentStep(task, roleId("checks"), "opus-high", 102, roles);
    const live = journeyView(task, context).nodes.filter(node => ["now", "next", "ahead"].includes(node.state));
    expect(live.map(node => node.roleId ?? node.work ?? node.waitsFor)).toEqual([roleId("checks"), "delivery", "delivery"]);
    task.stageIndex = 2; task.journey = []; task.retest = false;
    beginAgentStep(task, roleId("votes"), "opus-high", 103, roles);
    expect(journeyView(task, context).nodes.some(node => ["next", "ahead"].includes(node.state) && node.roleId === "code-reviewer")).toBe(false);
    task.stageIndex = -1; task.journey = [];
    beginAgentStep(task, roleId("plan"), "sol-high", 104, roles);
    expect(journeyView(task, context).nodes.filter(node => ["now", "next", "ahead"].includes(node.state)).map(node => node.roleId)).toEqual([roleId("plan")]);
    expect(legacyJourney(task, [], roles)[0]?.roleId).toBe(roleId("plan"));
    const changed = { ...context, roles: roles.map(role => role.result === "checks" ? { ...role, result: "notes" as const } : role) };
    expect(journeyViewKey(task, context)).not.toBe(journeyViewKey(task, changed));
  });

  it("keeps the view key stable for conversation updates and unrelated task activity", () => {
    const { state, task } = planningJourney();
    const context = contextOf(state);
    const key = journeyViewKey(task, context);
    const withNewConversation = { ...task, session: [...task.session, { id: "new", at: 1, from: "activity" as const, text: "Reading" }] };
    const otherTask = { ...task, id: "other", state: "running" as const, session: [...task.session, { id: "other-line", at: 2, from: "activity" as const, text: "Working" }] };
    expect(journeyViewKey(withNewConversation, context)).toBe(key);
    expect(journeyViewKey(task, { ...context, tasks: [...context.tasks, otherTask] })).toBe(key);
    const legacyTask = { ...task, journey: undefined };
    const timelineUpdate = { ...legacyTask, timeline: [...legacyTask.timeline, { ...legacyTask.timeline.at(-1)!, id: "extra", text: "Unrelated note" }] };
    expect(journeyViewKey(timelineUpdate, context)).toBe(journeyViewKey(legacyTask, context));
  });

  it("changes the view key when visible journey details change", () => {
    const { state, task } = planningJourney();
    const key = journeyViewKey(task, contextOf(state));
    expect(journeyViewKey({ ...task, statusLine: "Reading the project" }, contextOf(state))).not.toBe(key);
    expect(journeyViewKey({ ...task, state: "paused" }, contextOf(state))).not.toBe(key);
  });
});

it("stops unfinished check displays without changing completed results or closing a resumable step", () => {
  const task = { journey: [{ id: "checks", kind: "petrina" as const, work: "checks" as const, round: 1, sub: 0, startedAt: 10, productChecks: [
    { id: "passed", name: "Types", result: "pass" as const, startedAt: 10, endedAt: 12 },
    { id: "running", name: "Tests", result: "running" as const, startedAt: 11 },
    { id: "pending", name: "Commit hook", result: "pending" as const },
  ] }] };
  stopCheckProgress(task, 15);
  expect(task.journey[0]!.productChecks.map((check) => check.result)).toEqual(["pass", "stopped", "stopped"]);
  expect(task.journey[0]!.productChecks[0]!.endedAt).toBe(12);
  expect(task.journey[0]).not.toHaveProperty("endedAt");
});

it("keeps a review's actual findings and objection answers when later rounds change the task", () => {
  const state = stateFixture({ now: 1_000_000_000_000 });
  const task = taskFixture(state, { journey: [{ id: 'architect-round-2', kind: 'agent', roleId: 'architect', profileId: 'opus-high', round: 2, sub: 0, startedAt: 1, endedAt: 2 }], objections: [{ id: 'objection', text: 'Review the neighboring flow', round: 1, blocking: true, raisedBy: 'sol-high', status: 'open' }] });
  const step = task.journey!.find((entry) => entry.roleId === "architect" && entry.round === 2)!;
  const record = { ...task, journey: [step] };
  delete step.endedAt;
  const objection = { ...task.objections[0]!, answer: "This round's answer." };
  const finding = { id: "finding", text: "The adjacent flow breaks.", severity: "blocking" as const, raisedBy: "sol-high", confirmedBy: [], status: "open" as const };
  recordStepResult(record, { objections: [objection], findings: [finding] });
  objection.answer = "A later answer.";
  finding.text = "A later report.";
  expect(step.result!.objections![0]!.answer).toBe("This round's answer.");
  expect(step.result!.findings![0]!.text).toBe("The adjacent flow breaks.");
  expect(JSON.parse(JSON.stringify(step)).result).toEqual(step.result);
});

it("never substitutes creation for an execution start on cancelled or waiting work", () => {
  const state = stateFixture({ now: 1_000_000_000_000 });
  const base = { ...taskFixture(state), createdAt: 100, startedAt: undefined, journey: [], plan: undefined, agent: undefined, stageIndex: -1 };
  const context = { roles: state.roles, profiles: state.profiles, tasks: [], inbox: [] };
  const cancelled = journeyView({ ...base, state: "cancelled" }, context);
  expect(cancelled.start).toEqual({ kind: "created", at: 100 });
  expect(cancelled.nodes).toHaveLength(0); expect(cancelled.end!.text).toBe("Cancelled");
  expect(journeyView({ ...base, state: "paused" }, context).start).toEqual({ kind: "created", at: 100 });
  expect(journeyView({ ...base, state: "backlog" }, context).start).toEqual({ kind: "backlog" });
  expect(journeyView({ ...base, state: "queued" }, context).start.kind).toBe("queued");
  expect(journeyView({ ...base, state: "cancelled", startedAt: 500 }, context).start).toEqual({ kind: "started", at: 500 });
});
