// A review or vote member whose model is full rejoins its running group when its own wait ends, while a peer is
// still held mid-turn. Every wait is recorded as the engine sets it, then held until the test ends it.
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slotUses, type Task } from "@petrina/core";
import { Engine } from "./engine.js";
import type { NativeStep, Scenario } from "./fake-agent.js";
import { Fakes, FAKE_AGENT, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const SOL = "gpt-6.1-sol";
const ASTRA = "gpt-6-astra";
const GROK = "grok-4.7";
const SHORT = [5_000, 10_000, 30_000];
const LONG = 5 * 60_000;
/** Long enough that no real timer ends a held wait during a test. */
const HELD = 60 * 60_000;
const TOOLS = ["claude-code", "codex", "grok", "antigravity"] as const;

/** The first turn of this role on this model marks itself, then waits for release-<conversation>. */
const hold = (role: string, model: string): { role: string; model: string; steps: NativeStep[] } => ({
  role, model, steps: [{ mark: `held-${role.replaceAll(" ", "-")}-{session}` }, { wait: "release-{session}" }],
});

type Recorded = { profileId: string; modelId: string; waitMs: number; stored: boolean };

async function start(scenario: Scenario, options: { tools?: readonly string[]; before?: (engine: Engine) => void } = {}) {
  const root = tempDir("petrina-rejoin-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ builder: "plain", reopen: "resume", ...scenario });
  const data = join(root, "data");
  const settings = { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], toolPath: () => "/bin/true" };
  const recorded: Recorded[] = [];
  const waits: string[] = [];
  let engine!: Engine;
  let taskId = "";
  /** A controlled clock for the retry decisions: each model wait is checked as it is set, then held until ended. */
  const open = () => {
    engine = new Engine(data, settings);
    const tools = options.tools ?? ["claude-code", "codex"];
    engine.s.setup!.checks = TOOLS.map((id) => ({ id, status: tools.includes(id) ? "ready" as const : "logged-out" as const }));
    options.before?.(engine);
    const record = engine.recordModelCapacity.bind(engine);
    engine.recordModelCapacity = (task, roleId, profileId, error, waitMs) => {
      const before = Date.now();
      record(task, roleId, profileId, error, waitMs);
      const after = Date.now();
      const entry = task.modelCapacity!.find((item) => item.toolId === error.toolId && item.modelId === error.modelId)!;
      const wait = waitMs ?? LONG;
      recorded.push({ profileId, modelId: error.modelId, waitMs: wait, stored: entry.until >= before + wait && entry.until <= after + wait });
      entry.until = after + HELD;
    };
    const wait = engine.waitForUsage.bind(engine);
    engine.waitForUsage = (task, words) => {
      if (task.id === taskId) waits.push(words);
      wait(task, words);
    };
  };
  open();
  const productId = await engine.addProduct(makeProduct(root));
  engine.setProductDelivery(productId, "local", false);
  taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  const task = () => engine.s.tasks.find((entry) => entry.id === taskId)!;
  const answer = () => {
    for (const item of engine.getState().inbox) {
      if (item.taskId !== taskId) continue;
      if (item.kind === "plan" || item.kind === "design") engine.approve(item.id);
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
    }
  };
  const run = {
    data, fakes, productId, recorded, waits,
    get engine() { return engine; },
    get taskId() { return taskId; },
    task,
    answer,
    /** The model a conversation was opened on. */
    modelOf: (session: string) => fakes.settings(session).find((line) => line.startsWith("model="))?.slice("model=".length),
    /** Every prompt one conversation received, in order. */
    prompts: (role: string, session: string) => fakes.received(role).filter((entry) => entry.session === session),
    /** How a conversation was opened each time. */
    opens: (session: string) => fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how),
    /** The waits recorded for one profile, in order. */
    waitsOf: (profileId: string) => recorded.filter((entry) => entry.profileId === profileId),
    /** The conversations held mid-turn for this role. */
    held: (role: string) => readdirSync(fakes.dir).filter((name) => name.startsWith(`held-${role.replaceAll(" ", "-")}-`)).map((name) => name.slice(`held-${role.replaceAll(" ", "-")}-`.length)),
    release: (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go"),
    /** This model's held wait ends now, and the scheduler runs as the limit timer would. */
    endWait: (modelId: string) => {
      for (const entry of task().modelCapacity ?? []) if (entry.modelId === modelId) entry.until = Date.now() - 1;
      engine.schedule();
    },
    /** The member stopped on a full model while its group still runs, after `stops` recorded waits for this profile. */
    paused: (member: string, profileId: string, stops: number) => waitFor(() => {
      answer();
      const current = task();
      if (current.state === "failed") throw new Error(current.error);
      const group = engine.screenGroups.get(taskId);
      return recorded.filter((entry) => entry.profileId === profileId).length === stops && group && !group.running(member);
    }, `${member} to wait out its model beside its peers`, 60_000),
    done: () => waitFor(() => {
      answer();
      const current = engine.getState().tasks.find((entry) => entry.id === taskId) as Task;
      if (current.state === "failed") throw new Error(`The task failed: ${current.error}`);
      return current.state === "done" && current;
    }, "the task to finish", 60_000),
    restart: async () => {
      await engine.shutdown();
      open();
    },
  };
  return run;
}

type Run = Awaited<ReturnType<typeof start>>;

function expectShortContinues(prompts: readonly { text: string }[]) {
  for (const prompt of prompts) {
    expect(prompt.text.startsWith("The selected model was at capacity.")).toBe(true);
    expect(prompt.text).not.toContain("# Your job");
    expect(prompt.text).not.toContain("Petrina restarted");
  }
}

const roundOf = (task: Task) => task.rounds[task.plan!.stages.find((stage) => stage.kind === "review-chain")!.id] ?? 1;

/** The one conversation of this role that ran on this model. */
const sessionOn = (run: Run, role: string, model: string) => waitFor(() => run.fakes.received(role).find((entry) => run.modelOf(entry.session) === model)?.session, `the ${role} on ${model}`);

const heldOne = (run: Run, role: string) => waitFor(() => run.held(role)[0], `the ${role} to be held mid-turn`, 60_000);

describe.concurrent("a full model beside a working peer", () => {
  it("brings a reviewer back three times beside a held peer, in the same conversation, copy and inputs", async () => {
    const run = await start({ planner: "parallel", nativeRetry: [hold("code reviewer", "opus")], capacity: [{ model: SOL, role: "code reviewer", partial: true, times: 3 }] });
    try {
      await run.paused("review-1", "sol-high", 1);
      const opus = await heldOne(run, "code reviewer");
      const sol = await sessionOn(run, "code reviewer", SOL);
      const waiting = run.task();
      // The model wait is not a wait for a slot, and the task keeps working on its held peer.
      expect(waiting.state).toBe("running");
      expect(waiting.holdsSlot).toBe(true);
      expect(waiting.statusLine).not.toContain("waiting for a slot");
      const copy = join(run.data, "worktrees", run.productId, `${run.taskId}.copies`, "review-1");
      expect(existsSync(join(copy, "capacity-draft.txt"))).toBe(true);
      writeFileSync(join(copy, "kept-by-the-test.txt"), "kept\n");
      const input = structuredClone(waiting.hunt!.input);
      const pinned = waiting.hunt!.input!.heads[run.productId]!;
      // The rejoining member does not read the pull request again.
      let reads = 0;
      const sources = run.engine["sources"];
      const refresh = sources.refresh.bind(sources);
      sources.refresh = (...args: Parameters<typeof refresh>) => { reads += 1; return refresh(...args); };
      for (const stops of [2, 3]) {
        run.endWait(SOL);
        await run.paused("review-1", "sol-high", stops);
      }
      run.endWait(SOL);
      await waitFor(() => run.task().hunt?.reported["1"], "the reviewer back from its full model to report");
      expect(run.task().hunt?.reported["0"]).toBeUndefined();
      expect(run.fakes.marked(`release-${opus}`)).toBe(false);
      expect(run.waitsOf("sol-high").map((entry) => entry.waitMs)).toEqual(SHORT);
      expect(run.recorded.every((entry) => entry.stored)).toBe(true);
      const prompts = run.prompts("code reviewer", sol);
      expect(prompts).toHaveLength(4);
      expect(prompts[0]!.text).toContain("# Your job");
      expectShortContinues(prompts.slice(1));
      expect(run.opens(sol)).toEqual(["new", "resume", "resume", "resume"]);
      expect(existsSync(join(copy, "kept-by-the-test.txt"))).toBe(true);
      expect(git(copy, "rev-parse", "HEAD")).toBe(pinned);
      expect(run.task().hunt?.input).toEqual(input);
      expect(reads).toBe(0);
      run.release(opus);
      const task = await run.done();
      expect(roundOf(task)).toBe(1);
      expect(run.fakes.received("builder")).toHaveLength(1);
      expect(run.prompts("code reviewer", opus)).toHaveLength(1);
      expect(task.findings.filter((finding) => finding.raisedBy === "opus-high")).toHaveLength(1);
      const verdicts = run.engine.tracking.log.moments({ taskId: run.taskId, kinds: ["verdict"] });
      expect(verdicts.filter((entry) => entry.profileId === "opus-high")).toHaveLength(1);
      expect(verdicts.filter((entry) => entry.profileId === "sol-high")).toHaveLength(1);
      // Nobody ever left the task waiting for the full model.
      expect(run.waits).toEqual([]);
      expect(task.capacityResume).toBeUndefined();
    } finally { await run.engine.shutdown(); }
  });

  it("brings two reviewers back at their own times beside a held third, after a provider's longer delay, with a message for the one away", async () => {
    const run = await start({
      planner: "trio",
      nativeRetry: [hold("code reviewer", "opus")],
      capacity: [{ model: SOL, role: "code reviewer", thrown: true, retryAfterMs: 45_000 }, { model: GROK, role: "code reviewer", shape: "grok" }],
    }, { tools: ["claude-code", "codex", "grok"] });
    try {
      await run.paused("review-1", "sol-high", 1);
      await run.paused("review-2", "grok-xhigh", 1);
      const opus = await heldOne(run, "code reviewer");
      const [sol, grok] = await Promise.all([sessionOn(run, "code reviewer", SOL), sessionOn(run, "code reviewer", GROK)]);
      expect(run.waitsOf("sol-high").map((entry) => entry.waitMs)).toEqual([45_000]);
      expect(run.waitsOf("grok-xhigh").map((entry) => entry.waitMs)).toEqual([5_000]);
      run.endWait(GROK);
      await waitFor(() => run.task().hunt?.reported["2"], "the Grok reviewer to come back and report");
      // The provider asked for longer: scheduling passes while a peer works do not bring it back early.
      for (let pass = 0; pass < 3; pass++) {
        run.engine.schedule();
        expect(run.engine.screenGroups.get(run.taskId)?.running("review-1")).toBe(false);
      }
      expect(run.prompts("code reviewer", sol)).toHaveLength(1);
      const message = "Check the guest view too";
      run.engine.sendMessage(run.taskId, message);
      run.endWait(SOL);
      await waitFor(() => run.task().hunt?.reported["1"], "the Codex reviewer to come back and report");
      expect(run.fakes.marked(`release-${opus}`)).toBe(false);
      expect(run.task().hunt?.reported["0"]).toBeUndefined();
      run.release(opus);
      const task = await run.done();
      expect(roundOf(task)).toBe(1);
      for (const session of [sol, grok]) {
        const prompts = run.prompts("code reviewer", session);
        expect(prompts[0]!.text).toContain("# Your job");
        expectShortContinues(prompts.slice(1, 2));
        const opens = run.opens(session);
        expect(opens).toHaveLength(2);
        expect(opens[0]).toBe("new");
        expect(opens[1]).not.toBe("new");
      }
      const heard = (session: string) => run.prompts("code reviewer", session).filter((entry) => entry.text.includes(message)).length;
      // The reviewer that was away hears it once after it rejoins; the one that already reported never does.
      expect(heard(sol)).toBe(1);
      expect(heard(grok)).toBe(0);
      expect(heard(opus)).toBe(1);
      expect(run.prompts("code reviewer", grok)).toHaveLength(2);
      for (const profileId of ["opus-high", "sol-high", "grok-xhigh"]) expect(task.findings.filter((finding) => finding.raisedBy === profileId)).toHaveLength(1);
      expect(run.waits).toEqual([]);
    } finally { await run.engine.shutdown(); }
  });

  it("keeps a reviewer out while a peer waits for or uses the screen, and brings it back in its own conversation once the screen is settled", async () => {
    const run = await start({
      planner: "trio",
      nativeRetry: [hold("code reviewer", "opus")],
      capacity: [{ model: SOL, role: "code reviewer", times: 1 }],
      screenRoles: ["code reviewer"], screenModels: [GROK], screenRoleHold: true,
    }, { tools: ["claude-code", "codex", "grok"] });
    try {
      await run.paused("review-1", "sol-high", 1);
      const opus = await heldOne(run, "code reviewer");
      const [sol, grok] = await Promise.all([sessionOn(run, "code reviewer", SOL), sessionOn(run, "code reviewer", GROK)]);
      const group = run.engine.screenGroups.get(run.taskId)!;
      await waitFor(() => run.task().screen?.member === "review-2" && !run.task().screen?.granted && !group.running("review-2"), "the Grok reviewer to wait for the screen");
      run.endWait(SOL);
      expect(group.running("review-1")).toBe(false);
      run.engine.allowScreen(run.taskId);
      await waitFor(() => run.fakes.marked(`on-screen-${grok}`), "the Grok reviewer to use the screen");
      run.engine.schedule();
      expect(group.running("review-1")).toBe(false);
      expect(run.prompts("code reviewer", sol)).toHaveLength(1);
      writeFileSync(join(run.fakes.dir, `screen-release-${grok}`), "go");
      await waitFor(() => run.task().hunt?.reported["1"], "the paused reviewer to come back once the screen is settled");
      expect(run.task().hunt?.reported["2"]).toBe(true);
      expect(run.task().hunt?.reported["0"]).toBeUndefined();
      expect(run.fakes.marked(`release-${opus}`)).toBe(false);
      const prompts = run.prompts("code reviewer", sol);
      expect(prompts).toHaveLength(2);
      expectShortContinues(prompts.slice(1));
      expect(run.opens(sol)).toEqual(["new", "resume"]);
      expect(run.waitsOf("sol-high").map((entry) => entry.waitMs)).toEqual([5_000]);
      run.release(opus);
      const task = await run.done();
      expect(roundOf(task)).toBe(1);
      for (const profileId of ["opus-high", "sol-high", "grok-xhigh"]) expect(task.findings.filter((finding) => finding.raisedBy === profileId)).toHaveLength(1);
    } finally { await run.engine.shutdown(); }
  });

  for (const busy of [true, false]) it(`hands the seat to another tool after the short retries ${busy ? "once that tool's seat frees up" : "at once when it has a seat"}, beside a held peer`, async () => {
    // No other Codex model: after its short retries the Codex seat goes to Grok, the most independent tool left.
    const run = await start({ planner: "parallel", nativeRetry: [hold("code reviewer", "opus")], capacity: [{ model: SOL, role: "code reviewer", times: 4 }] }, {
      tools: ["claude-code", "codex", "grok"],
      before: (engine) => {
        engine.s.profiles = engine.s.profiles.filter((profile) => profile.toolId !== "codex" || profile.modelId === SOL);
        engine.setPoolLimit(4);
        engine.setToolCap("grok", 1);
      },
    });
    // Other work holds Grok's one seat, the way a background agent does.
    const other = { id: "other-work", roleId: "verifier", profileId: "grok-high", label: "Other work", since: Date.now() };
    if (busy) run.engine.s.backgroundAgents = [other];
    try {
      for (const stops of [1, 2, 3]) {
        await run.paused("review-1", "sol-high", stops);
        run.endWait(SOL);
      }
      const opus = await heldOne(run, "code reviewer");
      if (busy) {
        await run.paused("review-1", "sol-high", 4);
        const group = run.engine.screenGroups.get(run.taskId)!;
        // It stays ready to return, waiting only for Grok's seat, however often scheduling runs.
        expect(group.returning!()).toEqual([expect.objectContaining({ taskId: run.taskId, toolId: "grok" })]);
        run.engine.schedule();
        expect(group.running("review-1")).toBe(false);
        expect(run.fakes.received("code reviewer").some((entry) => run.modelOf(entry.session) === GROK)).toBe(false);
        // The other work ends and gives its seat back.
        run.engine.s.backgroundAgents = [];
        run.engine.schedule();
      }
      await waitFor(() => run.task().hunt?.reported["1"], "the seat's new tool to report");
      expect(run.fakes.marked(`release-${opus}`)).toBe(false);
      expect(run.task().hunt?.reported["0"]).toBeUndefined();
      expect(run.waitsOf("sol-high").map((entry) => entry.waitMs)).toEqual([...SHORT, LONG]);
      run.release(opus);
      const task = await run.done();
      expect(roundOf(task)).toBe(1);
      const reviewers = run.fakes.received("code reviewer");
      const sol = reviewers.filter((entry) => run.modelOf(entry.session) === SOL);
      expect(new Set(sol.map((entry) => entry.session)).size).toBe(1);
      expect(sol).toHaveLength(4);
      expectShortContinues(sol.slice(1));
      expect(reviewers.filter((entry) => run.modelOf(entry.session) === GROK)).toHaveLength(1);
      for (const toolId of ["claude-code", "grok"]) expect(task.findings.filter((finding) => run.engine.profile(finding.raisedBy)?.toolId === toolId)).toHaveLength(1);
      expect(run.waits).toEqual([]);
    } finally { await run.engine.shutdown(); }
  });

  it("gives a replacement model its own short retries inside the running group, and never starts the first model's over", async () => {
    const run = await start({ planner: "parallel", nativeRetry: [hold("code reviewer", "opus")], capacity: [{ model: SOL, role: "code reviewer", times: 4 }, { model: ASTRA, role: "code reviewer", times: 1 }] });
    try {
      for (const stops of [1, 2, 3]) {
        await run.paused("review-1", "sol-high", stops);
        run.endWait(SOL);
      }
      await run.paused("review-1", "astra-xhigh", 1);
      const opus = await heldOne(run, "code reviewer");
      expect(run.waitsOf("sol-high").map((entry) => entry.waitMs)).toEqual([...SHORT, LONG]);
      expect(run.waitsOf("astra-xhigh").map((entry) => entry.waitMs)).toEqual([5_000]);
      run.endWait(ASTRA);
      await waitFor(() => run.task().hunt?.reported["1"], "the replacement to continue and report");
      expect(run.fakes.marked(`release-${opus}`)).toBe(false);
      run.release(opus);
      const task = await run.done();
      expect(roundOf(task)).toBe(1);
      const reviewers = run.fakes.received("code reviewer");
      const sol = reviewers.filter((entry) => run.modelOf(entry.session) === SOL);
      const astra = reviewers.filter((entry) => run.modelOf(entry.session) === ASTRA);
      expect(new Set(sol.map((entry) => entry.session)).size).toBe(1);
      expect(sol).toHaveLength(4);
      expectShortContinues(sol.slice(1));
      expect(new Set(astra.map((entry) => entry.session)).size).toBe(1);
      expect(astra).toHaveLength(2);
      expect(astra[0]!.text).toContain("could not continue (the selected model is at capacity)");
      expectShortContinues(astra.slice(1));
      expect(run.opens(astra[0]!.session)).toEqual(["new", "resume"]);
      expect(run.waitsOf("sol-high")).toHaveLength(4);
      expect(task.findings.filter((finding) => finding.raisedBy === "opus-high")).toHaveLength(1);
      expect(run.waits).toEqual([]);
    } finally { await run.engine.shutdown(); }
  });

  it("keeps a verifier's own place on its tool through the five-minute wait beside a held partner", async () => {
    const run = await start({ planner: "short", reviewer: "important", verifier: "not-a-bug", nativeRetry: [hold("verifier", "opus")], capacity: [{ model: SOL, role: "verifier", times: 4 }] }, {
      before: (engine) => { engine.s.profiles = engine.s.profiles.filter((profile) => profile.modelId !== ASTRA); },
    });
    try {
      const place = await waitFor(() => run.task().hunt?.panel?.seats.find((seat) => seat.toolId === "codex"), "the verification panel");
      const member = `vote-${place.key}`;
      for (const stops of [1, 2, 3]) {
        await run.paused(member, "sol-high", stops);
        run.endWait(SOL);
      }
      await run.paused(member, "sol-high", 4);
      const opus = await heldOne(run, "verifier");
      const panel = structuredClone(run.task().hunt!.panel!);
      expect(run.waitsOf("sol-high").map((entry) => entry.waitMs)).toEqual([...SHORT, LONG]);
      run.endWait(SOL);
      await waitFor(() => run.task().hunt?.voted?.["sol-high"], "the verifier to continue and vote");
      expect(run.fakes.marked(`release-${opus}`)).toBe(false);
      expect(run.task().hunt?.panel).toEqual(panel);
      run.release(opus);
      const task = await run.done();
      expect(roundOf(task)).toBe(1);
      expect(panel.seats).toHaveLength(2);
      expect(panel.seats.some((seat) => seat.third)).toBe(false);
      const votes = task.findings.flatMap((finding) => finding.votes ?? []);
      expect(votes.filter((vote) => vote.toolId === "codex").map((vote) => vote.by)).toEqual(["sol-high"]);
      expect(votes.filter((vote) => vote.toolId === "claude-code").map((vote) => vote.by)).toEqual(["opus-high"]);
      const verifiers = run.fakes.received("verifier");
      const sol = verifiers.filter((entry) => run.modelOf(entry.session) === SOL);
      expect(new Set(sol.map((entry) => entry.session)).size).toBe(1);
      expect(sol).toHaveLength(5);
      expectShortContinues(sol.slice(1));
      expect(run.opens(sol[0]!.session)).toEqual(["new", "resume", "resume", "resume", "resume"]);
      expect(verifiers.filter((entry) => run.modelOf(entry.session) !== SOL).map((entry) => entry.session)).toEqual([opus]);
      expect(run.waits).toEqual([]);
    } finally { await run.engine.shutdown(); }
  });

  for (const busy of ["pool", "tool"] as const) {
    it(`waits for a free seat after the model wait when the ${busy === "pool" ? "pool" : "tool's cap"} is full, then takes the next one before queued work`, async () => {
      const run = await start({
        planner: "parallel",
        nativeRetry: [hold("code reviewer", SOL), hold("planner", "opus")],
        capacity: [{ model: "opus", role: "code reviewer", shape: "claude", times: 1 }],
      }, { before: (engine) => {
        if (busy === "pool") engine.setPoolLimit(2);
        else engine.setToolCap("claude-code", 1);
      } });
      const others: string[] = [];
      const planners = () => run.fakes.received("planner");
      const plannerOf = (title: string) => planners().find((entry) => entry.text.includes(title))?.session;
      // The busiest moment never goes past the pool or the tool's cap.
      let most = 0, mostClaude = 0;
      const unsubscribe = run.engine.subscribe(() => {
        const uses = slotUses(run.engine.activeState());
        most = Math.max(most, uses.length);
        mostClaude = Math.max(mostClaude, uses.filter((use) => use.toolId === "claude-code").length);
      });
      try {
        await waitFor(() => {
          const own = plannerOf("Add a greeting");
          if (own) run.release(own);
          return own;
        }, "the task's own planner");
        await run.paused("review-0", "opus-high", 1);
        const sol = await heldOne(run, "code reviewer");
        const opus = await sessionOn(run, "code reviewer", "opus");
        // Other work takes the seat the full model left.
        others.push(run.engine.addTask({ productId: run.productId, title: "Add a farewell", description: "[no-check]" }));
        const farewell = await waitFor(() => plannerOf("Add a farewell"), "another task's planner to take the free seat");
        await waitFor(() => run.held("planner").includes(farewell), "that planner to be held");
        if (busy === "pool") others.push(run.engine.addTask({ productId: run.productId, title: "Add a footer", description: "[no-check]" }));
        // The wait ends with no seat: nothing starts and nothing retries, however often scheduling runs.
        run.endWait("opus");
        for (let pass = 0; pass < 3; pass++) {
          run.engine.schedule();
          expect(run.engine.screenGroups.get(run.taskId)?.running("review-0")).toBe(false);
        }
        expect(run.prompts("code reviewer", opus)).toHaveLength(1);
        expect(run.waitsOf("opus-high")).toHaveLength(1);
        if (busy === "pool") expect(run.engine.getState().tasks.find((task) => task.id === others[1])!.state).toBe("queued");
        // The other work ends: its plan waits for the coordinator, which frees its seat.
        run.release(farewell);
        await waitFor(() => run.prompts("code reviewer", opus).length === 2, "the reviewer to take the freed seat");
        const order = run.fakes.received().map((entry) => entry.session);
        const footer = plannerOf("Add a footer");
        if (footer) expect(order.indexOf(footer)).toBeGreaterThan(order.lastIndexOf(opus));
        expectShortContinues(run.prompts("code reviewer", opus).slice(1));
        expect(run.opens(opus)).toEqual(["new", "resume"]);
        await waitFor(() => run.task().hunt?.reported["0"], "the reviewer to report");
        expect(run.fakes.marked(`release-${sol}`)).toBe(false);
        run.release(sol);
        await run.done();
        if (busy === "pool") expect(most).toBeLessThanOrEqual(2);
        else expect(mostClaude).toBeLessThanOrEqual(1);
        expect(run.waits).toEqual([]);
      } finally {
        unsubscribe();
        for (const id of others) run.engine.cancel(id);
        await run.engine.shutdown();
      }
    });
  }
});

describe.concurrent("a full model when the group stops or ends", () => {
  it("shows the capacity wait once every peer finished first, waits out a paused pool, then continues the same conversation", async () => {
    const run = await start({ planner: "parallel", nativeRetry: [hold("code reviewer", "opus")], capacity: [{ model: SOL, role: "code reviewer", times: 1 }] });
    try {
      await run.paused("review-1", "sol-high", 1);
      const opus = await heldOne(run, "code reviewer");
      run.release(opus);
      const waiting = await waitFor(() => {
        const task = run.task();
        return task.state === "waiting" && !run.engine.drivers.has(run.taskId) && !run.engine.settling.has(run.taskId) && task;
      }, "the task to wait for the full model after its peer reported");
      expect(waiting.statusLine.startsWith("The selected model is at capacity")).toBe(true);
      expect(waiting.holdsSlot).toBe(false);
      expect(waiting.hunt?.reported).toEqual({ "0": true });
      run.engine.setPoolPaused(true);
      run.endWait(SOL);
      expect(run.engine.drivers.has(run.taskId)).toBe(false);
      const sol = await sessionOn(run, "code reviewer", SOL);
      expect(run.prompts("code reviewer", sol)).toHaveLength(1);
      run.engine.setPoolPaused(false);
      const task = await run.done();
      expect(roundOf(task)).toBe(1);
      const prompts = run.prompts("code reviewer", sol);
      expect(prompts).toHaveLength(2);
      expectShortContinues(prompts.slice(1));
      expect(run.opens(sol)).toEqual(["new", "resume"]);
      expect(run.waitsOf("sol-high").map((entry) => entry.waitMs)).toEqual([5_000]);
      // Only the group's end, and the step it ended, showed the full model's wait.
      expect(run.waits.length).toBeGreaterThan(0);
      expect(run.waits.every((words) => words.startsWith("The selected model is at capacity"))).toBe(true);
      expect(run.prompts("code reviewer", opus)).toHaveLength(1);
    } finally { await run.engine.shutdown(); }
  });

  it("brings nobody back after the task is cancelled, and removes the working copies", async () => {
    const run = await start({ planner: "parallel", nativeRetry: [hold("code reviewer", "opus")], capacity: [{ model: SOL, role: "code reviewer", times: 1 }] });
    try {
      await run.paused("review-1", "sol-high", 1);
      await heldOne(run, "code reviewer");
      const sol = await sessionOn(run, "code reviewer", SOL);
      const copies = join(run.data, "worktrees", run.productId, `${run.taskId}.copies`);
      expect(existsSync(join(copies, "review-1"))).toBe(true);
      run.engine.cancel(run.taskId);
      run.endWait(SOL);
      await waitFor(() => !run.engine.settling.has(run.taskId) && !run.engine.screenGroups.has(run.taskId), "the cancelled group to settle");
      run.engine.schedule();
      expect(run.prompts("code reviewer", sol)).toHaveLength(1);
      expect(run.engine.getState().tasks.find((task) => task.id === run.taskId)?.state ?? "cancelled").toBe("cancelled");
      await waitFor(() => !existsSync(join(copies, "review-1")) && !existsSync(join(copies, "review-0")), "the reviewers' copies to be removed");
    } finally { await run.engine.shutdown(); }
  });

  it("brings nobody back while draining, then reopens the same conversation after a restart on the remaining schedule", async () => {
    const run = await start({ planner: "parallel", nativeRetry: [hold("code reviewer", "opus")], capacity: [{ model: SOL, role: "code reviewer", times: 2 }] });
    try {
      await run.paused("review-1", "sol-high", 1);
      const opus = await heldOne(run, "code reviewer");
      const sol = await sessionOn(run, "code reviewer", SOL);
      const drained = run.engine.drain(60_000);
      run.endWait(SOL);
      expect(run.engine.screenGroups.get(run.taskId)?.running("review-1")).toBe(false);
      run.release(opus);
      expect(await drained).toBe(0);
      expect(run.prompts("code reviewer", sol)).toHaveLength(1);
      expect(run.task().hunt?.reported).toEqual({ "0": true });
      await run.restart();
      // After the restart the member runs alone, so its next wait is the task's.
      await waitFor(() => run.waitsOf("sol-high").length === 2 && run.task().state === "waiting" && !run.engine.drivers.has(run.taskId) && !run.engine.settling.has(run.taskId), "the next short wait after the restart");
      expect(run.waitsOf("sol-high").map((entry) => entry.waitMs)).toEqual([5_000, 10_000]);
      run.endWait(SOL);
      const task = await run.done();
      expect(roundOf(task)).toBe(1);
      const prompts = run.prompts("code reviewer", sol);
      expect(prompts).toHaveLength(3);
      expectShortContinues(prompts.slice(1));
      expect(run.opens(sol)).toEqual(["new", "resume", "resume"]);
      expect(run.prompts("code reviewer", opus)).toHaveLength(1);
    } finally { await run.engine.shutdown(); }
  });
});
