import { describe, expect, it } from "vitest";
import { createDemoState, createPortfolioDemo } from "../src/demo.js";
import {
  beginAgentStep,
  beginPetrinaStep,
  beginYouStep,
  endAgentStep,
  endPetrinaStep,
  endYouStep,
  JOURNEY_WORDS as W,
  journeyProblems,
  journeyView,
  journeyViewKey,
  landingOf,
  legacyJourney,
  petrinaMoment,
  portReviewerIndex,
  recordStepResult,
  stepName,
  syncWait,
  stopCheckProgress,
  type JourneyTask,
  type JourneyView,
} from "../src/journey.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../src/library.js";
import { addRole, libraryRoles, NO_ROLE_CHANGES, ROLE_STARTS } from "../src/roles.js";
import type { JourneyStep, State, Task } from "../src/model.js";
import type { DeepMutable } from "../src/flow.js";
import { Simulator, type Triggers } from "../src/sim.js";

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
  const state = createDemoState(1_000_000_000_000);
  const task = state.tasks.find((entry) => entry.id === "guest-checkout")!;
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

const taskOf = (sim: Simulator, id: string): Task => sim.getState().tasks.find((entry) => entry.id === id)!;
const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });
const viewOf = (sim: Simulator, id: string): JourneyView => journeyView(taskOf(sim, id), contextOf(sim.getState()));
/** Each box as "Name: state". */
const boxes = (view: JourneyView) => view.nodes.map((node) => `${node.name}: ${node.state}`);
const inboxItem = (sim: Simulator, id: string, kind: string) => sim.getState().inbox.find((item) => item.taskId === id && item.kind === kind);

