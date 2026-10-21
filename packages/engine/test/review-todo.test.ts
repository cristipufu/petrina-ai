import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mainLine, nextLine, timeLeft, workedSoFar, type State, type Task } from "@petrina/core";
import { Store } from "../src/store.js";
import { ADAPTERS } from "../src/tools.js";
import { EngineProcess, Fakes, removeDir, tempDir, makeProduct, waitFor, git } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const MINUTE = 60_000;
const models = ["opus-high", "gpt-6.1-sol-high"];

async function setup(role: "code-reviewer" | "security-reviewer" = "code-reviewer", important = false) {
  const root = tempDir("petrina-group-summary-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", reviewTodo: true, ...(role === "security-reviewer" ? { risk: "high" } : {}), ...(important ? { reviewer: "important" } : {}) });
  const home = join(root, "home");
  const clock = join(root, "clock"); writeFileSync(clock, "0");
  const launch = async () => {
    const engine = await EngineProcess.start(home, [join(import.meta.dir, "clock-harness.ts"), home, fakes.dir, clock]);
    await engine.until(state => Object.keys(ADAPTERS).every(id => state.tools.some(tool => tool.id === id && tool.status === "ready") && state.setup?.checks.some(check => check.id === id && check.status === "ready" && !check.checking)), "every review tool to be ready");
    return engine;
  };
  const engine = await launch();
  await engine.act("setPoolLimit", Object.keys(ADAPTERS).length);
  const productId = await engine.act("addProduct", makeProduct(root));
  await engine.act("setProductDelivery", productId, "local", true);
  const taskId = await engine.act("addTask", { productId, title: "Check the greeting", approvePlan: true });
  const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
  const planned = await engine.until((state) => state.inbox.some((item) => item.kind === "plan"), "the plan check");
  const stage = find(planned).plan!.stages.find((entry) => entry.roleId === role && entry.kind === "review-chain")!;
  await engine.act("addReviewer", taskId, stage.id, role === "security-reviewer" ? "opus-high" : "sol-high");
  const go = (name: string) => writeFileSync(join(fakes.dir, name), "go");
  // The security case first passes the single code reviewer.
  if (role === "security-reviewer") for (const name of ["publish-1", "action-1", "result-1", "finish"]) go(`${name}-code-reviewer-opus-high`);
  const approve = () => engine.act("approve", planned.inbox.find((item) => item.kind === "plan")!.id);
  const ready = (tag: string, attempt = 1) => waitFor(() => fakes.marked(`summary-ready-${tag}-${attempt}`), `${tag} to start attempt ${attempt}`);
  const advance = (minutes: number) => writeFileSync(clock, String(minutes * MINUTE));
  return { engine, fakes, home, launch, find, taskId, role, stage, go, approve, ready, advance };
}

