import { describe, expect, it } from "vitest";

import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../../../src/library.js";
import type { State, Task } from "../../../src/model.js";
import { Simulator } from "../../../src/sim.js";

import { simVersions } from "../../../src/sim-script.js";
import { CALL_WORDS } from "../../../src/call.js";
import { mainLine, nextLine } from "../../../src/summary.js";

const MINUTE = 60_000;

function emptyState(): State {
  return {
    now: 0,
    seq: 0,
    products: [{ id: "p", name: "Product", repo: "acme/product", tone: "blue" }],
    roles: BUILT_IN_ROLES,
    tools: KNOWN_TOOLS,
    profiles: DEFAULT_PROFILES,
    tasks: [],
    inbox: [],
    pool: { limit: 4, paused: false, toolCaps: {} },
  };
}

const taskOf = (sim: Simulator, id: string): Task => sim.getState().tasks.find((task) => task.id === id)!;

const next = (sim: Simulator, id: string) => nextLine(sim.getState(), taskOf(sim, id));

const item = (sim: Simulator, kind: string) => sim.getState().inbox.find((entry) => entry.kind === kind);

function until(sim: Simulator, reached: () => boolean, approve = false): void {
  for (let tick = 0; tick < 400; tick += 1) {
    if (reached()) return;
    sim.tick();
    for (const entry of sim.getState().inbox) {
      if (entry.kind === "question") sim.answer(entry.id, entry.options?.[0] ?? "Yes");
      else if (entry.kind === "permission") sim.allow(entry.id, "once");
      else if (approve && entry.kind !== "disagreement") sim.approve(entry.id);
    }
  }
  throw new Error("never reached");
}

function feature(options: { disagree?: boolean; approvePlan?: boolean } = {}) {
  const seed = new Simulator(emptyState(), { prMergeAfter: 1_000 });
  const id = seed.addTask({ productId: "p", title: "Saved carts", kind: "feature", approvePlan: options.approvePlan ?? false });
  const sim = new Simulator(seed.getState(), { prMergeAfter: 1_000, ...(options.disagree ? { disagree: [id] } : {}) });
  const on = (roleId: string, round = 1, extra: (task: Task) => boolean = () => true) => () => {
    const task = taskOf(sim, id);
    const stage = task.plan?.stages[task.stageIndex];
    return task.state === "running" && task.agent?.roleId === roleId && (stage ? (task.rounds[stage.id] ?? 1) : 1) === round && extra(task);
  };
  return { sim, id, on };
}

describe("a card's main line", () => {

  it("keeps the to-do item while scripted tool activity changes", () => {
    const { sim, id, on } = feature();
    until(sim, on("builder"), true);
    const seen: { main: string; action: string }[] = [];
    for (let tick = 0; tick < 8 && taskOf(sim, id).agent?.roleId === "builder"; tick += 1) {
      const task = taskOf(sim, id);
      if (task.state === "running" && task.todo) seen.push({ main: mainLine(task), action: task.statusLine });
      sim.tick();
      for (const entry of sim.getState().inbox) if (entry.kind === "permission") sim.allow(entry.id, "once");
    }
    // Some to-do item stayed the card's main line while its actions changed under it.
    const lines = new Set(seen.map((entry) => entry.main));
    expect([...lines].some((line) => new Set(seen.filter((entry) => entry.main === line).map((entry) => entry.action)).size >= 2)).toBe(true);
    expect(seen.every((entry) => entry.main !== entry.action)).toBe(true);
    // The timeline lists each to-do item, the session each action.
    const task = taskOf(sim, id);
    for (const line of lines) expect(task.timeline.some((entry) => entry.text === line)).toBe(true);
    expect(task.session.some((line) => line.from === "activity" && line.text === "Editing 3 files")).toBe(true);
  });
});

