import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_WORDS, type InboxKind, type State, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { removeDir, SLOW } from "./support.js";

const fake = join(import.meta.dir, "fake-agent.ts");
const temp = mkdtempSync(join(tmpdir(), "petrina-engine-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();

function makeRepo(name = "repo"): string {
  const repo = join(temp, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

afterAll(() => removeDir(temp));

/** Wait for a condition on the engine's state, answering the inbox like a coordinator would. */
async function until(engine: Engine, done: (state: State) => boolean, respond: (engine: Engine, state: State) => void, ms = 60_000): Promise<State> {
  const started = Date.now();
  for (;;) {
    const state = engine.getState();
    if (done(state)) return state;
    if (Date.now() - started > ms * SLOW) throw new Error(`Timed out. Tasks: ${JSON.stringify(state.tasks.map((task) => [task.state, task.statusLine, task.error]))} Inbox: ${JSON.stringify(state.inbox.map((item) => item.kind))}`);
    respond(engine, state);
    await Bun.sleep(50);
  }
}

describe("Engine with a fake ACP agent", () => {
  const repo = makeRepo();
  const engine = new Engine(join(temp, "data"), { agentCommand: () => [process.execPath, fake] });

  afterAll(() => engine.shutdown());

  it("takes a task from the queue to a commit on main, asking the coordinator along the way", async () => {
    const productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "local", true);
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A friendly greeting file.", kind: "feature" });

    const asked = new Set<string>();
    const state = await until(
      engine,
      (current) => ["done", "failed"].includes(current.tasks.find((task) => task.id === taskId)?.state ?? ""),
      (current, snapshot) => {
        for (const item of snapshot.inbox) {
          if (asked.has(item.id)) continue;
          asked.add(item.id);
          if (item.kind === "question") current.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item.kind === "permission") current.allow(item.id, "once");
          else current.approve(item.id);
        }
      },
    );

    const task = state.tasks.find((entry) => entry.id === taskId)!;
    expect(task.error).toBeUndefined();
    expect(task.state).toBe("done");
    expect(task.landed?.branch).toBe("main");
    // The coordinator was asked a question, a permission and two checkpoints.
    expect(task.timeline.some((entry) => entry.text.startsWith("You answered: Formal"))).toBe(true);
    // The tool's own safety check asked; Petrina passed it on unchanged.
    expect(task.timeline.some((entry) => entry.text.includes("You allowed: Installing packages"))).toBe(true);
    expect(task.timeline.some((entry) => entry.text === "You approved the design")).toBe(true);
    expect(task.timeline.some((entry) => entry.text === "You approved the delivery")).toBe(true);
    // The work is on main, with the permission granted.
    expect(git(repo, "show", "main:greeting.txt")).toBe("Hello (with left-pad)");
    expect(task.findings.some((finding) => finding.severity === "suggestion")).toBe(true);
    expect(existsSync(task.worktree!)).toBe(true);
  });
});

describe("The coordinator's call on a design disagreement", () => {
  const CALL = "Show the greeting to everyone, in English only.";
  const repo = makeRepo("call-repo");
  const data = join(temp, "call-data");
  // While this file exists, the architect stops halfway through following a call.
  const hold = join(temp, "hold-call");
  const start = () => new Engine(data, { agentCommand: () => [process.execPath, fake, `--hold=${hold}`] });
  let engine = start();

  afterAll(() => engine.shutdown());

  /** Answer questions and permissions; leave checkpoints to the test. */
  const coordinator = (current: Engine, state: State) => {
    for (const item of state.inbox) {
      if (item.kind === "question") current.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") current.allow(item.id, "once");
    }
  };
  const itemOf = (state: State, taskId: string, kind: InboxKind) => state.inbox.find((item) => item.taskId === taskId && item.kind === kind);
  const taskOf = (state: State, taskId: string) => state.tasks.find((task) => task.id === taskId)!;
  const waitFor = (taskId: string, kind: InboxKind) => until(engine, (state) => !!itemOf(state, taskId, kind) || taskOf(state, taskId).state === "failed", coordinator);
  const reviewerRuns = (task: Task) => task.timeline.filter((entry) => entry.roleId === "design-reviewer" && entry.tone === "milestone").length;
  const architectRuns = (task: Task) => task.timeline.filter((entry) => entry.roleId === "architect" && entry.tone === "milestone").length;
  let productId = "";

  it("settles the design: the architect follows the call once, then a design check, with no review round", async () => {
    productId = await engine.addProduct(repo);
    const taskId = engine.addTask({ productId, title: "Pick a greeting", description: "A greeting file. [disagree]" });
    let state = await waitFor(taskId, "disagreement");
    const before = taskOf(state, taskId);
    const open = before.objections.filter((objection) => objection.status === "open");
    expect(open).toHaveLength(2);
    const design = before.plan!.stages[before.stageIndex]!;
    const rounds = before.rounds[design.id];
    const reviews = reviewerRuns(before);
    const architects = architectRuns(before);

    engine.requestChanges(itemOf(state, taskId, "disagreement")!.id, CALL);
    expect(taskOf(engine.getState(), taskId).call).toMatchObject({ text: CALL, stageId: design.id, open: open.map((objection) => objection.id) });
    state = await waitFor(taskId, "design");
    const after = taskOf(state, taskId);
    expect(after.error).toBeUndefined();

    // The architect ran exactly once more, the reviewer not at all, and the round count stayed put.
    expect(architectRuns(after)).toBe(architects + 1);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds[design.id]).toBe(rounds);
    expect(itemOf(state, taskId, "disagreement")).toBeUndefined();
    // It was told the call is final, in the coordinator's words, with every open objection by id.
    expect(after.session.some((line) => line.from === "agent" && line.text === `Call: ${CALL}. Final: yes. Open: ${open.map((objection) => objection.id).join(", ")}.`)).toBe(true);
    // It left one objection out, was asked again, and every objection has an answer: none open, none defaulted.
    expect(after.objections.find((objection) => objection.id === open[0]!.id)).toMatchObject({ status: "rejected", call: CALL, answer: "Removed it from the brief, as the call says." });
    expect(after.objections.find((objection) => objection.id === open[1]!.id)).toMatchObject({ status: "accepted", answer: "Added it to the brief." });
    expect(after.objections.find((objection) => objection.id === open[1]!.id)?.call).toBeUndefined();
    expect(after.objections.some((objection) => objection.status === "open")).toBe(false);
    // Following the call was a step of its own: once done, nothing said in it goes to the next one.
    expect(after.stepNotes).toBeUndefined();
    expect(after.stepAttempts).toBeUndefined();

    const texts = after.timeline.map((entry) => entry.text);
    expect(texts).toContain(CALL_WORDS.made(CALL));
    expect(texts.some((text) => text.startsWith("You asked for changes"))).toBe(false);
    expect(texts.indexOf(CALL_WORDS.updated)).toBeGreaterThan(texts.indexOf(CALL_WORDS.made(CALL)));
    expect(texts.indexOf(CALL_WORDS.settled)).toBeGreaterThan(texts.indexOf(CALL_WORDS.updated));
    expect(after.statusLine).toBe(CALL_WORDS.waiting);
    expect(itemOf(state, taskId, "design")?.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");

    // Changes asked for at this check go to the architect only and come back to the same check.
    const check = itemOf(state, taskId, "design")!;
    const checkIndex = after.stageIndex;
    engine.requestChanges(check.id, "Say where the greeting shows.");
    state = await until(engine, (current) => !!itemOf(current, taskId, "design") && itemOf(current, taskId, "design")!.id !== check.id, coordinator);
    const revised = taskOf(state, taskId);
    expect(revised.stageIndex).toBe(checkIndex);
    expect(architectRuns(revised)).toBe(architects + 2);
    expect(reviewerRuns(revised)).toBe(reviews);
    expect(revised.rounds[design.id]).toBe(rounds);
    expect(revised.timeline.map((entry) => entry.text)).toContain(CALL_WORDS.revised);
    expect(itemOf(state, taskId, "disagreement")).toBeUndefined();
    // It got the note and every objection the call covered, and could correct its decisions, tags and notes.
    expect(revised.session.some((line) => line.from === "agent" && line.text === `Revising: ${open.map((objection) => objection.id).join(", ")}. Latest note: - Say where the greeting shows.`)).toBe(true);
    expect(revised.objections.find((objection) => objection.id === open[0]!.id)).toMatchObject({ status: "accepted", answer: "Kept it in the brief after your note." });
    expect(revised.objections.find((objection) => objection.id === open[0]!.id)?.call).toBeUndefined();
    expect(revised.objections.find((objection) => objection.id === open[1]!.id)).toMatchObject({ status: "accepted", call: CALL, answer: "Added it to the brief, as the call says." });
    expect(itemOf(state, taskId, "design")?.body).toContain("Your call settled 1 objection (1 accepted, 0 rejected). The architect answered 1 on its own.");

    // Approving moves on to the build. The call stays, so nothing later can reopen the design it settled.
    engine.approve(itemOf(state, taskId, "design")!.id);
    state = await until(engine, (current) => taskOf(current, taskId).agent?.roleId === "builder", coordinator);
    expect(taskOf(state, taskId).call?.text).toBe(CALL);
    engine.cancel(taskId);
  });

  it("answers the plan's own design check after Screens: no second check, and approving it keeps the call", async () => {
    const taskId = engine.addTask({ productId, title: "Pick a slogan", description: "A slogan file. [disagree] [screens]" });
    let state = await waitFor(taskId, "disagreement");
    const before = taskOf(state, taskId);
    const stages = before.plan!.stages.map((stage) => stage.id);
    const design = before.plan!.stages[before.stageIndex]!;
    expect(before.plan!.stages[before.stageIndex + 1]?.roleId).toBe("ux-designer");
    const reviews = reviewerRuns(before);
    const rounds = before.rounds[design.id];

    engine.requestChanges(itemOf(state, taskId, "disagreement")!.id, CALL);
    expect(taskOf(engine.getState(), taskId).plan!.stages.map((stage) => stage.id)).toEqual(stages);
    state = await waitFor(taskId, "design");
    const at = taskOf(state, taskId);
    expect(at.error).toBeUndefined();
    // Screens ran after the architect followed the call; the check is the plan's own, with the call's words.
    expect(at.stageIndex).toBe(stages.indexOf(design.id) + 2);
    expect(at.timeline.findIndex((entry) => entry.roleId === "ux-designer")).toBeGreaterThan(at.timeline.findIndex((entry) => entry.text === CALL_WORDS.settled));
    expect(at.statusLine).toBe(CALL_WORDS.waiting);
    const check = itemOf(state, taskId, "design")!;
    expect(check.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected).");

    // Changes there go to the architect alone and come back, through Screens, to the same check.
    engine.requestChanges(check.id, "Say where the slogan shows.");
    state = await until(engine, (current) => !!itemOf(current, taskId, "design") && itemOf(current, taskId, "design")!.id !== check.id, coordinator);
    const after = taskOf(state, taskId);
    expect(after.stageIndex).toBe(at.stageIndex);
    expect(after.plan!.stages.map((stage) => stage.id)).toEqual(stages);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds[design.id]).toBe(rounds);
    expect(itemOf(state, taskId, "disagreement")).toBeUndefined();
    expect(after.statusLine).toBe(CALL_WORDS.waiting);
    expect(itemOf(state, taskId, "design")?.body).toContain("Your call settled");

    // Approving it moves on to the build, and the call stays.
    engine.approve(itemOf(state, taskId, "design")!.id);
    state = await until(engine, (current) => taskOf(current, taskId).agent?.roleId === "builder", coordinator);
    expect(taskOf(state, taskId).call?.text).toBe(CALL);
    engine.cancel(taskId);
  });

  it("never lets a later design check reopen the design the call settled", async () => {
    const taskId = engine.addTask({ productId, title: "Pick a tagline", description: "A tagline file. [disagree] [two-checks]" });
    let state = await waitFor(taskId, "disagreement");
    // The engine's state is live: keep what it was before the call.
    const before = taskOf(state, taskId);
    const designIndex = before.stageIndex;
    const design = before.plan!.stages[designIndex]!;
    const stages = before.plan!.stages.length;
    const reviews = reviewerRuns(before);
    const rounds = before.rounds[design.id];

    engine.requestChanges(itemOf(state, taskId, "disagreement")!.id, CALL);
    state = await waitFor(taskId, "design");
    const first = itemOf(state, taskId, "design")!;
    expect(taskOf(state, taskId).stageIndex).toBe(designIndex + 1);
    engine.approve(first.id);
    state = await until(engine, (current) => !!itemOf(current, taskId, "design") && itemOf(current, taskId, "design")!.id !== first.id, coordinator);
    const at = taskOf(state, taskId);
    expect(at.stageIndex).toBe(designIndex + 3);
    expect(at.call?.text).toBe(CALL);
    expect(at.statusLine).toBe(CALL_WORDS.waiting);
    const later = itemOf(state, taskId, "design")!;
    expect(later.body).toContain("Your call settled");

    // Changes at the later check go to the architect alone: no review round, no new disagreement.
    engine.requestChanges(later.id, "Say where the tagline shows.");
    state = await until(engine, (current) => !!itemOf(current, taskId, "design") && itemOf(current, taskId, "design")!.id !== later.id, coordinator);
    const after = taskOf(state, taskId);
    expect(after.error).toBeUndefined();
    // Back at the later check, not the earlier one already approved.
    expect(after.stageIndex).toBe(designIndex + 3);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds[design.id]).toBe(rounds);
    expect(after.plan!.stages).toHaveLength(stages);
    expect(itemOf(state, taskId, "disagreement")).toBeUndefined();
    expect(after.timeline.map((entry) => entry.text)).toContain(CALL_WORDS.revised);
    expect(itemOf(state, taskId, "design")?.body).toContain("Your call settled");
    expect(after.objections.some((objection) => objection.status === "open")).toBe(false);
    engine.cancel(taskId);
  });

  it("keeps a non-blocking point raised as the design settles as an undecided follow-up, never rejected", async () => {
    const taskId = engine.addTask({ productId, title: "Pick a colour", description: "A colour file. [follow-up]" });
    const state = await waitFor(taskId, "design");
    const objections = taskOf(state, taskId).objections;
    expect(objections).toHaveLength(1);
    expect(objections[0]!.status).toBe("noted");
    expect(objections[0]!.answer).toBeUndefined();
    engine.cancel(taskId);
  });

  it("leaves siding with the architect as it was", async () => {
    const taskId = engine.addTask({ productId, title: "Pick a welcome", description: "A welcome file. [disagree]" });
    let state = await waitFor(taskId, "disagreement");
    const before = taskOf(state, taskId);
    const open = before.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
    const stages = before.plan!.stages.length;

    engine.approve(itemOf(state, taskId, "disagreement")!.id);
    state = await waitFor(taskId, "design");
    const after = taskOf(state, taskId);
    expect(after.timeline.map((entry) => entry.text)).toContain("You sided with the architect");
    for (const id of open) expect(after.objections.find((objection) => objection.id === id)).toMatchObject({ status: "rejected" });
    expect(after.objections.some((objection) => objection.call !== undefined)).toBe(false);
    expect(after.call).toBeUndefined();
    expect(after.plan!.stages).toHaveLength(stages);
    expect(itemOf(state, taskId, "design")?.body).toBeUndefined();
    engine.cancel(taskId);
  });

  it("sends the design back for a full round when changes are asked for at a check with no call", async () => {
    const taskId = engine.addTask({ productId, title: "Pick a motto", description: "A motto file." });
    let state = await waitFor(taskId, "design");
    const check = itemOf(state, taskId, "design")!;
    // The engine's state is live: keep what it was before asking for changes.
    const before = taskOf(state, taskId);
    const design = before.plan!.stages.find((stage) => stage.kind === "converge")!;
    const reviews = reviewerRuns(before);
    const rounds = before.rounds[design.id] ?? 1;

    engine.requestChanges(check.id, "Make it shorter.");
    state = await until(engine, (current) => !!itemOf(current, taskId, "design") && itemOf(current, taskId, "design")!.id !== check.id, coordinator);
    const after = taskOf(state, taskId);
    expect(reviewerRuns(after)).toBe(reviews + 1);
    expect(after.rounds[design.id]).toBe(rounds + 1);
    expect(after.timeline.map((entry) => entry.text)).toContain("You asked for changes: Make it shorter.");
    engine.cancel(taskId);
  });

  it("follows the call after a restart halfway through and a pause, adding the design check the plan did not have", async () => {
    const taskId = engine.addTask({ productId, title: "Pick a farewell", description: "A farewell file. [disagree] [no-check]" });
    let state = await waitFor(taskId, "disagreement");
    const before = taskOf(state, taskId);
    const design = before.plan!.stages[before.stageIndex]!;
    expect(before.plan!.stages[before.stageIndex + 1]?.kind).not.toBe("gate");
    const reviews = reviewerRuns(before);

    // Petrina restarts while the architect is halfway through following the call, then the task is paused and resumed.
    writeFileSync(hold, "");
    engine.requestChanges(itemOf(state, taskId, "disagreement")!.id, CALL);
    state = await until(engine, (current) => taskOf(current, taskId).timeline.some((entry) => entry.roleId === "architect" && entry.text === "Reading your call"), coordinator);
    const halfway = taskOf(state, taskId);
    expect(halfway.state).toBe("running");
    expect(halfway.statusLine).toBe(CALL_WORDS.following);
    const architects = architectRuns(halfway);
    engine.setPoolPaused(true);
    engine.shutdown();
    rmSync(hold);
    engine = start();
    expect(taskOf(engine.getState(), taskId).call?.text).toBe(CALL);
    engine.pause(taskId);
    engine.resume(taskId);
    engine.setPoolPaused(false);

    state = await waitFor(taskId, "design");
    const after = taskOf(state, taskId);
    expect(after.error).toBeUndefined();
    // The architect picked up following the call: one more run, and still no reviewer.
    expect(architectRuns(after)).toBe(architects + 1);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.timeline.map((entry) => entry.text)).toContain(CALL_WORDS.updated);
    expect(after.plan!.stages[after.stageIndex]).toMatchObject({ kind: "gate", gate: "design", id: `${design.id}:call-check` });
    expect(after.objections.some((objection) => objection.status === "open")).toBe(false);

    // Approving the added check moves on to the next stage of the plan.
    engine.approve(itemOf(state, taskId, "design")!.id);
    state = await until(engine, (current) => taskOf(current, taskId).agent?.roleId === "builder", coordinator);
    expect(taskOf(state, taskId).plan!.stages[taskOf(state, taskId).stageIndex]!.roleId).toBe("builder");
    engine.cancel(taskId);
  });
});
