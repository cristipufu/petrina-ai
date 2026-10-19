import { describe, expect, it } from "vitest";
import { gateStatus, gateTitle, MAX_REVIEW_ROUNDS, noteRoundEnd, reviewRoundEnd, type DeepMutable } from "../src/flow.js";
import { answerByCall, CALL_WORDS, dueAnswers, unanswered } from "../src/call.js";
import { CLEANUP_WORDS } from "../src/cleanup.js";
import { createDemoState, createPortfolioDemo, DEMO_TRIGGERS } from "../src/demo.js";
import { JOURNEY_WORDS as W } from "../src/journey.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../src/library.js";
import type { DesignCall, Objection, Stage, State, Task } from "../src/model.js";
import { slotUses, startsNextCount } from "../src/scheduler.js";
import { readCall, Simulator } from "../src/sim.js";
import { MemoryWorkLog } from "../src/worklog.js";

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

/** The same simulator, with the disagreeing task's plan reshaped around its design stage. */
function reshaped(sim: Simulator, id: string, reshape: (stages: Stage[], design: number) => Stage[]): Simulator {
  const state = JSON.parse(JSON.stringify(sim.getState())) as { tasks: { id: string; stageIndex: number; plan: { stages: Stage[] } }[] };
  const draft = state.tasks.find((entry) => entry.id === id)!;
  draft.plan.stages = reshape(draft.plan.stages, draft.stageIndex);
  return new Simulator(state as unknown as State, { prMergeAfter: 1_000, disagree: [id] });
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

describe("limits between simulated agents", () => {
  for (const limit of ["tool", "pool", "paused"] as const) {
    it(`keeps running agents when the ${limit} limit changes, then checks same-tool successors`, () => {
      const sim = new Simulator(emptyState(9));
      sim.setPoolPaused(true);
      sim.setToolCap("claude-code", 7);
      const ids = Array.from({ length: 9 }, (_, index) => sim.addTask({ productId: "p", title: `Task ${index}`, kind: "new" }));
      sim.setPoolPaused(false);
      expect(slotUses(sim.getState())).toHaveLength(7);
      if (limit === "tool") sim.setToolCap("claude-code", 5);
      else if (limit === "pool") sim.setPoolLimit(5);
      else sim.setPoolPaused(true);
      expect(slotUses(sim.getState())).toHaveLength(7);
      let reachedFive = false;
      const queued = ids.slice(7);
      let waitingSeen = false;
      let otherToolSeen = false;
      for (let tick = 0; tick < 100; tick += 1) {
        sim.tick();
        const state = sim.getState();
        const uses = slotUses(state);
        for (const task of state.tasks) if (task.holdsSlot) expect(task.agent).toBeDefined();
        const used = limit === "tool" ? uses.filter((use) => use.toolId === "claude-code").length : uses.length;
        if (used <= 5) reachedFive = true;
        if (reachedFive) expect(used).toBeLessThanOrEqual(5);
        for (const task of state.tasks.filter((task) => task.state === "waiting")) {
          waitingSeen = true;
          expect(task.column).not.toBe("queue");
          expect(task.statusLine).toMatch(/Waiting for (a free|the pool)/);
        }
        otherToolSeen ||= uses.some((use) => use.toolId === "codex");
        for (const item of state.inbox) if (!item.blocking) sim.approve(item.id);
        if (limit === "paused" && uses.length === 0) {
          expect(queued.every((id) => task(sim, id).state === "queued")).toBe(true);
          sim.setPoolPaused(false);
          expect(queued.every((id) => task(sim, id).state === "queued")).toBe(true);
          break;
        }
      }
      expect(waitingSeen).toBe(true);
      if (limit !== "paused") expect(otherToolSeen).toBe(true);
    });
  }
});

describe("The coordinator's call on a design disagreement", () => {
  const CALL = "Accept the blocking point: keep the confirmation step only for existing accounts.";
  const objections = [
    { id: "b", blocking: true, text: "The answer for existing accounts adds a confirmation step to notifications that slows everyone down." },
    { id: "m", blocking: false, text: "Consider a short note telling existing users what changed." },
  ];
  const read = (words: string) => Object.fromEntries(readCall(words, objections, "notifications"));
  const clearCalls: readonly [string, Partial<Record<"b" | "m", "accepted" | "rejected">>][] = [
    ["Reject the blocking point in any case.", { b: "rejected" }],
    ["Reject the blocking point no matter what.", { b: "rejected" }],
    ["Reject both points without exception.", { b: "rejected", m: "rejected" }],
    ["Side with the architect in any case.", { b: "rejected", m: "rejected" }],
    ["Reject the blocking point, whether or not the note stays.", { b: "rejected" }],
    ["Reject the blocking point, whether or not it stays.", { b: "rejected" }],
    ["Reject the blocking point, whether or not the confirmation step stays.", { b: "rejected" }],
    ["Reject the blocking point, whether or not the step stays.", { b: "rejected" }],
    ["Accept the short note, whether or not the note stays.", { m: "accepted" }],
    ["Accept the short note, whether or not the blocking point stays.", { m: "accepted" }],
    ["Reject both points, whether or not the note stays.", { b: "rejected", m: "rejected" }],
    ["Accept the short note in any case.", { m: "accepted" }],
    ["Accept both without exception.", { b: "accepted", m: "accepted" }],
    ["Reject it: the blocking point.", { b: "rejected" }],
    ["Reject it (the blocking point).", { b: "rejected" }],
    ["Reject — the blocking point.", { b: "rejected" }],
    ["Accept it: the short note.", { m: "accepted" }],
    ["Don't, in any case, reject the blocking point.", { b: "accepted" }],
    ["I will not, in any case, reject the blocking point.", { b: "accepted" }],
    ["Do not, in any case, accept the blocking point.", { b: "rejected" }],
    ["Never, without exception, reject the blocking point.", { b: "accepted" }],
    ["I refuse to, no matter what, accept the blocking point.", { b: "rejected" }],
    ["The minor one, side with the reviewer, and the blocking one, side with the architect.", { b: "rejected", m: "accepted" }],
    ["For the minor one, side with the reviewer, and for the blocking one, side with the architect.", { b: "rejected", m: "accepted" }],
    ["Regarding the blocking point, side with the architect, and regarding the minor point, side with the reviewer.", { b: "rejected", m: "accepted" }],
    ["The blocking one, side with the reviewer, and the minor one, side with the architect.", { b: "accepted", m: "rejected" }],
    ["The minor one, side with the reviewer. The blocking one, side with the architect.", { b: "rejected", m: "accepted" }],
    ["The minor one, accept it, and the blocking one, reject it.", { b: "rejected", m: "accepted" }],
    ["For the minor one, accept it, and for the blocking one, reject it.", { b: "rejected", m: "accepted" }],
    ["For the minor one, side with the reviewer, and for the blocking one, reject it.", { b: "rejected", m: "accepted" }],
    ["For the minor one, accept it, and for the blocking one, side with the architect.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer on the minor point and the architect for the blocking one.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer on the minor point and the architect about the blocking one.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer for the minor point and the architect about the blocking one.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer about the minor point and the architect for the blocking one.", { b: "rejected", m: "accepted" }],
    ["Side with the architect for the blocking one and the reviewer about the minor one.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer for the blocking one and the architect about the minor one.", { b: "accepted", m: "rejected" }],
    ["Reject every one of them.", { b: "rejected", m: "rejected" }],
    ["Accept every one of them.", { b: "accepted", m: "accepted" }],
    ["Reject each one of them.", { b: "rejected", m: "rejected" }],
    ["Accept each one of them.", { b: "accepted", m: "accepted" }],
    ["Reject every one.", { b: "rejected", m: "rejected" }],
    ["Accept each one.", { b: "accepted", m: "accepted" }],
    ["Do not accept every one of them.", { b: "rejected", m: "rejected" }],
    ["Accept each one of them except the blocking point.", { b: "rejected", m: "accepted" }],
    ...["every", "each"].flatMap((all) => ["", "single ", "last "].flatMap((emphasis) => ["them", "the points", "the objections"].flatMap((points): typeof clearCalls[number][] => [
      [`Reject ${all} ${emphasis}one of ${points}.`, { b: "rejected", m: "rejected" }],
      [`Accept ${all} ${emphasis}one of ${points}.`, { b: "accepted", m: "accepted" }],
    ]))),
    ["Reject the blocking point whether or not the note stays.", { b: "rejected" }],
    ["Reject the blocking point, whether or not the note stays, and accept the short note.", { b: "rejected", m: "accepted" }],
    ...["answer", "answers", "note", "notes", "confirmation", "confirmations"].flatMap((reply): typeof clearCalls[number][] => [
      [`Side with the architect's ${reply}.`, { b: "rejected", m: "rejected" }],
      [`Side with the reviewer's ${reply}.`, { b: "accepted", m: "accepted" }],
    ]),
    ...["in any case", "no matter what", "without exception"].flatMap((emphasis): typeof clearCalls[number][] => [
      [`${emphasis} reject the blocking point.`, { b: "rejected" }],
      [`${emphasis} reject the blocking point and accept the short note.`, { b: "rejected", m: "accepted" }],
      [`Reject the blocking point ${emphasis} and accept the short note.`, { b: "rejected", m: "accepted" }],
      [`Reject the blocking point ${emphasis}: the confirmation step stays.`, { b: "rejected" }],
      [`Reject (${emphasis}) the blocking point.`, { b: "rejected" }],
      [`Reject — ${emphasis} — the blocking point.`, { b: "rejected" }],
      [`Reject, ${emphasis}, the blocking point.`, { b: "rejected" }],
      [`Do not (${emphasis}) accept the blocking point.`, { b: "rejected" }],
      [`Don't — ${emphasis} — reject the blocking point.`, { b: "accepted" }],
    ]),
    ["Accept the short note, while rejecting the blocking point.", { b: "rejected", m: "accepted" }],
    ["Accept the short note while rejecting the blocking point.", { b: "rejected", m: "accepted" }],
    ["Accept the short note while rejecting the blocking point that stays.", { b: "rejected", m: "accepted" }],
    ["Reject the blocking point while accepting that the note stays.", { b: "rejected", m: "accepted" }],
    ["While rejecting the blocking point that stays, accept the short note.", { b: "rejected", m: "accepted" }],
    ["While rejecting the blocking point.", { b: "rejected" }],
    ["While siding with the architect on the blocking point.", { b: "rejected" }],
    ["Reject the minor point while siding with the architect on the blocking one.", { b: "rejected", m: "rejected" }],
    ["Reject the blocking point, while accepting the short note.", { b: "rejected", m: "accepted" }],
    ["Reject the blocking point, while keeping the note short.", { b: "rejected" }],
    ["While keeping the note short, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point, while keeping the note that helps.", { b: "rejected" }],
    ["While keeping the note that helps, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point, while keeping the note which helps.", { b: "rejected" }],
    ["While keeping the note which helps, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point, while keeping the note that still helps.", { b: "rejected" }],
    ["While keeping the note that still helps, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point that still helps.", { b: "rejected" }],
    ["Accept the short note which helps.", { m: "accepted" }],
    ["While rejecting the blocking point that is optional, accept the short note.", { b: "rejected", m: "accepted" }],
    ["Accept the short note while rejecting the blocking point that is optional.", { b: "rejected", m: "accepted" }],
    ["Reject the blocking point that is optional.", { b: "rejected" }],
    ["Don't reject the blocking point that is optional.", { b: "accepted" }],
    ["Accept the short note that helps.", { m: "accepted" }],
    ["Reject the confirmation step.", { b: "rejected" }],
    ["Reject the confirmation step which helps.", { b: "rejected" }],
    ["Reject the step which helps.", { b: "rejected" }],
    ["Reject the confirmation step that still helps.", { b: "rejected" }],
    ["Reject the confirmation step that is optional.", { b: "rejected" }],
    ["While keeping the confirmation step which helps, reject the blocking point.", { b: "rejected" }],
    ["While rejecting the confirmation step that is optional, accept the short note.", { b: "rejected", m: "accepted" }],
    ["Accept the suggestion.", { m: "accepted" }],
    ["Accept the suggestion that helps.", { m: "accepted" }],
    ["Accept the minor suggestion that helps.", { m: "accepted" }],
    ["Reject everything except the short note.", { b: "rejected", m: "accepted" }],
    ["Reject everything except the note which helps.", { b: "rejected", m: "accepted" }],
    ["Reject everything except the note that still helps.", { b: "rejected", m: "accepted" }],
    ["Reject all but the note that helps.", { b: "rejected", m: "accepted" }],
    ["Reject the blocking point, not the note which helps.", { b: "rejected", m: "accepted" }],
    ["Accept the blocking point and the short note.", { b: "accepted", m: "accepted" }],
    ["Accept the blocking point and the note which helps.", { b: "accepted", m: "accepted" }],
    ["Accept the blocking point and the short note that helps.", { b: "accepted", m: "accepted" }],
    ["Accept the blocking point and the note that is optional.", { b: "accepted", m: "accepted" }],
    ["Reject the confirmation step that is now optional.", { b: "rejected" }],
    ["Don't reject the confirmation step which helps.", { b: "accepted" }],
    ["Accept the short note which still is optional.", { m: "accepted" }],
    ["Accept the suggestion that remains an open question.", { m: "accepted" }],
    ["While rejecting the blocking point that is optional.", { b: "rejected" }],
    ["Reject the short note. Accepting the short note is still open.", { m: "rejected" }],
    ["Accept the blocking point. It is optional to reject the blocking point.", { b: "accepted" }],
    ["Accept the blocking point. While rejecting the blocking point remains optional.", { b: "accepted" }],
    ["Accept the blocking point. Rejecting the blocking point is optional.", { b: "accepted" }],
    ["Accept both points. While rejecting the blocking point is optional.", { b: "accepted", m: "accepted" }],
    ["Reject both points. While accepting the short note is still open.", { b: "rejected", m: "rejected" }],
    ["Accept both points. While keeping the note is optional.", { b: "accepted", m: "accepted" }],
    ["Accept both points. While siding with the architect is optional.", { b: "accepted", m: "accepted" }],
    ["Accept the short note. While rejecting the blocking point is optional.", { m: "accepted" }],
    ["Reject the blocking point. While accepting the short note is optional.", { b: "rejected" }],
    ["Accept the short note. While keeping it helps.", { m: "accepted" }],
    ["Either way, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point, either way.", { b: "rejected" }],
    ["Regardless, reject the blocking point.", { b: "rejected" }],
    ["Accept the blocking point and the note about what changed.", { b: "accepted", m: "accepted" }],
    ["Accept the note about what changed.", { m: "accepted" }],
    ["Accept the blocking point, and the note about what changed.", { b: "accepted", m: "accepted" }],
    ["Accept the minor point and the architect to review the blocking one.", { m: "accepted" }],
    ["Side with the reviewer on the minor point and the architect to review the blocking one.", { m: "accepted" }],
    ["Accept the minor point and the architect about the blocking one can wait.", { m: "accepted" }],
    ["Accept the minor point and the architect for the blocking one.", { m: "accepted" }],
  ];

  it.each(clearCalls)("keeps clear call regressions settled, including a later correction: %s", (words, expected) => {
    expect(read(words)).toEqual(expected);
    const decisions = new Map(Object.entries(expected));
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const settled = task(sim, id);
    const due = settled.call!.open;
    for (const objection of settled.objections.filter((entry) => due.includes(entry.id))) {
      const decision = decisions.get(objection.blocking ? "b" : "m");
      expect(objection.status).toBe(decision ?? (objection.blocking ? "accepted" : "rejected"));
      expect(objection.call).toBe(decision ? words : undefined);
    }

    // Put every point on the other side first, so the same wording must now correct an answer.
    const reset = objections.map(({ id, blocking }) => `${decisions.get(id) === "accepted" ? "Reject" : "Accept"} the ${blocking ? "blocking point" : "minor one"}`).join(" and ");
    sim.requestChanges(check.id, reset);
    const again = tickUntil(sim, "design");
    const before = task(sim, id);
    sim.requestChanges(again.id, words);
    tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => due.includes(entry.id))) {
      const previous = before.objections.find((entry) => entry.id === objection.id)!;
      const decision = decisions.get(objection.blocking ? "b" : "m");
      expect(objection.status).toBe(decision ?? previous.status);
      expect(objection.call).toBe(previous.call);
      if (decision) expect(objection.answer).toContain("your note");
    }
    expect(reviewerRuns(after)).toBe(reviewerRuns(before));
    expect(after.rounds).toEqual(before.rounds);
  });

  it("keeps negatives, conditions and unclear wording around emphasis or a detached point unclear", () => {
    for (const words of [
      "Accept neither point in any case.",
      "Accept none of them without exception.",
      "Reject any point in any case.",
      "I do not want to reject the blocking point in any case.",
      "Should we reject the blocking point in any case?",
      "Reject the blocking point if the note stays, in any case.",
      "Reject the blocking point in any case where the note stays.",
      "Accept both without exception except the short note.",
      "Reject the blocking point, whether the note stays.",
      "Reject the blocking point, whether or not we accept the minor one.",
      "Accept it: the short note or the blocking point.",
      "Reject — if the minor point stays.",
      "I accept the brief — the blocking point.",
      "Reject the blocking point, while the note stays.",
      "While it stays, reject the blocking point.",
      "Reject the blocking point while the confirmation step stays.",
      "While the step stays, reject the blocking point.",
    ]) expect(read(words), words).toEqual({});
    expect(read("Reject the blocking point, in any case.")).toEqual({ b: "rejected" });
    expect(read("Accept the short note, whether or not the blocking point stays.")).toEqual({ m: "accepted" });
    expect(read("Never reject the blocking point in any case.")).toEqual({ b: "accepted" });
    expect(read("I refuse to accept it: the blocking point.")).toEqual({ b: "rejected" });
  });

  it("keeps later decisions and named points ahead of an earlier pronoun's topic", () => {
    expect(read("Reject the blocking point in any case. On second thought, accept it.")).toEqual({ b: "accepted" });
    expect(read("Reject it: the blocking point. On second thought, accept it.")).toEqual({ b: "accepted" });
    expect(read("Accept the minor point. Reject it: the blocking point.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Reject the blocking point. Accept it: the short note.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Accept – the short note.")).toEqual({ m: "accepted" });
    expect(read("Reject - the blocking point.")).toEqual({ b: "rejected" });
  });

  it.each([
    "Accept the blocking point if it is optional.",
    "Reject the blocking point if it stays.",
    "Accept the blocking point, whether it is right.",
    "If it is optional, accept the blocking point.",
    "Reject the blocking point unless it stays.",
    "Do not, if it stays, accept the blocking point.",
    "Reject the blocking point, whether or not it stays if the minor point is optional.",
    "Reject the blocking point, whether it stays or goes.",
    "Don't, perhaps, reject the blocking point.",
    "Never, possibly, accept the blocking point.",
    "Accept the minor point and don't, perhaps, reject the blocking point.",
    "Reject the blocking point, or accept the short note.",
    "Accept the blocking point or reject the short note.",
    "Side with the reviewer, or side with the architect on the blocking point.",
    "Reject the blocking point. Or accept the short note.",
    "Accept the short note. Or reject the blocking point.",
    "Reject the blocking point, or the minor one.",
    "Either reject the blocking point or accept the short note.",
    "I might reject the blocking point.",
    "I may accept the blocking point.",
    "I might, after checking, reject the blocking point.",
    "I may (in any case) accept the blocking point.",
    "I might side with the architect on the minor point.",
    "Reject the blocking point and I may accept the minor one.",
    "Reject the blocking point when the note stays.",
    "Reject the blocking point whenever the note stays.",
    "Accept the short note where it helps.",
    "When the note stays, reject the blocking point.",
    "Whenever the note stays, reject the blocking point.",
    "Where it helps, accept the short note.",
    "Reject the blocking point in any case when the note stays.",
    "Accept each one of them if the step is optional.",
    "Accept one of them.",
    "Reject any one of them.",
    "Accept both (without exception) except the short note.",
    "Accept both, without exception, except the short note.",
    "Accept both — without exception — except the short note.",
    "Reject the blocking point, maybe.",
    "Reject the blocking point, perhaps.",
    "Reject the blocking point, possibly.",
    "Reject the blocking point, I might.",
    "Reject the blocking point, I may.",
    "Maybe, reject the blocking point.",
    "Perhaps, reject the blocking point.",
    "Possibly, reject the blocking point.",
    "Reject the blocking point while the note stays.",
    "Reject the blocking point while the note is optional.",
    "Reject the blocking point, while the note is optional.",
    "While the note is optional, reject the blocking point.",
    "While rejecting the blocking point is optional, accept the short note.",
    "While keeping the note is optional, reject the blocking point.",
    "While rejecting the blocking point remains open, accept the short note.",
    "While accepting the short note is optional, reject the blocking point.",
    "While siding with the architect is optional, accept the short note.",
    "Reject the blocking point while accepting the short note is still open.",
    "Accept the short note while keeping it helps.",
    "While rejecting the blocking point is optional.",
    "While rejecting the blocking point remains optional.",
    "While rejecting the blocking point is still optional.",
    "While accepting the short note is still open.",
    "It is optional to reject the blocking point.",
    "It is still optional to reject the blocking point.",
    "It is optional to accept the short note.",
    "It is optional to side with the architect.",
    "Rejecting the blocking point is optional.",
    "Accepting the short note is optional.",
    "Siding with the architect is optional.",
    "Rejecting the blocking point remains optional.",
    "Accepting the short note is still optional.",
    "Rejecting the blocking point stays open.",
    "Accepting the short note is still open.",
    "Rejecting the blocking point remains open.",
    "Accepting both points are optional.",
    "Reject the blocking point, which is optional.",
    "Reject the blocking point, which is still open.",
    "Reject the blocking point, which remains optional.",
    "Reject the blocking point, which stays open.",
    "Reject the blocking point, this is optional.",
    "Reject the blocking point (this is optional).",
    "Reject the blocking point, that is optional.",
    "Reject the blocking point, that is still optional.",
    "Reject the blocking point, that is still open.",
    "Reject the blocking point, that stays open.",
    "Reject the blocking point, that remains optional.",
    "Reject the blocking point, that remains open.",
    "Reject the blocking point, that helps.",
    "Reject the blocking point (that is optional).",
    "Reject the blocking point (that helps).",
    "Reject the blocking point — that helps.",
    "Reject the blocking point — that is optional.",
    "Side with the architect, that is optional.",
    "Side with the reviewer, that is optional.",
    "While rejecting that is optional, accept the short note.",
    "While keeping that helps.",
    "Reject the blocking point while keeping that helps.",
    "While keeping that helps, reject the blocking point.",
    "Accept the short note while keeping that helps.",
    "It's optional to reject the blocking point.",
    "It’s optional to reject the blocking point.",
    "It's optional to accept the short note.",
    "It's optional to side with the architect.",
    "It's open to reject the blocking point.",
    "It’s open to accept the short note.",
    "It's still open to reject the blocking point.",
    "It's now open to reject the blocking point.",
    "It's left open to reject the blocking point.",
    "It's open to side with the architect.",
    "It is now open to reject the blocking point.",
    "Rejecting the blocking point is now open.",
    "Accepting both points are now open.",
    "While rejecting the blocking point is now open, accept the short note.",
    "Rejecting the blocking point is still left open.",
    "Rejecting the blocking point is now left open.",
    "Rejecting the blocking point is an optional choice.",
    "It is an optional choice to reject the blocking point.",
    "Rejecting the blocking point remains an open question.",
    "Reject the blocking point (this is now open).",
    "Reject the blocking point, that is now open.",
    "Reject the blocking point — which is now open.",
    "Reject the blocking point (it's open).",
    "Reject the blocking point, it's open.",
    "Reject the confirmation step which helps if the note stays.",
    "Accept the blocking point and the note which helps, maybe.",
    "Reject everything except the note which helps, or accept both points.",
    "Reject the blocking point, it's optional.",
    "Reject the blocking point (it's optional).",
    "Optionally reject the blocking point.",
    "Rejecting the blocking point is open.",
    "Rejecting the blocking point is now optional.",
    "Rejecting the blocking point is left open.",
    "Reject the blocking point (this is still open).",
    "Reject the blocking point (this remains optional).",
    "Reject the blocking point (this stays open).",
    "While keeping the note is optional.",
    "While siding with the architect is optional.",
    "While keeping it helps.",
    "While rejecting the blocking point remains open.",
    "Reject the blocking point while it remains.",
    "While it remains, reject the blocking point.",
    "Accept the short note while it helps.",
    "While it helps, accept the short note.",
    "Reject the blocking point in case the note stays.",
    "Accept the blocking point provided the note stays.",
    "Reject the blocking point as long as the note stays.",
    "Reject the blocking point, assuming the note stays.",
    "While the note stays, reject the blocking point.",
    "In case the note stays, reject the blocking point.",
    "Provided the note stays, accept the blocking point.",
    "As long as the note stays, reject the blocking point.",
    "Assuming the note stays, reject the blocking point.",
    "Reject the blocking point. Alternatively, accept the short note.",
    "Reject the blocking point, alternatively accept the short note.",
    "Reject every one of the points if the step is optional.",
    "Accept every single one of them, maybe.",
    "Reject every last one of the objections or accept the blocking point.",
  ])("leaves conditions and unclear asides unresolved, including at the design check: %s", (words) => {
    expect(read(words)).toEqual({});
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    let check = tickUntil(sim, "design");
    const settled = task(sim, id);
    for (const objection of settled.objections.filter((entry) => settled.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "accepted" : "rejected");
      expect(objection.call).toBeUndefined();
    }
    expect(check.body).toContain("Your call settled 0 objections");

    for (const reset of ["Accept both points.", "Reject both points."]) {
      sim.requestChanges(check.id, reset);
      check = tickUntil(sim, "design");
      const before = task(sim, id).objections;
      sim.requestChanges(check.id, words);
      check = tickUntil(sim, "design");
      expect(task(sim, id).objections.map(({ id, status, call }) => ({ id, status, call }))).toEqual(before.map(({ id, status, call }) => ({ id, status, call })));
    }
  });

  it.each([
    "Side with the reviewer on the minor point and I checked with the architect on the blocking point.",
    "Side with the reviewer on the minor point, after talking with the architect about the blocking point.",
    "Side with the reviewer on the minor point and I spoke with the architect on the blocking point.",
  ])("does not take a conversation with the architect as a decision: %s", (words) => {
    expect(read(words)).toEqual({ m: "accepted" });
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const settled = task(sim, id);
    for (const objection of settled.objections.filter((entry) => settled.call!.open.includes(entry.id))) {
      expect(objection.status).toBe("accepted");
      expect(objection.call).toBe(objection.blocking ? undefined : words);
    }
    expect(check.body).toContain("Your call settled 1 objection (1 accepted, 0 rejected)");

    sim.requestChanges(check.id, words);
    tickUntil(sim, "design");
    const blocking = task(sim, id).objections.find((entry) => entry.blocking && settled.call!.open.includes(entry.id))!;
    expect(blocking.status).toBe("accepted");
    expect(blocking.call).toBeUndefined();
    expect(read("Side with the reviewer on the minor point and with the architect on the blocking point.")).toEqual({ b: "rejected", m: "accepted" });
  });

  it.each(["answer", "answers", "note", "notes", "confirmation", "confirmations"])("keeps each side's %s with its named point", (reply) => {
    for (const preposition of ["on", "about", "for", "to"]) {
      expect(read(`Accept the architect's ${reply} ${preposition} the blocking one.`)).toEqual({ b: "rejected" });
      expect(read(`Reject the architect's ${reply} ${preposition} the minor one.`)).toEqual({ m: "accepted" });
      for (const action of ["Accept", "Reject", "Side with the reviewer on"]) {
        const words = `${action} the minor point and the architect's ${reply} ${preposition} the blocking one.`;
        const expected = action === "Reject" ? { b: "accepted", m: "rejected" } : { b: "rejected", m: "accepted" };
        expect(read(words)).toEqual(expected);
        const { sim, id } = disagreeing();
        sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
        const check = tickUntil(sim, "design");
        const due = task(sim, id).call!.open;
        for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
          expect(objection.status).toBe(expected[objection.blocking ? "b" : "m"]);
          expect(objection.call).toBe(words);
        }
        sim.requestChanges(check.id, action === "Reject" ? "Reject the blocking point and accept the minor one." : "Accept the blocking point and reject the minor one.");
        const again = tickUntil(sim, "design");
        sim.requestChanges(again.id, words);
        tickUntil(sim, "design");
        for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
          expect(objection.status).toBe(expected[objection.blocking ? "b" : "m"]);
        }
      }
      const words = `Side with the architect on the blocking point and the reviewer's ${reply} ${preposition} the minor one.`;
      expect(read(words)).toEqual({ b: "rejected", m: "accepted" });
      const { sim, id } = disagreeing();
      sim.requestChanges(inboxItem(sim, "disagreement")!.id, "Side with the reviewer.");
      const check = tickUntil(sim, "design");
      sim.requestChanges(check.id, words);
      tickUntil(sim, "design");
      for (const objection of task(sim, id).objections.filter((entry) => task(sim, id).call!.open.includes(entry.id))) {
        expect(objection.status).toBe(objection.blocking ? "rejected" : "accepted");
      }
    }
  });

  it.each([
    ["Reject the blocking point and tell users what changed.", { b: "rejected" }],
    ["Accept the minor one and confirm the step.", { m: "accepted" }],
    ["Accept the minor one and the step slows everyone.", { m: "accepted" }],
    ["Reject the blocking point and shorten the note.", { b: "rejected" }],
    ["Reject the blocking point and change the note.", { b: "rejected" }],
  ] as const)("keeps a joined remark from deciding an unrelated point: %s", (words, expected) => {
    expect(read(words)).toEqual(expected);
    const decisions = new Map(Object.entries(expected));
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    let check = tickUntil(sim, "design");
    const due = task(sim, id).call!.open;
    for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
      const decision = decisions.get(objection.blocking ? "b" : "m");
      expect(objection.status).toBe(decision ?? (objection.blocking ? "accepted" : "rejected"));
      expect(objection.call).toBe(decision ? words : undefined);
    }
    sim.requestChanges(check.id, "Accept the blocking point and reject the minor one.");
    check = tickUntil(sim, "design");
    sim.requestChanges(check.id, words);
    tickUntil(sim, "design");
    for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
      const decision = decisions.get(objection.blocking ? "b" : "m");
      expect(objection.status).toBe(decision ?? (objection.blocking ? "accepted" : "rejected"));
      expect(objection.call).toBe(decision ? words : undefined);
    }
  });

  it("withdraws an earlier alternative without changing an unrelated decision", () => {
    expect(read("Accept the minor point. Reject the blocking point. Or accept it.")).toEqual({ m: "accepted" });
    expect(read("Reject the blocking point. Or accept the minor point. Reject both points.")).toEqual({ b: "rejected", m: "rejected" });
    expect(read("Reject the blocking point in any case, or accept the short note.")).toEqual({});
    expect(read("Accept both without exception except the short note.")).toEqual({});
    expect(read("Accept the blocking point and the short note, but reject the short note.")).toEqual({});
    expect(read("Accept the minor point. Reject the blocking point. Alternatively, accept it.")).toEqual({ m: "accepted" });
    expect(read("Reject the blocking point. Alternatively, accept the short note. Reject both points.")).toEqual({ b: "rejected", m: "rejected" });
  });

  it("keeps a follow-up note from adding the original call's badge to an undecided point", () => {
    const { sim, id } = disagreeing();
    const words = "Reject the blocking point.";
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    let check = tickUntil(sim, "design");
    const due = task(sim, id).call!.open;
    for (const [note, status] of [["Accept the short note.", "accepted"], ["Reject the short note.", "rejected"], ["Accept the short note.", "accepted"], ["Say how it looks on phones.", "accepted"]]) {
      sim.requestChanges(check.id, note!);
      check = tickUntil(sim, "design");
      for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
        expect(objection.status).toBe(objection.blocking ? "rejected" : status);
        expect(objection.call).toBe(objection.blocking ? words : undefined);
      }
      expect(check.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");
    }
  });

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
    expect(task(sim, id).todo).toBe("Reading your call");
    sim.tick();
    expect(task(sim, id).statusLine).toBe("Reading the brief");
    expect(task(sim, id).todo).toBe("Reading your call");

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

    // Approving moves on to the build. The call stays, so nothing later can reopen the design it settled.
    sim.approve(check.id);
    sim.tick();
    expect(task(sim, id).call?.text).toBe(CALL);
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

  it.each([
    "Reject the reviewer's blocking point: the confirmation step stays.",
    "Reject: the blocking point.",
    "Reject (the blocking point).",
    "Regarding the blocking point, reject it.",
  ])("follows a call that rejects the blocking point, tagging only what it decided: %s", (words) => {
    const { sim, id } = disagreeing();
    const open = task(sim, id).objections.filter((objection) => objection.status === "open");
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of open) {
      const answered = after.objections.find((entry) => entry.id === objection.id)!;
      expect(answered.status).toBe("rejected");
      // The call decided the blocking point; the other one the architect answered in its own name.
      expect(answered.call).toBe(objection.blocking ? words : undefined);
    }
    expect(check.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");
  });

  it("lets a note at the check correct how the architect read the call", () => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const blocking = task(sim, id).objections.find((objection) => objection.blocking && task(sim, id).call!.open.includes(objection.id))!;
    expect(blocking).toMatchObject({ status: "accepted", call: CALL });
    expect(task(sim, id).journey?.find((step) => step.waitsFor === "call")).toMatchObject({ outcome: W.madeCall, reason: W.yourCall, endedAt: expect.any(Number) });
    const designCheck = task(sim, id).journey!.at(-1)!;

    sim.requestChanges(check.id, "You read my call wrong: keeping the step means I reject the blocking point.");
    const again = tickUntil(sim, "design");
    const journey = task(sim, id).journey!;
    expect(journey.find((step) => step.id === designCheck.id)).toMatchObject({ outcome: W.changes, reason: W.changesAsked, endedAt: expect.any(Number) });
    expect(journey.at(-1)).toMatchObject({ kind: "you", waitsFor: "design" });
    expect(journey.at(-1)?.endedAt).toBeUndefined();
    const corrected = task(sim, id).objections.find((objection) => objection.id === blocking.id)!;
    expect(corrected).toMatchObject({ status: "rejected", call: CALL });
    expect(corrected.answer).toContain("your note");
    expect(again.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");

    // A later note that decides nothing leaves the corrected decision as it is.
    sim.requestChanges(again.id, "Say what the confirmation step looks like on phones.");
    const later = tickUntil(sim, "design");
    expect(task(sim, id).objections.find((objection) => objection.id === blocking.id)).toMatchObject({ status: "rejected", call: CALL });

    // A correction can start with "never".
    sim.requestChanges(later.id, "Never reject the blocking point.");
    tickUntil(sim, "design");
    expect(task(sim, id).objections.find((objection) => objection.id === blocking.id)).toMatchObject({ status: "accepted", call: CALL });
  });

  it.each([
    "Reject: the blocking point.",
    "Reject (the blocking point).",
    "Regarding the blocking point, reject it.",
    "Side with the reviewer on the minor point and the architect on the blocking one.",
    "Side with the reviewer on the minor point and the architect for the blocking one.",
    "Side with the reviewer on the minor point and the architect about the blocking one.",
    "Accept the minor point and the architect's answer on the blocking one.",
    "Accept the blocking point. On second thought, reject it.",
  ])("can correct the blocking decision at the design check: %s", (note) => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const before = task(sim, id);
    const blocking = before.objections.find((objection) => objection.blocking && before.call!.open.includes(objection.id))!;
    expect(blocking.status).toBe("accepted");

    sim.requestChanges(check.id, note);
    tickUntil(sim, "design");
    const after = task(sim, id);
    expect(after.objections.find((objection) => objection.id === blocking.id)).toMatchObject({ status: "rejected", call: CALL });
    expect(reviewerRuns(after)).toBe(reviewerRuns(before));
    expect(after.rounds).toEqual(before.rounds);
  });

  it.each([
    "Side with the reviewer on the minor point and the architect on the blocking one.",
    "Side with the reviewer on the minor point and the architect for the blocking one.",
    "Side with the reviewer on the minor point and the architect about the blocking one.",
    "Side with the reviewer for the minor point and the architect about the blocking one.",
    "Accept the minor point and the architect's answer on the blocking one.",
  ])("follows both parts of a split call: %s", (words) => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "rejected" : "accepted");
      expect(objection.call).toBe(words);
    }
  });

  it("leaves an unclear later reference to the architect, without a 'Your call' tag", () => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, "Reject both points. On second thought, accept it.");
    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "accepted" : "rejected");
      expect(objection.call).toBeUndefined();
    }
    expect(check.body).toContain("Your call settled 0 objections (0 accepted, 0 rejected). The architect answered 2 on its own.");
  });

  it("keeps the call's decisions and tags when a note at the check only accepts the brief", () => {
    const { sim, id } = disagreeing();
    const words = "Reject the blocking point.";
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const before = task(sim, id).objections.filter((objection) => task(sim, id).call!.open.includes(objection.id));

    sim.requestChanges(check.id, "I accept the brief, just say what the step looks like on phones.");
    const again = tickUntil(sim, "design");
    for (const objection of before) {
      const after = task(sim, id).objections.find((entry) => entry.id === objection.id)!;
      expect(after.status).toBe("rejected");
      expect(after.call).toBe(objection.blocking ? words : undefined);
    }
    expect(again.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");
  });

  it("answers in the architect's own name when it cannot read a decision in the call", () => {
    const { sim, id } = disagreeing();
    const words = "Keep the confirmation step, but only for existing accounts.";
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "accepted" : "rejected");
      expect(objection.call).toBeUndefined();
    }
    expect(check.body).toContain("Your call settled 0 objections (0 accepted, 0 rejected). The architect answered 2 on its own.");
  });

  it("decides only the point a call names, even when the call names the feature", () => {
    const { sim, id } = disagreeing();
    const words = "Reject the minor suggestion for saved carts.";
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "accepted" : "rejected");
      expect(objection.call).toBe(objection.blocking ? undefined : words);
    }
    expect(check.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");
  });

  it("reads accept, reject and siding with either side, per objection the words name", () => {
    expect(read("Keep the confirmation step, but only for existing accounts.")).toEqual({});
    expect(read("Side with the reviewer.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("I side with the architect on this.")).toEqual({ b: "rejected", m: "rejected" });
    expect(read("Reject the blocking point but accept the minor one.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Accept the not blocking point.")).toEqual({ m: "accepted" });
    expect(read("Accept the architect's answer on the confirmation step.")).toEqual({ b: "rejected" });
    expect(read("Don't reject the point about telling users.")).toEqual({ m: "accepted" });
    expect(read("Reject it all. Actually, accept the blocking one.")).toEqual({ b: "accepted", m: "rejected" });
    // Short words name a point too, and the feature's name names none.
    expect(read("Reject the short note.")).toEqual({ m: "rejected" });
    expect(read("Reject the minor suggestion for notifications.")).toEqual({ m: "rejected" });
    expect(read("Accept the minor point about notifications.")).toEqual({ m: "accepted" });
    expect(read("Accept the point about notifications.")).toEqual({});
    // Opposite decisions in one sentence stay apart, wherever the points sit.
    expect(read("The minor one I reject, the blocking point I accept.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Accept the blocking point, not the minor one.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Accept everything except the short note.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Side with the reviewer on the blocking point but with the architect on the minor one.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Reject the minor one and accept the rest.")).toEqual({ b: "accepted", m: "rejected" });
    // A list adds to a decision, a clause before it says what it is about, and one after it only explains.
    expect(read("Accept the blocking point and the short note.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("Accept the blocking point and the notes about what changed.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("Reject the note about what changed.")).toEqual({ m: "rejected" });
    expect(read("Accept the blocking point except the note about what changed.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Accept the blocking point and the note about everyone.")).toEqual({ b: "accepted" });
    expect(read("Either way, reject the blocking point and accept the short note.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Reject the blocking point in any case, while accepting the short note.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Reject the blocking point and the architect to review the minor one.")).toEqual({ b: "rejected" });
    expect(read("Don't reject the blocking point, while accepting the short note.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("For the blocking point, side with the architect.")).toEqual({ b: "rejected" });
    expect(read("Reject the blocking point, users hate extra steps.")).toEqual({ b: "rejected" });
    // An "and" part that is more than a name only explains.
    expect(read("Accept the minor one and keep the confirmation step.")).toEqual({ m: "accepted" });
    expect(read("Reject the blocking point and keep the note short.")).toEqual({ b: "rejected" });
    expect(read("Accept the blocking point and the rest.")).toEqual({ b: "accepted", m: "accepted" });
    // "All but" and "everything but" leave a point out.
    expect(read("Accept all but the blocking point.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Reject everything but the short note.")).toEqual({ b: "rejected", m: "accepted" });
    // "Never", "not" or "refuse to" just before a decision turn it round.
    expect(read("Never accept the blocking point.")).toEqual({ b: "rejected" });
    expect(read("Reject the minor one, never accept the blocking point.")).toEqual({ b: "rejected", m: "rejected" });
    expect(read("Never mind, reject the blocking point.")).toEqual({ b: "rejected" });
    expect(read("I refuse to accept the blocking point.")).toEqual({ b: "rejected" });
    expect(read("I won't accept the blocking point.")).toEqual({ b: "rejected" });
    // Anything unclear decides nothing.
    for (const words of [
      "I accept the brief, just say what the step looks like on phones.",
      "Fine, I accept that.",
      "Accept neither point.",
      "Accept none of them.",
      "Reject none of the points.",
      "Accept one of them.",
      "I do not want to accept the minor one.",
      "Should we accept the blocking point?",
      "Accept the blocking point or the minor one.",
      "Accept the blocking point if the step is optional.",
      "Accept the short note about the confirmation step.",
      "Side with the reviewer and side with the architect.",
      "I disagree with the reviewer.",
      "I agree with the architect.",
      "The architect is right.",
    ]) {
      expect(read(words)).toEqual({});
    }
  });

  it("keeps a decision with its point across punctuation or an introductory phrase", () => {
    expect(read("Reject: the blocking point.")).toEqual({ b: "rejected" });
    expect(read("Reject (the blocking point).")).toEqual({ b: "rejected" });
    expect(read("Regarding the blocking point, reject it.")).toEqual({ b: "rejected" });
    expect(read("Regarding the minor point, accept it.")).toEqual({ m: "accepted" });
    // Explanations still cannot add another point to a decision.
    expect(read("Reject the minor point: keep the confirmation step.")).toEqual({ m: "rejected" });
    expect(read("I accept the brief, the blocking point still needs an answer.")).toEqual({});
    expect(read("Accept: the minor point, reject: the blocking one.")).toEqual({ b: "rejected", m: "accepted" });
  });

  it("keeps each side with the point it names in a split call", () => {
    expect(read("Side with the reviewer on the minor point and the architect on the blocking one.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Accept the minor point and the architect's answer on the blocking one.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Side with the architect on the minor point and the reviewer on the blocking one.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Reject the minor point and the architect's answer on the blocking one.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Accept the minor point and the architect will explain the blocking one.")).toEqual({ m: "accepted" });
  });

  it("lets a later sentence change the last point's decision, leaving an unclear reference to the architect", () => {
    expect(read("Accept the blocking point. On second thought, reject it.")).toEqual({ b: "rejected" });
    expect(read("Reject the blocking point. Never mind, accept it.")).toEqual({ b: "accepted" });
    expect(read("Accept the minor point. Reject the blocking point. Never mind, accept it.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("Accept both points. On second thought, reject it.")).toEqual({});
    expect(read("Accept the blocking point. Should we accept the minor one? Reject it.")).toEqual({});
    expect(read("Accept the blocking point. I have doubts about the short note, reject it.")).toEqual({});
    expect(read("Reject it.")).toEqual({});
    expect(read("Accept the blocking point. Fine, I accept that.")).toEqual({ b: "accepted" });
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

  it("answers the plan's own design check after Screens: no second check, and approving it keeps the call", () => {
    const { sim, id } = disagreeing("new");
    const before = task(sim, id);
    const design = before.plan!.stages[before.stageIndex]!;
    const stages = before.plan!.stages.map((stage) => stage.id);
    expect(before.plan!.stages[before.stageIndex + 1]!.roleId).toBe("ux-designer");
    const reviews = reviewerRuns(before);
    const rounds = { ...before.rounds };

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    expect(task(sim, id).plan!.stages.map((stage) => stage.id)).toEqual(stages);
    const check = tickUntil(sim, "design");
    const at = task(sim, id);
    // Screens ran after the architect followed the call, and the check is the plan's own, with the call's words.
    expect(at.plan!.stages[at.stageIndex]).toMatchObject({ kind: "gate", gate: "design" });
    expect(at.plan!.stages[at.stageIndex]!.id).not.toBe(`${design.id}:call-check`);
    expect(at.timeline.findIndex((entry) => entry.roleId === "ux-designer")).toBeGreaterThan(at.timeline.findIndex((entry) => entry.text === CALL_WORDS.settled));
    expect(at.statusLine).toBe(CALL_WORDS.waiting);
    expect(check.body).toContain("Your call settled 1 objection (1 accepted, 0 rejected). The architect answered 1 on its own.");

    // Changes there go to the architect alone and come back, through Screens, to the same check.
    sim.requestChanges(check.id, "Say what the confirmation step looks like on phones.");
    const again = tickUntil(sim, "design");
    const after = task(sim, id);
    expect(after.stageIndex).toBe(at.stageIndex);
    expect(after.plan!.stages.map((stage) => stage.id)).toEqual(stages);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds).toEqual(rounds);
    expect(inboxItem(sim, "disagreement")).toBeUndefined();
    expect(after.statusLine).toBe(CALL_WORDS.waiting);
    expect(again.body).toContain("Your call settled");

    // Approving it moves on to the build, and the call stays.
    sim.approve(again.id);
    sim.tick();
    expect(task(sim, id).call?.text).toBe(CALL);
    expect(task(sim, id).agent?.roleId).toBe("builder");
    expect(task(sim, id).plan!.stages.filter((stage) => stage.kind === "gate" && stage.gate === "design")).toHaveLength(1);
  });

  it("adds a design check after a call when the plan has none before the build, and moves on from it", () => {
    const seed = disagreeing();
    const id = seed.id;
    const sim = reshaped(seed.sim, id, (stages) => stages.filter((stage) => !(stage.kind === "gate" && stage.gate === "design")));
    const design = task(sim, id).plan!.stages[task(sim, id).stageIndex]!;
    expect(task(sim, id).plan!.stages[task(sim, id).stageIndex + 1]!.roleId).toBe("builder");

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const at = task(sim, id);
    expect(at.plan!.stages[at.stageIndex]).toMatchObject({ kind: "gate", gate: "design", id: `${design.id}:call-check` });
    expect(at.plan!.stages[at.stageIndex - 1]!.id).toBe(design.id);
    expect(check.body).toContain("Your call settled");

    sim.approve(check.id);
    sim.tick();
    expect(task(sim, id).agent?.roleId).toBe("builder");
  });

  it("never lets a later design check reopen the design the call settled", () => {
    const seed = disagreeing();
    const id = seed.id;
    // Design, its check, Screens, then a second design check on the same design.
    const sim = reshaped(seed.sim, id, (stages, design) => {
      const screens: Stage = { id: `${stages[design]!.id}:ux`, kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] };
      const later: Stage = { id: `${stages[design]!.id}:later-check`, kind: "gate", title: "Your design check", roleId: "architect", profileIds: [], gate: "design" };
      return [...stages.slice(0, design + 2), screens, later, ...stages.slice(design + 2)];
    });
    const before = task(sim, id);
    const reviews = reviewerRuns(before);
    const rounds = { ...before.rounds };
    const stages = before.plan!.stages.length;

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    sim.approve(tickUntil(sim, "design").id);
    const later = tickUntil(sim, "design");
    expect(task(sim, id).plan!.stages[task(sim, id).stageIndex]!.id).toContain(":later-check");
    expect(task(sim, id).statusLine).toBe(CALL_WORDS.waiting);
    expect(later.body).toContain("Your call settled");

    // Changes at the later check go to the architect alone: no review round, no new disagreement.
    sim.requestChanges(later.id, "Say what the confirmation step looks like on phones.");
    const checks: string[] = [];
    for (let tick = 0; tick < 300 && task(sim, id).agent?.roleId !== "builder"; tick += 1) {
      sim.tick();
      for (const item of sim.getState().inbox.filter((entry) => entry.taskId === id)) {
        expect(item.kind).toBe("design");
        expect(item.body).toContain("Your call settled");
        checks.push(item.id);
        sim.approve(item.id);
      }
    }
    const after = task(sim, id);
    expect(after.agent?.roleId).toBe("builder");
    expect(checks.length).toBeGreaterThan(0);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds).toEqual(rounds);
    expect(after.plan!.stages).toHaveLength(stages);
    expect(after.timeline.some((entry) => entry.text === CALL_WORDS.revised)).toBe(true);
    expect(after.objections.some((objection) => objection.status === "open")).toBe(false);
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

describe("Removing the working copies of finished tasks", () => {
  const texts = (entry: Task) => entry.timeline.map((line) => line.text);

  it("keeps simulated GitHub progress outside tasks when handing the demo to another simulator", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 10 });
    const id = sim.addTask({ productId: "p", title: "Tidy the footer", kind: "chore", delivery: "pull-request" });
    runUntil(sim, () => task(sim, id).state === "pr-open");
    sim.tick(); sim.tick();
    const open = sim.openWork();
    expect(open.pullRequests.find(([taskId]) => taskId === id)?.[1]).toBeGreaterThanOrEqual(2);
    expect("prAge" in task(sim, id)).toBe(false);
    const resumed = new Simulator(sim.getState(), { prMergeAfter: 10, open, log: sim.workLog });
    for (let tick = open.pullRequests.find(([taskId]) => taskId === id)![1]; tick <= 10; tick++) resumed.tick();
    expect(task(resumed, id).pr?.state).toBe("merged");
    expect(resumed.openWork().pullRequests.some(([taskId]) => taskId === id)).toBe(false);
  });

  it("removes a delivered task's copy right after the delivery, and keeps one with an open pull request until it is merged", () => {
    const log = new MemoryWorkLog(0);
    const sim = new Simulator(emptyState(), { prMergeAfter: 3, log });
    const local = sim.addTask({ productId: "p", title: "Tidy the footer", kind: "chore", delivery: "local" });
    const pr = sim.addTask({ productId: "p", title: "Fix the broken link", kind: "bug", delivery: "pull-request" });

    runUntil(sim, () => task(sim, local).state === "done" && task(sim, pr).state === "pr-open");
    expect(task(sim, local).cleanup?.removedAt).toBeDefined();
    expect(texts(task(sim, local)).indexOf(CLEANUP_WORDS.removed)).toBeGreaterThan(texts(task(sim, local)).findIndex((text) => text.startsWith("Petrina moved")));
    expect(task(sim, pr).cleanup).toBeUndefined();
    expect(texts(task(sim, pr))).not.toContain(CLEANUP_WORDS.removed);

    runUntil(sim, () => task(sim, pr).state === "done");
    expect(task(sim, pr).cleanup?.removedAt).toBeDefined();
    expect(texts(task(sim, pr)).indexOf(CLEANUP_WORDS.removed)).toBeGreaterThan(texts(task(sim, pr)).findIndex((text) => text.startsWith("Merged on GitHub")));
    expect(log.moments({ taskId: pr, kinds: ["task-end"] }).map((entry) => entry.outcome)).toEqual(["delivered", "merged"]);
  });

  it("keeps a cancelled task's copy while its pull request is open, and says nothing for a task that never started", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: false, toolCaps: {} } }, { prMergeAfter: 1_000 });
    const pr = sim.addTask({ productId: "p", title: "Fix the broken link", kind: "bug" });
    const queued = sim.addTask({ productId: "p", title: "Not started", kind: "chore" });
    sim.cancel(queued);
    expect(task(sim, queued).cleanup).toBeUndefined();
    expect(texts(task(sim, queued)).some((text) => text.includes("working copy"))).toBe(false);

    runUntil(sim, () => task(sim, pr).state === "pr-open");
    sim.cancel(pr);
    sim.tick();
    expect(task(sim, pr).state).toBe("cancelled");
    expect(task(sim, pr).cleanup).toBeUndefined();
    for (let tick = 0; tick < 1_000; tick += 1) sim.tick();
    expect(task(sim, pr).state).toBe("cancelled");
    expect(task(sim, pr).pr?.state).toBe("merged");
    expect(task(sim, pr).cleanup?.removedAt).toBeDefined();
  });

  it("removes a running task's copy when it is cancelled", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Search", kind: "chore" });
    sim.tick();
    sim.cancel(id);
    expect(task(sim, id).cleanup?.removedAt).toBeDefined();
    expect(texts(task(sim, id)).slice(-2)).toEqual(["You cancelled it", CLEANUP_WORDS.removed]);
  });

  it("says once that a locked copy could not be removed, and removes it at the next try", () => {
    const seed = new Simulator(emptyState());
    const id = seed.addTask({ productId: "p", title: "Tidy the footer", kind: "chore", delivery: "local" });
    const sim = new Simulator(seed.getState(), { lockedCopies: [id] });
    runUntil(sim, () => task(sim, id).state === "done");
    expect(task(sim, id).cleanup).toEqual({ error: CLEANUP_WORDS.locked });
    expect(texts(task(sim, id)).at(-1)).toBe(CLEANUP_WORDS.failed(CLEANUP_WORDS.locked));

    sim.tick();
    expect(task(sim, id).cleanup?.removedAt).toBeDefined();
    expect(texts(task(sim, id)).slice(-2)).toEqual([CLEANUP_WORDS.failed(CLEANUP_WORDS.locked), CLEANUP_WORDS.removed]);
    sim.tick();
    expect(texts(task(sim, id)).filter((text) => text === CLEANUP_WORDS.removed)).toHaveLength(1);
  });

  it("shows the demo's finished tasks without their copies, one after a retry, and keeps open pull requests' copies", () => {
    const state = createDemoState(1_000_000_000);
    const byTitle = (title: string) => state.tasks.find((entry) => entry.title === title)!;
    expect(texts(byTitle("Report errors to Sentry")).slice(-2)).toEqual([CLEANUP_WORDS.failed(CLEANUP_WORDS.locked), CLEANUP_WORDS.removed]);
    expect(texts(byTitle("Fix the footer links")).at(-1)).toBe(CLEANUP_WORDS.removed);
    for (const entry of state.tasks.filter((item) => item.state !== "done" && item.state !== "cancelled")) expect(entry.cleanup).toBeUndefined();

    const { state: portfolio } = createPortfolioDemo(1_000_000_000);
    for (const entry of portfolio.tasks) expect(entry.cleanup?.removedAt !== undefined).toBe(entry.state === "done" || entry.state === "cancelled");
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
    expect(state.inbox.map((item) => item.kind).sort()).toEqual(["delivery", "disagreement", "guide", "learnings", "permission", "plan", "question", "screen"]);
    // The reviewers of "Fix login loop on Safari" look at the change together: two slots for that task.
    expect(slotUses(state)).toHaveLength(4);
    expect(startsNextCount(state)).toBe(1);
  });

  it("builds a twenty-product portfolio that fits in its pool", () => {
    const { state } = createPortfolioDemo(1_000_000_000);
    expect(state.products).toHaveLength(20);
    expect(slotUses(state).length).toBeLessThanOrEqual(state.pool.limit);
    expect(new Set(state.inbox.map((item) => item.id)).size).toBe(state.inbox.length);
    // The last four products are quiet: nothing on the board, nothing in their history.
    const quiet = new Set(state.products.slice(16).map((product) => product.id));
    expect(state.tasks.some((task) => quiet.has(task.productId))).toBe(false);
  });
});

