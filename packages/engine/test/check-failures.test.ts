import { executionFor } from "../src/repository-context.js";
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decisionEvidence, displayTask, draftOf, journeyProblems, journeyView, type DeepMutable, type State, type Task, type WorkflowEvent } from "@petrina/core";
import { Engine } from "./engine.js";
import { commandText } from "../src/checks.js";
import { Store } from "../src/store.js";
import type { Scenario } from "./fake-agent.js";
import { coordinator, Fakes, git, itemOf, makeProduct, removeDir, tempDir, taskOf, traceTaskWait, until, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(approveDelivery = true, scenario: Scenario = { planner: "short" }, extra?: { builderInstructions?: string; checkArgs?: string[] } | string) {
  // Edited builder options, or a trace label when a wait needs one.
  const builderOptions = typeof extra === "string" || extra == null ? {} : extra;
  const trace = typeof extra === "string" ? extra : undefined;
  const root = tempDir("petrina-check-failure-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const file = join(root, "check.ts");
  const log = join(root, "runs.txt");
  // Count actual command invocations outside the working copy, where restoring tracked files cannot hide one.
  // "--sequence=PFFP": the nth actual run passes or fails by its letter; later runs repeat the last one.
  writeFileSync(file, `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const sequence = process.argv.find((arg) => arg.startsWith("--sequence="))?.slice(11);
const earlier = existsSync(process.argv[2]) ? readFileSync(process.argv[2], "utf8").split("\\n").filter((line) => line === "passed" || line === "failed").length : 0;
const ok = sequence ? sequence[Math.min(earlier, sequence.length - 1)] === "P" : process.argv.includes("--pass") || existsSync("welcome.txt");
if (process.argv.includes("--hold")) {
  appendFileSync(process.argv[2], "started\\n");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
appendFileSync(process.argv[2], ok ? "passed\\n" : "failed\\n");
console.log(ok ? "The welcome page works" : "The welcome page is missing (captured failure)");
process.exit(ok ? 0 : 1);
`);
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] };
  let engine = new Engine(join(root, "data"), options);
  const repo = makeProduct(root);
  const productId = await engine.addProduct(repo);
  engine.setProductDelivery(productId, "local", approveDelivery);
  const command = (...args: string[]) => commandText([process.execPath, file, log, ...args]);
  const setCheck = (...args: string[]) => engine.setProductChecks(productId, [{ name: "Welcome", command: command(...args) }]);
  setCheck(...(builderOptions.checkArgs ?? []));
  if (builderOptions.builderInstructions) engine.saveRole("builder", { ...draftOf(engine.role("builder")!), instructions: builderOptions.builderInstructions });
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  let deliveryWaits = 0;
  return {
    fakes, repo, taskId, productId, root, log, command, setCheck,
    get engine() { return engine; },
    runs: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    delivery: () => traceTaskWait(trace ? `${trace}: delivery ${++deliveryWaits}` : undefined, () => engine.getState(), taskId,
      () => until(engine, (state) => !!itemOf(state, taskId, "delivery"), coordinator(["plan"])).then((state) => taskOf(state, taskId))),
    async restart(edit?: (state: DeepMutable<State>) => void) {
      await engine.shutdown();
      if (edit) {
        const store = new Store(join(root, "data", "petrina.db"));
        const loaded = store.load()!;
        const state = { ...loaded, tasks: loaded.tasks.map(displayTask) };
        edit(state as DeepMutable<State>);
        store.save(state);
        store.close();
      }
      engine = new Engine(join(root, "data"), options);
    },
  };
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);
const checkSteps = (task: Task) => task.journey!.filter((step) => step.kind === "petrina" && step.work === "checks");
const sentBack = (task: Task) => lines(task).filter((line) => line.startsWith("Sent back to the builder: the checks failed")).length;
const reviewStage = (task: Task) => task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
const ahead = (engine: Engine, task: Task) => {
  const state = engine.getState();
  return journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox }).nodes.filter((node) => node.state === "next" || node.state === "ahead").map((node) => node.name);
};

