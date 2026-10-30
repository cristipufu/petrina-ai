import { existsSync } from "node:fs";
import { rejectionOf } from "@petrina/test-support/rejections";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { readFileSync } from "node:fs";
import { Coordination } from "../../../src/coordination.js";
import { commandInputText } from "../../../src/checks.js";
import * as fs from "node:fs/promises";
import { cpSync } from "node:fs";
import { detachRepositoryState, executionFor } from "@petrina/orchestrator";
import { repositorySeed } from "@petrina/test-support/repositories";
import { waitFor } from "../../fixtures.js";
import { writeFileSync } from "node:fs";
import * as gitOps from "@petrina/repositories/git";
import { git } from "../../fixtures.js";
import { gitCommand, writeGitProgram } from "@petrina/test-support/git-program";
import { expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { checkOutcome, checkProblem, deliveryCheckProblem, checkSetupOutcome, recordedCheckBatch, sameCheckEnvironmentIdentity } from "@petrina/core";
import * as environment from "@petrina/repositories/check-environment";
import { checkSetupFixture } from "../../fixtures/check-setup.js";
import { readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { waitForFile, powerLogSleep, SLOW } from "../../fixtures.js";

it("records the actual baseline for a first empty batch without taking a command place, and reads never resample it", async () => {
  const f = await checkSetupFixture();
  let restore: (() => void) | undefined;
  try {
    f.setChecks([]);
    const acquire = spyOn(f.engine.checkQueue, "acquire"); restore = () => acquire.mockRestore();
    const result = await f.check();
    expect(result.kind).toBe("passed");
    expect(acquire).not.toHaveBeenCalled();
    expect(f.invocations()).toEqual([]);
    expect(f.scope.work.checkSetup).toMatchObject({ requirements: [], results: [], lifecycle: "settled" });
    expect(f.scope.work.checkSetup!.executor).toEqual(environment.observeCheckExecutor().executor);
    expect(recordedCheckBatch(f.scope.work).kind).toBe("passed");
    restore(); restore = undefined;
    const baseline = spyOn(environment, "observeCheckExecutor");
    restore = () => baseline.mockRestore();
    baseline.mockImplementation(() => { throw new Error("Reads must not observe a live executor"); });
    expect((await f.native(() => f.engine["checks"].current(f.scope))).inputs.kind).toBe("matches");
    const sections = await f.native(() => f.engine["context"].sectionsFor(f.scope, "code-reviewer"));
    expect(sections.map(section => section.body).join("\n")).toContain("this read did not revalidate the local environment");
    expect(baseline).not.toHaveBeenCalled();
  } finally { try { restore?.(); } finally { await f.close(); } }
});

for (const declared of [false, true]) it(`reuses a stable complete batch after a real SQLite restart (declared setup: ${declared})`, async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["product"]);
    if (declared) f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n", stderr: "compiler metadata\n" });
    expect((await f.check()).kind).toBe("passed");
    const previous = structuredClone(f.scope.work.checks!), runs = f.invocations().filter(kind => kind === "product");
    expect(runs).toEqual(["product"]);
    expect(previous.environment).toBeDefined();
    await f.restart();
    expect(f.scope.work.checks!.results).toEqual(previous.results);
    expect((await f.check()).kind).toBe("passed");
    expect(f.invocations().filter(kind => kind === "product")).toEqual(["product"]);
    expect(f.scope.work.checks!.results).toEqual(previous.results);
    const reuse = f.task.journey!.flatMap(step => step.reuses ?? []).at(-1)!;
    expect(reuse.passed).toBe(true);
    expect(f.scope.work.checkSetup!.requirements).toHaveLength(declared ? 1 : 0);
    expect(reuse.environment).toEqual({ identity: f.scope.work.checkSetup!.identity!, setupAttemptId: f.scope.work.checkSetup!.id });
    const node = f.task.journey!.find(step => step.checkSetups?.some(attempt => attempt.id === reuse.environment!.setupAttemptId))!;
    const snapshot = structuredClone(node.checkSetups!.find(attempt => attempt.id === reuse.environment!.setupAttemptId)!);
    expect(snapshot.queuedAt).toBeGreaterThanOrEqual(previous.at);
    expect((await f.check()).kind).toBe("passed");
    expect(f.scope.work.checkSetup!.id).not.toBe(snapshot.id);
    await f.restart();
    const savedNode = f.task.journey!.find(step => step.id === node.id)!;
    expect(savedNode.checkSetups!.find(attempt => attempt.id === snapshot.id)).toEqual(snapshot);
    expect(f.scope.work.checks).toEqual(previous);
    if (declared) {
      const coordination = new Coordination(f.engine);
      const log = await f.native(() => coordination.call("journey.check", { taskId: f.taskId, nodeId: savedNode.id, setupAttemptId: snapshot.id, index: 0 }));
      expect(log.outcome).toBe("completed");
      expect(log.text).toContain("compiler 1");
    }
  } finally { await f.close(); }
});

