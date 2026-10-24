import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { journeyProblems, journeyView, type JourneyView, type State, type Task } from "@petrina/core";
import { Engine } from "./engine.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";
import { Coordination } from "../src/coordination.js";

const fake = join(import.meta.dir, "fake-agent.ts");
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** An engine on fake agents, with a product on a GitHub-like origin, delivering locally. */
async function setup(scenario: Parameters<Fakes["scenario"]>[0] = {}, approveDelivery = true) {
  const root = tempDir("petrina-journey-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, fake, fakes.dir] });
  const productId = await engine.addProduct(await makeProduct(root));
  engine.setProductDelivery(productId, "local", approveDelivery);
  return { engine, productId, fakes };
}

const taskOf = (engine: Engine, id: string): Task => engine.getState().tasks.find((task) => task.id === id)!;
const viewOf = (engine: Engine, id: string): JourneyView => {
  const state = engine.getState();
  return journeyView(taskOf(engine, id), { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });
};

/** Wait for `done`, answering the inbox once per item; `respond` may handle an item itself. */
async function until(engine: Engine, done: (state: State) => boolean, respond: (engine: Engine, kind: string, id: string) => boolean = () => false, what = "the task"): Promise<void> {
  const seen = new Set<string>();
  await waitFor(() => {
    const state = engine.getState();
    if (done(state)) return true;
    for (const item of state.inbox) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (respond(engine, item.kind, item.id)) continue;
      if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else engine.approve(item.id);
    }
    return false;
  }, what, 60_000);
}