/** Tick until `done`, settling everything on the way like a coordinator who says yes, unless `respond` handles it. */
function runUntil(sim: Simulator, done: () => boolean, respond: (kind: string, itemId: string) => boolean = () => false, limit = 400): void {
  for (let tick = 0; tick < limit && !done(); tick += 1) {
    sim.tick();
    for (const item of sim.getState().inbox) {
      if (respond(item.kind, item.id)) continue;
      if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") sim.allow(item.id, "once");
      else sim.approve(item.id);
    }
  }
  if (!done()) throw new Error("never got there");
}

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
    const task = JSON.parse(JSON.stringify({ ...createDemoState(100).tasks[0]!, state: "running", stageIndex: 0, sub: 0, rounds: {}, fixing: true, journey: [], builderSession: undefined, delivery: "pull-request", plan: {
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
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Greeting", kind: "feature" });
    sim.tick();
    const state = sim.getState();
    const task = taskOf(sim, id);
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
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Greeting", kind: "feature" });
    sim.tick();
    const state = sim.getState();
    const task = taskOf(sim, id);
    const key = journeyViewKey(task, contextOf(state));
    expect(journeyViewKey({ ...task, statusLine: "Reading the project" }, contextOf(state))).not.toBe(key);
    expect(journeyViewKey({ ...task, state: "paused" }, contextOf(state))).not.toBe(key);
  });

  it("starts in the queue with the planner next, and the planner choosing the rest", () => {
    const sim = new Simulator({ ...emptyState(), pool: { limit: 2, paused: true, toolCaps: {} } });
    const first = sim.addTask({ productId: "p", title: "Saved carts" });
    const second = sim.addTask({ productId: "p", title: "Team invites" });
    sim.setHeld(second, true);
    const view = viewOf(sim, first);
    expect(view.start).toEqual({ kind: "queued", position: 1 });
    expect(boxes(view)).toEqual(["Planner: next"]);
    expect(view.nodes[0]!.profileId).toBe("sonnet-medium");
    expect(view.rest).toBe("The planner will choose the rest");
    expect(view.end).toBeUndefined();
    expect(viewOf(sim, second).start).toEqual({ kind: "held" });

    sim.setPoolPaused(false);
    const planning = viewOf(sim, first);
    expect(planning.start).toEqual({ kind: "started", at: 0 });
    expect(boxes(planning)).toEqual(["Planner: now"]);
    expect(planning.nodes[0]).toMatchObject({ run: "working", live: "Planner is starting", startedAt: 0 });
    expect(planning.rest).toBe("The planner will choose the rest");
  });

  it("shows every round, check and send-back in order, ending with Petrina's delivery", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 3 });
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    runUntil(sim, () => taskOf(sim, id).state === "pr-open");
    const view = viewOf(sim, id);
    expect(view.nodes.map((node) => node.name)).toEqual([
      "Planner",
      "Architect",
      "Design reviewer",
      "Architect (round 2)",
      "Design reviewer (round 2)",
      "Your design check",
      "Builder",
      "Automated checks",
      "Code reviewers",
      "Builder (fixes)",
      "Automated checks (round 2)",
      "Code reviewers (round 2)",
      "Your delivery check",
      "Publish delivery",
    ]);
    expect(view.nodes.every((node) => node.state === "done")).toBe(true);
    expect(view.nodes.map((node) => node.reason ?? "")).toEqual([
      "plan ready",
      "brief ready",
      "1 blocking objection",
      "objections answered",
      "no blocking objections",
      "you approved",
      "ready for review",
      "checks passed",
      "sent back: 1 important",
      "fixes ready",
      "checks passed",
      "review passed",
      "you approved",
      "",
    ]);
    // Send-backs are amber; everything else moves on.
    expect(view.nodes.filter((node) => node.tone === "back").map((node) => node.name)).toEqual(["Design reviewer", "Code reviewers"]);
    expect(view.nodes[2]!.outcome).toBe("2 objections, 1 blocking");
    // Every reviewer of a round looks at once: one box for all of them, saying what the round raised.
    expect(view.nodes[8]).toMatchObject({ team: ["opus-high", "sol-xhigh"], outcome: "1 important, 1 nit · 1 follow-up" });
    expect(view.nodes[11]!.outcome).toBe("Nothing to fix");
    expect(view.nodes[7]).toMatchObject({ kind: "petrina", work: "checks", outcome: "All 3 checks pass" });
    expect(view.nodes[9]!.outcome).toBe("Fixed 1 finding");
    expect(view.nodes.at(-1)!.outcome).toMatch(/^Opened pull request #\d+$/);
    const number = taskOf(sim, id).pr!.number;
    expect(view.end).toEqual({ text: `Pull request #${number} · awaiting merge`, state: "pending" });
    expect(journeyProblems(taskOf(sim, id))).toEqual([]);

    runUntil(sim, () => taskOf(sim, id).state === "done");
    expect(viewOf(sim, id).end).toEqual({ text: `Merged #${number}`, state: "done" });
  });

  it("tags timeline and session lines with the step they belong to", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 3 });
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "bug" });
    runUntil(sim, () => taskOf(sim, id).state === "done");
    const task = taskOf(sim, id);
    const journey = task.journey!;
    for (const step of journey.filter((entry) => entry.kind === "agent")) {
      // Each agent's box starts when its "started" line does, and its lines carry the box.
      const started = task.timeline.find((entry) => entry.step === step.id && entry.tone === "milestone");
      expect(started?.at).toBe(step.startedAt);
      expect(task.session.some((line) => line.step === step.id && line.from === "activity")).toBe(true);
    }
    expect(task.timeline.find((entry) => entry.text === "You approved the delivery")?.step).toBe(journey.find((step) => step.waitsFor === "delivery")!.id);
    expect(task.timeline[0]!.step).toBeUndefined();
  });

  it("shows the plan still ahead as faint steps that follow changes in the Plan tab", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    runUntil(sim, () => !!inboxItem(sim, id, "design"), (kind) => kind === "design");
    let view = viewOf(sim, id);
    const ahead = view.nodes.filter((node) => node.state === "next" || node.state === "ahead");
    expect(view.nodes.find((node) => node.state === "you")?.name).toBe("Your design check");
    expect(ahead.map((node) => `${node.name} ${(node.team ?? [node.profileId ?? ""]).join(" ")}`.trim())).toEqual(["Builder sol-high", "Code reviewers opus-high sol-xhigh", "Your delivery check", "Publish delivery"]);
    expect(ahead.at(-1)).toMatchObject({ kind: "petrina", work: "delivery" });
    expect(ahead[0]!.state).toBe("next");
    expect(ahead.every((node) => node.outcome === undefined && node.reason === undefined && node.startedAt === undefined)).toBe(true);
    expect(view.rest).toBeUndefined();

    sim.setStageProfile(id, `${id}:build`, "profileIds", 0, "opus-high");
    sim.addReviewer(id, `${id}:review`, "sonnet-medium");
    view = viewOf(sim, id);
    expect(view.nodes.find((node) => node.name === "Builder")?.profileId).toBe("opus-high");
    expect(view.nodes.find((node) => node.name === "Code reviewers")?.team).toEqual(["opus-high", "sol-xhigh", "sonnet-medium"]);
  });

  it("puts the coordinator's call on the path, and the architect who follows it", () => {
    const seed = new Simulator(emptyState());
    const id = seed.addTask({ productId: "p", title: "Gift cards", kind: "feature" });
    const sim = new Simulator(seed.getState(), { disagree: [id] });
    runUntil(sim, () => !!inboxItem(sim, id, "disagreement"), (kind) => kind === "disagreement");
    let view = viewOf(sim, id);
    const call = view.nodes.find((node) => node.name === "Your call")!;
    expect(call).toMatchObject({ kind: "you", state: "you", waitsFor: "call", live: "The architects disagree. Your call" });
    expect(view.nodes[view.nodes.indexOf(call) - 1]).toMatchObject({ name: "Design reviewer (round 3)", reason: "1 blocking objection", tone: "back" });

    sim.requestChanges(inboxItem(sim, id, "disagreement")!.id, "Keep it simple: one card per order.");
    view = viewOf(sim, id);
    expect(view.nodes.find((node) => node.name === "Your call")).toMatchObject({ state: "done", outcome: W.madeCall, reason: "your call", tone: "back" });
    expect(view.nodes.find((node) => node.state === "now")).toMatchObject({ name: "Architect (your call)", run: "working" });
    runUntil(sim, () => !!inboxItem(sim, id, "design"), (kind) => kind === "design");
    view = viewOf(sim, id);
    const architect = boxes(view).indexOf("Architect (your call): done");
    expect(boxes(view).slice(architect, architect + 2)).toEqual(["Architect (your call): done", "Your design check: you"]);
    expect(view.nodes.find((node) => node.name === "Architect (your call)")?.reason).toBe("brief follows your call");
    expect(journeyProblems(taskOf(sim, id))).toEqual([]);
  });

  it("says when you sided with the architect", () => {
    const seed = new Simulator(emptyState());
    const id = seed.addTask({ productId: "p", title: "Gift cards", kind: "feature" });
    const sim = new Simulator(seed.getState(), { disagree: [id] });
    runUntil(sim, () => !!inboxItem(sim, id, "disagreement"), (kind) => kind === "disagreement");
    sim.approve(inboxItem(sim, id, "disagreement")!.id);
    expect(viewOf(sim, id).nodes.find((node) => node.name === "Your call")).toMatchObject({ outcome: W.sided, reason: "you sided with the architect", tone: "on" });
  });

  it("sends the work back to the builder when you ask for changes at the delivery check", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Pricing", kind: "chore" });
    runUntil(sim, () => !!inboxItem(sim, id, "delivery"), (kind) => kind === "delivery");
    sim.requestChanges(inboxItem(sim, id, "delivery")!.id, "Use the new plan names.");
    const view = viewOf(sim, id);
    expect(view.nodes.find((node) => node.name === "Your delivery check")).toMatchObject({ reason: "changes asked", tone: "back", outcome: W.changes });
    expect(view.nodes.find((node) => node.state === "next" || node.state === "now")).toMatchObject({ name: "Builder (fixes 2)" });
    runUntil(sim, () => !!inboxItem(sim, id, "delivery"), (kind) => kind === "delivery");
    expect(viewOf(sim, id).nodes.map((node) => node.name).slice(-6)).toEqual(["Your delivery check", "Builder (fixes 2)", "Automated checks (round 2, again)", "Code reviewer (round 2, again)", "Your delivery check", "Publish delivery"]);
  });
});

