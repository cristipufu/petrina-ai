import { describe, expect, it } from "vitest";
import { createDemoState, createFirstRunDemo, createPortfolioDemo, DEMO_PRODUCTS } from "../src/demo.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../src/library.js";
import type { Stage, State, StepRecord, Task } from "../src/model.js";
import { Simulator } from "../src/sim.js";
import { CALL_WORDS } from "../src/call.js";
import { TODO_MAX, leftWords, mainLine, nextLine, pauseClock, plainTodo, resumeClock, startClock, timeLeft, workedSoFar } from "../src/summary.js";

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

/** Tick until `reached`, answering questions and permissions but leaving checkpoints alone unless `approve`. */
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

/** A feature in the simulator: design (Opus with a sol reviewer), your design check, build on sol, two reviewers at once, your OK to ship, then Petrina's pull request. */
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

describe("the to-do item as plain text", () => {
  it("is one line with formatting marks removed", () => {
    expect(plainTodo("- [ ] **Working out** what the `engine` records\nper _step_")).toBe("Working out what the engine records per step");
    expect(plainTodo("## Read the [design brief](https://example.com/brief)")).toBe("Read the design brief");
    expect(plainTodo("1. Check ~~old~~ new <b>screens</b>")).toBe("Check old new screens");
    // Words that only look like formatting keep their spelling.
    expect(plainTodo("Update snake_case_names and 2 * 3")).toBe("Update snake_case_names and 2 * 3");
    expect(plainTodo("  \n ** \n")).toBeUndefined();
  });

  it("is at most about 100 characters, with an ellipsis", () => {
    const long = plainTodo(`Working out ${"what the engine records about each step ".repeat(5)}`)!;
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("  ");
  });
});