it("a real unmet prerequisite blocks the first batch without a code finding or Builder charge", async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { code: 7, stdout: "compiler missing\n", stderr: "needs local setup\n" });
    expect((await f.check()).kind).toBe("blocked");
    expect(f.invocations()).toEqual(["compiler"]);
    expect(f.scope.work.checks).toBeUndefined();
    expect(checkSetupOutcome(f.scope.work.checkSetup)).toMatchObject({ kind: "unmet", code: 7 });
    expect(checkProblem(f.scope.work)).toBe("unverified");
    expect(f.task.findings).toEqual([]);
    expect(f.scope.work.checkReturns).toBeUndefined();
    const run = f.scope.work.checkSetup!.results[0]!.run;
    expect(checkOutcome(run).kind).toBe("failed");
    expect(run.outputIdentity!.stdout.digest).not.toBe(run.outputIdentity!.stderr.digest);
    const attempt = structuredClone(f.scope.work.checkSetup), marker = structuredClone(f.scope.work.checkSetupInvalidated);
    expect((await f.check()).kind).toBe("blocked");
    expect(f.invocations()).toEqual(["compiler"]);
    expect(f.scope.work.checkSetup).toEqual(attempt);
    expect(f.scope.work.checkSetupInvalidated).toEqual(marker);
  } finally { await f.close(); }
});

it("records actual startup unavailability as local setup, retaining zero product executions", async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["product"]);
    f.engine.setProductCheckSetup("product", [{ id: "missing", name: "Missing compiler", argv: [join(f.root, "not-installed")] }]);
    expect((await f.check()).kind).toBe("blocked");
    expect(f.invocations()).toEqual([]);
    expect(checkSetupOutcome(f.scope.work.checkSetup).kind).toBe("unavailable");
    expect(f.task.findings).toEqual([]);
    expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.scope.work.checks).toBeUndefined();
  } finally { await f.close(); }
});

it("keeps the old failure and allowance through setup repair, and explicit rerun executes a fresh full batch on identical probe bytes", async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n" }); f.command("product", { code: 7, stdout: "broken product\n" });
    expect((await f.check()).kind).toBe("product-failed");
    const previous = structuredClone(f.scope.work.checks!);
    f.scope.work.checkReturns = 1;
    f.command("compiler", { code: 9, stdout: "compiler 1\n" });
    expect((await f.check()).kind).toBe("blocked");
    expect(f.scope.work.checks!.results).toEqual(previous.results);
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.task.findings.some(finding => finding.status === "open")).toBe(true);
    f.command("compiler", { stdout: "compiler 1\n" }); f.command("product", { stdout: "fixed product\n" });
    // A repaired local setup does not silently retry a previously blocked batch.
    expect((await f.check()).kind).toBe("blocked");
    expect(f.invocations().filter(kind => kind === "product")).toHaveLength(1);
    f.task.stageIndex = 2; f.engine.gate(f.task, "delivery");
    const item = f.engine.s.inbox.find(item => item.taskId === f.taskId && item.kind === "delivery")!;
    f.engine.rerunChecks(item.id);
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.scope.work.approvedSha).toBeUndefined();
    expect((await f.check()).kind).toBe("passed");
    expect(f.invocations().filter(kind => kind === "product")).toHaveLength(2);
    expect(sameCheckEnvironmentIdentity(previous.environment, f.scope.work.checks!.environment)).toBe(true);
    expect(f.scope.work.checkSetupInvalidated).toBeUndefined();
    expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.task.findings.every(finding => finding.status !== "open")).toBe(true);
  } finally { await f.close(); }
});

it("changed actual prerequisite output invalidates whole reuse without decorating old rows", async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n", stderr: "" });
    expect((await f.check()).kind).toBe("passed");
    const old = f.scope.work.checks!, rows = structuredClone(old.results), identity = structuredClone(old.environment);
    f.command("compiler", { stdout: "compiler 1\n", stderr: "new setup facts\n" });
    expect((await f.check()).kind).toBe("passed");
    expect(f.invocations().filter(kind => kind === "product")).toHaveLength(2);
    expect(sameCheckEnvironmentIdentity(identity, f.scope.work.checks!.environment)).toBe(false);
    expect(old.results).toEqual(rows); expect(old.environment).toEqual(identity);
  } finally { await f.close(); }
});