describe("delivery in the demo, as the engine does it", () => {
  it("commits to main with no agent: Petrina moves main forward itself", () => {
    const sim = new Simulator(emptyState(4), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Small fix", kind: "chore", delivery: "local" });
    runUntil(sim, () => task(sim, id).state === "done");
    const done = task(sim, id);
    expect(done.landed?.branch).toBe("main");
    const lines = done.timeline.map((entry) => entry.text);
    expect(lines).not.toContain("Release Manager started");
    expect(lines.some((line) => line.startsWith("Petrina moved main forward to it"))).toBe(true);
  });

  it("opens a pull request with no agent: Petrina opens it with the builder's text, each step said once", () => {
    const sim = new Simulator(emptyState(4), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Small fix", kind: "chore", delivery: "pull-request" });
    runUntil(sim, () => task(sim, id).state === "pr-open");
    const lines = task(sim, id).timeline.map((entry) => entry.text);
    expect(lines).not.toContain("Release Manager started");
    expect(lines.filter((line) => line === "Petrina pushed the branch")).toHaveLength(1);
  });

  it("has the Release Manager write a release's notes, then Petrina publishes it", () => {
    const sim = new Simulator(emptyState(4), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Small fix", kind: "chore", delivery: "release" });
    runUntil(sim, () => task(sim, id).state === "done");
    const done = task(sim, id);
    const lines = done.timeline.map((entry) => entry.text);
    expect(done.release?.tag).toBeDefined();
    expect(lines.filter((line) => line === "Ready to publish")).toHaveLength(1);
    expect(lines.indexOf("Release Manager started")).toBeGreaterThan(-1);
    expect(lines.findIndex((line) => line.startsWith("Petrina pushed main and the tag"))).toBeGreaterThan(lines.indexOf("Ready to publish"));
  });
});

describe("a delivery whose review rounds ran out", () => {
  it("says the coordinator decides, with how many blocking findings are open, never 'ready to ship'", () => {
    const task = { title: "Fix the focus", findings: [{ status: "open", severity: "blocking" }, { status: "open", severity: "blocking" }, { status: "fixed", severity: "blocking" }] } as unknown as Task;
    expect(gateTitle(task, "delivery")).toBe("Your call on “Fix the focus”: 2 blocking findings still open");
    expect(gateStatus(task, "delivery")).toBe("Review rounds ran out with 2 blocking findings open. Your call");
    const passed = { title: "Fix the focus", findings: [] } as unknown as Task;
    expect(gateTitle(passed, "delivery")).toBe("Ready to ship “Fix the focus”");
    expect(gateStatus(passed, "delivery")).toBe("Reviews done. Waiting for your OK to ship");
  });
});

describe("review rounds that converge", () => {
  const stage = { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["a"], maxRounds: 2 } as unknown as Stage;
  const task = (open: number, history?: number[]) =>
    ({
      stageIndex: 1,
      plan: { stages: [{ id: "build", kind: "do", roleId: "builder", profileIds: ["b"] }, stage] },
      findings: Array.from({ length: open }, () => ({ status: "open", severity: "blocking" })),
      ...(history ? { blockingAfter: { review: history } } : {}),
    }) as unknown as Task;

  it("sends the work back within the planned rounds, whatever the count", () => {
    expect(reviewRoundEnd(task(4), stage, 1).kind).toBe("send back");
  });

  it("uses the smaller count as progress for older tasks without finding snapshots", () => {
    expect(reviewRoundEnd(task(2, [4]), stage, 2).kind).toBe("send back");
    expect(reviewRoundEnd(task(1, [4, 2]), stage, 3).kind).toBe("send back");
  });

  it("counts resolved findings as progress even when reviewers raise new blockers", () => {
    const current = {
      ...task(2, [2]),
      findings: [
        { id: "old-1", status: "fixed", severity: "blocking" },
        { id: "old-2", status: "fixed", severity: "blocking" },
        { id: "new-1", status: "open", severity: "blocking" },
        { id: "new-2", status: "open", severity: "blocking" },
      ],
      blockingFindingsAfter: { review: [["old-1", "old-2"]] },
    } as unknown as Task;
    expect(reviewRoundEnd(current, stage, 3)).toEqual({ kind: "send back", builder: 0, open: 2 });
  });

  it("stops when the same blocking findings remain open", () => {
    const current = {
      ...task(2, [2]),
      findings: [
        { id: "same-1", status: "open", severity: "blocking" },
        { id: "same-2", status: "open", severity: "blocking" },
      ],
      blockingFindingsAfter: { review: [["same-1", "same-2"]] },
    } as unknown as Task;
    expect(reviewRoundEnd(current, stage, 3)).toEqual({ kind: "used up", open: 2 });
  });

  it("records only the open blockers by ID after a round", () => {
    const current = {
      findings: [
        { id: "open", status: "open", severity: "blocking" },
        { id: "fixed", status: "fixed", severity: "blocking" },
        { id: "nit", status: "open", severity: "suggestion" },
      ],
    } as unknown as DeepMutable<Task>;
    noteRoundEnd(current, "review", 1);
    expect(current.blockingFindingsAfter).toEqual({ review: [["open"]] });
  });

  it("hands the coordinator a round that stopped making progress, and never goes past five rounds", () => {
    expect(reviewRoundEnd(task(2, [2]), stage, 2).kind).toBe("used up");
    expect(reviewRoundEnd(task(3, [2]), stage, 2).kind).toBe("used up");
    expect(reviewRoundEnd(task(1, [5, 4, 3, 2]), stage, MAX_REVIEW_ROUNDS).kind).toBe("used up");
  });
});


describe("starting choices in the demo", () => {
  for (const startFrom of [{ kind: "default" }, { kind: "pull-request", value: "7" }] as const) it(`asks for confirmation of a ${startFrom.kind === "default" ? "planner-selected product" : "pull request destination"} with the optional plan check off`, () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: startFrom.kind === "default" ? "" : "p", title: "A small change", kind: "chore", approvePlan: false, startFrom });
    for (let tick = 0; tick < 30 && !sim.getState().inbox.some((item) => item.taskId === id && item.kind === "plan"); tick++) sim.tick();
    const plan = sim.getState().inbox.find((item) => item.taskId === id && item.kind === "plan");
    expect(plan?.body).toContain("Works on: Product");
    expect(task(sim, id).approvePlan).toBe(false);
    sim.approve(plan!.id);
    expect(task(sim, id).confirmWork).toBe(false);
    expect(task(sim, id).source?.confirmed).toBe(true);
  });
});