describe("a card's main line", () => {
  const base = { statusLine: "Running a command", todo: "Working out what the engine records per step" };
  it("is the to-do item while the agent works, and the status line otherwise", () => {
    expect(mainLine({ ...base, state: "running" })).toBe(base.todo);
    expect(mainLine({ state: "running", statusLine: "Reading the code" })).toBe("Reading the code");
    for (const state of ["needs-you", "waiting", "paused", "failed", "cancelled", "done", "pr-open"] as const) {
      expect(mainLine({ ...base, state, statusLine: "Waiting for your answer" })).toBe("Waiting for your answer");
    }
  });

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
  it("names the remaining role in a mixed review, including roles the coordinator added", () => {
    const { sim, id, on } = feature();
    until(sim, on("builder"), true);
    const state = sim.getState();
    const task = taskOf(sim, id);
    const custom = { ...state.roles.find((role) => role.id === "code-reviewer")!, id: "added-privacy", name: "Privacy specialist", added: true };
    const stages = task.plan!.stages.map((stage) => stage.kind === "review-chain" ? { ...stage, roleIds: ["code-reviewer", custom.id] } : stage);
    const planned = { ...task, plan: { ...task.plan!, stages } };
    const people = { ...state, roles: [...state.roles, custom] };
    expect(nextLine(people, planned)).toBe("Next: review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    const stageIndex = stages.findIndex((stage) => stage.kind === "review-chain");
    const review = stages[stageIndex]!;
    const paused: Task = { ...planned, state: "paused", stageIndex, sub: 0, hunt: { stageId: review.id, round: 1, reported: { "0": true } } };
    expect(nextLine(people, paused)).toBe("Next: privacy specialist (Codex · sol), then your OK to ship");
    expect(nextLine({ ...people, roles: [...state.roles, { ...custom, name: "Claims reviewer" }] }, paused)).toBe("Next: claims reviewer (Codex · sol), then your OK to ship");
    expect(nextLine(people, { ...paused, hunt: { ...paused.hunt!, reported: { "1": true } } })).toBe("Next: code review (Claude Code · Opus 5.5), then your OK to ship");
  });

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
    expect(nextLine(state, final)).toBe("Next: your OK to ship, then Petrina opens the pull request");
    // This check is still required when there is no builder to return findings to.
    const noBuilder: Task = { ...final, stageIndex: final.stageIndex - 1, plan: { ...final.plan!, stages: stages.filter((stage) => stage.roleId !== "builder").map((stage) => stage.kind === "review-chain" ? { ...stage, maxRounds: 3 } : stage) } };
    expect(nextLine(state, noBuilder)).toBe("Next: your OK to ship, then Petrina opens the pull request");
    for (const status of ["fixed", "dismissed"] as const) {
      expect(nextLine(state, { ...final, findings: final.findings.map((finding) => ({ ...finding, status })) })).toBe("Next: Petrina opens the pull request, or your OK to ship if blocking issues are found");
    }
    // Past its planned rounds, a review that leaves fewer blocking findings than the round before still sends the work back.
    const converging: Task = { ...final, rounds: { [review.id]: 2 }, blockingAfter: { [review.id]: [2] } };
    expect(nextLine(state, converging)).toBe("Next: Petrina opens the pull request, or fixes by the builder if blocking issues are found");
    expect(nextLine(state, { ...converging, blockingAfter: { [review.id]: [1] } })).toBe("Next: your OK to ship, then Petrina opens the pull request");
    expect(nextLine(state, { ...converging, rounds: { [review.id]: 5 } })).toBe("Next: your OK to ship, then Petrina opens the pull request");

    const demo = new Simulator({ ...state, tasks: [final] });
    until(demo, () => item(demo, "delivery") !== undefined);
    expect(taskOf(demo, id).agent).toBeUndefined();
    expect(next(demo, id)).toBe("Next: Petrina opens the pull request");
    demo.approve(item(demo, "delivery")!.id);
    until(demo, () => taskOf(demo, id).state === "pr-open");
    expect(taskOf(demo, id).timeline.some((entry) => entry.text.startsWith("Petrina opened pull request"))).toBe(true);
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

  it("names the work still ahead while the Check finder or the Guide keeper prepares it", () => {
    const { sim, id, on } = feature();
    until(sim, on("builder"), true);
    const state = sim.getState();
    const building = taskOf(sim, id);
    expect(nextLine(state, building)).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    const preparing = { ...building.agent!, roleId: "guide-keeper" as const };
    expect(nextLine(state, { ...building, agent: preparing })).toBe("Next: build (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)");
    expect(nextLine(state, { ...building, fixing: true, agent: preparing })).toBe("Next: fixes by the builder (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)");
    until(sim, on("code-reviewer"), true);
    const reviewing = taskOf(sim, id);
    const duringReview = "Next: your OK to ship, or fixes by the builder if blocking issues are found";
    expect(nextLine(sim.getState(), reviewing)).toBe(duringReview);
    // A voter is part of the review, so what follows it stays next. Only preparation puts the review back.
    expect(nextLine(sim.getState(), { ...reviewing, agent: { ...reviewing.agent!, roleId: "verifier" } })).toBe(duringReview);
    expect(nextLine(sim.getState(), { ...reviewing, agent: { ...reviewing.agent!, roleId: "check-finder" } })).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
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
    // The last planned round, after a round that left one blocking finding: it cannot send the work back again.
    until(sim, on("code-reviewer", 2, (task) => task.sub === 1), true);
    expect(next(sim, id)).toBe("Next: your OK to ship, then Petrina opens the pull request");
    until(sim, () => item(sim, "delivery") !== undefined);
    expect(next(sim, id)).toBe("Next: Petrina opens the pull request");
  });

  it("names a port review's one reviewer, a security review, and how each delivery goes out", () => {
    const { sim, id } = feature();
    until(sim, () => item(sim, "design") !== undefined);
    const state = sim.getState();
    const task = taskOf(sim, id);
    const stages = task.plan!.stages;
    const review = stages.findIndex((stage) => stage.kind === "review-chain");
    const waiting: Task = { ...task, state: "waiting", stageIndex: review, sub: 0 };
    expect(nextLine({ ...state, inbox: [] }, waiting)).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    // A port of a change already reviewed: one reviewer, on a tool other than the builder's (Codex).
    const port: Task = { ...waiting, portReview: { from: "a", head: "b", onto: "c", files: [] } };
    expect(nextLine({ ...state, inbox: [] }, port)).toBe("Next: a review of the port (Claude Code · Opus 5.5), then your OK to ship");
    const security: Task = { ...waiting, plan: { ...task.plan!, stages: stages.map((stage) => (stage.kind === "review-chain" ? { ...stage, roleId: "security-reviewer" } : stage)) } };
    expect(nextLine({ ...state, inbox: [] }, security)).toBe("Next: security review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    // At the delivery check: Petrina publishes by itself; a release has its notes written first.
    const check = stages.findIndex((stage) => stage.gate === "delivery");
    const ready: Task = { ...task, state: "waiting", stageIndex: check + 1, sub: 0 };
    expect(nextLine(state, { ...ready, delivery: "local" })).toBe("Next: Petrina commits to main");
    expect(nextLine(state, { ...ready, delivery: "release" })).toBe("Next: release notes (Claude Code · Sonnet 5.5), then Petrina publishes the release");
    const notes: Task = { ...ready, delivery: "release", state: "running", agent: { roleId: "release-manager", profileId: "sonnet-medium", since: 0, step: 0 } };
    expect(nextLine(state, notes)).toBe("Next: Petrina publishes the release");
    expect(nextLine(state, { ...notes, delivery: "pull-request" })).toBeUndefined();
  });

  it("skips acceptance already tried during fixes and names the delivery check after a final test pass", () => {
    const { sim, id } = feature();
    until(sim, () => item(sim, "design") !== undefined);
    const state = sim.getState();
    const task = taskOf(sim, id);
    const stages = [...task.plan!.stages];
    const build = stages.findIndex((stage) => stage.roleId === "builder");
    stages.splice(build + 1, 0, { id: "test", title: "Test", kind: "do", roleId: "tester", profileIds: ["sol-high"] });
    const fixing: Task = { ...task, plan: { ...task.plan!, stages }, state: "running", stageIndex: build, fixing: true, testedPatch: "earlier" };
    expect(nextLine(state, fixing)).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    expect(nextLine(state, { ...fixing, stageIndex: build + 1, retest: true })).toBe("Next: your OK to ship, or fixes by the builder if acceptance checks fail");
    expect(startClock({ ...fixing, stageIndex: build + 1, fixing: false, retest: true }, "tester", 0).repeat).toBe(true);
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

  it("skips the earlier design checks the engine goes past on the way back to the one where you asked for changes", () => {
    const { sim, id, on } = feature();
    until(sim, on("architect", 1));
    const state = sim.getState();
    const task = taskOf(sim, id);
    const [design, check, ...rest] = task.plan!.stages;
    const screens: Stage = { id: "screens", kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] };
    const later: Stage = { ...check!, id: "later-check" };
    const returning: Task = { ...task, rounds: { [design!.id]: 2 }, returnToCheck: 3, plan: { ...task.plan!, stages: [design!, check!, screens, later, ...rest] } };
    expect(nextLine(state, returning)).toBe("Next: design review again (Codex · sol), then screens (Claude Code · Opus 5.5)");
    const { returnToCheck: _, ...fresh } = returning;
    expect(nextLine(state, fresh)).toBe("Next: design review again (Codex · sol), then your design check");
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

  it("leaves reported reviewers out of a paused or waiting round, including a port review", () => {
    const { sim, id, on } = feature();
    until(sim, on("code-reviewer"), true);
    const state = sim.getState();
    const task = taskOf(sim, id);
    const stage = task.plan!.stages[task.stageIndex]!;
    for (const waiting of ["paused", "waiting"] as const) {
      const partial: Task = { ...task, state: waiting, sub: 0, hunt: { stageId: stage.id, round: 1, reported: { "1": true } } };
      expect(nextLine(state, partial)).toBe("Next: code review (Claude Code · Opus 5.5), then your OK to ship");
      expect(nextLine(state, { ...partial, hunt: { ...partial.hunt!, round: 2 } })).toContain("Claude Code · Opus 5.5 and Codex · sol");
      const port = { ...partial, hunt: { ...partial.hunt!, reported: {} }, portReview: { from: "old", head: "change", onto: "new", files: [] } };
      expect(nextLine(state, port)).toContain("a review of the port (Claude Code · Opus 5.5)");
      expect(nextLine(state, { ...port, hunt: { ...port.hunt!, reported: { "0": true } } })).toBe("Next: your OK to ship, then Petrina opens the pull request");
      expect(nextLine(state, { ...port, hunt: { ...port.hunt!, reported: { "1": true } } })).toBe("Next: your OK to ship, then Petrina opens the pull request");
      const actualBuilder: Task = { ...port, builderSession: { stageId: "build", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "actual-build" } };
      expect(nextLine(state, actualBuilder)).toContain("a review of the port (Codex · sol)");
    }
  });
});

describe("how long the step has left", () => {
  const record = (worked: number, at: number, repeat = false): StepRecord => ({ roleId: "builder", repeat, worked, at });
  /** A builder that has worked `so far` on its first pass, with these records elsewhere in Petrina. */
  function board(records: StepRecord[], soFar: number, state: Task["state"] = "running") {
    const { sim, id, on } = feature();
    until(sim, on("builder"), true);
    const now = 10 * 60 * MINUTE;
    const task: Task = { ...taskOf(sim, id), state, stepClock: { roleId: "builder", repeat: false, worked: soFar, since: now } };
    const done: Task = { ...task, id: "done", state: "done", steps: records };
    return { state: { ...sim.getState(), now, tasks: [task, done] }, task };
  }

  it("says nothing without history, nothing with two past steps, and a rough time with three", () => {
    expect(timeLeft(board([], 0).state, board([], 0).task)).toBeUndefined();
    const two = board([record(20 * MINUTE, 1), record(20 * MINUTE, 2)], 5 * MINUTE);
    expect(timeLeft(two.state, two.task)).toBeUndefined();
    const three = board([record(20 * MINUTE, 1), record(18 * MINUTE, 2), record(22 * MINUTE, 3)], 5 * MINUTE);
    expect(timeLeft(three.state, three.task)).toBe("About 15 minutes left");
  });

  it("only counts steps of the same kind, the latest ten, and only while the agent works", () => {
    const repeats = board([record(20 * MINUTE, 1, true), record(20 * MINUTE, 2, true), record(20 * MINUTE, 3, true)], 0);
    expect(timeLeft(repeats.state, repeats.task)).toBeUndefined();
    const old = Array.from({ length: 10 }, (_, index) => record(3 * 60 * MINUTE, index));
    const recent = Array.from({ length: 10 }, (_, index) => record(60 * MINUTE, 100 + index));
    const latest = board([...recent, ...old], 0);
    expect(timeLeft(latest.state, latest.task)).toBe("About an hour left");
    // The agent has handed back its result; Petrina may still be tidying up the repository.
    expect(timeLeft(latest.state, { ...latest.task, stepClock: pauseClock(latest.task.stepClock!, latest.state.now) })).toBeUndefined();
    const waiting = board([record(20 * MINUTE, 1), record(20 * MINUTE, 2), record(20 * MINUTE, 3)], 0, "needs-you");
    expect(timeLeft(waiting.state, waiting.task)).toBeUndefined();
  });

  it("says when a step runs past its usual time", () => {
    const late = board([record(20 * MINUTE, 1), record(20 * MINUTE, 2), record(20 * MINUTE, 3)], 25 * MINUTE);
    expect(timeLeft(late.state, late.task)).toBe("Taking longer than usual");
  });

  it("is worded roughly", () => {
    expect(leftWords(3 * MINUTE)).toBe("A few minutes left");
    expect(leftWords(14 * MINUTE)).toBe("About 15 minutes left");
    expect(leftWords(62 * MINUTE)).toBe("About an hour left");
    expect(leftWords(115 * MINUTE)).toBe("About 2 hours left");
    expect(leftWords(0)).toBe("Taking longer than usual");
  });

  it("does not count time spent waiting for the coordinator", () => {
    const { sim, id } = feature();
    let clock = startClock(taskOf(sim, id), "builder", 0);
    clock = pauseClock(clock, 4 * MINUTE);
    expect(workedSoFar(clock, 30 * MINUTE)).toBe(4 * MINUTE);
    clock = resumeClock(clock, 30 * MINUTE);
    expect(workedSoFar(clock, 33 * MINUTE)).toBe(7 * MINUTE);
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

describe("the demo", () => {
  it("keeps the first task's to-do item through actions after setup, with Next and no guessed time", () => {
    const demo = createFirstRunDemo(1_000_000_000);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    const product = DEMO_PRODUCTS[0]!;
    sim.addProduct(product);
    const request = { productId: product.id, title: "Add a greeting", approvePlan: true, clientId: "first-summary" };
    const id = sim.startFirstTask(request);
    expect(sim.startFirstTask(request)).toBe(id);
    expect(sim.getState().setup?.done).toBe(true);
    until(sim, () => taskOf(sim, id).agent?.roleId === "planner" && !!taskOf(sim, id).todo);
    const todo = taskOf(sim, id).todo;
    sim.tick();
    const firstAction = taskOf(sim, id).statusLine;
    sim.tick();
    expect(taskOf(sim, id).statusLine).not.toBe(firstAction);
    expect(mainLine(taskOf(sim, id))).toBe(todo);
    expect(next(sim, id)).toBe("Next: your plan check");
    expect(timeLeft(sim.getState(), taskOf(sim, id))).toBeUndefined();
    until(sim, () => item(sim, "plan") !== undefined);
    expect(taskOf(sim, id).todo).toBeUndefined();
    expect(mainLine(taskOf(sim, id))).toBe(taskOf(sim, id).statusLine);
    expect(next(sim, id)).toMatch(/^Next: design \(/);
  });

  it("shows to-do items, Next lines, and a time estimate only where finished demo tasks give enough history", () => {
    const state = createDemoState(1_000_000_000);
    const find = (id: string) => state.tasks.find((task) => task.id === id)!;
    const working = find("login-loop");
    expect(working.state).toBe("running");
    expect(mainLine(working)).toBe("Trying to prove “done” wrong");
    expect(working.statusLine).toBe("Reading the code");
    expect(nextLine(state, working)).toBe("Next: your OK to ship, or fixes by the builder if blocking issues are found");
    expect(timeLeft(state, working)).toBe("About 30 minutes left");
    // Waiting on you mid-step: the card says so, and the to-do item it was on is kept.
    const asking = find("dark-mode");
    expect(mainLine(asking)).toBe("Waiting for your answer");
    expect(asking.todo).toBe("Sketching the dark mode flow");
    expect(nextLine(state, asking)).toBe("Next: design review (Codex · sol), then your design check");
    expect(timeLeft(state, asking)).toBeUndefined();
    // The newer demo has history for architects too. On an older install without records, the same
    // working task still shows no estimate; the extra demo history must not become a guessed default.
    expect(timeLeft({ ...state, tasks: state.tasks.map((task) => ({ ...task, steps: undefined })) }, working)).toBeUndefined();
    for (const task of state.tasks.filter((entry) => ["queued", "done"].includes(entry.state))) expect(nextLine(state, task)).toBeUndefined();
  });

  it("shows a demo to-do item as plain text, with the same limit as the engine", () => {
    const marked = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const markedId = marked.addTask({ productId: "p", title: "Improve **checkout**", kind: "feature" });
    const markedRaw = "Sketching the improve **checkout** flow";
    until(marked, () => taskOf(marked, markedId).todo === plainTodo(markedRaw), true);
    const shown = taskOf(marked, markedId).todo!;
    expect(shown).toBe("Sketching the improve checkout flow");
    expect(shown).not.toMatch(/[*_`#]/);
    expect(taskOf(marked, markedId).timeline.some((entry) => entry.text === shown)).toBe(true);

    const word = "checkout".repeat(12);
    const longRaw = `Sketching the ${word} ${word} flow`;
    expect(longRaw.length).toBeGreaterThan(TODO_MAX);
    const long = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const longId = long.addTask({ productId: "p", title: `Improve ${word} ${word}`, kind: "feature" });
    until(long, () => taskOf(long, longId).todo === plainTodo(longRaw), true);
    const capped = taskOf(long, longId).todo!;
    expect(capped).toBe(plainTodo(longRaw));
    expect(capped.length).toBeLessThanOrEqual(TODO_MAX);
    expect(capped.endsWith("…")).toBe(true);

    const when = 1_000_000_000;
    for (const state of [createDemoState(when), createPortfolioDemo(when).state]) {
      for (const task of state.tasks) {
        if (!task.todo) continue;
        expect(task.todo, task.title).toBe(plainTodo(task.todo));
        expect(task.todo.length, task.title).toBeLessThanOrEqual(TODO_MAX);
      }
    }
  });

  it("gives the portfolio's working tasks their to-do items and Next lines", () => {
    const portfolio = createPortfolioDemo(1_000_000_000).state;
    const running = portfolio.tasks.filter((task) => task.state === "running");
    expect(running.length).toBeGreaterThan(0);
    for (const task of running) {
      expect(task.todo).toBeTruthy();
      expect(mainLine(task)).toBe(task.todo);
      expect(task.statusLine).not.toBe(task.todo);
      expect(nextLine(portfolio, task)).toMatch(/^Next: /);
    }
  });
});