describe("questions and permissions on the journey", () => {
  function asking(): { sim: Simulator; id: string } {
    const seed = new Simulator(emptyState());
    const id = seed.addTask({ productId: "p", title: "Greeting", kind: "feature" });
    const triggers: Triggers = {
      [`${id}|architect|1|0`]: { kind: "question", title: "Formal or casual?", options: ["Formal", "Casual"] },
      [`${id}|architect|1|1`]: { kind: "question", title: "Emoji?", options: ["No", "Yes"] },
      [`${id}|builder|1|0`]: { kind: "permission", title: "Add a package", detail: "npm install left-pad" },
      [`${id}|builder|1|1`]: { kind: "permission", title: "Change the database", detail: "bun run migrate" },
    };
    return { sim: new Simulator(seed.getState(), { triggers }), id };
  }

  it("is amber while open and says how you answered", () => {
    const { sim, id } = asking();
    runUntil(sim, () => !!inboxItem(sim, id, "question"), () => true);
    let architect = viewOf(sim, id).nodes.find((node) => node.name === "Architect")!;
    expect(architect.state).toBe("you");
    expect(architect.asks).toEqual([expect.objectContaining({ kind: "question", title: "Formal or casual?" })]);
    expect(architect.asks[0]!.endedAt).toBeUndefined();

    sim.answer(inboxItem(sim, id, "question")!.id, "Formal");
    runUntil(sim, () => !!inboxItem(sim, id, "question"), () => true);
    sim.decideForMe(inboxItem(sim, id, "question")!.id);
    runUntil(sim, () => !!inboxItem(sim, id, "permission"), (kind) => kind !== "design");
    sim.allow(inboxItem(sim, id, "permission")!.id, "once");
    runUntil(sim, () => !!inboxItem(sim, id, "permission"), () => true);
    sim.deny(inboxItem(sim, id, "permission")!.id, "Not this time");

    const view = viewOf(sim, id);
    architect = view.nodes.find((node) => node.name === "Architect")!;
    expect(architect.state).toBe("done");
    expect(architect.asks.map((ask) => [ask.title, ask.how, ask.answer])).toEqual([
      ["Formal or casual?", "answered", "Formal"],
      ["Emoji?", "decided", "No"],
    ]);
    expect(view.nodes.find((node) => node.name === "Builder")!.asks.map((ask) => [ask.title, ask.how, ask.answer])).toEqual([
      ["Add a package", "allowed", undefined],
      ["Change the database", "denied", "Not this time"],
    ]);
    expect(view.nodes.find((node) => node.name === "Builder")!.state).toBe("now");
  });

  it("withdraws a question when you pause, and resuming continues the same box", () => {
    const { sim, id } = asking();
    runUntil(sim, () => !!inboxItem(sim, id, "question"), () => true);
    const before = taskOf(sim, id).journey!.at(-1)!;
    sim.pause(id);
    let architect = viewOf(sim, id).nodes.find((node) => node.name === "Architect")!;
    expect(architect).toMatchObject({ state: "now", run: "paused", live: "Paused by you" });
    expect(architect.asks[0]).toMatchObject({ how: "withdrawn" });
    sim.resume(id);
    sim.tick();
    const journey = taskOf(sim, id).journey!;
    expect(journey.at(-1)!.id).toBe(before.id);
    expect(journey.filter((step) => step.roleId === "architect")).toHaveLength(1);
    architect = viewOf(sim, id).nodes.find((node) => node.name === "Architect")!;
    expect(architect.startedAt).toBe(before.startedAt);
  });
});

