import { executionFor } from "../src/repository-context.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { draftOf, slotUses, slotWait } from "@petrina/core";
import { Engine } from "./engine.js";
import { stepKey } from "../src/kernel.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, removeDir, SLOW, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const later = () => Date.now() + 3_600_000;

async function fixture(scenario: Scenario = {}) {
  const root = tempDir("petrina-builder-continuity-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "claude-build", builder: "plain", controlled: true, reopen: "resume", limited: [{ model: "opus", role: "builder", spendCap: true }], ...scenario });
  let nextGrokCheck: string | undefined;
  const options = {
    agentCommand: (profile: { toolId: string }) => {
      const flag = profile.toolId === "grok" ? nextGrokCheck : undefined;
      if (flag) nextGrokCheck = undefined;
      return [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, ...(flag ? [flag] : [])];
    },
    toolPath: () => "/bin/true", usageCommands: { codex: null }, toolCheckTimeoutMs: 8000 * SLOW,
  };
  let engine = new Engine(join(root, "data"), options);
  engine.setPoolPaused(true);
  const repo = makeProduct(root);
  const productId = await engine.addProduct(repo);
  engine.setProductDelivery(productId, "local", true);
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  const task = () => engine.getState().tasks.find((task) => task.id === taskId)!;
  const model = (session: string) => fakes.settings(session).find((line) => line.startsWith("model="))?.slice(6);
  const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
  const advance = (done: () => boolean, allow: (role: string) => boolean = () => true) => waitFor(() => {
    for (const prompt of fakes.received()) if (allow(prompt.role)) release(prompt.session);
    for (const item of engine.getState().inbox) {
      if (["plan", "design"].includes(item.kind)) engine.approve(item.id);
      if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
      if (item.kind === "permission") engine.allow(item.id, "once");
    }
    if (task().state === "failed") throw new Error(task().error);
    return done();
  }, "the Builder and its reviews", 60_000);
  const delivery = () => engine.getState().inbox.some((item) => item.kind === "delivery");
  const restart = async (flag?: string) => {
    await engine.shutdown();
    nextGrokCheck = flag;
    options.toolCheckTimeoutMs = (flag === "--hang" ? 200 : 8000) * SLOW;
    engine = new Engine(join(root, "data"), options);
    await engine.waitUntilReady();
  };
  return { get engine() { return engine; }, fakes, task, model, advance, delivery, restart, repo, root };
}

function roomierAlternative(engine: Engine) {
  engine.s.pool.usage = [
    { toolId: "codex", kind: "weekly", status: "allowed", utilization: 0.33, at: Date.now(), resetsAt: later() },
    { toolId: "grok", kind: "weekly", status: "allowed", utilization: 0.01, at: Date.now(), resetsAt: later() },
  ];
}

describe.concurrent("the Builder's saved fallback conversation", () => {
  it("keeps Codex at 33% for review fixes, with actual attribution and independent reviews", async () => {
    const f = await fixture({ reviewer: "important-twice", learnings: true });
    try {
      f.engine.setPoolPaused(false);
      await f.advance(() => f.fakes.received("builder").some((entry) => f.model(entry.session) === "gpt-6.1-sol"), (role) => role !== "builder");
      const review = f.engine.s.tasks.find((task) => task.id === f.task().id)!.plan!.stages.find((stage) => stage.kind === "review-chain")!;
      review.profileIds = ["sol-high", "grok-high"];
      review.maxRounds = 3;
      await f.advance(() => f.fakes.received("code reviewer").length > 0, (role) => role !== "code reviewer");
      expect(f.task().lessons?.filter((lesson) => lesson.roleId === "builder")).toEqual([
        expect.objectContaining({ profileId: "sol-high", text: "Run the tests with bun test: they take a second." }),
        expect.objectContaining({ profileId: "sol-high", text: "Greetings live at the repository root." }),
      ]);
      const original = f.fakes.received("builder").find((entry) => f.model(entry.session) === "gpt-6.1-sol")!;
      roomierAlternative(f.engine);
      await f.advance(f.delivery);
      const builders = f.fakes.received("builder").filter((entry) => f.model(entry.session) === "gpt-6.1-sol");
      expect(builders).toHaveLength(2);
      expect(builders.every((entry) => entry.session === original.session)).toBe(true);
      expect(builders[1]!.text).toStartWith("Petrina is back with more work on this task");
      expect(f.fakes.received("builder").some((entry) => f.model(entry.session) === "grok-4.7")).toBe(false);
      expect(f.task().builderSession).toEqual(expect.objectContaining({ profileId: "sol-high", plannedProfileId: "opus-high", toolId: "codex", sessionId: original.session }));
      const returns = f.task().journey!.filter((step) => step.builderReturn);
      expect(returns).toHaveLength(2);
      expect(returns.map((step) => f.task().timeline.find((entry) => entry.step === step.id && entry.text.startsWith(step.builderReturn!.outcome))?.profileId)).toEqual(["sol-high", "sol-high"]);
      expect(f.task().findings.filter((finding) => finding.severity === "blocking").every((finding) => finding.answer?.fixed)).toBe(true);
      const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
      expect(new Set(verdicts.filter((entry) => entry.round === 2).map((entry) => f.engine.profile(entry.profileId!)?.toolId))).toEqual(new Set(["codex", "grok"]));
    } finally { f.engine.shutdown(); }
  });

  it("reopens the saved Codex conversation for a real main conflict and keeps the port review on Grok", async () => {
    const f = await fixture();
    try {
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      const original = f.task().builderSession!;
      expect(original.toolId).toBe("codex");
      roomierAlternative(f.engine);
      writeFileSync(join(f.repo, "greeting.txt"), "Hello from main\n");
      git(f.repo, "add", "greeting.txt");
      git(f.repo, "commit", "-q", "-m", "A greeting on main");
      f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
      await f.advance(() => f.fakes.received("code reviewer").some((entry) => entry.text.includes("Review only the port")), (role) => role !== "code reviewer");
      const port = f.fakes.received("code reviewer").find((entry) => entry.text.includes("Review only the port"))!;
      expect(f.model(port.session)).toBe("grok-4.7");
      expect(f.task().builderSession?.sessionId).toBe(original.sessionId);
      expect(f.fakes.received("builder").at(-1)).toEqual(expect.objectContaining({ session: original.sessionId, text: expect.stringContaining("Petrina is back with more work on this task") }));
      await f.advance(f.delivery);
      expect(f.task().timeline.find((entry) => entry.text.startsWith("Brought up to date with main"))?.profileId).toBe("sol-high");
    } finally { f.engine.shutdown(); }
  });

  for (const check of ["ready", "logged-out", "timeout"] as const) it(`recovers an active legacy Grok Builder when its startup check is ${check}`, async () => {
    const f = await fixture({ builder: "work" });
    const hold = join(f.root, "hold-check");
    try {
      f.engine.s.pool.limited = [{ toolId: "codex", until: later(), reason: "Codex is out" }];
      f.engine.setPoolPaused(false);
      // The fake marks itself working before Petrina hears the step. Wait until this conversation is briefed.
      await f.advance(() => {
        const task = f.task();
        const conversation = task.conversation;
        return !!conversation
          && f.fakes.marked("builder-working")
          && conversation.toolId === "grok"
          && conversation.briefed === true
          && task.timeline.some((entry) => entry.text === "Drafting the greeting" && entry.at >= conversation.startedAt);
      });
      const saved = f.engine.s.tasks.find((task) => task.id === f.task().id)!;
      const original = executionFor(saved).work.conversation!;
      expect(original.toolId).toBe("grok");
      expect(original.briefed).toBe(true);
      const startingRole = structuredClone(original.role!);
      const newInstructions = "Use the next Builder's updated instructions.";
      f.engine.saveRole("builder", { ...draftOf(startingRole), instructions: newInstructions });
      // The incident predates the planned-profile note. Codex is now Ready with 34% used.
      delete original.plannedProfileId;
      f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "codex");
      f.engine.s.pool.usage = [{ toolId: "codex", kind: "weekly", status: "allowed", utilization: 0.34, at: Date.now(), resetsAt: later() }];
      f.engine.s.setup!.checks = [{ id: "codex", status: "ready" }, { id: "grok", status: "unchecked" }, { id: "claude-code", status: "ready" }];
      const before = f.fakes.received("builder").length;
      if (check === "ready") writeFileSync(hold, "");
      await f.restart(check === "ready" ? `--hold-open=${hold}` : check === "logged-out" ? "--logged-out" : "--hang");
      expect(f.task().state).toBe("waiting");
      expect(f.task().holdsSlot).toBe(false);
      expect(f.task().statusLine).toBe("Checking Grok before the Builder returns");
      expect(f.task().conversation?.role).toEqual(startingRole);
      expect(f.fakes.received("builder")).toHaveLength(before);
      if (check === "ready") {
        await waitFor(() => existsSync(`${hold}.reached`), "Grok's short readiness check");
        expect(f.task().conversation?.sessionId).toBe(original.sessionId);
        rmSync(hold);
      }
      await f.advance(f.delivery);
      const last = f.fakes.received("builder").at(-1)!;
      expect(f.model(last.session)).toBe(check === "ready" ? "grok-4.7" : "gpt-6.1-sol");
      expect(last.session === original.sessionId).toBe(check === "ready");
      expect(existsSync(join(f.task().worktree!, "notes.txt"))).toBe(true);
      expect(f.engine.role("builder")?.instructions).toBe(newInstructions);
      expect(f.fakes.received("builder").every((entry) => !entry.text.includes(newInstructions))).toBe(true);
      if (check !== "ready") expect(last.text).toContain(startingRole.instructions);
      if (check === "ready") {
        expect(f.fakes.opens().filter((open) => open.session === original.sessionId).map((open) => open.how)).toEqual(["new", "resume"]);
        expect(f.task().timeline.some((entry) => entry.text === "Picked up where it left off")).toBe(true);
        expect(f.task().timeline.some((entry) => entry.text.includes("different tool or model"))).toBe(false);
      }
    } finally { rmSync(hold, { force: true }); f.engine.shutdown(); }
  });
});