describe("real grouped review summaries", () => {
  for (const [role, kind, todo] of [
    ["code-reviewer", "question", "Checking the greeting"],
    ["security-reviewer", "permission", "Checking access to the greeting"],
  ] as const) {
    it(`keeps ${role} items through actions and saves individual working times without ${kind} waits`, async () => {
      const run = await setup(role);
      const { engine, find, go } = run;
      try {
        await run.approve();
        const reserved = await engine.until((state) => {
          const task = find(state);
          return task.hunt?.stageId === run.stage.id && [task.agent, ...(task.helpers ?? [])].filter((agent) => agent?.roleId === role).length === 2;
        }, "both reviewers to have their seats");
        const tags = [find(reserved).agent!, ...find(reserved).helpers!].map((agent) => {
          const profile = reserved.profiles.find((profile) => profile.id === agent.profileId)!;
          return `${role}-${profile.modelId}-${profile.effort}`;
        });
        await Promise.all(tags.map((tag) => run.ready(tag)));
        for (const tag of tags) go(`publish-1-${tag}`);
        const started = find(await engine.until((state) => Object.values(find(state).hunt?.work ?? {}).every((work) => work.todo === todo), "both to-do lists"));
        expect(mainLine(started)).toBe(todo);
        const first = started.agent!.profileId;
        for (const tag of tags) go(`action-1-${tag}`);
        const state = await engine.until((state) => Object.values(find(state).hunt?.work ?? {}).every((work) => work.activity === "Continuing work"), "both read actions");
        const working = find(state);
        expect(mainLine(working)).toBe(todo);
        expect(working.statusLine).toBe("Continuing work");
        expect(Object.values(working.hunt!.work!).every(work => work.toolActivity?.actionCount === 1 && work.toolActivity.lastActivity === "Reading the code" && !work.toolActivity.runningTool)).toBe(true);
        const toolStep = working.journey!.find(step => Object.keys(step.toolActivity ?? {}).length === 2)!;
        expect(new Set(toolStep.toolInvocations!.map(call => call.seat)).size).toBe(2);
        expect(working.agent!.profileId).toBe(first);
        expect(timeLeft(state, working)).toBeUndefined();
        const history = (count: number): State => ({ ...state, tasks: [...state.tasks, { ...working, id: "history", steps: Array.from({ length: count }, (_, at) => ({ roleId: role, repeat: false, worked: 60 * MINUTE, at })) }] });
        expect(timeLeft(history(2), working)).toBeUndefined();
        expect(timeLeft(history(3), working)).toBe("About an hour left");

        run.advance(4);
        for (const tag of tags) go(`ask-${kind}-${tag}`);
        go(`result-1-${tags[0]}`);
        const oneAsked = await engine.until((state) => state.inbox.filter((item) => item.kind === kind).length === 1, "one agent waiting while the other works");
        expect(Object.values(find(oneAsked).hunt!.work!).filter((work) => work.clock?.since !== undefined)).toHaveLength(1);
        run.advance(5);
        go(`result-1-${tags[1]}`);
        const asked = await engine.until((state) => state.inbox.filter((item) => item.kind === kind).length === 2, "both agents waiting on you");
        const waiting = find(asked);
        expect(waiting.stepClock!.since).toBeUndefined();
        expect(Object.values(waiting.hunt!.work!).every((work) => work.clock?.since === undefined)).toBe(true);
        expect(waiting.todo).toBe(todo);
        expect(mainLine(waiting)).toBe(kind === "question" ? "Waiting for your answer" : "Waiting for your permission");
        const worked = workedSoFar(waiting.stepClock!, asked.now);
        run.advance(25);
        const later = await engine.state();
        expect(workedSoFar(find(later).stepClock!, later.now)).toBe(worked);
        expect(timeLeft(history(3), waiting)).toBeUndefined();

        const requests = asked.inbox.filter((item) => item.kind === kind);
        const answer = (id: string) => kind === "question" ? engine.act("answer", id, "Yes") : engine.act("allow", id, "once");
        await answer(requests[0]!.id);
        const oneWaiting = find(await engine.state());
        expect(oneWaiting.state).toBe("needs-you");
        expect(oneWaiting.agent!.profileId).toBe(requests[1]!.profileId!);
        expect(oneWaiting.stepClock!.since).toBeUndefined();
        expect(Object.values(oneWaiting.hunt!.work!).filter((work) => work.clock?.since !== undefined)).toHaveLength(1);
        run.advance(28);
        // Both may now finish, but the second agent's extra wait still does not count.
        await answer(requests[1]!.id);
        for (const tag of tags) go(`finish-${tag}`);
        const done = find(await engine.until((state) => state.inbox.some((item) => item.kind === "delivery"), "the delivery check"));
        const records = done.steps!.filter((entry) => entry.roleId === role);
        expect(records).toHaveLength(2);
        expect(records.every((entry) => !entry.repeat && entry.worked >= 4 * MINUTE && entry.worked < 9 * MINUTE)).toBe(true);
        expect(done.todo).toBeUndefined();
        expect(done.stepClock).toBeUndefined();
        await engine.quit();
        const store = new Store(join(run.home, "petrina.db"));
        try { expect(find(store.load()!).steps).toEqual(done.steps); } finally { store.close(); }
      } finally { if (engine.proc.exitCode === null) await engine.quit(); }
    });
  }

  it("keeps unfinished work through a restart, excludes it from history, and skips reported reviewers in Next after a pause", async () => {
    const run = await setup();
    let engine = run.engine;
    const tags = models.map((model) => `code-reviewer-${model}`);
    try {
      await run.approve();
      await Promise.all(tags.map((tag) => run.ready(tag)));
      for (const tag of tags) { run.go(`publish-1-${tag}`); run.go(`action-1-${tag}`); }
      await engine.until((state) => Object.values(run.find(state).hunt?.work ?? {}).every((work) => work.activity === "Continuing work"), "the review actions");
      run.advance(5);
      run.go(`result-1-${tags[1]}`); run.go(`finish-${tags[1]}`);
      const partial = await engine.until((state) => !!run.find(state).hunt?.reported["1"], "the second reviewer to finish");
      expect(run.find(partial).steps!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
      await engine.act("setPoolPaused", true);
      await engine.act("sendMessage", run.taskId, "Check the guest view too", "queue");
      await engine.kill();
      run.advance(6 * 60);
      engine = await run.launch();
      const recovered = await engine.state();
      expect(run.find(recovered).todo).toBe("Checking the greeting");
      expect(run.find(recovered).stepClock!.worked).toBeGreaterThanOrEqual(5 * MINUTE);
      expect(run.find(recovered).stepClock!.worked).toBeLessThan(6 * MINUTE);
      expect(nextLine(recovered, run.find(recovered))).toBe("Next: code review (Claude Code · Opus 5.5), then your OK to ship");
      await engine.act("setPoolPaused", false);
      await run.ready(tags[0]!, 2);
      expect(run.find(await engine.until((state) => run.find(state).todo === "Checking the greeting", "the reopened reviewer summary")).todo).toBe("Checking the greeting");
      // Pausing clears the item, but the saved result still keeps the other reviewer out of Next.
      await engine.act("pause", run.taskId);
      const paused = await engine.state();
      expect(run.find(paused).todo).toBeUndefined();
      expect(nextLine(paused, run.find(paused))).toBe("Next: code review (Claude Code · Opus 5.5), then your OK to ship");
      await engine.act("resume", run.taskId);
      await run.ready(tags[0]!, 3);
      for (const name of ["publish-3", "action-3", "result-3", "finish"]) run.go(`${name}-${tags[0]}`);
      const done = run.find(await engine.until((state) => state.inbox.some((item) => item.kind === "delivery"), "the delivery check"));
      expect(done.steps!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
      expect(run.fakes.openings("code reviewer")).toHaveLength(4);
    } finally { await engine.quit(); }
  });

  for (const role of ["code-reviewer", "security-reviewer"] as const) {
    it(`keeps a ${role}'s clock stopped until both permission requests are answered`, async () => {
      const run = await setup(role);
      const { engine, find, go } = run;
      try {
        await run.approve();
        const reserved = await engine.until((state) => find(state).hunt?.stageId === run.stage.id && [find(state).agent, ...(find(state).helpers ?? [])].filter((agent) => agent?.roleId === role).length === 2, "both review seats");
        const tags = [find(reserved).agent!, ...find(reserved).helpers!]
          .sort((a, b) => a.reviewKey!.localeCompare(b.reviewKey!))
          .map((agent) => {
            const profile = reserved.profiles.find((profile) => profile.id === agent.profileId)!;
            return `${role}-${profile.modelId}-${profile.effort}`;
          });
        await Promise.all(tags.map((tag) => run.ready(tag)));
        for (const tag of tags) { go(`publish-1-${tag}`); go(`action-1-${tag}`); }
        await engine.until((state) => Object.values(find(state).hunt!.work!).every((work) => work.activity === "Continuing work"), "both review actions");
        run.advance(4);
        go(`ask-permission-${tags[0]}`); go(`ask-permission-twice-${tags[0]}`); go(`result-1-${tags[0]}`);
        const asked = await engine.until((state) => state.inbox.filter((item) => item.kind === "permission").length === 2, "both requests from one reviewer");
        const requests = asked.inbox.filter((item) => item.kind === "permission");
        expect(requests.every((item) => item.reviewKey === "reviewer:0")).toBe(true);
        const before = workedSoFar(find(asked).hunt!.work!["reviewer:0"]!.clock!, asked.now);
        run.advance(25);
        await engine.act("allow", requests[0]!.id, "once");
        run.advance(40);
        const waiting = await engine.state();
        const work = find(waiting).hunt!.work!["reviewer:0"]!;
        expect(find(waiting).state).toBe("needs-you");
        expect(work.waiting).toBe("Waiting for your permission");
        expect(work.clock!.since).toBeUndefined();
        expect(workedSoFar(work.clock!, waiting.now)).toBe(before);
        expect(find(waiting).hunt!.work!["reviewer:1"]!.clock!.since).toBeDefined();
        expect(mainLine(find(waiting))).toBe("Waiting for your permission");
        expect(timeLeft(waiting, find(waiting))).toBeUndefined();
        // Denial also settles only its own request; it resumes work when it is the last one.
        await engine.act("deny", requests[1]!.id);
        const resumed = find(await engine.state());
        expect(resumed.hunt!.work!["reviewer:0"]!.clock!.since).toBeDefined();
        expect(resumed.hunt!.work!["reviewer:0"]!.waiting).toBeUndefined();
        for (const tag of tags) { go(`result-1-${tag}`); go(`finish-${tag}`); }
        const done = find(await engine.until((state) => state.inbox.some((item) => item.kind === "delivery"), "the delivery check"));
        const records = done.steps!.filter((step) => step.roleId === role);
        expect(records).toHaveLength(2);
        expect(Math.min(...records.map((step) => step.worked))).toBeGreaterThanOrEqual(4 * MINUTE);
        expect(Math.min(...records.map((step) => step.worked))).toBeLessThan(5 * MINUTE);
      } finally { await engine.quit(); }
    });
  }

  it("records a single port reviewer even when the stage plans two profiles", async () => {
    const run = await setup();
    let engine = run.engine;
    try {
      await engine.act("setPoolPaused", true);
      await run.approve();
      await engine.quit();
      // A saved port, ready for its one review, on a stage that normally has two reviewers.
      const store = new Store(join(run.home, "petrina.db"));
      try {
        const state = store.load()!;
        const task = run.find(state);
        const product = state.products.find((entry) => entry.id === task.productId)!;
        const baseSha = task.baseSha ?? git(product.path!, "rev-parse", "HEAD").trim();
        // This test starts at the review boundary: seed a valid working copy and already-approved checks,
        // so it measures the one port reviewer rather than setup, checkout or Check finder work.
        store.save({
          ...state,
          products: state.products.map((entry) => entry.id === product.id ? { ...entry, checksBy: "coordinator", checks: [] } : entry),
          tasks: state.tasks.map((entry): Task => entry.id !== task.id ? entry : { ...task, stageIndex: task.plan!.stages.findIndex((stage) => stage.id === run.stage.id), worktree: product.path, baseSha, base: baseSha, branch: task.branch ?? "petrina/port-review-test", reviewedTree: "reviewed", portReview: { from: baseSha, head: baseSha, onto: baseSha, files: ["greeting.txt"] } }),
        });
      } finally { store.close(); }
      engine = await run.launch();
      await engine.act("setPoolPaused", false);
      const tag = "code-reviewer-opus-high";
      await run.ready(tag);
      run.go(`publish-1-${tag}`); run.go(`action-1-${tag}`);
      const working = await engine.until((state) => run.find(state).statusLine === "Continuing work", "the port review action");
      expect(mainLine(run.find(working))).toBe("Checking the greeting");
      expect(run.find(working).stepClock!.roleId).toBe("code-reviewer");
      run.advance(8);
      run.go(`result-1-${tag}`); run.go(`finish-${tag}`);
      const done = run.find(await engine.until((state) => state.inbox.some((item) => item.kind === "delivery"), "the port's delivery check"));
      expect(done.steps!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
      expect(run.fakes.openings("code reviewer")).toHaveLength(1);
    } finally { await engine.quit(); }
  });

  it("shows voters' to-do items and records each completed vote", async () => {
    const run = await setup("code-reviewer", true);
    const { engine } = run;
    try {
      await run.approve();
      for (const model of models) for (const name of ["publish-1", "action-1", "result-1", "finish"]) run.go(`${name}-code-reviewer-${model}`);
      const voting = await engine.until((state) => run.find(state).agent?.roleId === "verifier" && Object.keys(run.find(state).hunt?.work ?? {}).filter(key => key.startsWith("verifier:")).length === Object.keys(ADAPTERS).length, "every fresh voter");
      const voters = [run.find(voting).agent!, ...(run.find(voting).helpers ?? [])].map((agent) => {
        const profile = voting.profiles.find((profile) => profile.id === agent.profileId)!;
        return { seat: agent.reviewKey!, tag: `verifier-${profile.modelId}-${profile.effort}` };
      });
      const tags = voters.map(voter => voter.tag);
      await Promise.all(tags.map((tag) => run.ready(tag)));
      for (const tag of tags) run.go(`publish-1-${tag}`);
      for (const tag of tags.slice(0, -1)) run.go(`action-1-${tag}`);
      const hasAction = (state: State, seat: string) => {
        const work = run.find(state).hunt?.work?.[seat];
        return work?.todo === "Checking the reported problem" && work.toolActivity?.lastActivity === "Reading the code";
      };
      // The displayed voter can be ready while a peer is still waiting to act.
      // Hold that peer explicitly so this cannot rely on simultaneous delivery.
      const early = await engine.until(state => voters.slice(0, -1).every(voter => hasAction(state, voter.seat)), "the released voters' activity");
      expect(run.find(early).todo).toBe("Checking the reported problem");
      expect(run.find(early).statusLine).toBe("Continuing work");
      const last = voters.at(-1)!;
      expect(run.find(early).hunt!.work![last.seat]!.toolActivity).toBeUndefined();
      run.go(`action-1-${last.tag}`);
      const acting = await engine.until(state => voters.every(voter => hasAction(state, voter.seat)), "every voter's item and action");
      expect(timeLeft(acting, run.find(acting))).toBeUndefined();
      expect(Object.values(run.find(acting).hunt!.work!).filter(work => work.toolActivity?.lastActivity === "Reading the code")).toHaveLength(voters.length);
      for (const voter of voters) {
        const activity = run.find(acting).hunt!.work![voter.seat]!.toolActivity!;
        expect(activity.actionCount).toBe(1);
        expect(activity.runningTool).toBeUndefined();
      }
      for (const tag of tags) { run.go(`result-1-${tag}`); run.go(`finish-${tag}`); }
      const done = run.find(await engine.until((state) => state.inbox.some((item) => item.kind === "delivery"), "the delivery check"));
      expect(done.steps!.filter((step) => step.roleId === "verifier")).toHaveLength(voters.length);
      expect(done.todo).toBeUndefined();
    } finally { await engine.quit(); }
  });

  for (const savedBy of ["opus-high", "sol-high"]) {
    it(`keeps an older vote credited to ${savedBy} when the remaining voter finishes after a restart`, async () => {
      const run = await setup("code-reviewer", true);
      let engine = run.engine;
      const savedVote = { by: savedBy, verdict: "real" as const, reason: "The greeting is missing." };
      try {
        await engine.act("setPoolPaused", true);
        await run.approve();
        await engine.quit();
        // The previous engine saved the replacement's actual profile, without a planned slot.
        // Older planned attribution also remains valid, without guessing who actually ran it.
        const store = new Store(join(run.home, "petrina.db"));
        try {
          const state = store.load()!;
          store.save({
            ...state,
            tasks: state.tasks.map((task): Task => task.id !== run.taskId ? task : {
              ...task,
              stageIndex: task.plan!.stages.findIndex((stage) => stage.id === run.stage.id),
              hunt: { stageId: run.stage.id, round: 1, reported: { "0": true, "1": true }, voted: { "sol-high": true }, findings: 0 },
              findings: [{ id: "saved-finding", text: "The greeting is missing.", severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "open", votes: [savedVote] }],
            }),
          });
        } finally { store.close(); }
        run.fakes.scenario({ planner: "short", builder: "plain", reviewTodo: true });
        engine = await run.launch();
        expect(run.find(await engine.state()).hunt?.voterProfiles).toBeUndefined();
        await engine.act("setPoolPaused", false);
        const reserved = await engine.until((state) => {
          // An older vote without a tool does not fill a seat, so every ready tool still votes.
          const count = state.tools.filter((tool) => tool.status === "ready").length;
          const seats = Object.keys(run.find(state).hunt?.work ?? {}).filter((key) => key.startsWith("verifier:")).length;
          return count > 0 && seats === count;
        }, "the remaining voters' seats");
        const tags = [run.find(reserved).agent!, ...(run.find(reserved).helpers ?? [])].map((agent) => {
          const profile = reserved.profiles.find((profile) => profile.id === agent.profileId)!;
          return `verifier-${profile.modelId}-${profile.effort}`;
        });
        await Promise.all(tags.map((tag) => run.ready(tag)));
        for (const tag of tags) for (const name of ["publish-1", "action-1", "result-1", "finish"]) run.go(`${name}-${tag}`);
        const voted = run.find(await engine.until((state) => !!run.find(state).findings[0]?.verification, "the saved finding's verdict"));
        const finding = voted.findings[0]!;
        expect(finding.votes).toHaveLength(1 + tags.length);
        expect(finding.votes![0]).toEqual(savedVote);
        expect(finding.votes!.some((vote) => vote.by === "opus-high" && vote.plannedProfileId === "opus-high")).toBe(true);
        expect(finding.votes!.slice(1).every((vote) => vote.plannedProfileId && vote.verdict === "real")).toBe(true);
        expect(finding.verification!.verdict).toBe("real");
        expect(finding.status).not.toBe("dismissed");
        await engine.quit();
        const saved = new Store(join(run.home, "petrina.db"));
        try { expect(run.find(saved.load()!).findings[0]!.votes).toEqual(finding.votes); } finally { saved.close(); }
      } finally { if (engine.proc.exitCode === null) await engine.quit(); }
    });
  }

  it("credits a grouped review's replacement and excludes the handed-over step from timing history", async () => {
    const run = await setup();
    run.fakes.scenario({ planner: "short", builder: "plain", reviewTodo: true, learnings: true, limited: [{ model: "opus", role: "code reviewer", type: "seven_day_opus" }] });
    const { engine } = run;
    try {
      await run.approve();
      const tags = ["code-reviewer-sonnet-high", "code-reviewer-gpt-6.1-sol-high"];
      await Promise.all(tags.map((tag) => run.ready(tag)));
      for (const tag of tags) { run.go(`publish-1-${tag}`); run.go(`action-1-${tag}`); }
      const acting = await engine.until((state) => Object.values(run.find(state).hunt?.work ?? {}).every((work) => work.activity === "Continuing work"), "the replacement reviewer's to-do and action");
      const task = run.find(acting);
      const replacement = [task.agent!, ...(task.helpers ?? [])].find((agent) => agent.reviewKey === "reviewer:0")!;
      expect(acting.profiles.find((profile) => profile.id === replacement.profileId)!.modelId).toBe("sonnet");
      expect(task.hunt!.work!["reviewer:0"]!.attempts).toBe(2);
      expect(mainLine(task)).toBe("Checking the greeting");
      run.go(`result-1-${tags[0]}`); run.go(`finish-${tags[0]}`);
      const reported = run.find(await engine.until((state) => !!run.find(state).hunt?.reported["0"], "the replacement's result"));
      expect(reported.lessons!.some((lesson) => lesson.roleId === "code-reviewer" && lesson.profileId === replacement.profileId)).toBe(true);
      run.go(`result-1-${tags[1]}`); run.go(`finish-${tags[1]}`);
      const done = run.find(await engine.until((state) => state.inbox.some((item) => item.kind === "delivery"), "the delivery check"));
      expect(done.timeline.some((entry) => entry.roleId === "code-reviewer" && entry.tone === "done" && entry.profileId === replacement.profileId)).toBe(true);
      expect(done.steps!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
    } finally { await engine.quit(); }
  });

  it("stops an out-of-usage member's clock while a peer keeps working", async () => {
    const run = await setup();
    const { engine } = run;
    const tags = models.map((model) => `code-reviewer-${model}`);
    try {
      await run.approve();
      await Promise.all(tags.map((tag) => run.ready(tag)));
      for (const tag of tags) { run.go(`publish-1-${tag}`); run.go(`action-1-${tag}`); }
      await engine.until((state) => Object.values(run.find(state).hunt!.work!).every((work) => work.activity === "Continuing work"), "both reviewers at work");
      run.advance(4);
      run.go(`ask-question-${tags[1]}`); run.go(`result-1-${tags[1]}`);
      const asked = await engine.until((state) => state.inbox.some((item) => item.kind === "question"), "the second reviewer's question");
      // Running agents may finish, but no stand-in may start while the pool is paused.
      await engine.act("setPoolPaused", true);
      run.fakes.scenario({ planner: "short", builder: "plain", reviewTodo: true, limited: [{ model: "gpt-6.1-sol", role: "code reviewer" }] });
      await engine.act("answer", asked.inbox.find((item) => item.kind === "question")!.id, "Yes");
      const limited = await engine.until((state) => run.find(state).timeline.some((entry) => entry.text.includes("ran out of usage")) && !run.find(state).helpers?.length, "the limited reviewer to stop while its peer works");
      const task = run.find(limited);
      const clock = task.hunt!.work!["reviewer:1"]!.clock!;
      expect(clock.since).toBeUndefined();
      expect(task.hunt!.work!["reviewer:0"]!.clock!.since).toBeDefined();
      expect(mainLine(task)).toBe("Checking the greeting");
      run.advance(24);
      await engine.act("sendMessage", run.taskId, "Keep checking the guest view", "queue");
      const later = await engine.state();
      expect(workedSoFar(run.find(later).hunt!.work!["reviewer:1"]!.clock!, later.now)).toBe(workedSoFar(clock, limited.now));
      expect(workedSoFar(run.find(later).stepClock!, later.now)).toBeGreaterThanOrEqual(24 * MINUTE);
      await engine.act("cancel", run.taskId);
      expect(run.find(await engine.state()).steps!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(0);
    } finally { await engine.quit(); }
  });
});