describe("the journey's ends", () => {
  it("cancelling stops the step under way and ends the journey with Cancelled", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "bug" });
    runUntil(sim, () => taskOf(sim, id).agent?.roleId === "builder");
    sim.cancel(id);
    const view = viewOf(sim, id);
    expect(boxes(view)).toEqual(["Planner: done", "Builder: cancelled"]);
    expect(view.nodes[1]!.outcome).toBe(W.stopped);
    expect(view.end).toEqual({ text: "Cancelled", state: "cancelled" });
    expect(journeyProblems(taskOf(sim, id))).toEqual([]);
  });

  it("a waiting task names what it waits for, and finishes when it lands", () => {
    const sim = new Simulator(emptyState(1), { prMergeAfter: 2 });
    const first = sim.addTask({ productId: "p", title: "Guest checkout", kind: "bug" });
    const second = sim.addTask({ productId: "p", title: "Saved carts", kind: "bug" });
    sim.setAfter(second, [first]);
    expect(() => sim.setAfter(first, [second])).toThrow();
    expect(() => sim.setAfter(second, [second])).toThrow();
    let view = viewOf(sim, second);
    expect(view.start).toEqual({ kind: "queued", position: 1 });
    expect(boxes(view)).toEqual(["Waiting for others: now", "Planner: next"]);
    expect(view.nodes[0]).toMatchObject({ kind: "wait", run: "waiting", live: "Waiting for “Guest checkout” to land", waitsOn: [{ id: first, title: "Guest checkout" }] });
    expect(taskOf(sim, second).timeline.at(-1)?.text).toBe("It starts after “Guest checkout” lands");

    runUntil(sim, () => taskOf(sim, second).state !== "queued");
    view = viewOf(sim, second);
    expect(view.nodes[0]).toMatchObject({ state: "done", reason: "“Guest checkout” landed", outcome: "“Guest checkout” landed" });
    expect(view.nodes[1]).toMatchObject({ name: "Planner", state: "now" });
    expect(journeyProblems(taskOf(sim, second))).toEqual([]);
  });

  it("a wait that is removed says it no longer waits", () => {
    const sim = new Simulator({ ...emptyState(), pool: { limit: 2, paused: true, toolCaps: {} } });
    const first = sim.addTask({ productId: "p", title: "Guest checkout" });
    const second = sim.addTask({ productId: "p", title: "Saved carts" });
    sim.setAfter(second, [first]);
    sim.setAfter(second, []);
    expect(viewOf(sim, second).nodes[0]).toMatchObject({ kind: "wait", state: "done", reason: "no longer waits" });
    expect(taskOf(sim, second).statusLine).toBe("In the queue");
  });

  it("on hold, the wait still ends when the other task does", () => {
    const sim = new Simulator({ ...emptyState(), pool: { limit: 2, paused: true, toolCaps: {} } });
    const first = sim.addTask({ productId: "p", title: "Guest checkout" });
    const second = sim.addTask({ productId: "p", title: "Saved carts" });
    sim.setAfter(second, [first]);
    sim.setHeld(second, true);
    sim.cancel(first);
    expect(taskOf(sim, second)).toMatchObject({ state: "queued", held: true });
    expect(viewOf(sim, second).nodes[0]).toMatchObject({ kind: "wait", state: "done", reason: "“Guest checkout” did not land: cancelled" });
    expect(taskOf(sim, second).statusLine).not.toMatch(/^Waiting for/);
  });
});