describe("what comes next", () => {
  it("keeps the call visible without a to-do list, while retaining the latest action", () => {
    const { sim, id, on } = feature({ disagree: true });
    until(sim, () => item(sim, "disagreement") !== undefined);
    sim.requestChanges(item(sim, "disagreement")!.id, "Keep the simpler flow.");
    until(sim, on("architect", 3));
    const { todo: _todo, ...task } = taskOf(sim, id);
    for (const statusLine of ["Reading the code", "Running a command", "Editing files"]) {
      expect(mainLine({ ...task, statusLine })).toBe(CALL_WORDS.following);
      expect(mainLine({ ...task, statusLine, todo: "Updating the guest flow" })).toBe("Updating the guest flow");
    }
    expect(mainLine({ ...task, state: "needs-you", statusLine: "Waiting for your answer" })).toBe("Waiting for your answer");
  });

  it("puts the required shipping check before delivery when the final review still has blockers", () => {
    const { sim, id, on } = feature();
    until(sim, on("code-reviewer", 1, (task) => task.sub === 1), true);
    const state = sim.getState();
    const task = taskOf(sim, id);
    const stages = task.plan!.stages.filter((stage) => stage.gate !== "delivery").map((stage) => stage.kind === "review-chain" ? { ...stage, maxRounds: 1 } : stage);
    const review = stages.find((stage) => stage.kind === "review-chain")!;
    const final: Task = { ...task, approveDelivery: false, plan: { ...task.plan!, stages } };
    expect(nextLine(state, final)).toBe("Next: your call, then Petrina opens the pull request");
    // This check is still required when there is no builder to return findings to.
    const noBuilder: Task = { ...final, stageIndex: final.stageIndex - 1, plan: { ...final.plan!, stages: stages.filter((stage) => stage.roleId !== "builder").map((stage) => stage.kind === "review-chain" ? { ...stage, maxRounds: 3 } : stage) } };
    expect(nextLine(state, noBuilder)).toBe("Next: your call, then Petrina opens the pull request");
    for (const status of ["fixed", "dismissed"] as const) {
      expect(nextLine(state, { ...final, findings: final.findings.map((finding) => ({ ...finding, status })) })).toBe("Next: Petrina opens the pull request, or your call if blocking issues are found");
    }
    // Past its planned rounds, a review that leaves fewer blocking findings than the round before still sends the work back.
    const converging: Task = { ...final, rounds: { [review.id]: 2 }, blockingAfter: { [review.id]: [2] } };
    expect(nextLine(state, converging)).toBe("Next: Petrina opens the pull request, or fixes by the builder if blocking issues are found");
    expect(nextLine(state, { ...converging, blockingAfter: { [review.id]: [1] } })).toBe("Next: your call, then Petrina opens the pull request");
    expect(nextLine(state, { ...converging, rounds: { [review.id]: 5 } })).toBe("Next: your call, then Petrina opens the pull request");

    const demo = new Simulator({ ...state, tasks: [final] });
    until(demo, () => item(demo, "delivery") !== undefined);
    expect(taskOf(demo, id).agent).toBeUndefined();
    expect(next(demo, id)).toBe("Next: Petrina opens the pull request");
    demo.approve(item(demo, "delivery")!.id);
    until(demo, () => taskOf(demo, id).state === "pr-open");
    expect(taskOf(demo, id).timeline.some((entry) => entry.text.startsWith("Petrina opened pull request"))).toBe(true);
  });

  it("passes a later review over findings a decision to continue covers, in the demo and its preview, until the change moves", () => {
    const { sim, id, on } = feature();
    until(sim, on("code-reviewer"), true);
    const state = sim.getState();
    const task = taskOf(sim, id);
    const stage = task.plan!.stages[task.stageIndex]!;
    const last = stage.maxRounds ?? 2;
    const accepted = { id: "accepted", text: "An older problem the coordinator chose to continue past", severity: "blocking" as const, raisedBy: "sol-high", confirmedBy: ["opus-high"], status: "open" as const };
    // Its last round, where an unchanged Important finding alone would ask the coordinator again.
    const at = (versions: Record<string, string>): Task => ({ ...task, rounds: { ...task.rounds, [stage.id]: last }, hunt: { stageId: stage.id, round: last, reported: {}, findings: 1 }, findings: [accepted], blockingFindingsAfter: { [stage.id]: [["accepted"]] },
      reviewDecision: { stageId: "earlier-review", round: 3, accepted: true, covers: ["accepted"], at: state.now, versions } });
    const decided = at(simVersions(task));
    const moved = at(Object.fromEntries(Object.keys(simVersions(task)).map((product) => [product, "an earlier change"])));
    expect(nextLine(state, decided)).not.toMatch(/^Next: your call/);
    expect(nextLine(state, { ...decided, reviewDecision: { stageId: "earlier-review", round: 3, accepted: true } })).toMatch(/^Next: your call/);
    // A Builder turn or a hand change since the decision may have changed the code: the preview no longer relies on the cover.
    const builder = task.journey!.find((step) => step.roleId === "builder")!;
    expect(nextLine(state, { ...decided, journey: [...task.journey!, { ...builder, id: "later-build", startedAt: state.now + 1, endedAt: state.now + 1 }] })).toMatch(/^Next: your call/);
    expect(nextLine(state, { ...decided, journey: [...task.journey!, { ...builder, id: "later-build", startedAt: state.now + 1, endedAt: state.now + 1, builderReturn: { productId: "p", changed: false, claimedFixes: 0, outcome: "Unchanged" } }] })).not.toMatch(/^Next: your call/);
    expect(nextLine(state, { ...decided, handChanges: true })).toMatch(/^Next: your call/);
    const run = (variant: Task) => {
      const demo = new Simulator({ ...state, tasks: state.tasks.map((entry) => entry.id === id ? variant : entry) }, { prMergeAfter: 1_000 });
      until(demo, () => taskOf(demo, id).stageIndex !== task.stageIndex);
      return { demo, after: taskOf(demo, id), review: taskOf(demo, id).journey!.findLast((step) => step.stageId === stage.id && step.kind === "agent")! };
    };
    const passed = run(decided);
    expect(passed.review.reason).toBe("review passed; 1 earlier important still open under your decision to continue");
    expect(passed.after.timeline.some((entry) => entry.text === "Review passed: 1 earlier important still open under your decision to continue")).toBe(true);
    expect(passed.after.findings.find((finding) => finding.id === "accepted")).toEqual(accepted);
    expect(passed.after.reviewDecision).toEqual(decided.reviewDecision);
    expect(passed.after.fixing).toBeFalsy();
    expect(item(passed.demo, "delivery")?.title).toContain("1 blocking finding still open");
    // A change since the decision ends its cover: the coordinator is asked again about everything open.
    const changed = run(moved);
    expect(changed.review.reason).toBe("1 important still open");
    expect(changed.after.reviewDecision).toEqual(expect.objectContaining({ stageId: stage.id, accepted: false, covers: ["accepted"] }));
  });

  it("follows the design loop: review, another round, the reviewer's last round", () => {
    const { sim, id, on } = feature({ disagree: true });
    until(sim, on("architect", 1));
    expect(next(sim, id)).toBe("Next: design review (Codex · sol), then your design check");
    until(sim, on("design-reviewer", 1));
    expect(next(sim, id)).toBe("Next: your design check, or another design round if the reviewer objects");
    until(sim, on("architect", 2));
    expect(next(sim, id)).toBe("Next: design review again (Codex · sol), then your design check");
    until(sim, on("design-reviewer", 3));
    expect(next(sim, id)).toBe("Next: your design check, or your call if they still disagree");
  });

  it("goes straight to the design check after the coordinator's call, then the build and the first review", () => {
    const { sim, id, on } = feature({ disagree: true });
    until(sim, () => item(sim, "disagreement") !== undefined);
    expect(next(sim, id)).toBe("Next: your design check, then build (Codex · sol)");
    sim.requestChanges(item(sim, "disagreement")!.id, "Keep it simple.");
    until(sim, on("architect", 3, (task) => task.call !== undefined));
    expect(next(sim, id)).toBe("Next: your design check, then build (Codex · sol)");
    until(sim, () => item(sim, "design") !== undefined);
    expect(next(sim, id)).toBe("Next: build (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)");
  });

  it("follows the review loop: every reviewer at once, fixes by the builder, code review again", () => {
    const { sim, id, on } = feature();
    // The reviewers look at the change together: what follows is the same whichever of them is still looking.
    until(sim, on("code-reviewer", 1, (task) => task.sub === 0), true);
    expect(next(sim, id)).toBe("Next: your OK to ship, or fixes by the builder if blocking issues are found");
    until(sim, on("code-reviewer", 1, (task) => task.sub === 1), true);
    expect(next(sim, id)).toBe("Next: your OK to ship, or fixes by the builder if blocking issues are found");
    until(sim, on("builder", 1, (task) => task.fixing), true);
    expect(next(sim, id)).toBe("Next: code review again (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    // The previous blocker was fixed; a distinct new blocker can still return to the Builder.
    until(sim, on("code-reviewer", 2, (task) => task.sub === 1), true);
    expect(next(sim, id)).toBe("Next: your OK to ship, or fixes by the builder if blocking issues are found");
    until(sim, () => item(sim, "delivery") !== undefined);
    expect(next(sim, id)).toBe("Next: Petrina opens the pull request");
  });

  it("names the plan check while planning, only when the coordinator approves plans", () => {
    const checked = feature({ approvePlan: true });
    until(checked.sim, checked.on("planner"));
    expect(next(checked.sim, checked.id)).toBe("Next: your plan check");
    until(checked.sim, () => item(checked.sim, "plan") !== undefined);
    expect(next(checked.sim, checked.id)).toBe("Next: design (Claude Code · Opus 5.5), then design review (Codex · sol)");
    const unchecked = feature();
    until(unchecked.sim, unchecked.on("planner"));
    expect(next(unchecked.sim, unchecked.id)).toBeUndefined();
  });

  it("changes straight away when the plan changes who works on a stage", () => {
    const { sim, id } = feature();
    until(sim, () => item(sim, "design") !== undefined);
    const build = taskOf(sim, id).plan!.stages.find((stage) => stage.roleId === "builder")!;
    sim.setStageProfile(id, build.id, "profileIds", 0, "opus-high");
    expect(next(sim, id)).toBe("Next: build (Claude Code · Opus 5.5), then code review (Claude Code · Opus 5.5 and Codex · sol)");
  });

  it("shows the step a waiting or paused task starts again, and nothing for queued, stuck or finished tasks", () => {
    const { sim, id, on } = feature();
    until(sim, on("builder"), true);
    sim.pause(id);
    expect(next(sim, id)).toBe("Next: build (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)");
    const task = taskOf(sim, id);
    for (const state of ["queued", "failed", "done", "cancelled", "pr-open"] as const) expect(nextLine(sim.getState(), { ...task, state })).toBeUndefined();
    expect(nextLine(sim.getState(), { ...task, state: "waiting" })).toBe("Next: build (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)");
  });

  it("keeps a paused checkpoint next, without repeating an agent that already finished", () => {
    const { sim, id } = feature({ disagree: true });
    until(sim, () => item(sim, "disagreement") !== undefined);
    sim.pause(id);
    expect(next(sim, id)).toBe("Next: your call, then your design check");
    sim.resume(id);
    sim.approve(item(sim, "disagreement")!.id);
    until(sim, () => item(sim, "design") !== undefined);
    sim.pause(id);
    expect(next(sim, id)).toBe("Next: your design check, then build (Codex · sol)");
  });
});

describe("the step records the simulator keeps", () => {
  it("records each finished step with its pass, without the time waiting for an answer, and not one started again after a pause", () => {
    const seed = new Simulator(emptyState(), { prMergeAfter: 1_000, tickMs: MINUTE });
    const id = seed.addTask({ productId: "p", title: "Saved carts", kind: "bug" });
    const sim = new Simulator(seed.getState(), { prMergeAfter: 1_000, tickMs: MINUTE, triggers: { [`${id}|builder|1|1`]: { kind: "question", title: "Which screen first?", options: ["Cart"] } } });
    // The builder asks; the answer comes ten minutes later.
    for (let tick = 0; tick < 100 && !item(sim, "question"); tick += 1) sim.tick();
    for (let tick = 0; tick < 10; tick += 1) sim.tick();
    sim.answer(item(sim, "question")!.id, "Cart");
    until(sim, () => taskOf(sim, id).agent?.roleId === "code-reviewer", true);
    const builder = taskOf(sim, id).steps!.find((entry) => entry.roleId === "builder")!;
    // Fifteen moments and the hand-back, one minute each: the ten minutes of waiting are not in it.
    expect(builder).toMatchObject({ repeat: false, worked: 16 * MINUTE });
    // The second reviewer is paused and resumed: its step starts again and leaves no record.
    until(sim, () => taskOf(sim, id).agent?.roleId === "code-reviewer" && taskOf(sim, id).sub === 1 && taskOf(sim, id).state === "running", true);
    sim.pause(id);
    sim.resume(id);
    until(sim, () => taskOf(sim, id).agent?.roleId === "builder", true);
    expect(taskOf(sim, id).steps!.map((entry) => [entry.roleId, entry.repeat])).toEqual([
      ["planner", false],
      ["builder", false],
      ["code-reviewer", false],
    ]);
    until(sim, () => item(sim, "delivery") !== undefined);
    expect(taskOf(sim, id).steps!.map((entry) => [entry.roleId, entry.repeat]).slice(3)).toEqual([
      ["builder", true],
      ["code-reviewer", true],
      ["code-reviewer", true],
    ]);
  });
});
