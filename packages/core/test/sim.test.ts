import { describe, expect, it } from "vitest";
import { answerByCall, CALL_WORDS, dueAnswers, unanswered } from "../src/call.js";
import { createDemoState, createPortfolioDemo, DEMO_TRIGGERS } from "../src/demo.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../src/library.js";
import type { DesignCall, Objection, State, Task } from "../src/model.js";
import { slotUses, startsNextCount } from "../src/scheduler.js";
import { Simulator } from "../src/sim.js";

function emptyState(limit = 2): State {
  return {
    now: 0,
    seq: 0,
    products: [{ id: "p", name: "Product", repo: "acme/product", tone: "blue" }],
    roles: BUILT_IN_ROLES,
    tools: KNOWN_TOOLS,
    profiles: DEFAULT_PROFILES,
    tasks: [],
    inbox: [],
    pool: { limit, paused: false, toolCaps: {} },
  };
}

function task(sim: Simulator, id: string): Task {
  const found = sim.getState().tasks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
}

/** Tick until `done`, settling the inbox the way a coordinator who says yes to everything would. */
function runUntil(sim: Simulator, done: () => boolean, limit = 300): void {
  for (let tick = 0; tick < limit && !done(); tick += 1) {
    sim.tick();
    for (const item of sim.getState().inbox) {
      if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") sim.allow(item.id, "once");
      else sim.approve(item.id);
    }
  }
}

/** A task whose design reviewer keeps objecting, ticked until the architects disagree. */
function disagreeing(kind: Task["kind"] = "feature", limit = 2): { sim: Simulator; id: string } {
  const seed = new Simulator(emptyState(limit), { prMergeAfter: 1_000 });
  const id = seed.addTask({ productId: "p", title: "Saved carts", kind });
  const sim = new Simulator(seed.getState(), { prMergeAfter: 1_000, disagree: [id] });
  for (let tick = 0; tick < 300 && !inboxItem(sim, "disagreement"); tick += 1) sim.tick();
  if (!inboxItem(sim, "disagreement")) throw new Error("the architects never disagreed");
  return { sim, id };
}

function inboxItem(sim: Simulator, kind: string) {
  return sim.getState().inbox.find((item) => item.kind === kind);
}

/** Tick until an inbox item of `kind` shows up. */
function tickUntil(sim: Simulator, kind: string, limit = 300) {
  for (let tick = 0; tick < limit && !inboxItem(sim, kind); tick += 1) sim.tick();
  const item = inboxItem(sim, kind);
  if (!item) throw new Error(`no ${kind} item`);
  return item;
}

const reviewerRuns = (task: Task) => task.timeline.filter((entry) => entry.roleId === "design-reviewer" && entry.tone === "milestone").length;