describe.concurrent("failed checks are evidence until something changes", () => {
  it("keeps an early static failure current across returns and restart, with heavy checks visibly skipped", async () => {
    const f = await fixture(true, { planner: "short", builder: "plain" });
    try {
      f.engine.setProductChecks(f.productId, [{ name: "Tests", command: f.command("--pass") }, { name: "Type check", command: f.command() }]);
      const task = await f.delivery();
      expect(f.runs()).toEqual(["failed"]);
      const step = checkSteps(task)[0]!;
      expect(step.productChecks!.map((check) => [check.name, check.result])).toEqual([["Tests", "skipped"], ["Type check", "fail"]]);
      expect(f.fakes.openings("code reviewer")).toEqual([]);
      await f.restart();
      expect(await f.engine["checks"].current(executionFor(f.engine.task(f.taskId)!))).toBe(true);
      expect(f.runs()).toEqual(["failed"]);
      f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const rerun = await f.delivery();
      const evidence = decisionEvidence(rerun);
      expect(f.runs()).toEqual(["failed", "failed"]);
      expect(evidence.map(check => [check.name, check.result, check.reusedAt])).toEqual([["Type check", "fail", undefined], ["Tests", "skipped", undefined]]);
      expect(evidence[1]!.source?.stepId).toBe(checkSteps(rerun).at(-1)!.id);
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).not.toContain("no new execution");
    } finally { await f.engine.shutdown(); }
  });
  it("gives built-in and edited builders the check commands without telling them to rerun the full suite", async () => {
    for (const builderInstructions of [undefined, "Use a focused test for the changed behavior."]) {
      const f = await fixture(true, { planner: "short", builder: "plain" }, { builderInstructions, checkArgs: ["--pass"] });
      try {
        await f.delivery();
        const opening = f.fakes.openings("builder")[0]!;
        expect(opening).toContain("## Product checks\n");
        expect(opening).toContain(f.command("--pass"));
        expect(opening).not.toContain("run every one in full before you finish");
        expect(opening).not.toContain("Run every check in full");
        expect(opening).toContain("Run focused tests that cover the behavior you changed while you work.");
        expect(opening).toContain("Before handoff, do not rerun the full product checks or test suite");
        if (builderInstructions) expect(opening).toContain(builderInstructions);
      } finally { await f.engine.shutdown(); }
    }
  });

  it("finishes the current reviewer but starts no delivery preparation while the pool is paused", async () => {
    const f = await fixture(true, { planner: "short", builder: "plain", controlled: true });
    const release = (session: string) => writeFileSync(join(f.fakes.dir, `release-${session}`), "go");
    try {
      f.setCheck("--pass");
      await waitFor(() => {
        for (const prompt of f.fakes.received()) if (prompt.role !== "code reviewer") release(prompt.session);
        coordinator(["plan"])(f.engine, f.engine.getState());
        return f.fakes.received("code reviewer").length > 0;
      }, "the final reviewer to start");
      expect(f.runs()).toEqual(["passed"]);
      f.engine.setPoolPaused(true);
      f.setCheck("--pass", "--new-definition");
      for (const prompt of f.fakes.received("code reviewer")) release(prompt.session);
      const waiting = await until(f.engine, (state) => taskOf(state, f.taskId).state === "waiting");
      expect(taskOf(waiting, f.taskId).statusLine).toBe("Waiting for the pool to resume");
      expect(taskOf(waiting, f.taskId).holdsSlot).toBe(false);
      expect(f.runs()).toEqual(["passed"]);
      expect(itemOf(waiting, f.taskId, "delivery")).toBeUndefined();
      f.engine.setPoolPaused(false);
      await f.delivery();
      expect(f.runs()).toEqual(["passed", "passed"]);
      expect(f.fakes.openings("code reviewer")).toHaveLength(1);
    } finally { f.engine.shutdown(); }
  });

  it("still presents a finished plan checkpoint while the pool is paused", async () => {
    const f = await fixture(true, { planner: "short", controlled: true });
    try {
      const planner = await waitFor(() => f.fakes.received("planner")[0], "the planner to start");
      f.engine.task(f.taskId)!.approvePlan = true;
      f.engine.setPoolPaused(true);
      writeFileSync(join(f.fakes.dir, `release-${planner.session}`), "go");
      const state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "plan"));
      expect(taskOf(state, f.taskId).holdsSlot).toBe(false);
      expect(f.fakes.received("builder")).toHaveLength(0);
      expect(f.runs()).toEqual([]);
    } finally { f.engine.shutdown(); }
  });

  it("reuses one passing run through read-only reviewers, acceptance and delivery without dropping an acceptance pass", async () => {
    const f = await fixture(true, { planner: "tester-first", builder: "plain" });
    try {
      f.setCheck("--pass");
      const task = await f.delivery();
      expect(f.runs()).toEqual(["passed"]);
      expect(f.fakes.openings("tester")).toHaveLength(1);
      expect(f.fakes.openings("tester")[0]).toContain("Current product checks, run by Petrina itself");
      expect(f.fakes.openings("tester")[0]).toContain("do not rerun the full checks");
      expect(f.fakes.openings("code reviewer").length).toBeGreaterThan(0);
      expect(f.fakes.openings("code reviewer").every((prompt) => prompt.includes("Current product checks, run by Petrina itself"))).toBe(true);
      expect(checkSteps(task)).toHaveLength(1);
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toEqual(["passed"]);
      expect(f.fakes.openings("tester")).toHaveLength(1);
    } finally { f.engine.shutdown(); }
  });

  it("spends no acceptance turn on unchanged failing code before asking the coordinator", async () => {
    const f = await fixture(true, { planner: "tester-first", builder: "plain" });
    try {
      const task = await f.delivery();
      expect(f.runs()).toEqual(["failed"]);
      expect(f.fakes.openings("tester")).toHaveLength(0);
      expect(f.fakes.openings("code reviewer")).toHaveLength(0);
      expect(task.journey?.some((step) => step.roleId === "tester")).toBe(false);
      expect(journeyProblems(task as Task)).toEqual([]);
      expect(task.checkReturns).toBe(2);
      expect(task.findings.some((finding) => finding.text.startsWith("Check failed") && finding.status === "open")).toBe(true);
      // Acceptance testing waits where the checks stopped it, and starts once they pass.
      expect(task.plan!.stages[task.stageIndex]!.roleId).toBe("tester");
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).toContain("Stopped before acceptance testing.");
    } finally { await f.engine.shutdown(); }
  });

  it("asks the coordinator before final acceptance when later checks fail after their builder returns are exhausted", async () => {
    const f = await fixture(true, { planner: "tester-first", builder: "plain" });
    try {
      f.setCheck("--pass");
      const original = await f.delivery();
      const testedPatch = original.testedPatch;
      const reviewers = f.fakes.openings("code reviewer").length;
      expect(f.fakes.openings("tester")).toHaveLength(1);
      expect(original.acceptancePassed).toBe(true);

      // A later fix changes the patch after acceptance has already passed. The earlier
      // automatic check fixes have used their allowance, as on a long-running task.
      const live = f.engine.task(f.taskId)!;
      executionFor(live).work.checkReturns = 2;
      writeFileSync(join(executionFor(live).work.worktree!, "later-fix.txt"), "A later change\n");
      git(executionFor(live).work.worktree!, "add", "later-fix.txt");
      git(executionFor(live).work.worktree!, "commit", "-q", "-m", "A later change");
      f.setCheck();
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Check the later change");

      const failed = await f.delivery();
      expect(failed.checks!.results.some((run) => !run.ok)).toBe(true);
      expect(failed.checkReturns).toBe(2);
      expect(failed.testedPatch).toBe(testedPatch);
      expect(f.fakes.openings("tester")).toHaveLength(1);
      expect(f.fakes.openings("code reviewer")).toHaveLength(reviewers);
      expect(failed.statusLine).toBe("Checks still fail. Your call");
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).toContain("Automated checks: 1 of 1 failed (Welcome)");
      expect(journeyProblems(failed)).toEqual([]);

      await f.restart();
      expect(f.fakes.openings("tester")).toHaveLength(1);
      expect(taskOf(f.engine.getState(), f.taskId).checks).toEqual(failed.checks);

      // A coordinator-authorized real fix still goes through checks, review and
      // final acceptance. Escalating must not mark the unfinished review complete.
      f.fakes.scenario({ planner: "tester-first", builder: "plain", fixes: "change" });
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the failed welcome check");
      const fixed = await f.delivery();
      expect(fixed.checks!.results.every((run) => run.ok)).toBe(true);
      expect(f.fakes.openings("code reviewer")).toHaveLength(reviewers * 2);
      expect(f.fakes.openings("tester")).toHaveLength(2);
      expect(fixed.testedPatch).not.toBe(testedPatch);
      expect(journeyProblems(fixed)).toEqual([]);
    } finally { await f.engine.shutdown(); }
  });

  it("tells acceptance testing whether saved checks really cover the code and required commands", async () => {
    const f = await fixture();
    try {
      f.setCheck("--pass");
      await f.delivery();
      const task = f.engine.task(f.taskId)!;
      const saved = structuredClone(executionFor(task).work.checks!);
      const evidence = async () => (await f.engine["context"].sectionsFor(executionFor(task), "tester")).find((section) => section.title.includes("product checks"));
      expect(await evidence()).toEqual(expect.objectContaining({ title: "Current product checks, run by Petrina itself", body: expect.stringContaining("do not rerun the full checks") }));

      writeFileSync(join(executionFor(task).work.worktree!, "greeting.txt"), "Uncommitted change\n");
      expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
      git(executionFor(task).work.worktree!, "add", "greeting.txt");
      git(executionFor(task).work.worktree!, "commit", "-q", "-m", "A real change");
      expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
      git(executionFor(task).work.worktree!, "reset", "--hard", saved.sha!);
      expect((await evidence())?.title).toBe("Current product checks, run by Petrina itself");

      f.setCheck("--pass", "--changed");
      expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
      f.setCheck("--pass");
      executionFor(task).work.checks!.results = [{ ...saved.results[0]!, ok: false, timedOut: true }];
      expect((await evidence())?.body).toContain("not passing acceptance evidence");
      expect((await evidence())?.body).not.toContain("Use them for automated acceptance");
      executionFor(task).work.checks!.results = [];
      expect(await evidence()).toBeUndefined();
      executionFor(task).work.checks = structuredClone(saved);
      f.engine.setProductChecks(f.productId, [
        { name: "Welcome", command: f.command("--pass") },
        { name: "Extra", command: f.command("--pass", "--extra") },
      ]);
      expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
      // Building context reads evidence; it never runs checks to make the evidence current.
      expect(f.runs()).toEqual(["passed"]);
    } finally { f.engine.shutdown(); }
  });

  it("returns unchanged work twice without using a review round, keeps the failure after restart, and checks a real fix", async () => {
    const f = await fixture();
    try {
      let task = await f.delivery();
      const review = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
      const captured = task.checks;
      expect(f.runs()).toEqual(["failed"]);
      expect(task.checkReturns).toBe(2);
      expect(task.rounds[review.id] ?? 1).toBe(1);
      expect(task.blockingAfter?.[review.id]).toBeUndefined();
      expect(task.reviewedSha).toBeUndefined();
      expect(f.fakes.openings("builder")).toHaveLength(3);
      expect(f.fakes.openings("code reviewer")).toHaveLength(0);
      expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(false);
      expect(lines(task)).not.toContain("Reviewers wait until the checks pass");
      expect(task.statusLine).toBe("Checks still fail. Your call");
      const recordedChecks = checkSteps(task);
      expect(recordedChecks).toHaveLength(1);
      expect(recordedChecks[0]).toEqual(expect.objectContaining({ outcome: "1 of 1 check failed", reason: "1 check failed", tone: "back", end: "done", endedAt: expect.any(Number) }));
      expect(task.journey!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(0);
      expect(task.timeline.find((entry) => entry.text.startsWith("Checks:"))?.step).toBe(recordedChecks[0]!.id);
      expect(journeyProblems(task)).toEqual([]);
      const failure = task.findings.find((finding) => finding.text.startsWith("Check failed"))!;
      // The fake builder claims it fixed the finding without changing any files. Evidence wins.
      expect(failure.answer?.fixed).toBe(true);
      expect(failure.status).toBe("open");
      const repairs = task.journey!.filter((step) => step.fixing && step.roleId === "builder");
      expect(repairs.every((step) => step.builderReturn?.changed === false)).toBe(true);
      expect(repairs.every((step) => step.outcome?.startsWith("No code changes; checks still failing"))).toBe(true);
      expect(task.journey!.filter((step) => step.work === "check-reuse").every((step) => step.productChecks?.[0]?.run?.source?.stepId === recordedChecks[0]!.id)).toBe(true);
      expect(task.journey!.at(-1)!.productChecks?.[0]?.reusedAt).toBeNumber();
      expect(failure.evidence).toContain("captured failure");
      expect(f.fakes.prompts("builder").filter((text) => text.includes("captured failure"))).toHaveLength(2);
      // Rereading the saved failure keeps its diagnostics: the saved log, the journey's run and the check problem.
      const run = task.checks!.results[0]!;
      expect(readFileSync(run.logPath!, "utf8")).toContain("captured failure");
      expect(recordedChecks[0]!.productChecks![0]!.run?.logPath).toBe(run.logPath);
      expect(task.stageIndex).toBe(reviewStage(task));
      const blocker = itemOf(f.engine.getState(), f.taskId, "delivery")!;
      expect(blocker.title).toBe("Your call on “Add a greeting”: a check still fails (Welcome)");
      expect(blocker.body).toContain("• Welcome failed: The welcome page is missing (captured failure)");
      expect(blocker.body).toContain("Stopped before the review.");

      await f.restart();
      expect(taskOf(f.engine.getState(), f.taskId).checks).toEqual(captured);
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the welcome page");
      task = await f.delivery();
      expect(f.runs()).toEqual(["failed"]);
      expect(task.checks).toEqual(captured);
      expect(task.checkReturns).toBe(2);
      expect(task.findings.filter((finding) => finding.text.startsWith("Check failed"))).toHaveLength(1);
      // The guarded review reuses the failure: no review or acceptance starts, and the allowance stays spent.
      expect(checkSteps(task).map(({ reuses: _reuses, ...step }) => step)).toEqual(recordedChecks.map(({ reuses: _reuses, ...step }) => step));
      expect(checkSteps(task)[0]!.reuses!.map((entry) => entry.purpose)).toEqual(["review", "review", "review"]);
      expect(checkSteps(task)[0]!.reuses!.every((entry) => !entry.passed && entry.tree === captured!.tree)).toBe(true);
      expect(checkSteps(task)[0]!.checkAttempts![0]).toMatchObject({ sha: captured!.sha, tree: captured!.tree, definition: captured!.definition });
      expect(checkSteps(task)[0]!.checkAttempts![0]!.passed).toBeUndefined();
      const blockedEvents = (await f.engine.events.wait({ taskIds: [f.taskId], from: "oldest", timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
      expect(blockedEvents.find((event) => event.kind === "check.reused")).toMatchObject({ nodeId: captured!.provenance!.nodeId, purpose: "review", passed: false, tree: captured!.tree, definition: captured!.definition });
      expect(blockedEvents.some((event) => event.kind === "seat.started" && ["code-reviewer", "tester"].includes(String(event.roleId)))).toBe(false);
      expect(blockedEvents.find((event) => event.kind === "coordinator.request" && event.requestKind === "delivery")).toMatchObject({ title: blocker.title });
      expect(journeyProblems(task)).toEqual([]);

      f.fakes.scenario({ planner: "short", fixes: "change" });
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Make the actual fix");
      task = await f.delivery();
      expect(f.runs()).toEqual(["failed", "passed"]);
      expect(task.checks!.tree).not.toBe(captured!.tree);
      expect(task.checks!.results.every((run) => run.ok)).toBe(true);
      expect(task.checkReturns).toBeUndefined();
      expect(task.findings.find((finding) => finding.id === failure.id)?.status).toBe("fixed");
      expect(task.rounds[review.id] ?? 1).toBe(1);
      expect(task.blockingAfter?.[review.id]).toEqual([0]);
      expect(f.fakes.openings("code reviewer")).toHaveLength(1);
      expect(checkSteps(task)).toHaveLength(2);
      expect((({ reuses: _reuses, ...step }) => step)(checkSteps(task)[0]!)).toEqual((({ reuses: _reuses, ...step }) => step)(recordedChecks[0]!));
      expect(checkSteps(task)[1]).toEqual(expect.objectContaining({ outcome: "The check passes", reason: "checks passed", end: "done" }));
      const recoveredEvents = (await f.engine.events.wait({ taskIds: [f.taskId], from: "oldest", timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
      expect(recoveredEvents.find((event) => event.kind === "node.started" && event.roleId === "code-reviewer")).toMatchObject({ checks: { basis: "ran", passed: true, nodeId: checkSteps(task)[1]!.id } });
      expect(task.journey!.find((step) => step.roleId === "code-reviewer")).toEqual(expect.objectContaining({ outcome: "1 nit", reason: "review passed", end: "done" }));
      expect(journeyProblems(task)).toEqual([]);
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toEqual(["failed", "passed"]);
    } finally {
      await f.engine.shutdown();
    }
  });

  it("does not consume more rounds when reviews were already exhausted, including a saved run from before the update", async () => {
    const f = await fixture(true, { planner: "short" }, "Exhausted review rounds");
    try {
      // Start with passing checks and a real review that uses up its sole round.
      f.setCheck("--pass");
      f.fakes.scenario({ planner: "short", reviewer: "important" });
      let task = await f.delivery();
      const review = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
      expect(task.blockingAfter?.[review.id]).toEqual([1]);
      expect(lines(task).filter((line) => line.startsWith("Review rounds used up"))).toHaveLength(1);
      f.setCheck();
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix what failed");
      task = await f.delivery();
      expect(f.runs()).toEqual(["passed", "failed"]);
      const captured = task.checks!;

      // Resume at review as a restart between saving the failure and handling its return would do.
      // Older saved results have the commands and tree, but no definition fingerprint.
      await f.restart((state) => {
        const saved = state.tasks.find((task) => task.id === f.taskId)!;
        delete saved.checks!.definition;
        saved.stageIndex = saved.plan!.stages.findIndex((stage) => stage.id === review.id);
        saved.state = "waiting";
        state.inbox = state.inbox.filter((item) => item.taskId !== f.taskId);
      });
      task = await f.delivery();
      expect(f.runs()).toEqual(["passed", "failed"]);
      expect(task.checks!.at).toBe(captured.at);
      expect(task.checks!.definition).toMatch(/^[a-f0-9]{64}$/);
      expect(task.blockingAfter?.[review.id]).toEqual([1]);
      expect(task.rounds[review.id] ?? 1).toBe(1);
      expect(lines(task).filter((line) => line.startsWith("Review rounds used up"))).toHaveLength(1);
      expect(f.fakes.openings("code reviewer")).toHaveLength(1);

      f.fakes.scenario({ planner: "short", fixes: "change" });
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the welcome page");
      task = await f.delivery();
      expect(f.runs()).toEqual(["passed", "failed", "passed"]);
      expect(task.blockingAfter?.[review.id]).toEqual([1, 0]);
    } finally {
      f.engine.shutdown();
    }
  });

  it("runs changed commands on the same code, including at final delivery preparation", async () => {
    const f = await fixture();
    try {
      let task = await f.delivery();
      const failedTree = task.checks!.tree;
      f.setCheck("--pass");
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Use the corrected check");
      task = await f.delivery();
      expect(task.checks!.tree).toBe(failedTree);
      expect(f.runs()).toEqual(["failed", "passed"]);

      // The coordinator changes the required command after review: final preparation must notice it.
      f.setCheck("--pass", "--changed");
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toEqual(["failed", "passed", "passed"]);
    } finally {
      f.engine.shutdown();
    }
  });

  it("keeps a forced check decision and allows explicit reruns without approving delivery or replenishing repairs", async () => {
    const f = await fixture(false);
    try {
      const blocked = await f.delivery();
      expect(f.runs()).toEqual(["failed"]);
      expect(blocked.stageIndex).toBe(reviewStage(blocked));
      // This task normally delivers without asking. Failed checks still bring it to the coordinator.
      const decision = itemOf(f.engine.getState(), f.taskId, "delivery")!.id;
      expect(() => f.engine.approve(decision)).toThrow("delivery has not been approved");
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.id).toBe(decision);
      expect(f.runs()).toEqual(["failed"]);

      f.engine.rerunChecks(decision);
      const failed = await f.delivery();
      expect(f.runs()).toEqual(["failed", "failed"]);
      expect(failed.checks!.results[0]!.output).toContain("captured failure");
      expect(failed.checkReturns).toBe(2);
      expect(failed.approvedSha).toBeUndefined();
      expect(failed.error).toBeUndefined();

      f.setCheck("--pass");
      f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toEqual(["failed", "failed", "passed"]);
      // The passing run continued at the review the checks had held back; nothing shipped unreviewed.
      expect(f.fakes.openings("code reviewer")).toHaveLength(1);
    } finally {
      f.engine.shutdown();
    }
  });

  it("keeps completed evidence when a changed check is cancelled, then runs the required check after restart", async () => {
    const f = await fixture();
    try {
      const captured = (await f.delivery()).checks;
      f.setCheck("--hold");
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Check the updated command");
      await until(f.engine, () => f.runs().includes("started"), coordinator(["plan"]));
      f.engine.pause(f.taskId);
      expect(taskOf(f.engine.getState(), f.taskId).checks).toEqual(captured);
      await f.restart();
      expect(taskOf(f.engine.getState(), f.taskId).state).toBe("paused");
      f.setCheck("--pass");
      f.engine.resume(f.taskId);
      const task = await f.delivery();
      expect(f.runs()).toEqual(["failed", "started", "passed"]);
      expect(task.checks!.results.every((run) => run.ok)).toBe(true);
      expect(task.blockingAfter?.[task.plan!.stages.find((stage) => stage.kind === "review-chain")!.id]).toEqual([0]);
    } finally {
      f.engine.shutdown();
    }
  });

  it("requires a fresh final run when main moves after approval", async () => {
    const f = await fixture();
    try {
      f.setCheck("--pass");
      const reviewedTree = (await f.delivery()).checks!.tree;
      writeFileSync(join(f.repo, "NEWS.md"), "News from another task\n");
      git(f.repo, "add", "NEWS.md");
      git(f.repo, "commit", "-q", "-m", "News on main");
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const state = await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      const shipped = taskOf(state, f.taskId);
      expect(f.runs()).toEqual(["passed", "passed"]);
      expect(shipped.checks!.tree).not.toBe(reviewedTree);
      expect(shipped.checks!.sha).toBe(git(f.repo, "rev-parse", "main"));
    } finally {
      f.engine.shutdown();
    }
  });

  it.skipIf(process.platform === "win32")("checks a corrected commit title and changed local hook even when the code stays the same", async () => {
    const f = await fixture();
    try {
      f.setCheck("--pass");
      const hook = join(f.repo, ".git", "hooks", "commit-msg");
      writeFileSync(hook, '#!/bin/sh\nhead -1 "$1" | grep -q "^Fix:" || { echo "Use Fix in the title"; exit 1; }\n');
      chmodSync(hook, 0o755);
      let task = await f.delivery();
      expect(f.runs()).toEqual(["passed"]);
      const tree = task.checks!.tree;
      expect(task.checks!.results.find((run) => run.name === "Commit message hook")?.ok).toBe(false);
      f.fakes.scenario({ planner: "short", title: "Fix: Add a greeting" });
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Correct the title");
      task = await f.delivery();
      expect(task.checks!.tree).toBe(tree);
      expect(task.checks!.results.every((run) => run.ok)).toBe(true);
      expect(f.runs()).toEqual(["passed", "passed"]);
      // Local hooks live outside the tree, so changing one must invalidate a passing run too.
      writeFileSync(hook, '#!/bin/sh\necho "The changed hook ran"\n');
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const state = await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(taskOf(state, f.taskId).checks!.results.find((run) => run.name === "Commit message hook")?.output).toContain("The changed hook ran");
      expect(f.runs()).toEqual(["passed", "passed", "passed"]);
      expect(git(f.repo, "log", "-1", "--format=%s")).toBe("Fix: Add a greeting");
    } finally {
      f.engine.shutdown();
    }
  });

  for (const hookName of ["pre-commit", "commit-msg"] as const) {
    function externalHook(f: Awaited<ReturnType<typeof fixture>>, pass: boolean) {
      const folder = join(f.root, "external-hooks");
      mkdirSync(folder);
      const launcher = join(folder, hookName);
      writeFileSync(launcher, '#!/bin/sh\nexec sh "$(dirname "$0")/implementation"\n');
      chmodSync(launcher, 0o755);
      git(f.repo, "config", "core.hooksPath", folder);
      const set = (ok: boolean) => writeFileSync(join(folder, "implementation"), `dir=$(dirname "$0")\nprintf 'run\\n' >> "$dir/runs"\necho "External implementation: ${ok ? "passed" : "failed (captured hook failure)"}"\nexit ${ok ? 0 : 1}\n`);
      set(pass);
      return { launcher, set, runs: () => existsSync(join(folder, "runs")) ? readFileSync(join(folder, "runs"), "utf8").trim().split("\n").length : 0 };
    }

    it.skipIf(process.platform === "win32")(`revalidates a passing ${hookName} launcher, preserves a failure across restart, and refreshes it on explicit Retry`, async () => {
      const f = await fixture();
      try {
        f.setCheck("--pass");
        const hook = externalHook(f, true);
        const launcher = readFileSync(hook.launcher, "utf8");
        const passed = (await f.delivery()).checks!;
        const initialRuns = hook.runs();
        expect(initialRuns).toBeGreaterThan(0);
        expect(f.runs()).toEqual(["passed"]);
        hook.set(false);
        expect(readFileSync(hook.launcher, "utf8")).toBe(launcher);
        f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        const failed = (await f.delivery()).checks!;
        expect(failed.definition).toBe(passed.definition);
        expect(failed.tree).toBe(passed.tree);
        expect(failed.results.at(-1)!.output).toContain("captured hook failure");
        expect(failed.results.at(-1)!.ok).toBe(false);
        expect(hook.runs()).toBe(initialRuns + 1);
        expect(f.runs()).toEqual(["passed"]);

        // The implementation is opaque: unchanged failed evidence blocks until the coordinator retries.
        hook.set(true);
        await f.restart();
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Check the saved failure");
        expect((await f.delivery()).checks).toEqual(failed);
        expect(hook.runs()).toBe(initialRuns + 1);
        expect(f.runs()).toEqual(["passed"]);
        // Stand in for a later failure before the delivery question is raised again.
        f.engine.takeItem(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        f.engine.fail(f.taskId, new Error("Delivery could not start"));
        f.engine.setPoolPaused(true);
        await f.engine.retry(itemOf(f.engine.getState(), f.taskId, "stuck")!.id);
        const waiting = taskOf(f.engine.getState(), f.taskId).checks!;
        expect(waiting.results).toEqual(failed.results);
        expect(waiting.sha).toBeUndefined();
        expect(waiting.tree).toBeUndefined();
        f.engine.setPoolPaused(false);
        const refreshed = (await f.delivery()).checks!;
        expect(refreshed.results.every((run) => run.ok)).toBe(true);
        expect(hook.runs()).toBeGreaterThan(initialRuns + 1);
        expect(f.runs()).toEqual(["passed", "passed"]);
      } finally { f.engine.shutdown(); }
    });

    it.skipIf(process.platform === "win32")(`explicit Retry refreshes a saved pass as well as the opaque ${hookName}`, async () => {
      const f = await fixture();
      try {
        f.setCheck("--pass");
        const hook = externalHook(f, true);
        const passed = (await f.delivery()).checks!;
        const initialRuns = hook.runs();
        f.engine.takeItem(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        f.engine.fail(f.taskId, new Error("Delivery could not start"));
        hook.set(false);
        f.engine.setPoolPaused(true);
        await f.engine.retry(itemOf(f.engine.getState(), f.taskId, "stuck")!.id);
        const waiting = taskOf(f.engine.getState(), f.taskId).checks!;
        expect(waiting.results).toEqual(passed.results);
        expect(waiting.sha).toBeUndefined();
        expect(waiting.tree).toBeUndefined();
        f.engine.setPoolPaused(false);
        const failed = (await f.delivery()).checks!;
        expect(failed.results.at(-1)!.ok).toBe(false);
        expect(failed.results.at(-1)!.output).toContain("captured hook failure");
        expect(hook.runs()).toBe(initialRuns + 1);
        expect(f.runs()).toEqual(["passed", "passed"]);
      } finally { f.engine.shutdown(); }
    });

    it.skipIf(process.platform === "win32")(`notices identical ${hookName} launchers in different folders, before review and delivery`, async () => {
      const f = await fixture();
      try {
        f.setCheck("--pass");
        const bad = join(f.root, "bad-hooks");
        const good = join(f.root, "good-hooks");
        for (const [folder, exit] of [[bad, 1], [good, 0]] as const) {
          mkdirSync(folder);
          writeFileSync(join(folder, hookName), '#!/bin/sh\nexec sh "$(dirname "$0")/check"\n');
          chmodSync(join(folder, hookName), 0o755);
          writeFileSync(join(folder, "check"), `echo "Hook beside the launcher: ${exit === 0 ? "passed" : "failed"}"\nexit ${exit}\n`);
        }
        expect(readFileSync(join(bad, hookName), "utf8")).toBe(readFileSync(join(good, hookName), "utf8"));
        git(f.repo, "config", "core.hooksPath", bad);
        const failed = (await f.delivery()).checks!;
        expect(failed.results.at(-1)!.ok).toBe(false);
        expect(f.runs()).toEqual(["passed"]);

        git(f.repo, "config", "core.hooksPath", good);
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Use the corrected hook folder");
        const passed = (await f.delivery()).checks!;
        expect(passed.tree).toBe(failed.tree);
        expect(passed.definition).not.toBe(failed.definition);
        expect(passed.results.at(-1)!.output).toContain("Hook beside the launcher: passed");
        expect(passed.results.every((run) => run.ok)).toBe(true);
        expect(f.runs()).toEqual(["passed", "passed"]);

        // Moving back after review must invalidate the pass at final delivery preparation too.
        git(f.repo, "config", "core.hooksPath", bad);
        f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        const task = await f.delivery();
        expect(task.checks!.results.at(-1)!.output).toContain("Hook beside the launcher: failed");
        expect(f.runs()).toEqual(["passed", "passed", "passed"]);
        expect(git(f.repo, "rev-parse", "HEAD")).not.toBe(git(task.worktree!, "rev-parse", "HEAD"));
      } finally {
        f.engine.shutdown();
      }
    });

    for (const originallyPassed of [false, true]) {
      it.skipIf(process.platform === "win32")(`refreshes an older saved ${hookName} ${originallyPassed ? "pass" : "failure"} without retrying unchanged product checks`, async () => {
        const f = await fixture(true, { planner: "short" }, originallyPassed ? undefined : `Legacy ${hookName} failure`);
        try {
          f.setCheck("--pass");
          const hook = join(f.repo, ".git", "hooks", hookName);
          writeFileSync(hook, `#!/bin/sh\necho "Original hook"\nexit ${originallyPassed ? 0 : 1}\n`);
          chmodSync(hook, 0o755);
          const original = (await f.delivery()).checks!;
          expect(original.results.at(-1)!.ok).toBe(originallyPassed);
          writeFileSync(hook, `#!/bin/sh\necho "Changed hook"\nexit ${originallyPassed ? 1 : 0}\n`);
          await f.restart((state) => { delete state.tasks.find((task) => task.id === f.taskId)!.checks!.definition; });
          const item = itemOf(f.engine.getState(), f.taskId, "delivery")!;
          if (originallyPassed) f.engine.approve(item.id);
          else f.engine.requestChanges(item.id, "The hook has been corrected");
          const refreshed = (await f.delivery()).checks!;
          expect(refreshed.tree).toBe(original.tree);
          expect(refreshed.results.at(-1)!.ok).toBe(!originallyPassed);
          expect(refreshed.results.at(-1)!.output).toContain("Changed hook");
          expect(refreshed.definition).toMatch(/^[a-f0-9]{64}$/);
          expect(f.runs()).toEqual(["passed"]);

          // A failure remains evidence; a pass must revalidate the hook's opaque implementation.
          await f.restart();
          f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Check the saved result");
          const again = (await f.delivery()).checks!;
          if (originallyPassed) expect(again).toEqual(refreshed);
          else {
            expect(again.at).toBeGreaterThan(refreshed.at);
            expect(again.results[0]).toEqual(refreshed.results[0]);
            // A rerun keeps the outcome but creates a new diagnostic file with its own identity.
            expect(again.results.map(({ ms, logPath, logFileIdentity, startedAt, endedAt, source, ...run }) => run)).toEqual(refreshed.results.map(({ ms, logPath, logFileIdentity, startedAt, endedAt, source, ...run }) => run));
            expect(again.results.at(-1)!.logPath).not.toBe(refreshed.results.at(-1)!.logPath);
            expect(again.results.at(-1)!.logFileIdentity).not.toEqual(refreshed.results.at(-1)!.logFileIdentity);
            for (const run of [refreshed.results.at(-1)!, again.results.at(-1)!]) {
              const info = statSync(run.logPath!, { bigint: true });
              expect(run.logFileIdentity).toEqual({ device: info.dev.toString(), inode: info.ino.toString() });
            }
            expect(readFileSync(again.results.at(-1)!.logPath!, "utf8")).toBe(readFileSync(refreshed.results.at(-1)!.logPath!, "utf8"));
            expect(again.definition).toBe(refreshed.definition);
            expect(again.tree).toBe(refreshed.tree);
          }
          expect(f.runs()).toEqual(["passed"]);
        } finally {
          f.engine.shutdown();
        }
      });
    }

    it.skipIf(process.platform === "win32")(`keeps an older failed suite while refreshing ${hookName}, until a real fix`, async () => {
      const f = await fixture();
      try {
        const hook = join(f.repo, ".git", "hooks", hookName);
        writeFileSync(hook, '#!/bin/sh\necho "Old hook failed"\nexit 1\n');
        chmodSync(hook, 0o755);
        await f.delivery();
        expect(f.runs()).toEqual(["failed"]);
        writeFileSync(hook, '#!/bin/sh\necho "Corrected hook passed"\n');
        await f.restart((state) => { delete state.tasks.find((task) => task.id === f.taskId)!.checks!.definition; });
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "The hook has been corrected");
        const failed = await f.delivery();
        expect(f.runs()).toEqual(["failed"]);
        expect(failed.checks!.results[0]!.output).toContain("captured failure");
        expect(failed.checks!.results[0]!.ok).toBe(false);
        expect(failed.checks!.results.at(-1)!.output).toContain("Corrected hook passed");
        expect(failed.checks!.results.at(-1)!.ok).toBe(true);
        expect(failed.checks!.definition).toMatch(/^[a-f0-9]{64}$/);

        f.fakes.scenario({ planner: "short", fixes: "change" });
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the failed product check");
        const fixed = await f.delivery();
        expect(f.runs()).toEqual(["failed", "passed"]);
        expect(fixed.checks!.results.every((run) => run.ok)).toBe(true);
      } finally {
        f.engine.shutdown();
      }
    });
  }

  for (const exhausted of [false, true]) {
    it(`reviews a real fix normally after port checks fail with builder returns ${exhausted ? "used up" : "available"}`, async () => {
      const f = await fixture(true, {});
      try {
        f.setCheck("--pass");
        await f.delivery();
        expect(f.fakes.openings("code reviewer")).toHaveLength(2);
        if (exhausted) await f.restart((state) => { state.tasks.find((task) => task.id === f.taskId)!.checkReturns = 2; });
        // Main overlaps the already reviewed work. The builder must port greeting.txt by hand.
        writeFileSync(join(f.repo, "greeting.txt"), "A greeting on main\n");
        git(f.repo, "add", "greeting.txt");
        git(f.repo, "commit", "-q", "-m", "A greeting on main");
        f.setCheck();
        // The port resolves greeting.txt; the later check fix changes welcome.txt, outside the port.
        f.fakes.scenario({ fixes: "change" });
        f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        if (exhausted) {
          const failed = await f.delivery();
          expect(f.runs()).toEqual(["passed", "failed"]);
          expect(failed.portReview).toBeUndefined();
          expect(f.fakes.openings("code reviewer")).toHaveLength(2);
          f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the failed welcome check");
        }
        const task = await f.delivery();
        expect(lines(task)).toContain("Brought up to date with main: Added a greeting.");
        expect(f.runs()).toEqual(["passed", "failed", "passed"]);
        expect(existsSync(join(task.worktree!, "welcome.txt"))).toBe(true);
        const reviews = f.fakes.openings("code reviewer").slice(2);
        expect(reviews).toHaveLength(2);
        for (const prompt of reviews) {
          expect(prompt).not.toContain("Review only the port");
          expect(prompt).toContain(`git diff ${task.baseSha}...HEAD`);
        }
        expect(task.portReview).toBeUndefined();
        expect(task.rounds[task.plan!.stages.find((stage) => stage.kind === "review-chain")!.id] ?? 1).toBe(1);
      } finally {
        f.engine.shutdown();
      }
    });
  }
});

describe.concurrent("automatic check repairs belong to one failure episode", () => {
  it("gives a later failure its own two repairs after a genuine pass, and reviews and retests a fix made after review passed", async () => {
    const f = await fixture(true, { planner: "tester-first", builder: "plain", fixes: "change" }, { checkArgs: ["--sequence=FFP"] });
    try {
      let task = await f.delivery();
      // Two automatic turns, then a real pass on the changed code closes the episode before acceptance testing.
      expect(f.runs()).toEqual(["failed", "failed", "passed"]);
      expect(sentBack(task)).toBe(2);
      expect(task.checkReturns).toBeUndefined();
      expect(f.fakes.openings("builder")).toHaveLength(3);
      expect(f.fakes.openings("tester")).toHaveLength(1);
      expect(f.fakes.openings("code reviewer")).toHaveLength(2);
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.title).toBe("Ready to ship “Add a greeting”");

      // A changed check fails on what was about to ship: the new episode has its own two returns again.
      f.setCheck("--sequence=FFPFFP", "--later");
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      task = await f.delivery();
      expect(f.runs()).toEqual(["failed", "failed", "passed", "failed", "failed", "passed"]);
      expect(sentBack(task)).toBe(4);
      expect(task.checkReturns).toBeUndefined();
      expect(f.fakes.openings("builder")).toHaveLength(5);
      // The fix made after review passed is reviewed again and tried once more before the delivery check; nothing shipped.
      expect(f.fakes.openings("code reviewer")).toHaveLength(4);
      expect(f.fakes.openings("tester")).toHaveLength(2);
      expect(task.state).toBe("needs-you");
      expect(task.approvedSha).toBeUndefined();
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.title).toBe("Ready to ship “Add a greeting”");
      expect(journeyProblems(task)).toEqual([]);
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toHaveLength(6);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps a pending review round when check repairs run out, and runs it with its number after a passing fix", async () => {
    const f = await fixture(true, { planner: "tester-first", builder: "plain", reviewer: "important", fixes: "change" }, { checkArgs: ["--sequence=PFFFP"] });
    try {
      let task = await f.delivery();
      const review = reviewStage(task);
      const stage = task.plan!.stages[review]!;
      // Round 1 sent a finding back; its fix fails the checks three times in a row before round 2.
      expect(f.runs()).toEqual(["passed", "failed", "failed", "failed"]);
      expect(task.stageIndex).toBe(review);
      expect(task.rounds[stage.id]).toBe(2);
      expect(task.blockingAfter?.[stage.id]).toEqual([1]);
      expect(task.checkReturns).toBe(2);
      expect(sentBack(task)).toBe(2);
      expect(f.fakes.openings("code reviewer")).toHaveLength(2);
      expect(f.fakes.openings("tester")).toHaveLength(1);
      const anchor = task.reviewedSha;
      expect(anchor).toBeDefined();
      const item = itemOf(f.engine.getState(), f.taskId, "delivery")!;
      expect(item.title).toBe("Your call on “Add a greeting”: a check still fails (Welcome)");
      expect(task.statusLine).toBe("Checks still fail. Your call");
      expect(item.body).toContain("Still failing after 2 automatic Builder turns.\n• Welcome failed: The welcome page is missing (captured failure)");
      expect(item.body).toContain("The Builder's last answer, saying it fixed this: “Fixed it.”");
      // The Builder answered round 1's Important finding and its nit; no reviewer has looked at either fix yet.
      expect(item.body).toContain("Stopped before the review (round 2). A reviewer has not yet confirmed 2 fixes the Builder made for review findings.");
      expect(item.body).toMatch(/After the Builder's next turn, still to come: code review again \([^)]*\), then final acceptance testing \([^)]*\) if the code changed, then your OK to ship/);
      expect(item.body).toContain("Send back with a note to give the Builder one more turn. Approving does not ship while checks fail or remain unverified.");
      expect(item.body).toContain("Automated checks: 1 of 1 failed (Welcome).");
      expect(lines(task)).toContain("Checks still fail after 2 automatic Builder turns (Welcome), so Petrina waits for you before the review (round 2)");
      // The journey still shows the pending review round ahead of the delivery check.
      const upcoming = ahead(f.engine, task);
      expect(upcoming.indexOf("Code reviewers (round 2)")).toBeGreaterThanOrEqual(0);
      expect(upcoming.indexOf("Code reviewers (round 2)")).toBeLessThan(upcoming.indexOf("Your delivery check"));
      expect(journeyProblems(task)).toEqual([]);

      f.engine.requestChanges(item.id, "Fix the welcome check");
      task = await f.delivery();
      expect(f.runs()).toEqual(["passed", "failed", "failed", "failed", "passed"]);
      expect(task.checkReturns).toBeUndefined();
      // Round 2 ran on the changes since round 1, kept its number, then acceptance was tried on the final code.
      const second = f.fakes.openings("code reviewer").slice(2);
      expect(second).toHaveLength(2);
      for (const prompt of second) {
        expect(prompt).toContain("This is review round 2:");
        expect(prompt).toContain(`Incremental comparison git diff ${anchor}..HEAD:`);
      }
      expect(task.rounds[stage.id]).toBe(2);
      expect(task.blockingAfter?.[stage.id]).toEqual([1, 0]);
      expect(f.fakes.openings("tester")).toHaveLength(2);
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.title).toBe("Ready to ship “Add a greeting”");
      expect(journeyProblems(task)).toEqual([]);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps the episode count across a restart, the blocker and its position after one, and the cleared count after a pass", async () => {
    const f = await fixture(true, { planner: "short", builder: "plain", controlled: true });
    const release = (session: string) => writeFileSync(join(f.fakes.dir, `release-${session}`), "go");
    const releaseAll = (engine: Engine, state: State) => {
      coordinator(["plan"])(engine, state);
      for (const prompt of f.fakes.received()) release(prompt.session);
    };
    try {
      // Hold the first automatic repair while it works, then restart in the middle of the episode.
      await waitFor(() => {
        coordinator(["plan"])(f.engine, f.engine.getState());
        const builders = f.fakes.received("builder");
        for (const prompt of f.fakes.received()) if (prompt.role !== "builder" || prompt.session === builders[0]?.session) release(prompt.session);
        return builders.length >= 2;
      }, "the first automatic repair to start");
      expect(executionFor(f.engine.task(f.taskId)!).work.checkReturns).toBe(1);
      await f.restart();
      expect(executionFor(f.engine.task(f.taskId)!).work.checkReturns).toBe(1);
      let state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "delivery"), releaseAll);
      let task = taskOf(state, f.taskId);
      // One more automatic turn after the restart, never a fresh pair.
      expect(task.checkReturns).toBe(2);
      expect(sentBack(task)).toBe(2);
      expect(f.runs()).toEqual(["failed"]);
      const item = itemOf(state, f.taskId, "delivery")!;

      await f.restart();
      state = f.engine.getState();
      task = taskOf(state, f.taskId);
      expect(itemOf(state, f.taskId, "delivery")).toEqual(item);
      expect(task.stageIndex).toBe(reviewStage(task));
      expect(task.state).toBe("needs-you");
      expect(task.statusLine).toBe("Checks still fail. Your call");
      expect(task.checkReturns).toBe(2);

      // The coordinator's turn is not a fresh allowance: a still-failing run returns straight to the blocker.
      const builders = f.fakes.openings("builder").length;
      f.engine.requestChanges(item.id, "Try once more");
      state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "delivery"), releaseAll);
      task = taskOf(state, f.taskId);
      expect(f.fakes.openings("builder").length).toBe(builders + 1);
      expect(task.checkReturns).toBe(2);
      expect(sentBack(task)).toBe(2);
      expect(f.fakes.openings("code reviewer")).toHaveLength(0);

      f.fakes.scenario({ planner: "short", builder: "plain", controlled: true, fixes: "change" });
      f.engine.requestChanges(itemOf(state, f.taskId, "delivery")!.id, "Make the actual fix");
      state = await until(f.engine, (state) => itemOf(state, f.taskId, "delivery")?.title.startsWith("Ready to ship") ?? false, releaseAll);
      expect(f.runs()).toEqual(["failed", "passed"]);
      expect(taskOf(state, f.taskId).checkReturns).toBeUndefined();
      await f.restart();
      expect(taskOf(f.engine.getState(), f.taskId).checkReturns).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });

  it("restores a saved task's spent allowance at its next verified pass", async () => {
    const f = await fixture(true, { planner: "short", builder: "plain" }, { checkArgs: ["--pass"] });
    try {
      await f.delivery();
      // Saved before episodes existed: both returns spent, although the checks pass now.
      await f.restart((state) => { state.tasks.find((task) => task.id === f.taskId)!.checkReturns = 2; });
      expect(taskOf(f.engine.getState(), f.taskId).checkReturns).toBe(2);
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const state = await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toEqual(["passed"]);
      expect(taskOf(state, f.taskId).checkReturns).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });

  it("keeps a check open when the Builder blames the environment, and shows that answer as its claim", async () => {
    const claim = "Nothing to fix: the check failed because the Mac went to sleep.";
    const f = await fixture(true, { planner: "short", builder: "plain", answer: { fixed: false, text: claim } });
    try {
      const task = await f.delivery();
      expect(f.runs()).toEqual(["failed"]);
      expect(task.checkReturns).toBe(2);
      const failure = task.findings.find((finding) => finding.text.startsWith("Check failed"))!;
      expect(failure).toEqual(expect.objectContaining({ status: "open", answer: expect.objectContaining({ fixed: false, text: claim }) }));
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).toContain(`The Builder's last answer: “${claim}”`);
      expect(f.fakes.openings("code reviewer")).toHaveLength(0);
      expect(task.journey!.filter((step) => step.fixing && step.roleId === "builder").every((step) => step.outcome === "No code changes; checks still failing")).toBe(true);
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).toContain("not independently confirmed");
    } finally { await f.engine.shutdown(); }
  });

  it("runs unchanged work only on the coordinator's explicit request and resumes review after a pass", async () => {
    const f = await fixture(true, { planner: "short", builder: "plain" }, { checkArgs: ["--sequence=FFP"] });
    try {
      const first = await f.delivery();
      expect(first.checkReturns).toBe(2);
      expect(f.runs()).toEqual(["failed"]);
      f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const second = await f.delivery();
      expect(f.runs()).toEqual(["failed", "failed"]);
      expect(second.checkReturns).toBe(2);
      expect(second.approvedFor).toBeUndefined();
      expect(f.fakes.openings("builder")).toHaveLength(3);
      expect(checkSteps(second)).toHaveLength(2);
      f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const passing = await f.delivery();
      expect(f.runs()).toEqual(["failed", "failed", "passed"]);
      expect(f.fakes.openings("code reviewer")).toHaveLength(1);
      expect(passing.approvedFor).toBeUndefined();
      expect(passing.checkReturns).toBeUndefined();
      expect(checkSteps(passing)).toHaveLength(3);
      expect(passing.journey!.filter((step) => step.work === "checks")[0]).toEqual(checkSteps(first)[0]);
    } finally { await f.engine.shutdown(); }
  });
});