describe("New task product rows", () => {
  it("lets the demo planner propose a product when none were selected, then keeps edits at approval", async () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "", worksOn: [], title: "Let the planner choose", kind: "chore" });
    const gate = tickUntil(sim, "plan");
    expect(task(sim, id).selectedProducts).toEqual([]);
    expect(task(sim, id).workRows).toHaveLength(1);
    expect(task(sim, id).workRows![0]!.change).toBe("added");
    const reason = task(sim, id).workRows![0]!.choice.reason;
    await sim.setTaskStart(id, { productId: "p", startFrom: { kind: "branch", name: "chosen-branch" }, delivery: "local" });
    expect(task(sim, id).workRows![0]!.change).toBe("added");
    expect(task(sim, id).workRows![0]!.choice.reason).toBe(reason);
    const resumed = new Simulator(sim.getState());
    expect(task(resumed, id).workRows![0]!.change).toBe("added");
    sim.approve(gate.id);
    expect(task(sim, id).repositories![0]!.source!.destination).toMatchObject({ branch: "chosen-branch", mode: "local" });
    expect(task(sim, id).delivery).toBe("local");
  });

  for (const count of [1, 2]) it(`keeps edits to each of ${count} product rows through approval and delivery`, async () => {
    const initial = emptyState();
    const products = [initial.products[0]!, { ...initial.products[0]!, id: "api", name: "API", repo: "acme/api" }].slice(0, count);
    const sim = new Simulator({ ...initial, products });
    const id = sim.addTask({ productId: "p", worksOn: products.map((product) => ({ productId: product.id, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Edit approved choices", kind: "chore", approvePlan: true, approveDelivery: true });
    const gate = tickUntil(sim, "plan");
    for (const [index, product] of products.entries()) {
      const choice = { productId: product.id, startFrom: { kind: "branch" as const, name: `release-${index}` }, delivery: "local" as const, lead: index === count - 1 };
      await sim.setTaskStart(id, choice);
      expect(task(sim, id).workRows![index]!.choice).toEqual(choice);
      expect(task(sim, id).workRows![index]!.source!.start).toEqual({ kind: "branch", branch: `release-${index}` });
    }
    sim.approve(gate.id);
    for (const [index, work] of task(sim, id).repositories!.entries()) {
      expect(work.source!.start).toEqual({ kind: "branch", branch: `release-${index}` });
      expect(work.source!.destination).toMatchObject({ mode: "local", kind: "branch", branch: `release-${index}` });
      expect(work.workChoice).toEqual(task(sim, id).workRows![index]!.choice);
    }
    expect(task(sim, id).leadProductId).toBe(products[count - 1]!.id);
    expect(task(sim, id).source).toEqual(task(sim, id).repositories![0]!.source);
    expect(task(sim, id).delivery).toBe("local");
    expect(task(sim, id).plan!.stages.find((stage) => stage.kind === "do" && stage.roleId === "release-manager")!.title).toBe(count > 1 ? "Deliver across 2 products" : "Commit to release-0");
    runUntil(sim, () => task(sim, id).state === "done");
    expect(task(sim, id).repositories!.map((work) => work.landed?.branch)).toEqual(products.map((_, index) => `release-${index}`));
    expect(task(sim, id).repositories!.every((work) => !work.pr)).toBe(true);
  });

  for (const startFrom of [{ kind: "default" }, { kind: "branch", name: "release-2.x" }, { kind: "pull-request", value: "7" }] as const) {
    for (const delivery of ["local", "pull-request"] as const) it(`preserves one product's ${startFrom.kind} start and ${delivery} delivery`, () => {
      const legacy = new Simulator(emptyState());
      const rows = new Simulator(emptyState());
      const previous = legacy.addTask({ productId: "p", title: "Keep the choice", kind: "chore", startFrom, delivery });
      const current = rows.addTask({ productId: "", worksOn: [{ productId: "p", startFrom, delivery }], title: "Keep the choice", kind: "chore" });
      const expected = task(legacy, previous), actual = task(rows, current);
      expect(actual.workChoice).toEqual(expected.workChoice);
      expect(actual.source).toEqual(expected.source);
      expect(actual.delivery).toBe(delivery);
      expect(actual.confirmWork).toBe(expected.confirmWork);
      runUntil(rows, () => !!inboxItem(rows, "delivery"));
      expect(task(rows, current).source).toEqual(expected.source);
      expect(task(rows, current).delivery).toBe(delivery);
    });
  }
});
