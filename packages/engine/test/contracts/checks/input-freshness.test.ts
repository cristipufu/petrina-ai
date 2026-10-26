import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { commandInputText } from "../../../src/checks.js";
import { git, makeProduct, removeDir, tempDir, waitForFile } from "../../fixtures.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { checkContext } from "../../fixtures/check-context.js";
import { writeGitProgram } from "@petrina/test-support/git-program";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("requires a fresh execution when a saved complete pass has no recorded check definition", async () => {
  const root = tempDir("petrina-check-definition-");
  let f: Awaited<ReturnType<typeof checkContext>> | undefined;
  try {
    f = await checkContext(root);
    f.setCheck("--sequence=PF");
    expect((await f.check()).kind).toBe("passed");
    const checks = f.engine["checks"], saved = f.scope.work.checks!;
    const originalAt = saved.at, originalResult = structuredClone(saved.results);
    delete saved.definition;
    const required = await checks.ensureChecks(f.scope, new AbortController().signal);
    expect((await checks.current(f.scope)).inputs.kind).not.toBe("matches");
    const captured = await checks["captureState"](f.scope, required);
    const live = await checks["observeSetup"](f.scope, required, captured, new AbortController().signal, {}, "before-checks");
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
    if (f) { await f.engine.shutdown(); removeDir(root); }
  }
});

it("does not reuse an unbound product pass when a previously failing hook now passes", async () => {
  const root = tempDir("petrina-hook-definition-");
  let f: Awaited<ReturnType<typeof checkContext>> | undefined;
  try {
    f = await checkContext(root);
    f.setCheck("--sequence=PF");
    const hooks = join(root, "product-hooks"), hook = join(hooks, "pre-commit");
    writeGitProgram(hook, "exit 7");
    await git(f.scope.work.worktree!, "config", "core.hooksPath", hooks);
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
    if (f) { await f.engine.shutdown(); removeDir(root); }
  }
});

it("does not mistake a configured hook command for an automatically appended hook result", async () => {
  const root = tempDir("petrina-explicit-hook-check-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    const task = engine.task(engine.addTask({ productId, title: "An explicit check" }))!;
    const scope = executionFor(task);
    scope.work.worktree = engine.productOf(task)!.path;
    engine.setProductChecks(productId, [{ name: "Repository check", command: "git hook run --ignore-missing pre-commit" }]);
    expect((await engine["checks"].failing(scope, new AbortController().signal)).kind).toBe("passed");
    expect(scope.work.checks!.results.map(run => run.command)).toEqual(["git hook run --ignore-missing pre-commit"]);
    expect(task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(1);
  } finally { await engine.shutdown(); }
});

it("cannot use an old passing command when required checks change during execution", async () => {
  const root = tempDir("petrina-changing-check-inputs-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  const release = join(root, "release"), started = join(root, "started"), log = join(root, "runs");
  const script = join(root, "check.ts");
  writeFileSync(script, `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const [mode, started, release, log] = process.argv.slice(2);
appendFileSync(log, mode + "\\n");
if (mode === "old-pass") { writeFileSync(started, "ready"); while (!existsSync(release)) await Bun.sleep(10); }
process.exit(mode === "new-fail" ? 1 : 0);`);
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    const task = engine.task(engine.addTask({ productId, title: "Check freshness" }))!;
    const scope = executionFor(task);
    scope.work.worktree = engine.productOf(task)!.path;
    const definitions = (mode: string) => [{ name: "Tests", command: commandInputText([process.execPath, script, mode, started, release, log]) }];
    engine.setProductChecks(productId, definitions("old-pass"));
    const running = engine["checks"].failing(scope, new AbortController().signal);
    try {
      await waitForFile(started);
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
  } finally { writeFileSync(release, "go"); await engine.shutdown(); }
});

it("bounds changing-input revalidation and never reports an obsolete pass as current", async () => {
  const root = tempDir("petrina-unstable-check-inputs-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  const script = join(root, "check.ts");
  writeFileSync(script, `import { existsSync, writeFileSync } from "node:fs";
const [started, release] = process.argv.slice(2);
writeFileSync(started, "ready"); while (!existsSync(release)) await Bun.sleep(10);`);
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    const task = engine.task(engine.addTask({ productId, title: "Unstable requirements" }))!;
    const scope = executionFor(task);
    scope.work.worktree = engine.productOf(task)!.path;
    const define = (index: number) => engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, script, join(root, `started-${index}`), join(root, `release-${index}`)]) }]);
    define(0);
    const running = engine["checks"].failing(scope, new AbortController().signal);
    // Attach the rejection handler before deliberately releasing the last invalidated pass.
    const rejected = expectRejection(running, "check inputs kept changing");
    for (let index = 0; index < 3; index += 1) {
      await waitForFile(join(root, `started-${index}`));
      define(index + 1);
      writeFileSync(join(root, `release-${index}`), "go");
    }
    await rejected;
    expect(scope.work.checks?.current).toBe(false);
    expect(task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(3);
    expect(scope.work.approvedSha).toBeUndefined();
  } finally {
    for (let index = 0; index < 4; index += 1) writeFileSync(join(root, `release-${index}`), "go");
    await engine.shutdown();
  }
});