for (const verification of [false, true]) it(`lets an admitted check finish during a graceful pause and reuses it after resume without a setup fault or full rerun${verification ? " through the verification entry" : ""}`, async () => {
  const f = await checkSetupFixture();
  const mark = join(f.root, "started"), release = join(f.root, "release");
  let running: ReturnType<typeof f.run> | undefined;
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n" });
    f.command("product", { mark, release, stdout: "passed after pause\n" });
    running = verification ? f.check() : f.run();
    await waitForFile(mark, { during: running });
    f.engine.setPoolPaused(true);
    f.release(release);
    expect((await running).kind).toBe("passed");
    expect(f.engine.s.pool.paused).toBe(true);
    expect(checkSetupOutcome(f.scope.work.checkSetup).kind).toBe("verified");
    expect(f.scope.work.checks!.current).toBe(true);
    expect(f.scope.work.checks!.results[0]!.ok).toBe(true);
    f.engine.setPoolPaused(false);
    expect((await f.check()).kind).toBe("passed");
    expect(f.invocations().filter(kind => kind === "product")).toEqual(["product"]);
    expect(f.scope.work.checkReturns).toBeUndefined();
  } finally { f.release(release); try { await running; } finally { await f.close(); } }
});

it("validates the entire setup declaration atomically, retains literal argv, and normalizes no-op saves", async () => {
  const f = await checkSetupFixture();
  try {
    const first = [{ id: " compiler ", name: " Compiler ", argv: [process.execPath, "", "literal $HOME"] }];
    f.engine.setProductCheckSetup("product", first);
    const declaration = structuredClone(f.product.checkSetup), invalidation = structuredClone(f.scope.work.checkSetupInvalidated);
    expect(f.product.checkSetup!.requirements).toEqual([{ ...first[0]!, id: "compiler", name: "Compiler" }]);
    f.engine.setProductCheckSetup("product", [{ ...first[0]!, id: "compiler", name: "Compiler" }]);
    expect(f.product.checkSetup).toEqual(declaration);
    expect(f.scope.work.checkSetupInvalidated).toEqual(invalidation);
    expect(() => f.engine.setProductCheckSetup("product", [...first, { id: "compiler", name: "Other", argv: ["other"] }])).toThrow("unique");
    expect(f.product.checkSetup).toEqual(declaration);
    expect(f.scope.work.checkSetupInvalidated).toEqual(invalidation);
    f.engine.setProductCheckSetup("product", []);
    const cleared = structuredClone(f.product.checkSetup);
    expect(cleared!.requirements).toEqual([]);
    expect(cleared!.revision).not.toBe(declaration!.revision);
    f.engine.setProductCheckSetup("product", []);
    expect(f.product.checkSetup).toEqual(cleared);
    expect(f.invocations()).toEqual([]);
  } finally { await f.close(); }
});

it("explicit stuck Retry invalidates the selected setup observation and runs fresh full checks on identical setup facts", async () => {
  const f = await checkSetupFixture();
  let restore: (() => void) | undefined;
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n" });
    expect((await f.check()).kind).toBe("passed");
    const previous = structuredClone(f.scope.work.checks!);
    f.scope.work.checkReturns = 1;
    const identity = spyOn(environment, "deriveCheckEnvironmentIdentity");
    restore = () => identity.mockRestore();
    identity.mockImplementation(() => { throw new Error("Setup identity recording unavailable"); });
    expect((await f.check()).kind).toBe("blocked");
    expect(checkSetupOutcome(f.scope.work.checkSetup).kind).toBe("unavailable");
    expect(f.scope.work.checkSetupInvalidated).toBeUndefined();
    restore(); restore = undefined;
    // The actual failed-task transition receives the recording failure; Retry owns its fresh-check intent.
    f.engine.fail(f.taskId, new Error("Setup identity recording unavailable"));
    const stuck = f.engine.s.inbox.find(item => item.taskId === f.taskId && item.kind === "stuck")!;
    expect(stuck).toBeDefined();
    await f.native(() => f.engine.retry(stuck.id));
    expect(f.scope.work.checkSetupInvalidated!.kind).toBe("explicit-rerun");
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.scope.work.checks!.results).toEqual(previous.results);
    expect((await f.check()).kind).toBe("passed");
    expect(f.invocations().filter(kind => kind === "product")).toHaveLength(2);
    expect(sameCheckEnvironmentIdentity(previous.environment, f.scope.work.checks!.environment)).toBe(true);
    expect(f.scope.work.checkSetupInvalidated).toBeUndefined();
  } finally { try { restore?.(); } finally { await f.close(); } }
});