describe("The coordinator's call on a design disagreement", () => {
  const CALL = "Keep the confirmation step, but only for existing accounts.";

  it("settles the design: the architect follows it once, no review round, then a design check", () => {
    const { sim, id } = disagreeing();
    const before = task(sim, id);
    const open = before.objections.filter((objection) => objection.status === "open");
    expect(open.length).toBeGreaterThan(1);
    const stage = before.plan!.stages[before.stageIndex]!;
    const rounds = before.rounds[stage.id];
    const reviews = reviewerRuns(before);

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    expect(task(sim, id).call?.text).toBe(CALL);
    sim.tick();
    expect(task(sim, id).agent?.roleId).toBe("architect");
    expect(task(sim, id).statusLine).toBe(CALL_WORDS.following);

    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    expect(inboxItem(sim, "disagreement")).toBeUndefined();
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds[stage.id]).toBe(rounds);
    expect(after.statusLine).toBe(CALL_WORDS.waiting);
    // Every objection that was open has an answer; the blocking one as the call says, the other in the architect's own name.
    for (const objection of open) {
      const answered = after.objections.find((entry) => entry.id === objection.id)!;
      expect(answered.status).not.toBe("open");
      expect(answered.answer).toBeTruthy();
      expect(answered.call).toBe(objection.blocking ? CALL : undefined);
    }
    expect(after.objections.some((objection) => objection.status === "open")).toBe(false);
    expect(check.body).toContain("Your call settled 1 objection (1 accepted, 0 rejected). The architect answered 1 on its own.");
    const texts = after.timeline.map((entry) => entry.text);
    const made = texts.indexOf(CALL_WORDS.made(CALL));
    expect(made).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf(CALL_WORDS.updated)).toBeGreaterThan(made);
    expect(texts.indexOf(CALL_WORDS.settled)).toBeGreaterThan(texts.indexOf(CALL_WORDS.updated));
    expect(texts.some((text) => text.startsWith("You asked for changes"))).toBe(false);

    // Approving moves on to the build, and the call is done with.
    sim.approve(check.id);
    sim.tick();
    expect(task(sim, id).call).toBeUndefined();
    expect(task(sim, id).agent?.roleId).toBe("builder");
  });

  it("sends changes asked for at the check after a call to the architect only, back to the same check", () => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const before = task(sim, id);
    const reviews = reviewerRuns(before);
    const rounds = { ...before.rounds };

    sim.requestChanges(check.id, "Say what the confirmation step looks like on phones.");
    const again = tickUntil(sim, "design");
    const after = task(sim, id);
    expect(again.id).not.toBe(check.id);
    expect(after.stageIndex).toBe(before.stageIndex);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds).toEqual(rounds);
    expect(inboxItem(sim, "disagreement")).toBeUndefined();
    expect(after.timeline.some((entry) => entry.text === CALL_WORDS.revised)).toBe(true);
    // The architect answered every objection the call covered again, so its notes follow the updated brief.
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).not.toBe("open");
      expect(objection.answer).toContain("your note");
    }
  });

  it("lets the architect correct a decision, a 'Your call' tag or a note when changes are asked for after a call", () => {
    const call: DesignCall = { text: CALL, stageId: "design", open: ["a", "b"], at: 0 };
    const objection = (id: string, extra: Partial<Objection>): Objection => ({ id, round: 2, text: `Objection ${id}`, blocking: true, raisedBy: "sol-xhigh", status: "open", ...extra });
    const answered = [
      objection("a", { status: "rejected", answer: "Removed it, as the call says.", call: CALL }),
      objection("b", { status: "accepted", answer: "Added it." }),
      objection("c", { status: "accepted", answer: "Settled before the call." }),
    ];
    // Every objection the call covered is due again; one answered before the call is not.
    expect(dueAnswers(answered, call).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(unanswered(answered, call, [{ id: "a" }]).map((entry) => entry.id)).toEqual(["b"]);

    const corrected = answerByCall(answered, call, [
      { id: "a", status: "accepted", byCall: false, answer: "The call does not decide it. Kept it in the brief." },
      { id: "b", status: "rejected", byCall: true, answer: "Left it out of the brief, as the call says." },
      { id: "c", status: "rejected", byCall: true, answer: "Not due." },
    ]);
    expect(corrected[0]).toEqual(objection("a", { status: "accepted", answer: "The call does not decide it. Kept it in the brief." }));
    expect(corrected[1]).toEqual(objection("b", { status: "rejected", answer: "Left it out of the brief, as the call says.", call: CALL }));
    expect(corrected[2]).toBe(answered[2]);
  });

  it("adds a design check after a call when the plan has none right after the design, and moves on from it", () => {
    const { sim, id } = disagreeing("new");
    const before = task(sim, id);
    const design = before.plan!.stages[before.stageIndex]!;
    expect(before.plan!.stages[before.stageIndex + 1]!.kind).not.toBe("gate");

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const at = task(sim, id);
    expect(at.plan!.stages[at.stageIndex]).toMatchObject({ kind: "gate", gate: "design", id: `${design.id}:call-check` });
    expect(at.plan!.stages[at.stageIndex - 1]!.id).toBe(design.id);

    sim.approve(check.id);
    sim.tick();
    expect(task(sim, id).agent?.roleId).toBe("ux-designer");
  });

  it("leaves siding with the architect as it was", () => {
    const { sim, id } = disagreeing();
    const before = task(sim, id);
    const open = before.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
    const stages = before.plan!.stages.length;

    sim.approve(inboxItem(sim, "disagreement")!.id);
    const after = task(sim, id);
    expect(after.timeline.at(-1)?.text).toBe("You sided with the architect");
    for (const objectionId of open) {
      const objection = after.objections.find((entry) => entry.id === objectionId)!;
      expect(objection.status).toBe("rejected");
      expect(objection.call).toBeUndefined();
    }
    expect(after.call).toBeUndefined();
    expect(after.plan!.stages).toHaveLength(stages);
    expect(inboxItem(sim, "design")?.body).toBeUndefined();
  });

  it("sends the design back for a full round when changes are asked for at a check with no call", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    const check = tickUntil(sim, "design");
    const before = task(sim, id);
    const reviews = reviewerRuns(before);

    sim.requestChanges(check.id, "Keep carts for a month.");
    tickUntil(sim, "design");
    const after = task(sim, id);
    expect(reviewerRuns(after)).toBe(reviews + 1);
    expect(after.timeline.some((entry) => entry.text === "You asked for changes: Keep carts for a month.")).toBe(true);
  });

  it("lets the demo coordinator make the call on the demo disagreement", () => {
    const sim = new Simulator(createDemoState(1_000_000_000), { triggers: DEMO_TRIGGERS, prMergeAfter: 1_000 });
    const item = inboxItem(sim, "disagreement")!;
    expect(item.body).toBe(CALL_WORDS.disagreement);
    sim.requestChanges(item.id, CALL);
    for (let tick = 0; tick < 100 && !sim.getState().inbox.some((entry) => entry.kind === "design" && entry.taskId === item.taskId); tick += 1) {
      sim.tick();
      for (const entry of sim.getState().inbox) if (entry.taskId !== item.taskId && entry.kind === "question") sim.answer(entry.id, entry.options?.[0] ?? "Yes");
    }
    const check = sim.getState().inbox.find((entry) => entry.kind === "design" && entry.taskId === item.taskId);
    expect(check?.body).toContain("Your call settled");
    const settled = task(sim, item.taskId);
    expect(settled.brief?.summary).toContain("following your call");
    expect(settled.objections.some((objection) => objection.call === CALL)).toBe(true);
    expect(settled.objections.some((objection) => objection.status === "open")).toBe(false);
  });
});