describe("recorded the way the engine records", () => {
  /** A task at its build stage, as the engine holds it: recorded through the shared helpers. */
  function atBuild(): Task & JourneyTask {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "bug" });
    runUntil(sim, () => taskOf(sim, id).agent?.roleId === "builder");
    return JSON.parse(JSON.stringify(taskOf(sim, id))) as Task & JourneyTask;
  }

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
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "bug" });
    runUntil(sim, () => !!inboxItem(sim, id, "delivery"), (kind) => kind === "delivery");
    const task = JSON.parse(JSON.stringify(taskOf(sim, id))) as Task & JourneyTask;
    task.journey!.pop(); // The delivery check was not reached: its checks failed to run.
    beginYouStep(task, "stuck", task.journey!.at(-1)!.endedAt!);
    const view = journeyView({ ...task, state: "failed" }, contextOf(sim.getState()));
    expect(boxes(view).slice(-3)).toEqual(["Stuck: you", "Your delivery check: next", "Publish delivery: ahead"]);
  });

  it.each([
    ["check-finder", "Code reviewers", "review-chain"],
    ["guide-keeper", "Builder (fixes)", "do"],
  ] as const)("keeps the main work ahead while the %s helps", (roleId, next, kind) => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "bug" });
    runUntil(sim, () => kind === "do" ? taskOf(sim, id).agent?.roleId === "builder" : taskOf(sim, id).column === "reviewing");
    const task = JSON.parse(JSON.stringify(taskOf(sim, id))) as Task & JourneyTask;
    if (roleId === "check-finder") task.journey!.pop(); // The reviewers have not started yet.
    else endAgentStep(task, { outcome: "Finished", reason: "ready" }, sim.getState().now);
    // The Guide keeper runs before the builder begins its requested fixes.
    const helping = { ...task, fixing: roleId === "guide-keeper" };
    beginAgentStep(helping, roleId, "opus-high", sim.getState().now, BUILT_IN_ROLES);
    const view = journeyView(helping, contextOf(sim.getState()));
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