describe("the engine records each task's journey", () => {
  it("keeps separate input records for parallel reviewer seats on the same available profile", async () => {
    const { engine, productId, fakes } = await setup();
    try {
      engine.setPoolPaused(true);
      await waitFor(() => !engine.s.setup?.checks.some(check => check.checking), "initial tool checks");
      engine.s.setup!.checks = [{ id: "codex", status: "ready" }, { id: "claude-code", status: "logged-out" }, { id: "grok", status: "logged-out" }, { id: "antigravity", status: "logged-out" }];
      engine.s.tools = engine.s.tools.map(tool => ({ ...tool, status: tool.id === "codex" ? "ready" : "logged-out" }));
      const id = engine.addTask({ productId, title: "Check the single-tool journey", description: "Keep reviewer seats separate." });
      engine.setPoolPaused(false);
      await until(engine, state => ["done", "failed"].includes(state.tasks.find(task => task.id === id)!.state));
      const task = taskOf(engine, id);
      expect(task.error).toBeUndefined();
      const inputs = task.journey!.find(step => step.roleId === "code-reviewer")!.agentInputs!.filter(input => input.roleId === "code-reviewer");
      expect(inputs).toHaveLength(2);
      expect(inputs.map(input => input.reviewerKey).sort()).toEqual(["0", "1"]);
      expect(new Set(inputs.map(input => input.profileId)).size).toBe(1);
      expect(inputs.every(input => input.selectionReason)).toBe(true);
      for (const input of inputs) expect(fakes.prompts().some(prompt => prompt.includes(input.instructions!))).toBe(true);
      // Each place's messages and result name its own start, so two places on one profile stay apart.
      const step = engine.task(id)!.journey!.find(step => step.roleId === "code-reviewer")!;
      const spoken = engine.task(id)!.session.filter(line => line.step === step.id && line.from === "agent" && line.roleId === "code-reviewer");
      expect(new Set(spoken.map(line => step.agentInputs![line.inputIndex!]!.reviewerKey))).toEqual(new Set(["0", "1"]));
      expect(new Set(spoken.map(line => line.inputIndex))).toEqual(new Set(step.agentResults!.filter(result => result.roleId === "code-reviewer").map(result => result.inputIndex)));
    } finally { await engine.shutdown(); }
  });
  it("lists one current message for an agent that streamed words and then asked a question", async () => {
    const { engine, productId } = await setup();
    try {
      const id = engine.addTask({ productId, title: "Ask before designing", description: "One agent, one current message." });
      const asked = (state: State) => state.inbox.some(item => item.taskId === id && item.kind === "question");
      await until(engine, asked, (_, kind) => kind === "question", "the architect's question");
      const task = engine.task(id)!, step = task.journey!.at(-1)!;
      const spoken = task.session.filter(line => line.step === step.id && line.from === "agent");
      expect(spoken.length).toBeGreaterThan(1);
      // The streamed words and the question name the same recorded start, so the agent is one current message.
      expect(new Set(spoken.map(line => line.inputIndex))).toEqual(new Set([step.agentInputs!.length - 1]));
      const read = await new Coordination(engine).call("task.conversation", { taskId: id, nodeId: step.id });
      expect(read.activeMessages).toEqual([expect.objectContaining({ id: spoken.at(-1)!.id, roleId: "architect" })]);
    } finally { await engine.shutdown(); }
  });
  it("keeps the still-asking reviewer discoverable when its same-profile peer answers and finishes", async () => {
    const { engine, productId } = await setup({ reviewer: "question", architect: "plain" });
    try {
      engine.setPoolPaused(true);
      await waitFor(() => !engine.s.setup?.checks.some(check => check.checking), "initial tool checks");
      engine.s.setup!.checks = [{ id: "claude-code", status: "ready" }, { id: "codex", status: "logged-out" }, { id: "grok", status: "logged-out" }, { id: "antigravity", status: "logged-out" }];
      engine.s.tools = engine.s.tools.map(tool => ({ ...tool, status: tool.id === "claude-code" ? "ready" : "logged-out" }));
      const id = engine.addTask({ productId, title: "Two reviewers ask", description: "Keep each reviewer's questions its own." });
      engine.setPoolPaused(false);
      const questions = () => engine.s.inbox.filter(item => item.taskId === id && item.kind === "question" && item.roleId === "code-reviewer");
      await until(engine, () => questions().length === 2, (current, kind, itemId) => kind === "question" && current.s.inbox.find(item => item.id === itemId)?.roleId === "code-reviewer", "both reviewers' questions");
      const task = engine.task(id)!, step = task.journey!.at(-1)!;
      const inputs = step.agentInputs!.filter(input => input.roleId === "code-reviewer");
      expect(inputs.map(input => input.reviewerKey).sort()).toEqual(["0", "1"]);
      expect(new Set(inputs.map(input => input.profileId)).size).toBe(1);
      const c = new Coordination(engine), read = () => c.call("task.conversation", { taskId: id, nodeId: step.id });
      const before = await read();
      expect((before.activeMessages as unknown[]).length).toBe(2);
      // One reviewer hears its answer and hands back; the other still waits on its own question.
      const [first, second] = questions();
      engine.answer(first!.id, "Yes");
      await waitFor(() => (step.agentResults ?? []).some(result => result.roleId === "code-reviewer"), "the answered reviewer's result");
      const finished = step.agentResults!.find(result => result.roleId === "code-reviewer")!.inputIndex!;
      const waiting = step.agentInputs!.findIndex((input, index) => input.roleId === "code-reviewer" && index !== finished);
      const lines = task.session.filter(line => line.step === step.id && line.from === "agent" && line.roleId === "code-reviewer");
      expect(lines.every(line => line.inputIndex === finished || line.inputIndex === waiting)).toBe(true);
      const after = await c.call("task.conversation", { taskId: id, nodeId: step.id, ifRevision: before.revision as string });
      expect(after.unchanged).toBe(false);
      const stillAsking = lines.filter(line => line.inputIndex === waiting).at(-1)!;
      expect(stillAsking.text).toBe(second!.title);
      expect((after.activeMessages as { id: string }[]).map(message => message.id)).toEqual([stillAsking.id]);
      const statuses = Object.fromEntries(((await read()).items as { id: string; mayChange: boolean | null }[]).map(item => [item.id, item.mayChange]));
      for (const line of lines) expect(statuses[line.id]).toBe(line.inputIndex === waiting);
    } finally { await engine.shutdown(); }
  });
  it("names the planner that can run as tool readiness changes, including after a restart", async () => {
    const { engine, productId } = await setup({ controlled: true });
    const data = engine.dataDir;
    let reopened: Engine | undefined;
    try {
      engine.setPoolPaused(true);
      const id = engine.addTask({ productId, title: "First task" });
      engine.s.setup!.checks = [{ id: "claude-code", status: "logged-out" }, { id: "codex", status: "ready" }];
      engine.commit();
      expect(viewOf(engine, id).nodes[0]).toMatchObject({ name: "Planner", state: "next", profileId: "sol-high" });
      await engine.shutdown();

      reopened = new Engine(data, { agentCommand: () => [process.execPath, fake] });
      expect(viewOf(reopened, id).nodes[0]).toMatchObject({ profileId: "sol-high" });
      reopened.s.setup!.checks = [{ id: "claude-code", status: "ready" }, { id: "codex", status: "ready" }];
      reopened.commitNow();
      expect(viewOf(reopened, id).nodes[0]).toMatchObject({ profileId: "opus-high" });
      expect(taskOf(reopened, id).journey).toBeUndefined();
    } finally {
      await reopened?.shutdown();
      await engine.shutdown();
    }
  });

  it.each(["engine", "window"] as const)("one step per agent and check, with outcomes, reasons, questions and tagged lines (%s answer)", async (from) => {
    const { engine, productId, fakes } = await setup();
    const id = engine.addTask({ productId, title: "Add a greeting", description: "A friendly greeting file." });
    await until(engine, (state) => ["done", "failed"].includes(state.tasks.find((task) => task.id === id)!.state), (squad, kind, itemId) => {
      if (kind !== "question") return false;
      if (from === "window") squad.answer(itemId, "Formal", { decided: true });
      else squad.decideForMe(itemId);
      return true;
    });
    const task = taskOf(engine, id);
    expect(task.error).toBeUndefined();
    const view = viewOf(engine, id);
    expect(view.nodes.map((node) => node.name)).toEqual(["Planner", "Architect", "Design reviewer", "Your design check", "Builder", "Check finder", "Automated checks", "Code reviewers", "Your delivery check", "Publish delivery"]);
    expect(view.nodes.every((node) => node.state === "done")).toBe(true);
    expect(view.nodes.map((node) => node.reason ?? "")).toEqual(["plan ready", "brief ready", "no blocking objections", "you approved", "ready for review", "checks found", "checks passed", "review passed", "you approved", ""]);
    expect(view.nodes.map((node) => node.outcome)).toEqual(["Plan with 4 stages", "Wrote the brief", "No objections", "Approved", "Change ready", "Found 1 check", "The check passes", "2 nits", "Approved", "Moved main forward"]);
    expect(view.nodes[6]!.productChecks).toEqual([expect.objectContaining({ name: "Version", result: "pass", startedAt: expect.any(Number), endedAt: expect.any(Number) })]);
    expect(view.nodes.map((node) => node.team ? [...node.team].sort().join(" ") : node.profileId ?? "")).toEqual(["opus-high", "opus-xhigh", "sol-xhigh", "", "sol-xhigh", "opus-high", "", "opus-high sol-high", "", ""]);
    expect(new Set(view.nodes[7]!.team)).toEqual(new Set(["opus-high", "sol-high"]));
    const execution = view.nodes[6]!;
    expect(view.nodes.filter(node => node.work === "checks")).toHaveLength(1);
    expect(view.nodes.filter(node => node.work === "check-reuse")).toHaveLength(0);
    const decision = view.nodes.find(node => node.kind === "you" && node.waitsFor === "delivery")!;
    expect(decision.productChecks![0]!.run).toEqual(execution.productChecks![0]!.run);
    expect(view.end).toEqual({ text: "Delivered locally to main", state: "done" });

    // Questions and permission requests hang under the step that asked, with the answer.
    expect(view.nodes[1]!.asks).toEqual([expect.objectContaining({ kind: "question", title: "Should the greeting be formal?", how: "decided", answer: "Formal" })]);
    expect(view.nodes[4]!.asks).toEqual([expect.objectContaining({ kind: "permission", how: "allowed" })]);
    expect(engine.tracking.log.moments({ taskId: id, kinds: ["ask"] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ ask: "question", answer: "decided" }),
      expect.objectContaining({ ask: "permission", answer: "allowed" }),
    ]));

    // Every agent's lines carry its step: its "started" line, what it did, and what it said.
    for (const step of task.journey!.filter((entry) => entry.kind === "agent")) {
      const role = engine.getState().roles.find((role) => role.id === step.roleId)!.name;
      expect(task.timeline.some((entry) => entry.step === step.id && entry.text.startsWith(role) && entry.text.includes("started"))).toBe(true);
      expect(task.session.filter((line) => line.step === step.id).length).toBeGreaterThan(0);
      expect(step.agentInputs?.length).toBeGreaterThan(0);
      expect(step.agentInputs?.every((input) => input.sections.every((section) => section.title && section.body))).toBe(true);
      for (const input of step.agentInputs ?? []) {
        expect(input.requestedProfileId).toBeString();
        expect(input.selectionReason).toBeString();
        expect(input.confirmedSettings?.model).toBeString();
        expect(input.instructions).toBeString();
        expect(fakes.prompts().some(prompt => prompt.includes(input.instructions!))).toBe(true);
        for (const update of input.updates ?? []) expect(fakes.prompts()).toContain(update.text);
      }
    }
    const builder = task.journey!.find((step) => step.roleId === "builder")!;
    expect(builder.agentInputs?.[0]).toMatchObject({ taskTitle: "Add a greeting", taskDescription: "A friendly greeting file.", stageTitle: "Build", roleId: "builder" });
    const architectInput = task.journey!.find(step => step.roleId === "architect")!.agentInputs![0]!;
    expect(architectInput.updates?.some(update => update.reason === "answer" && update.text.includes("The coordinator answered:"))).toBe(true);
    expect(task.timeline.find((entry) => entry.text.startsWith("You allowed"))?.step).toBe(builder.id);
    expect(journeyProblems(task)).toEqual([]);
    await engine.shutdown();
  });

  it("records parallel review, fresh votes and a fix round as distinct steps", async () => {
    const { engine, productId } = await setup({ reviewer: "important", fixes: "change" });
    try {
      const id = engine.addTask({ productId, title: "Fix the greeting", description: "A greeting file." });
      await until(engine, (state) => ["done", "failed"].includes(state.tasks.find((task) => task.id === id)!.state));
      const task = taskOf(engine, id);
      expect(task.error).toBeUndefined();
      const verifierInputs = task.journey!.filter(step => step.roleId === "verifier").flatMap(step => step.agentInputs ?? []);
      expect(verifierInputs.length).toBeGreaterThan(0);
      expect(verifierInputs.every(input => input.assignment === undefined)).toBe(true);
      const view = viewOf(engine, id);
      const reviews = view.nodes.filter((node) => node.roleId === "code-reviewer");
      expect(reviews.map((node) => node.name)).toEqual(["Code reviewers", "Code reviewers (round 2)"]);
      expect(new Set(reviews[0]!.team)).toEqual(new Set(["opus-high", "sol-high"]));
      expect(reviews[0]!.reason).toBe("1 important finding to check");
      const votes = view.nodes.filter((node) => node.roleId === "verifier");
      expect(votes).toHaveLength(1);
      expect(votes[0]).toMatchObject({ outcome: "1 checked: 1 must be fixed in this change", reason: "sent back: 1 important", tone: "back", state: "done" });
      expect(task.timeline.some(entry => entry.step === votes[0]!.id && entry.text === "1 checked: 1 must be fixed in this change")).toBe(true);
      expect(view.nodes.find((node) => node.name === "Builder (fixes)")).toMatchObject({ outcome: "Changes returned; 2 fixes claimed", reason: "Changes returned; 2 fixes claimed" });
      expect(view.nodes.at(-1)).toMatchObject({ kind: "petrina", name: "Publish delivery", state: "done" });
      expect(journeyProblems(task)).toEqual([]);
    } finally {
      await engine.shutdown();
    }
  });

  it("design rounds, the call on a disagreement, and the architect following it", async () => {
    const { engine, productId } = await setup();
    const id = engine.addTask({ productId, title: "Pick a greeting", description: "A greeting file. [disagree]" });
    const item = (kind: string) => engine.getState().inbox.find((entry) => entry.taskId === id && entry.kind === kind);
    await until(engine, () => !!item("disagreement"), (_engine, kind) => kind === "disagreement");
    let view = viewOf(engine, id);
    expect(view.nodes.map((node) => `${node.name}: ${node.state}`).slice(0, 6)).toEqual([
      "Planner: done",
      "Architect: done",
      "Design reviewer: done",
      "Architect (round 2): done",
      "Design reviewer (round 2): done",
      "Your call: you",
    ]);
    expect(view.nodes[2]).toMatchObject({ outcome: "2 objections, 1 blocking", reason: "1 blocking objection", tone: "back" });
    expect(view.nodes[5]!.live).toBe("The architects disagree. Your call");
    // What comes next is the plan: the design check, then the build.
    expect(view.nodes.slice(6, 8).map((node) => `${node.name}: ${node.state}`)).toEqual(["Your design check: next", "Builder: ahead"]);

    engine.requestChanges(item("disagreement")!.id, "Show the greeting to everyone, in English only.");
    await until(engine, () => !!item("design"), (_engine, kind) => kind === "design");
    view = viewOf(engine, id);
    expect(view.nodes.slice(5, 8).map((node) => `${node.name}: ${node.state}`)).toEqual(["Your call: done", "Architect (your call): done", "Your design check: you"]);
    expect(view.nodes[5]).toMatchObject({ reason: "your call", tone: "back" });
    expect(view.nodes[6]).toMatchObject({ reason: "brief follows your call" });
    expect(journeyProblems(taskOf(engine, id))).toEqual([]);
    engine.cancel(id);
    expect(viewOf(engine, id)).toMatchObject({ end: { text: "Cancelled", state: "cancelled" } });
    expect(viewOf(engine, id).nodes.at(-1)).toMatchObject({ name: "Your design check", state: "cancelled", outcome: "Cancelled" });
    await engine.shutdown();
  });

  it("a stuck step, a Stuck step for you, and a new box when you try again", async () => {
    const { engine, productId, fakes } = await setup({ planner: "short", builder: "fail-once" }, false);
    const id = engine.addTask({ productId, title: "Add a greeting" });
    await until(engine, (state) => state.tasks.find((task) => task.id === id)!.state === "failed", () => true);
    let view = viewOf(engine, id);
    expect(view.nodes.map((node) => `${node.name}: ${node.state}`).slice(0, 4)).toEqual(["Planner: done", "Builder: failed", "Stuck: you", "Builder (again): next"]);
    expect(view.nodes[1]).toMatchObject({ outcome: "Stuck", reason: taskOf(engine, id).error, tone: "stuck" });
    const failed = taskOf(engine, id).journey![1]!;
    expect(taskOf(engine, id).timeline.find((entry) => entry.text.startsWith("Stuck:"))?.step).toBe(failed.id);
    expect(fakes.marked("builder-failed")).toBe(true);

    await until(engine, (state) => state.tasks.find((task) => task.id === id)!.state === "done");
    view = viewOf(engine, id);
    expect(view.nodes.map((node) => `${node.name}: ${node.state}`)).toEqual(["Planner: done", "Builder: failed", "Stuck: done", "Builder (again): done", "Check finder: done", "Automated checks: done", "Code reviewer: done", "Publish delivery: done"]);
    expect(view.nodes[2]).toMatchObject({ outcome: "Tried again", reason: "you asked to try again" });
    expect(journeyProblems(taskOf(engine, id))).toEqual([]);
    await engine.shutdown();
  });

  it("cancelling stops the step under way", async () => {
    const { engine, productId } = await setup({ controlled: true });
    const id = engine.addTask({ productId, title: "Hold on" });
    await waitFor(() => taskOf(engine, id).journey?.at(-1)?.roleId === "planner", "the planner to start");
    engine.cancel(id);
    const view = viewOf(engine, id);
    expect(view.nodes.map((node) => `${node.name}: ${node.state}`)).toEqual(["Planner: cancelled"]);
    expect(view.nodes[0]!.outcome).toBe("Stopped: you cancelled");
    expect(view.rest).toBeUndefined();
    expect(journeyProblems(taskOf(engine, id))).toEqual([]);
    await engine.shutdown();
  });

  it("starts old tasks' journeys with one step per finished stage", async () => {
    const root = tempDir("petrina-journey-old-");
    roots.push(root);
    const data = join(root, "data");
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ controlled: true });
    let engine = new Engine(data, { agentCommand: () => [process.execPath, fake, fakes.dir] });
    const productId = await engine.addProduct(await makeProduct(root));
    engine.setPoolPaused(true);
    const id = engine.addTask({ productId, title: "From before" });
    // As if it ran before journeys were recorded: planned, designed and waiting for its build.
    const task = engine.task(id)! as unknown as Record<string, unknown>;
    Object.assign(task, {
      state: "waiting",
      startedAt: Date.now() - 60_000,
      stageIndex: 1,
      plan: { rationale: "Old.", plannerProfileId: "opus-high", stages: [{ id: `${id}:s0`, kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] }, { id: `${id}:s1`, kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] }] },
    });
    delete task.journey;
    await engine.shutdown();
    engine = new Engine(data, { agentCommand: () => [process.execPath, fake, fakes.dir] });
    const view = viewOf(engine, id);
    expect(view.nodes.map((node) => `${node.name}: ${node.state}`)).toEqual(["Planner: done", "Researcher: done", "Builder: next"]);
    expect(view.note).toMatch(/Earlier rounds were not recorded/);
    expect(taskOf(engine, id).journey).toHaveLength(2);
    await engine.shutdown();
  });

  it("keeps an old task's step under way, and the question it waits on, across a restart", async () => {
    const root = tempDir("petrina-journey-old-asked-");
    roots.push(root);
    const data = join(root, "data");
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({});
    const open = () => new Engine(data, { agentCommand: () => [process.execPath, fake, fakes.dir] });
    let engine = open();
    const productId = await engine.addProduct(await makeProduct(root));
    engine.setProductDelivery(productId, "local", false);
    const id = engine.addTask({ productId, title: "From before", description: "A friendly greeting file." });
    const question = () => engine.getState().inbox.find((item) => item.taskId === id && item.kind === "question");
    await until(engine, () => !!question(), () => true, "the architect's question");
    // As if it ran before journeys were recorded, and Petrina restarted before the question was answered.
    const before = engine.task(id)! as unknown as { journey?: unknown; timeline: { step?: string }[]; session: { step?: string }[] };
    delete before.journey;
    for (const line of [...before.timeline, ...before.session]) delete line.step;
    await engine.shutdown();

    engine = open();
    const asked = question()!;
    let view = viewOf(engine, id);
    expect(view.nodes.map((node) => `${node.name}: ${node.state}`).slice(0, 3)).toEqual(["Planner: done", "Architect: you", "Design reviewer: next"]);
    expect(view.nodes[1]!.asks).toEqual([expect.objectContaining({ id: asked.id, kind: "question", title: "Should the greeting be formal?" })]);
    expect(view.note).toMatch(/Earlier rounds were not recorded/);

    // Answering it continues the same box.
    const box = taskOf(engine, id).journey!.at(-1)!;
    engine.answer(asked.id, "Formal");
    await until(engine, () => !!engine.getState().inbox.find((item) => item.taskId === id && item.kind === "design"), () => true, "the design check");
    view = viewOf(engine, id);
    expect(view.nodes.map((node) => `${node.name}: ${node.state}`).slice(0, 4)).toEqual(["Planner: done", "Architect: done", "Design reviewer: done", "Your design check: you"]);
    expect(taskOf(engine, id).journey![1]).toMatchObject({ id: box.id, startedAt: box.startedAt, end: "done" });
    // toEqual, not toMatchObject: bun's toMatchObject writes its matchers into the object it checks.
    expect(taskOf(engine, id).journey![1]!.asks).toEqual([expect.objectContaining({ id: asked.id, how: "answered", answer: "Formal" })]);
    expect(journeyProblems(taskOf(engine, id))).toEqual([]);
    await engine.shutdown();
  });
});