for (const changed of [false, true]) it(`reuses retained product rows for opaque hook checks only under the same fresh setup (changed: ${changed})`, async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n" });
    await f.native(async () => {
      writeFileSync(join(f.path, "README.md"), "The reviewed task change\n");
      await gitOps.commitChanges(f.path, "Prepare the task change");
      const hooks = join(f.root, "hooks");
      writeGitProgram(join(hooks, "pre-commit"), gitCommand(f.argv("hook").map((part, index) => index === 2 ? part : { path: part })));
      await git(f.path, "config", "core.hooksPath", hooks);
    });
    expect((await f.check()).kind).toBe("passed");
    const original = f.scope.work.checks!.results[0]!, saved = structuredClone(original);
    expect(f.invocations().filter(kind => kind === "hook")).toHaveLength(1);
    if (changed) f.command("compiler", { stdout: "compiler 2\n" });
    expect((await f.check()).kind).toBe("passed");
    expect(f.invocations().filter(kind => kind === "product")).toHaveLength(changed ? 2 : 1);
    expect(f.invocations().filter(kind => kind === "hook")).toHaveLength(2);
    expect(original).toEqual(saved);
    expect(f.scope.work.checks!.results.map(run => checkOutcome(run).kind)).toEqual(["passed", "passed"]);
    expect(f.scope.work.checks!.results[0] === original).toBe(!changed);
  } finally { await f.close(); }
});

it("retains actual raw product success but no pass authority or episode reset when post-check setup changed", async () => {
  const f = await checkSetupFixture();
  const mark = join(f.root, "product-ready"), release = join(f.root, "release-product");
  let running: ReturnType<typeof f.check> | undefined;
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n" });
    f.command("product", { mark, release, stdout: "product passed\n" });
    f.scope.work.checkReturns = 2;
    running = f.check();
    await waitForFile(mark, { during: running });
    f.command("compiler", { stdout: "compiler 2\n" });
    f.release(release);
    expect((await running).kind).toBe("blocked");
    expect(f.invocations().filter(kind => kind === "product")).toHaveLength(1);
    expect(f.scope.work.checks!.results[0]!.ok).toBe(true);
    expect(checkOutcome(f.scope.work.checks!.results[0]!).kind).toBe("passed");
    expect(f.scope.work.checks!.current).toBe(false);
    expect(f.scope.work.checks!.environment).toBeUndefined();
    expect(f.scope.work.checkReturns).toBe(2);
    expect(f.task.findings).toEqual([]);
    expect(recordedCheckBatch(f.scope.work).kind).toBe("blocked");
  } finally { f.release(release); try { await running; } finally { await f.close(); } }
});

// Unknown recorded ownership is covered with the actual portable review/evidence/repair owners.
// Keep native setup failure and parsed machine-interruption observations here.
for (const peer of ["unmet", "confirmed-interruption"] as const)
it(peer === "unmet" ? "actual review routing repairs only the live failed product beside a setup-blocked sibling's old failure"
  : `actual shared review keeps the whole-task ownership barrier precise for ${peer}`, async () => {
  const f = await checkSetupFixture();
  try {
    await f.native(async () => {
      const seed = await repositorySeed(), path = join(f.root, "second");
      cpSync(seed.clone, path, { recursive: true });
      f.engine.s.products.push({ id: "second", name: "Second", path, repo: "local/second", tone: "blue" });
      const first = f.scope.work;
      f.task.repositories = [{ ...first, delivery: "local", completedStages: [] }, { productId: "second", worktree: path, branch: "main", base: seed.head, baseSha: seed.head, delivery: "local", completedStages: [] }];
      f.task.activeProductId = "product"; f.task.leadProductId = "product";
      detachRepositoryState(f.task);
    });
    f.setChecks(["product"]); f.command("product", { code: 7, stdout: "first product failure\n" });
    f.engine.setProductChecks("second", [{ name: "second", command: commandInputText(f.argv("second")) }]);
    f.command("second", { code: 7, stdout: "second product failure\n" });
    expect((await f.check()).kind).toBe("product-failed");
    const signal = f.engine.stopRequested.signal, second = executionFor(f.task, "second");
    expect((await f.native(() => f.engine["checks"].failing(second, signal))).kind).toBe("product-failed");
    const previous = structuredClone(second.work.checks!.results);
    second.work.checkReturns = 1;
    if (peer === "unmet") {
      f.command("compiler-second", { code: 9, stdout: "second setup unavailable\n" });
      f.engine.setProductCheckSetup("second", [{ id: "compiler", name: "Compiler", argv: f.argv("compiler-second") }]);
    } else {
      const run = second.work.checks!.results[0]!, start = run.startedAt!, end = run.endedAt!;
      const sleep = powerLogSleep(start - 1000, Math.ceil((end - start + 2000) / 1000));
      f.engine.options.machineRecords = async () => f.task.activeProductId === "second" ? sleep : "";
    }
    const invocations = f.invocations();
    const result = await f.native(() => f.engine["reviews"].runReview(f.task, f.task.plan!.stages[1]!, signal));
    if (peer === "unmet") {
      expect(result).toBe("continue");
      expect(f.task.repair!.products).toEqual(["product"]);
      expect(executionFor(f.task, "product").work.checkReturns).toBe(1);
      expect(second.work.checkReturns).toBe(1);
      expect(second.work.checks!.results).toEqual(previous);
      expect(f.task.findings.filter(finding => finding.status === "open").map(finding => finding.productIds)).toEqual([["product"], ["second"]]);
    } else {
      expect(result).toBe("continue");
      expect(f.task.repair!.products).toEqual(["product"]);
      expect(executionFor(f.task, "product").work.checkReturns).toBe(1);
      expect(second.work.checkReturns).toBe(1);
      expect(recordedCheckBatch(second.work).kind).toBe("blocked");
      expect(f.invocations()).toEqual(invocations);
      expect(checkOutcome(second.work.checks!.results[0]!).kind).toBe("incomplete");
      expect(second.work.checks!.results[0]!.interruption).toMatchObject({ source: "macOS power log" });
    }
    expect(f.receipts().every(record => record.state === "ended")).toBe(true);
  } finally { await f.close(); }
});

