import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { executionFor } from "@petrina/orchestrator";
import { commandInputText } from "../../../src/checks.js";
import { makeProduct, waitForFile } from "../../fixtures.js";
import { checkContext } from "../../fixtures/check-context.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { writeGitProgram } from "@petrina/test-support/git-program";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


it("requires a fresh execution when a saved complete pass has no recorded check definition", async () => {
  return engineCases.use("petrina-check-definition-", owner => checkContext(owner, async f => {
  try {
    f.setCheck("--sequence=PF");
    expect((await f.check()).kind).toBe("passed");
    const checks = f.engine["checks"], saved = f.scope.work.checks!;
    const originalAt = saved.at, originalResult = structuredClone(saved.results);
    delete saved.definition;
    const required = await checks.ensureChecks(f.scope, new AbortController().signal);
    expect((await checks.current(f.scope)).inputs.kind).not.toBe("matches");
    const captured = await checks["captureState"](f.scope, required);
    const live = await checks["observeSetup"]({
      scope: f.scope,
      checks: required,
      state: captured,
      signal: new AbortController().signal,
      env: {},
      position: "before-checks",
    });
    expect(await checks["savedProductResults"](f.scope, required, captured, live)).toBeUndefined();
    expect(saved.definition).toBeUndefined();
    expect(saved.at).toBe(originalAt); expect(saved.results).toEqual(originalResult);
    expect((await f.check()).kind).toBe("product-failed");
    expect(f.runs()).toEqual(["passed", "failed"]);
    expect(f.scope.work.checks!.definition).toMatch(/^[a-f0-9]{64}$/);
    expect(f.scope.work.checks!.results[0]!.ok).toBe(false);
    expect(saved.definition).toBeUndefined();
    expect(f.task.journey!.flatMap(step => step.reuses ?? []).some(reuse => reuse.passed)).toBe(false);
  } finally {
    if (f) { await owner.stop(f.engine); }
  }

  }));
});

it("does not reuse an unbound product pass when a previously failing hook now passes", async () => {
  return engineCases.use("petrina-hook-definition-", owner => checkContext(owner, async f => {
  const root = owner.root;
  try {
    f.setCheck("--sequence=PF");
    const hooks = join(root, "product-hooks"), hook = join(hooks, "pre-commit");
    writeGitProgram(hook, "exit 7");
    appendFileSync(join(f.scope.work.worktree!, ".git", "config"), `\n[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`);
    expect((await f.check()).kind).toBe("product-failed");
    const saved = f.scope.work.checks!;
    expect(saved.results.map(run => run.ok)).toEqual([true, false]);
    expect(f.runs()).toEqual(["passed"]);
    delete saved.definition;
    f.scope.work.checkReturns = 1;
    writeGitProgram(hook, "exit 0");
    expect((await f.check()).kind).toBe("product-failed");
    expect(f.runs()).toEqual(["passed", "failed"]);
    expect(f.scope.work.checks!.results.map(run => run.ok)).toEqual([false, true]);
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.scope.work.checks!.definition).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.definition).toBeUndefined();
  } finally {
    if (f) { await owner.stop(f.engine); }
  }

  }));
});

it("does not mistake a configured hook command for an automatically appended hook result", async () => {
  return engineCases.use("petrina-explicit-hook-check-", async owner => {
  const root = owner.root;
  const engine = owner.open(join(root, "data"), { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), terminals: () => [] });
  installSharedWorkflowFastPaths(engine, { fastCheckCapture: true });
  engine.schedule = () => {};
  try {
    const productId = await owner.run(engine, async () => {
      const clone = await makeProduct(root, { origin: "none" });
      await engine.waitUntilReady(); owner.check();
      return installPreparedProduct(engine, privateCloneProduct(clone));
    });
    const task = engine.task(engine.addTask({ productId, title: "An explicit check" }))!;
    const scope = executionFor(task);
    scope.work.worktree = engine.productOf(task)!.path;
    engine.setProductChecks(productId, [{ name: "Repository check", command: "git hook run --ignore-missing pre-commit" }]);
    const controller = new AbortController(); owner.onStop(() => controller.abort());
    expect((await owner.run(engine, () => engine["checks"].failing(scope, controller.signal))).kind).toBe("passed");
    expect(scope.work.checks!.results.map(run => run.command)).toEqual(["git hook run --ignore-missing pre-commit"]);
    expect(task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(1);
  } finally { await owner.stop(engine); }

  });
});

it("cannot use an old passing command when required checks change during execution", async () => {
  return engineCases.use("petrina-changing-check-inputs-", async owner => {
  const root = owner.root;
  const engine = owner.open(join(root, "data"), { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), terminals: () => [] });
  installSharedWorkflowFastPaths(engine, { fastCheckCapture: true });
  engine.schedule = () => {};
  const release = join(root, "release"), started = join(root, "started"), log = join(root, "runs");
  owner.onStop(() => writeFileSync(release, "go"));
  const script = join(root, "check.ts");
  writeFileSync(script, `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const [mode, started, release, log] = process.argv.slice(2);
appendFileSync(log, mode + "\\n");
if (mode === "old-pass") { writeFileSync(started, "ready"); while (!existsSync(release)) await Bun.sleep(10); }
process.exit(mode === "new-fail" ? 1 : 0);`);
  try {
    const productId = await owner.run(engine, async () => {
      const clone = await makeProduct(root, { origin: "none" });
      await engine.waitUntilReady(); owner.check();
      return installPreparedProduct(engine, privateCloneProduct(clone));
    });
    const task = engine.task(engine.addTask({ productId, title: "Check freshness" }))!;
    const scope = executionFor(task);
    scope.work.worktree = engine.productOf(task)!.path;
    const definitions = (mode: string) => [{ name: "Tests", command: commandInputText([process.execPath, script, mode, started, release, log]) }];
    engine.setProductChecks(productId, definitions("old-pass"));
    const controller = new AbortController();
    owner.onStop(() => controller.abort());
    let pending: Promise<unknown> | undefined;
    owner.onStop(async () => { await Promise.allSettled(pending ? [pending] : []); });
    const running = pending = engine["checks"].failing(scope, controller.signal);
    try {
      await waitForFile(started, { during: running });
      engine.setProductChecks(productId, definitions("new-fail"));
    } finally { writeFileSync(release, "go"); }
    expect((await running).kind).toBe("product-failed");
    expect(readFileSync(log, "utf8")).toBe("old-pass\nnew-fail\n");
    expect(scope.work.checks!.results[0]!.ok).toBe(false);
    const attempts = task.journey!.flatMap(step => step.checkAttempts ?? []);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.passed).toBe(false);
    expect(attempts[1]!.definition).not.toBe(attempts[0]!.definition);
    expect(scope.work.approvedSha).toBeUndefined();
  } finally { writeFileSync(release, "go"); await owner.stop(engine); }

  });
});