describe("tasks that ran before journeys were recorded", () => {
  it("show one box per finished stage, the live and faint steps as usual, and a quiet note", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    runUntil(sim, () => taskOf(sim, id).column === "reviewing");
    const { journey: _gone, ...old } = taskOf(sim, id);
    const view = journeyView(old as Task, contextOf(sim.getState()));
    // The reviewers look at once: one live box for all of them, then the delivery check.
    expect(boxes(view)).toEqual(["Planner: done", "Architect: done", "Your design check: done", "Builder: done", "Code reviewers: now", "Your delivery check: next", "Publish delivery: ahead"]);
    expect(view.nodes[4]!.team).toEqual(old.plan!.stages.find((stage) => stage.kind === "review-chain")!.profileIds);
    expect(view.nodes.slice(0, 4).every((node) => node.legacy && node.startedAt === undefined)).toBe(true);
    expect(view.note).toMatch(/Earlier rounds were not recorded/);
  });

  it("keep the coordinator's step they wait at, from when it was asked", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    runUntil(sim, () => !!inboxItem(sim, id, "design"), (kind) => kind === "design");
    const { journey: _gone, ...old } = taskOf(sim, id);
    const steps = legacyJourney(old as Task, sim.getState().inbox, BUILT_IN_ROLES);
    expect(steps.at(-1)).toMatchObject({ kind: "you", waitsFor: "design", startedAt: inboxItem(sim, id, "design")!.at });
    expect(steps.at(-1)!.legacy).toBeUndefined();
  });

  it("keep the step under way, with the question it waits on under it", () => {
    const seed = new Simulator(emptyState());
    const id = seed.addTask({ productId: "p", title: "Greeting", kind: "feature" });
    const sim = new Simulator(seed.getState(), { triggers: { [`${id}|architect|1|0`]: { kind: "question", title: "Formal or casual?", options: ["Formal", "Casual"] } } });
    runUntil(sim, () => !!inboxItem(sim, id, "question"), () => true);
    const { journey: _gone, ...old } = taskOf(sim, id);
    const question = inboxItem(sim, id, "question")!;
    const steps = legacyJourney(old as Task, sim.getState().inbox, BUILT_IN_ROLES);
    expect(steps.at(-1)).toMatchObject({ kind: "agent", roleId: "architect", stageId: old.plan!.stages[0]!.id, round: 1, sub: 0, startedAt: old.agent!.since, asks: [{ id: question.id, kind: "question", title: "Formal or casual?" }] });
    const view = journeyView({ ...old, journey: steps } as Task, contextOf(sim.getState()));
    expect(boxes(view).slice(0, 4)).toEqual(["Planner: done", "Architect: you", "Design reviewer: next", "Your design check: ahead"]);
    // Answering it continues the same box.
    const task: JourneyTask = { ...old, journey: steps };
    expect(beginAgentStep(task, "architect", old.agent!.profileId, Date.now(), BUILT_IN_ROLES)).toBe(steps.at(-1));
  });
});

describe("step names", () => {
  const step = (fields: Partial<JourneyStep>): JourneyStep => ({ id: "j", kind: "agent", round: 1, sub: 0, startedAt: 0, ...fields });
  const name = (fields: Partial<JourneyStep>, earlier: Partial<JourneyStep>[] = []) => stepName(step(fields), earlier.map(step), BUILT_IN_ROLES);

  it("say what each repeat is, never a counter", () => {
    expect(name({ roleId: "architect", stageId: "d", round: 2 })).toBe("Architect (round 2)");
    expect(name({ roleId: "design-reviewer", stageId: "d", round: 2, sub: 1 })).toBe("Design reviewer (round 2)");
    expect(name({ roleId: "architect", stageId: "d", call: true })).toBe("Architect (your call)");
    const firstFix = { roleId: "builder", stageId: "b", fixing: true, endedAt: 5, end: "done" as const };
    expect(name({ roleId: "builder", stageId: "b", fixing: true })).toBe("Builder (fixes)");
    expect(name({ roleId: "builder", stageId: "b", fixing: true }, [firstFix])).toBe("Builder (fixes 2)");
    expect(name({ roleId: "builder", stageId: "b", fixing: true }, [{ ...firstFix, end: "failed" }])).toBe("Builder (fixes, again)");
    expect(name({ roleId: "builder", stageId: "b" }, [{ roleId: "builder", stageId: "b", endedAt: 5, end: "failed" }])).toBe("Builder (again)");
    expect(name({ kind: "you", waitsFor: "delivery" })).toBe("Your delivery check");
    expect(name({ kind: "wait" })).toBe("Waiting for others");
    expect(name({ roleId: "code-reviewer", round: 2, team: ["a", "b"] })).toBe("Code reviewers (round 2)");
    expect(name({ roleId: "builder", stageId: "b", update: true })).toBe("Builder (update)");
    expect(name({ kind: "petrina", work: "checks", stageId: "r", round: 2 })).toBe("Automated checks (round 2)");
    expect(name({ kind: "petrina", work: "delivery", stageId: "s" }, [{ kind: "petrina", work: "delivery", stageId: "s", endedAt: 5 }])).toBe("Publish delivery (again)");
    expect(name({ kind: "petrina", work: "update" })).toBe("Update branch");
    expect(name({ kind: "petrina", work: "update", stageId: "r", round: 2 })).toBe("Update branch");
    expect(name({ roleId: "code-reviewer", stageId: "r", round: 2, port: true }, [{ roleId: "code-reviewer", stageId: "r", round: 2, endedAt: 5 }])).toBe("Code reviewer (port)");
    expect(name({ kind: "petrina", work: "checks", stageId: "r", round: 2, port: true })).toBe("Automated checks (port)");
  });

  it("put the words on the arrows", () => {
    expect([W.blocking(2), W.sentBack(3), W.checksFailed(2), W.landed(["Guest checkout"]), W.landed(["A", "B"]), W.othersCancelled(["A"])]).toEqual([
      "2 blocking objections",
      "sent back: 3 important",
      "2 checks failed",
      "“Guest checkout” landed",
      "“A” and “B” landed",
      "“A” did not land: cancelled",
    ]);
    expect([W.youApproved, W.changesAsked, W.yourCall, W.youSided, W.tryAgain, W.noLongerWaits]).toEqual(["you approved", "changes asked", "your call", "you sided with the architect", "you asked to try again", "no longer waits"]);
  });
});