describe("Simulator", () => {
  it("takes a bug from the queue to an open pull request without ever merging it itself", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Fix the broken link", kind: "bug" });

    runUntil(sim, () => task(sim, id).state === "pr-open");

    const done = task(sim, id);
    expect(done.state).toBe("pr-open");
    expect(done.column).toBe("ready");
    expect(done.pr?.state).toBe("open");
    // The first reviewer found a blocking issue, the builder fixed it, the second round passed.
    expect(done.findings.find((finding) => finding.severity === "blocking")?.status).toBe("fixed");
    expect(done.findings.find((finding) => finding.severity === "blocking")?.confirmedBy).toHaveLength(1);
  });

  it("waits at the delivery gate without holding a pool slot", () => {
    const sim = new Simulator(emptyState(1));
    const id = sim.addTask({ productId: "p", title: "Tidy the footer", kind: "chore" });
    for (let tick = 0; tick < 200 && !sim.getState().inbox.some((item) => item.kind === "delivery"); tick += 1) sim.tick();

    expect(task(sim, id).state).toBe("needs-you");
    expect(task(sim, id).holdsSlot).toBe(false);
    expect(slotUses(sim.getState())).toHaveLength(0);
  });

  it("settles a design only after the architect answers the blocking objection", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    for (let tick = 0; tick < 200 && !sim.getState().inbox.some((item) => item.kind === "design"); tick += 1) sim.tick();

    const designed = task(sim, id);
    expect(designed.brief).toBeDefined();
    expect(designed.objections.filter((objection) => objection.blocking).every((objection) => objection.status === "accepted")).toBe(true);
  });

  it("starts queued tasks in priority order and respects the pool limit", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: true, toolCaps: {} } });
    const a = sim.addTask({ productId: "p", title: "First", kind: "chore" });
    const b = sim.addTask({ productId: "p", title: "Second", kind: "chore", position: "top" });
    sim.setPoolPaused(false);

    expect(task(sim, b).state).toBe("running");
    expect(task(sim, a).state).toBe("queued");
  });

  it("delivers a queued message at the next step and an interrupt right away", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Search", kind: "chore" });
    sim.sendMessage(id, "Keep it simple");
    expect(task(sim, id).queued).toHaveLength(1);

    sim.tick();
    expect(task(sim, id).queued).toHaveLength(0);
    expect(task(sim, id).session.some((line) => line.from === "you" && line.text === "Keep it simple")).toBe(true);

    sim.sendMessage(id, "Actually, stop and use the old icons", "interrupt");
    expect(task(sim, id).session.some((line) => line.text === "Actually, stop and use the old icons")).toBe(true);
  });

  it("releases the slot when a task is paused and lets the next one start", () => {
    const sim = new Simulator(emptyState(1));
    const a = sim.addTask({ productId: "p", title: "One", kind: "chore" });
    const b = sim.addTask({ productId: "p", title: "Two", kind: "chore" });

    sim.pause(a);
    expect(task(sim, a).holdsSlot).toBe(false);
    expect(task(sim, b).state).toBe("running");
  });

  it("skips held tasks in the queue", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: true, toolCaps: {} } });
    const held = sim.addTask({ productId: "p", title: "Not yet", kind: "chore" });
    const next = sim.addTask({ productId: "p", title: "Go", kind: "chore" });
    sim.setHeld(held, true);
    sim.setPoolPaused(false);

    expect(task(sim, held).state).toBe("queued");
    expect(task(sim, next).state).toBe("running");
  });

  it("reorders the queue", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: true, toolCaps: {} } });
    const a = sim.addTask({ productId: "p", title: "A", kind: "chore" });
    const b = sim.addTask({ productId: "p", title: "B", kind: "chore" });
    const c = sim.addTask({ productId: "p", title: "C", kind: "chore" });
    sim.moveInQueue(c, 0);
    const order = sim.getState().tasks.filter((entry) => entry.state === "queued").sort((x, y) => x.priority - y.priority).map((entry) => entry.id);
    expect(order).toEqual([c, a, b]);
  });

  it("builds a demo board with work in every column and a consistent inbox", () => {
    const state = createDemoState(1_000_000_000);
    const columns = new Set(state.tasks.map((entry) => entry.column));
    for (const column of ["queue", "planning", "designing", "building", "reviewing", "ready", "done"]) expect(columns.has(column as Task["column"])).toBe(true);
    expect(new Set(state.inbox.map((item) => item.id)).size).toBe(state.inbox.length);
    expect(state.inbox.map((item) => item.kind).sort()).toEqual(["delivery", "disagreement", "permission", "plan", "question"]);
    expect(slotUses(state)).toHaveLength(3);
    expect(startsNextCount(state)).toBe(1);
  });

  it("builds a twenty-product portfolio that fits in its pool", () => {
    const { state } = createPortfolioDemo(1_000_000_000);
    expect(state.products).toHaveLength(20);
    expect(slotUses(state).length).toBeLessThanOrEqual(state.pool.limit);
    expect(new Set(state.inbox.map((item) => item.id)).size).toBe(state.inbox.length);
    expect(new Set(state.tasks.map((task) => task.productId)).size).toBe(16);
  });
});