it("actual release preparation restores its version and asks on setup failure without manufacturing a Builder finding", async () => {
  const f = await checkSetupFixture({ nativeGitCapture: true });
  let restore: (() => void) | undefined;
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n" });
    await f.native(async () => {
      writeFileSync(join(f.path, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
      await gitOps.commitChanges(f.path, "Declare the version");
    });
    expect((await f.check()).kind).toBe("passed");
    f.scope.work.checkReturns = 1;
    const before = readWorktreeCommit(f.path)!.commit;
    f.scope.work.delivery = "release";
    const stage = { id: "publish", title: "Publish", kind: "do" as const, roleId: "release-manager", profileIds: ["sol-high"] };
    f.task.plan!.stages.push(stage); f.task.stageIndex = 3;
    const releases = f.engine["shipping"].releases, choose = spyOn(releases, "chooseVersion");
    restore = () => choose.mockRestore();
    // Only unrelated remote version choice is scripted; setting/checking/restoring the actual Git version commit stays real.
    choose.mockImplementation(async scope => {
      scope.work.shipping!.version = "0.2.0"; scope.work.shipping!.tag = "v0.2.0";
      return releases["declaredVersions"](scope.work.worktree!, scope.work.shipping!.start!);
    });
    f.command("compiler", { code: 7, stdout: "compiler unavailable\n" });
    expect(await f.native(() => f.engine["shipping"]["prepare"](f.scope, stage, f.engine.stopRequested.signal))).toBe("stop");
    expect(readWorktreeCommit(f.path)!.commit).toBe(before);
    expect(f.scope.work.shipping).toBeUndefined();
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.task.findings).toEqual([]);
    expect(f.engine.s.inbox.some(item => item.taskId === f.taskId && item.kind === "delivery")).toBe(true);
    expect(f.invocations().filter(kind => kind === "product")).toHaveLength(1);
  } finally { try { restore?.(); } finally { await f.close(); } }
});

it("a declaration change while actual log setup waits forbids the obsolete spawn and checks the current command once", async () => {
  const f = await checkSetupFixture();
  let restore: (() => void) | undefined, release!: () => void;
  let running: ReturnType<typeof f.check> | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  try {
    f.setChecks(["old"]);
    const directory = join(f.data, "checks", f.taskId), original = fs.mkdir;
    const mkdir = spyOn(fs, "mkdir"); restore = () => mkdir.mockRestore();
    mkdir.mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]) === directory && !entered) { entered = true; await held; }
      return Reflect.apply(original, fs, args);
    }) as typeof fs.mkdir);
    running = f.check();
    await waitFor(() => entered, "the actual check log setup", undefined, { during: running });
    f.setChecks(["current"]); f.setSetup([]);
    release();
    const outcome = await running;
    if (outcome.kind === "blocked") console.error("Late setup-change outcome:", JSON.stringify({ kind: outcome.kind, reason: outcome.reason, setup: outcome.setup.kind }));
    expect(outcome.kind).toBe("passed");
    expect(f.invocations()).toEqual(["current"]);
    expect(f.scope.work.checks!.results[0]!.name).toBe("current");
    const attempts = f.task.journey!.flatMap(step => step.checkAttempts ?? []);
    expect(attempts[0]!.passed).toBe(false);
    expect(attempts.at(-1)!.passed).toBe(true);
  } finally { release(); try { restore?.(); } finally { try { await running; } finally { await f.close(); } } }
});