describe("unusual endings", () => {
  const sim = new Simulator(emptyState(), { prMergeAfter: 2 });
  const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "bug" });
  runUntil(sim, () => taskOf(sim, id).state === "pr-open");
  const open = taskOf(sim, id);
  const ending = (task: Task) => journeyView(task, contextOf(sim.getState())).end;

  it("a pull request closed without merging is not awaiting merge, and did not land", () => {
    const number = open.pr!.number;
    expect(ending(open)).toEqual({ text: `Pull request #${number} · awaiting merge`, state: "pending" });
    const closed: Task = { ...open, state: "done", pr: { ...open.pr!, state: "closed" } };
    expect(landingOf(closed)).toBe("closed");
    expect(ending(closed)).toEqual({ text: `Pull request #${number} closed without merging`, state: "unconfirmed" });
    // Recorded before "closed" was: a finished task whose pull request never merged.
    expect(landingOf({ ...open, state: "done" })).toBe("closed");
    expect(landingOf({ ...open, state: "done", pr: { ...open.pr!, state: "merged" } })).toBe("landed");
  });

  it("Mark as done does not confirm a delivery", () => {
    const { pr: _none, ...marked } = { ...open, state: "done" as const };
    expect(landingOf(marked)).toBe("marked-done");
    expect(ending(marked)).toEqual({ text: "Marked as done · delivery not confirmed", state: "unconfirmed" });
  });

  it("a prerequisite that did not land says so", () => {
    const others: Record<string, Pick<Task, "state" | "title" | "pr" | "release" | "landed">> = {
      a: { state: "done", title: "A", landed: { branch: "main", sha: "abc1234" } },
      b: { state: "done", title: "B", pr: { number: 7, url: "https://github.com/acme/p/pull/7", state: "closed", openedAt: 0 } },
      c: { state: "done", title: "C" },
      d: { state: "cancelled", title: "D" },
    };
    const reasonFor = (after: string[]) => {
      const waiting: JourneyTask & Pick<Task, "after"> = { stageIndex: -1, rounds: {}, sub: 0, fixing: false, after, journey: [] };
      syncWait(waiting, after.map((id) => ({ id, title: others[id]!.title })), (id) => others[id], 0);
      syncWait(waiting, [], (id) => others[id], 10);
      return waiting.journey![0]!.reason;
    };
    expect(reasonFor(["a"])).toBe("“A” landed");
    expect(reasonFor(["b"])).toBe("“B” did not land: closed without merging");
    expect(reasonFor(["c"])).toBe("“C” marked as done, delivery not confirmed");
    expect(reasonFor(["d"])).toBe("“D” did not land: cancelled");
    expect(reasonFor(["a", "d"])).toBe("“A” landed; “D” did not land: cancelled");
  });
});

