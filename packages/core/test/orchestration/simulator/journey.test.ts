import { describe, expect, it } from "vitest";

import { JOURNEY_WORDS as W, journeyProblems, journeyView, type JourneyView } from "../../../src/journey.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../../../src/library.js";

import type { State, Task } from "../../../src/model.js";

import { Simulator, type Triggers } from "../../../src/sim.js";

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

const boxes = (view: JourneyView) => view.nodes.map((node) => `${node.name}: ${node.state}`);

const inboxItem = (sim: Simulator, id: string, kind: string) => sim.getState().inbox.find((item) => item.taskId === id && item.kind === kind);

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
      "Changes returned; 1 fix claimed",
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
    expect(view.nodes[9]!.outcome).toBe("Changes returned; 1 fix claimed");
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