it("reads only the selected actual setup log and scopes same-content cursors to their immutable attempt", async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "αβ ".repeat(30), stderr: "the real stderr ending\n" });
    expect((await f.check()).kind).toBe("passed");
    const latest = f.scope.work.checkSetup!, node = f.task.journey!.find(step => step.checkSetups?.some(attempt => attempt.id === latest.id))!;
    const before = node.checkSetups!.find(attempt => attempt.position === "before-checks")!;
    const coordination = new Coordination(f.engine), args = { taskId: f.taskId, nodeId: node.id, productId: "product", setupAttemptId: latest.id, index: 0, limit: 17 };
    let page = await f.native(() => coordination.call("journey.check", args)), text = String(page.text ?? "");
    expect(page.outcome).toBe("completed"); expect(page.completeness).toBe("complete");
    while (page.shortened) {
      const cursor = page.next, previousOffset = page.offset;
      expect(typeof cursor).toBe("string");
      page = await f.native(() => coordination.call("journey.check", { ...args, cursor }));
      expect(page.outcome).toBe("completed"); expect(Number(page.offset)).toBeGreaterThan(Number(previousOffset));
      text += String(page.text ?? "");
    }
    expect(text).toBe(readFileSync(latest.results[0]!.run.logPath!, "utf8"));
    expect(text).toContain("αβ ".repeat(30)); expect(text).toContain("the real stderr ending");
    const firstResult = await f.native(() => coordination.call("journey.check", { ...args, setupAttemptId: before.id, section: "result", limit: 3 }));
    expect(firstResult.shortened).toBe(true);
    expect((await f.native(() => coordination.call("journey.check", { ...args, section: "result", cursor: firstResult.next }))).outcome).toBe("changed");
    expect((await f.native(() => coordination.call("journey.check", { ...args, setupAttemptId: "missing" }))).outcome).toBe("missing");
    expect((await f.native(() => coordination.call("journey.check", { ...args, nodeId: "wrong-node" }))).outcome).toBe("missing");
    expect((await f.check()).kind).toBe("passed");
    expect(f.scope.work.checkSetup!.id).not.toBe(latest.id);
    expect((await f.native(() => coordination.call("journey.check", { ...args, nodeId: undefined }))).outcome).toBe("missing");
    expect((await f.native(() => coordination.call("journey.check", args))).outcome).toBe("completed");
  } finally { await f.close(); }
});

it("restores a real probe's tracked write even when post-probe input observation rejects, retaining strict failed-owner evidence", async () => {
  const f = await checkSetupFixture({ nativeGitCapture: true });
  const cause = new Error("Post-probe inputs unavailable");
  const checks = f.engine["checks"], capture = checks["captureState"];
  let restored = false, confirmed = false;
  try {
    f.setChecks(["product"]); f.setSetup(["compiler"]);
    const file = join(f.path, "README.md"), original = readFileSync(file, "utf8");
    f.command("compiler", { stdout: "compiler 1\n", writeTracked: { file, text: "A probe must not change the reviewed product\n" } });
    let calls = 0;
    checks["captureState"] = async (...args) => {
      if (++calls === 2) throw cause;
      return Reflect.apply(capture, checks, args);
    };
    expect(await rejectionOf(f.check())).toBe(cause);
    checks["captureState"] = capture; restored = true;
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(f.invocations()).toEqual(["compiler"]);
    const run = f.scope.work.checkSetup!.results[0]!.run;
    expect(checkOutcome(run).kind).toBe("passed");
    expect(run.execution).toMatchObject({ exit: { status: "reported", code: 0 }, stdout: "eof", stderr: "eof" });
    expect(f.receipts()).toHaveLength(1);
    expect(f.receipts().every(record => record.state === "ended")).toBe(true);
    // Known rejection remains a strict failed operation; it never becomes automatic cleanup success.
    expect(await rejectionOf(f.close())).toBeInstanceOf(AggregateError);
    expect(existsSync(f.root)).toBe(true);
    confirmed = true;
  } finally {
    if (!restored) checks["captureState"] = capture;
    if (confirmed) removeFixtureRoot(f.root);
    else await f.close();
  }
});