describe("the demos", () => {
  const demos = [
    ["?demo", createDemoState(1_000_000_000_000)],
    ["?demo=portfolio", createPortfolioDemo(1_000_000_000_000).state],
  ] as const;

  for (const [name, state] of demos) {
    it(`${name}: every started task has a journey whose times match its timeline`, () => {
      for (const task of state.tasks) {
        if (task.state === "queued" && !task.after) {
          expect(task.journey, task.id).toBeUndefined();
          continue;
        }
        // A Backlog card is waiting to be queued, so it has not started and has no recorded journey.
        // One that was sent back after work began still has its journey, and is checked below.
        if (task.state === "backlog" && !task.journey) {
          expect(journeyProblems(task), task.id).toEqual([]);
          expect(journeyView(task, contextOf(state)).start, task.id).toEqual({ kind: "backlog" });
          continue;
        }
        expect(journeyProblems(task), task.id).toEqual([]);
        task.journey!.forEach((step, index) => {
          const lines = task.timeline.filter((entry) => entry.step === step.id);
          const where = `${task.id} ${step.id}`;
          // An agent's box starts with its "started" line; your steps start the moment the step before ended,
          // and end with what you decided.
          if (step.kind === "agent") expect(lines[0]?.at, where).toBe(step.startedAt);
          else if (step.kind === "you") expect(step.startedAt, where).toBe(task.journey![index - 1]?.endedAt);
          if (step.kind === "you" && step.endedAt !== undefined) expect(lines.at(-1)?.at, where).toBe(step.endedAt);
          for (const line of lines) expect(line.at, where).toBeGreaterThanOrEqual(step.startedAt);
        });
        const view = journeyView(task, contextOf(state));
        expect(view.nodes.length).toBeGreaterThan(0);
      }
    });
  }

  it("?demo has the call waiting on you, the delivery check after a send-back, open questions and a waiting task", () => {
    const [, state] = demos[0];
    const view = (id: string) => journeyView(state.tasks.find((task) => task.id === id)!, contextOf(state));
    expect(view("gift-cards").nodes.find((node) => node.state === "you")?.name).toBe("Your call");
    expect(boxes(view("pricing-refresh")).slice(2, 9)).toEqual([
      "Automated checks: done",
      "Code reviewer: done",
      "Builder (fixes): done",
      "Automated checks (round 2): done",
      "Code reviewer (round 2): done",
      "Your delivery check: you",
      "Publish delivery: next",
    ]);
    // Notes ships releases: the Release Manager writes the notes, then Petrina publishes.
    expect(boxes(view("dark-mode")).slice(-2)).toEqual(["Release Manager: ahead", "Publish delivery: ahead"]);
    expect(view("dark-mode").nodes.find((node) => node.state === "you")?.asks[0]).toMatchObject({ kind: "question" });
    expect(view("guest-checkout").nodes.find((node) => node.state === "you")?.asks[0]).toMatchObject({ kind: "permission" });
    expect(view("tag-search").nodes[0]).toMatchObject({ kind: "wait", live: "Waiting for “Dark mode” to land" });
  });

  it("?demo: allowing the permission and answering the question settle their capsules", () => {
    const sim = new Simulator(createDemoState(1_000_000_000_000));
    const item = (taskId: string) => sim.getState().inbox.find((entry) => entry.taskId === taskId && entry.blocking)!;
    sim.allow(item("guest-checkout").id, "once");
    sim.answer(item("dark-mode").id, "Follow the system setting");
    const asks = (id: string) => taskOf(sim, id).journey!.flatMap((step) => step.asks ?? []);
    expect(asks("guest-checkout")).toEqual([expect.objectContaining({ kind: "permission", how: "allowed" })]);
    expect(asks("dark-mode")).toEqual([expect.objectContaining({ kind: "question", how: "answered", answer: "Follow the system setting" })]);
    expect(viewOf(sim, "guest-checkout").nodes.some((node) => node.state === "you")).toBe(false);
  });

  it("?demo=portfolio has a long finished task", () => {
    const [, state] = demos[1];
    const task = state.tasks.find((entry) => entry.title === "Usage dashboard" && entry.state === "done")!;
    const view = journeyView(task, contextOf(state));
    expect(view.nodes).toHaveLength(20);
    expect(view.nodes.every((node) => node.state === "done")).toBe(true);
    expect(view.end?.state).toBe("done");
  });
});
