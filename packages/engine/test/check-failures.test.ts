import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyProblems, type DeepMutable, type State, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { commandText } from "../src/checks.js";
import { Store } from "../src/store.js";
import type { Scenario } from "./fake-agent.js";
import { coordinator, Fakes, git, itemOf, makeProduct, removeDir, tempDir, taskOf, until, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(approveDelivery = true, scenario: Scenario = { planner: "short" }) {
  const root = tempDir("petrina-check-failure-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const file = join(root, "check.ts");
  const log = join(root, "runs.txt");
  // Count actual command invocations outside the working copy, where restoring tracked files cannot hide one.
  writeFileSync(file, `import { appendFileSync, existsSync } from "node:fs";
const ok = process.argv.includes("--pass") || existsSync("welcome.txt");
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
  setCheck();
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  return {
    fakes, repo, taskId, productId, root, log, command, setCheck,
    get engine() { return engine; },
    runs: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    delivery: () => until(engine, (state) => !!itemOf(state, taskId, "delivery"), coordinator(["plan"])).then((state) => taskOf(state, taskId)),
    async restart(edit?: (state: DeepMutable<State>) => void) {
      await engine.shutdown();
      if (edit) {
        const store = new Store(join(root, "data", "petrina.db"));
        const state = store.load()!;
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

describe.concurrent("failed checks are evidence until something changes", () => {
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
    } finally { await f.engine.shutdown(); }
  });

  it("tells acceptance testing whether saved checks really cover the code and required commands", async () => {
    const f = await fixture();
    try {
      f.setCheck("--pass");
      await f.delivery();
      const task = f.engine.task(f.taskId)!;
      const saved = structuredClone(task.checks!);
      const evidence = async () => (await f.engine["context"].sectionsFor(task, "tester")).find((section) => section.title.includes("product checks"));
      expect(await evidence()).toEqual(expect.objectContaining({ title: "Current product checks, run by Petrina itself", body: expect.stringContaining("do not rerun the full checks") }));

      writeFileSync(join(task.worktree!, "greeting.txt"), "Uncommitted change\n");
      expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
      git(task.worktree!, "add", "greeting.txt");
      git(task.worktree!, "commit", "-q", "-m", "A real change");
      expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
      git(task.worktree!, "reset", "--hard", saved.sha!);
      expect((await evidence())?.title).toBe("Current product checks, run by Petrina itself");

      f.setCheck("--pass", "--changed");
      expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
      f.setCheck("--pass");
      task.checks!.results = [{ ...saved.results[0]!, ok: false, timedOut: true }];
      expect((await evidence())?.body).toContain("not passing acceptance evidence");
      expect((await evidence())?.body).not.toContain("Use them for automated acceptance");
      task.checks!.results = [];
      expect(await evidence()).toBeUndefined();
      task.checks = structuredClone(saved);
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
      expect(failure.evidence).toContain("captured failure");
      expect(f.fakes.prompts("builder").filter((text) => text.includes("captured failure"))).toHaveLength(2);

      await f.restart();
      expect(taskOf(f.engine.getState(), f.taskId).checks).toEqual(captured);
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the welcome page");
      task = await f.delivery();
      expect(f.runs()).toEqual(["failed"]);
      expect(task.checks).toEqual(captured);
      expect(task.checkReturns).toBe(2);
      expect(task.findings.filter((finding) => finding.text.startsWith("Check failed"))).toHaveLength(1);
      expect(checkSteps(task)).toEqual(recordedChecks);
      expect(journeyProblems(task)).toEqual([]);

      f.fakes.scenario({ planner: "short", fixes: "change" });
      f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Make the actual fix");
      task = await f.delivery();
      expect(f.runs()).toEqual(["failed", "passed"]);
      expect(task.checks!.tree).not.toBe(captured!.tree);
      expect(task.checks!.results.every((run) => run.ok)).toBe(true);
      expect(task.findings.find((finding) => finding.id === failure.id)?.status).toBe("fixed");
      expect(task.rounds[review.id] ?? 1).toBe(1);
      expect(task.blockingAfter?.[review.id]).toEqual([0]);
      expect(f.fakes.openings("code reviewer")).toHaveLength(1);
      expect(checkSteps(task)).toHaveLength(2);
      expect(checkSteps(task)[0]).toEqual(recordedChecks[0]);
      expect(checkSteps(task)[1]).toEqual(expect.objectContaining({ outcome: "The check passes", reason: "checks passed", end: "done" }));
      expect(task.journey!.find((step) => step.roleId === "code-reviewer")).toEqual(expect.objectContaining({ outcome: "1 nit", reason: "review passed", end: "done" }));
      expect(journeyProblems(task)).toEqual([]);
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toEqual(["failed", "passed"]);
    } finally {
      f.engine.shutdown();
    }
  });

  it("does not consume more rounds when reviews were already exhausted, including a saved run from before the update", async () => {
    const f = await fixture();
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

  it("keeps a forced delivery decision and the coordinator's explicit Retry when automatic returns are used up", async () => {
    const f = await fixture(false);
    try {
      await f.delivery();
      expect(f.runs()).toEqual(["failed"]);
      // This task normally delivers without asking. Failed checks still bring it to the coordinator.
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      let state = await until(f.engine, (state) => taskOf(state, f.taskId).state === "failed", coordinator(["plan"]));
      expect(taskOf(state, f.taskId).error).toContain("checks fail");
      expect(f.runs()).toEqual(["failed"]);

      f.engine.retry(itemOf(state, f.taskId, "stuck")!.id);
      state = await until(f.engine, (state) => taskOf(state, f.taskId).state === "failed", coordinator(["plan"]));
      expect(f.runs()).toEqual(["failed", "failed"]);
      expect(taskOf(state, f.taskId).checks!.results[0]!.output).toContain("captured failure");

      f.setCheck("--pass");
      f.engine.retry(itemOf(state, f.taskId, "stuck")!.id);
      await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toEqual(["failed", "failed", "passed"]);
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
        const f = await fixture();
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
            expect(again.results.map(({ ms, logPath, ...run }) => run)).toEqual(refreshed.results.map(({ ms, logPath, ...run }) => run));
            expect(again.results.at(-1)!.logPath).not.toBe(refreshed.results.at(-1)!.logPath);
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