it("the coordinator setup operation is idempotent, validates atomically and exposes saved settings without launching a probe", async () => {
  const f = await checkSetupFixture();
  let restore: (() => void) | undefined;
  try {
    const coordination = new Coordination(f.engine);
    const executor = spyOn(environment, "observeCheckExecutor"); restore = () => executor.mockRestore();
    executor.mockImplementation(() => { throw new Error("Saving or inspecting setup must not sample the executor"); });
    const args = { productId: "product", requirements: [{ id: "compiler", name: "Compiler", argv: f.argv("compiler") }], requestId: "save-local-setup" };
    expect((await f.native(() => coordination.call("product.check-setup", args))).outcome).toBe("completed");
    const declaration = structuredClone(f.product.checkSetup), invalidated = structuredClone(f.scope.work.checkSetupInvalidated);
    expect((await f.native(() => coordination.call("product.check-setup", args))).outcome).toBe("completed");
    expect(f.product.checkSetup).toEqual(declaration); expect(f.scope.work.checkSetupInvalidated).toEqual(invalidated);
    expect((await f.native(() => coordination.call("product.check-setup", { ...args, requirements: [] }))).outcome).toBe("conflict");
    expect((await f.native(() => coordination.call("product.check-setup", { ...args, requestId: "invalid-local-setup", requirements: [args.requirements[0], args.requirements[0]] }))).outcome).not.toBe("completed");
    expect(f.product.checkSetup).toEqual(declaration); expect(f.scope.work.checkSetupInvalidated).toEqual(invalidated);
    const product = await f.native(() => coordination.call("product.inspect", { productId: "product" }));
    expect(String(product.text)).toContain(declaration!.revision);
    const setup = await f.native(() => coordination.call("task.read", { taskId: f.taskId, section: "check-setup" }));
    expect(String(setup.text)).toContain("Recorded observations only");
    expect(f.invocations()).toEqual([]); expect(f.receipts()).toEqual([]);
    expect(executor).not.toHaveBeenCalled();
  } finally { try { restore?.(); } finally { await f.close(); } }
});


for (const declared of [false, true]) it(`keeps a verified actual failed command's bounded repair beside a timeout through reuse (declared setup: ${declared})`, async () => {
  const f = await checkSetupFixture();
  try {
    f.engine.options.checkTimeoutMs = 1000 * SLOW;
    f.setChecks(["failed", "held"]);
    if (declared) f.setSetup(["compiler"]);
    f.command("compiler", { stdout: "compiler 1\n" });
    f.command("failed", { code: 7, stdout: "actual code failure\n" });
    const mark = join(f.root, "held-ready");
    f.command("held", { mark, release: join(f.root, "never-release") });
    const first = await f.check();
    expect(first.kind).toBe("product-failed");
    if (first.kind !== "product-failed") throw new Error("The real completed failure must keep its bounded route");
    expect(first.failed.map(run => run.name)).toEqual(["failed"]);
    expect(existsSync(mark)).toBe(true);
    expect(first.results.map(run => checkOutcome(run).kind)).toEqual(["failed", "incomplete"]);
    expect(first.results[1]!.execution!.timedOut).toBe(true);
    expect(recordedCheckBatch(f.scope.work).kind).toBe("blocked");
    const saved = structuredClone(f.scope.work.checks!), invocations = f.invocations().filter(kind => kind !== "compiler");
    expect((await f.check()).kind).toBe("product-failed");
    expect(f.invocations().filter(kind => kind !== "compiler")).toEqual(invocations);
    expect(f.scope.work.checks!.results).toEqual(saved.results);
    expect(await f.native(() => f.engine["checks"].checksBeforeDelivery(f.scope, f.engine.stopRequested.signal))).toBe("returned");
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.task.fixing).toBe(true);
    expect(f.task.stageIndex).toBe(0);
    expect(f.scope.work.checks!.results[1]!.execution!.timedOut).toBe(true);
    // A conservative damaged ownership observation cannot inherit the verified failure's repair route.
    // The actor actually ended in the real timeout above; no passing or settlement facts are fabricated here.
    f.scope.work.checks!.results[1]!.execution!.outputCleanup = "unconfirmed";
    const uncertain = structuredClone(f.scope.work.checks!.results);
    expect((await f.check()).kind).toBe("blocked");
    expect(f.scope.work.checks!.results).toEqual(uncertain);
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.invocations().filter(kind => kind !== "compiler")).toEqual(invocations);
    // Removing the real binding cannot promote mixed history into live repair eligibility.
    delete f.scope.work.checks!.environment;
    expect((await f.check()).kind).toBe("blocked");
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.invocations().filter(kind => kind !== "compiler")).toEqual(invocations);
  } finally { await f.close(); }
});