describe("Builder continuity boundaries", () => {
  it("keeps usage, readiness, models, seats, pauses, plan changes and step-back rules", () => {
    const root = tempDir("petrina-builder-boundaries-");
    roots.push(root);
    const engine = new Engine(root, { agentCommand: () => ["unused"], toolPath: () => "/bin/true" });
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "product", name: "Product", repo: "a/b", tone: "blue", delivery: "local", approveDelivery: true });
    const id = engine.addTask({ productId: "product", title: "Build" });
    const task = engine.s.tasks.find((task) => task.id === id)!;
    task.stageIndex = 0;
    task.plan = { rationale: "Build", plannerProfileId: "opus-high", stages: [
      { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
      { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high", "grok-high"] },
    ] };
    task.fixing = true;
    executionFor(task).work.builderSession = { stageId: "build", profileId: "opus-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "saved" };
    engine.s.setup!.checks = ["claude-code", "codex", "grok"].map((id) => ({ id: id as "codex", status: "ready" }));
    engine.s.pool.paused = false;
    engine.s.pool.limit = 3;
    engine.s.pool.limited = [{ toolId: "claude-code", until: later(), reason: "Claude Code is out" }];
    roomierAlternative(engine);
    const snapshot = structuredClone({ task, pool: engine.s.pool, profiles: engine.s.profiles, checks: engine.s.setup!.checks });
    const reset = () => {
      Object.assign(task, structuredClone(snapshot.task));
      delete executionFor(task).work.conversation;
      engine.s.tasks = [task];
      engine.s.pool = structuredClone(snapshot.pool);
      engine.s.profiles = structuredClone(snapshot.profiles);
      engine.s.setup!.checks = structuredClone(snapshot.checks);
    };
    const choose = (planned = "opus-high", role = "builder") => engine.choose(planned, task, role, (toolId) => !slotWait(engine.getState(), { taskId: id, toolId }));
    const tool = () => { const choice = choose(); return choice?.kind === "none" ? "none" : choice?.profile.toolId; };
    try {
      expect(tool()).toBe("codex");
      engine.s.pool.usage = engine.s.pool.usage!.filter((entry) => entry.toolId !== "grok");
      expect(tool()).toBe("codex"); // Unknown Grok usage must not discard a healthy saved Codex.
      const handoffs: [string, () => void][] = [
        ["tool usage exhausted", () => { engine.s.pool.limited!.push({ toolId: "codex", until: later(), reason: "Codex is out" }); }],
        ["saved model exhausted", () => { engine.s.pool.limited!.push({ toolId: "codex", model: "sol", until: later(), reason: "Sol is out" }); }],
        ["90% near-limit mark", () => { engine.s.pool.usage![0]!.utilization = 0.9; }],
        ["usage warning", () => { engine.s.pool.usage![0]!.status = "allowed_warning"; }],
        ["no headroom on extra usage", () => { Object.assign(engine.s.pool.usage![0]!, { status: "rejected", overage: true }); }],
        ["logged out", () => { engine.s.setup!.checks[1]!.status = "logged-out"; }],
        ["not installed", () => { engine.s.setup!.checks[1]!.status = "not-installed"; }],
        ["unverified with Ready alternatives", () => { engine.s.setup!.checks[1]!.status = "unknown"; }],
        ["removed profiles", () => { engine.s.profiles = engine.s.profiles.filter((profile) => profile.toolId !== "codex"); }],
        ["different stage", () => { executionFor(task).work.builderSession!.stageId = "other"; }],
        ["changed plan effort", () => { executionFor(task).work.builderSession!.profileId = "opus-xhigh"; }],
        ["removed saved model", () => { executionFor(task).work.builderSession!.model = "removed-model"; }],
        ["fresh step-back round", () => { task.rounds["review"] = 4; }],
        ["new build", () => { task.fixing = false; }],
        ["no saved-tool capacity", () => { engine.s.pool.toolCaps["codex"] = 0; }],
      ];
      for (const [why, change] of handoffs) {
        reset(); change(); expect(tool(), why).toBe("grok");
      }
      reset();
      // A fallback build records who finished it, and still resumes for the profile the plan asked for.
      executionFor(task).work.builderSession = { stageId: "build", profileId: "sol-high", plannedProfileId: "opus-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "saved" };
      expect(tool()).toBe("codex");
      executionFor(task).work.builderSession!.plannedProfileId = "opus-xhigh";
      expect(tool()).toBe("grok");
      reset();
      expect(choose("grok-high")).toEqual(expect.objectContaining({ kind: "planned", profile: expect.objectContaining({ id: "grok-high" }) }));
      reset();
      executionFor(task).work.conversation = { step: stepKey(task), roleId: "builder", profileId: "sol-high", plannedProfileId: "opus-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "active", startedAt: Date.now(), briefed: true };
      expect(tool()).toBe("codex");
      executionFor(task).work.conversation!.plannedProfileId = "opus-xhigh";
      expect(tool()).toBe("grok");
      executionFor(task).work.conversation!.plannedProfileId = "opus-high";
      executionFor(task).work.conversation!.briefed = false;
      expect(tool()).toBe("grok");
      reset();
      engine.s.pool.usage![0]!.utilization = 0.8;
      engine.s.pool.toolCaps["codex"] = 2;
      engine.s.tasks.push({ ...structuredClone(task), id: "busy", state: "running", holdsSlot: true, agent: { roleId: "builder", profileId: "sol-high", since: Date.now(), step: 0 } });
      expect(slotUses(engine.getState())).toHaveLength(1);
      expect(tool()).toBe("grok"); // The existing 80% slowdown halves the cap.
      engine.s.pool.usage![0]!.utilization = 0.33;
      expect(tool()).toBe("codex"); // A seat is available again.
      engine.s.pool.toolCaps["codex"] = 1;
      expect(tool()).toBe("grok");
      // Both the saved fallback and the now-recovered planned tool are full: use free Grok.
      engine.s.pool.limited = [];
      engine.s.pool.toolCaps["claude-code"] = 1;
      engine.s.tasks.push({ ...structuredClone(task), id: "busy-claude", state: "running", holdsSlot: true, agent: { roleId: "builder", profileId: "opus-high", since: Date.now(), step: 0 } });
      expect(tool()).toBe("grok");
      engine.s.pool.limited = [{ toolId: "grok", until: later(), reason: "Grok is out" }];
      expect(tool()).toBe("claude-code"); // With no usable alternative, wait for capacity.
      reset(); engine.s.pool.paused = true;
      expect(slotWait(engine.getState(), { taskId: id, toolId: "codex" })).toBe("Waiting for the pool to resume");
      reset(); engine.s.pool.limit = 0;
      expect(slotWait(engine.getState(), { taskId: id, toolId: "codex" })).toBe("Waiting for a free slot");
      reset();
      expect(choose("opus-high", "release-manager")?.kind).toBe("substitute");
      expect(choose("opus-high", "release-manager")).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }) }));
    } finally { engine.shutdown(); }
  });
});