it("approves the remaining shared delivery after published checks change, while unfinished stale or legacy evidence still requires a rerun", async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["product"]);
    expect((await f.check()).kind).toBe("passed");
    await f.native(async () => {
      const seed = await repositorySeed(), path = join(f.root, "remaining");
      cpSync(seed.clone, path, { recursive: true });
      f.engine.s.products.push({ id: "remaining", name: "Remaining", path, repo: "local/remaining", tone: "green", checks: [], checksBy: "coordinator" });
      const first = f.scope.work;
      f.task.repositories = [{ ...first, delivery: "local", completedStages: [], landed: { branch: "main", sha: first.checks!.sha! } },
        { productId: "remaining", worktree: path, branch: "main", base: seed.head, baseSha: seed.head, delivery: "local", completedStages: [] }];
      f.task.activeProductId = "remaining"; f.task.leadProductId = "product";
      detachRepositoryState(f.task);
    });
    const published = executionFor(f.task, "product").work, remaining = executionFor(f.task, "remaining");
    expect((await f.native(() => f.engine["checks"].failing(remaining, f.engine.stopRequested.signal))).kind).toBe("passed");
    const oldRows = structuredClone(published.checks!.results), invocations = f.invocations();
    f.engine.setProductChecks("product", [{ name: "Changed after delivery", command: commandInputText(f.argv("product")) }]);
    expect(published.checks!.current).toBe(false);
    expect(checkProblem(f.task)).toBe("unverified");
    expect(deliveryCheckProblem(f.task)).toBeUndefined();
    f.task.stageIndex = 2;
    f.engine.gate(f.task, "delivery");
    const first = f.engine.s.inbox.find(item => item.taskId === f.taskId && item.kind === "delivery")!;
    const coordination = new Coordination(f.engine);
    const inspected = await f.native(() => coordination.call("inbox.inspect", { itemId: first.id }));
    expect(inspected.decisions).toContain("inbox.approve");
    expect(inspected.decisions).not.toContain("inbox.rerun-checks");
    expect(() => f.engine.rerunChecks(first.id)).toThrow("no failed or unverified");
    expect((await f.native(() => coordination.call("inbox.approve", { itemId: first.id, revision: inspected.revision, requestId: "approve-unfinished-only" }))).outcome).toBe("completed");
    expect(published.checks!.results).toEqual(oldRows);
    expect(published.checks!.current).toBe(false);
    // The unfinished owner still needs genuine authority; neither stale nor old missing setup can pass.
    f.task.stageIndex = 2;
    remaining.work.checks!.current = false;
    f.engine.gate(f.task, "delivery");
    const second = f.engine.s.inbox.find(item => item.taskId === f.taskId && item.kind === "delivery")!;
    expect(() => f.engine.approve(second.id)).toThrow("failing or unverified");
    delete remaining.work.checkSetup;
    const blocked = await f.native(() => coordination.call("inbox.inspect", { itemId: second.id }));
    expect(blocked.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
    expect((await f.native(() => coordination.call("inbox.approve", { itemId: second.id, revision: blocked.revision, requestId: "deny-unverified-owner" }))).outcome).toBe("invalid");
    f.engine.rerunChecks(second.id);
    expect(remaining.work.checkSetupInvalidated!.kind).toBe("explicit-rerun");
    expect(published.checkSetupInvalidated).toBeUndefined();
    expect(published.checks!.results).toEqual(oldRows);
    expect(published.checks!.current).toBe(false);
    expect((await f.native(() => f.engine["checks"].failing(remaining, f.engine.stopRequested.signal))).kind).toBe("passed");
    f.engine.gate(f.task, "delivery");
    const final = f.engine.s.inbox.find(item => item.taskId === f.taskId && item.kind === "delivery")!;
    expect(() => f.engine.approve(final.id)).not.toThrow();
    expect(f.invocations()).toEqual(invocations);
    expect(published.checks!.results).toEqual(oldRows);
  } finally { await f.close(); }
});

it("retains missing-definition failures without refreshing history or settling a passed peer", async () => {
  const f = await checkSetupFixture();
  try {
    f.setChecks(["passing-peer", "failed-product"]);
    f.command("failed-product", { code: 7, stdout: "actual product failure\n" });
    expect((await f.check()).kind).toBe("product-failed");
    const saved = f.scope.work.checks!;
    delete saved.definition;
    saved.current = false;
    f.scope.work.checkReturns = 2;
    // A prior finding is history; a row without its definition cannot newly close it.
    const passing = saved.results.find(run => run.name === "passing-peer")!;
    const finding = { id: "historical-peer-finding", text: `Check failed: ${passing.name} (${passing.command})`, evidence: "Previously reported failure", severity: "blocking" as const,
      raisedBy: "petrina" as const, confirmedBy: [], status: "open" as const };
    f.task.findings.push(finding);
    const before = structuredClone(saved), attempts = f.invocations();
    expect((await f.check()).kind).toBe("product-failed");
    expect(f.invocations()).toEqual(attempts);
    expect(f.scope.work.checks).toEqual(before);
    expect(f.scope.work.checkReturns).toBe(2);
    expect(f.task.findings.find(entry => entry.id === finding.id)).toEqual(finding);
    expect(f.task.journey!.flatMap(step => step.reuses ?? []).at(-1)!.passed).toBe(false);
    expect(recordedCheckBatch(f.scope.work).kind).toBe("blocked");
  } finally { await f.close(); }
});
