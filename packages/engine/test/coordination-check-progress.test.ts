import { rejectionOf } from "./rejections.js";
import { executionFor } from "../src/repository-context.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JOURNEY_WORDS as W, journeyView, type ProductCheck, type WorkflowEvent } from "@petrina/core";
import * as gitOps from "../src/git.js";
import { Engine } from "./engine.js";
import { Aborted } from "../src/kernel.js";
import { Coordination } from "../src/coordination.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.shutdown()));
  roots.forEach(removeDir);
});
const options = { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] };
function fixture() {
  const root = tempDir("petrina-check-evidence-");
  roots.push(root);
  const home = join(root, "home");
  const engine = new Engine(home, options);
  engines.push(engine);
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  const product = makeProduct(root);
  engine.s.products.push({ id: "product", name: "Example", repo: "local/example", path: product, tone: "blue", delivery: "local" });
  const task = engine.task(engine.addTask({ productId: "product", title: "Check evidence" }))!;
  executionFor(task).work.worktree = product;
  task.plan = { stages: [{ id: "release", title: "Release", kind: "do", roleId: "release-manager", profileIds: ["opus-high"] }], rationale: "Release", plannerProfileId: "opus-high" };
  task.stageIndex = 0;
  task.journey = [{ id: "notes", kind: "agent", roleId: "release-manager", stageId: "release", startedAt: 1, round: 1, sub: 0 }];
  engine.setPoolPaused(false);
  const coordination = new Coordination(engine);
  return { root, home, engine, task, coordination };
}

it("records a first failure on its own code before completion, including a hook failure", async () => {
  const { engine, task, coordination } = fixture();
  const scope = executionFor(task);
  scope.work.baseSha = git(scope.work.worktree!, "rev-parse", "HEAD");
  scope.work.branch = git(scope.work.worktree!, "symbolic-ref", "--short", "HEAD");
  writeFileSync(join(scope.work.worktree!, "checked.txt"), "The change to check\n");
  git(scope.work.worktree!, "add", "."); git(scope.work.worktree!, "commit", "-qm", "Prepare the checked change");
  const check: ProductCheck = { name: "Quick", argv: [process.execPath, "-e", "process.exit(1)"] };
  task.journey = [];
  expect(await engine["checks"].runProductChecks(scope, [check], new AbortController().signal)).toBe(1);
  const page = await coordination.call("watch.events", { taskIds: [task.id], from: "oldest", kinds: ["check.finished"], timeoutMs: 0 });
  const event = (page.events as WorkflowEvent[])[0]!;
  expect(event).toMatchObject({ result: "fail", ok: false, versions: { attemptId: "run-0", sha: scope.work.checks!.sha, tree: scope.work.checks!.tree, definition: scope.work.checks!.definition } });
  expect(event.versions).not.toHaveProperty("passed", true);
  const hook = join(scope.work.worktree!, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nprintf 'Hook diagnostic\\n' >&2\nexit 1\n", { mode: 0o755 });
  const cursor = (await coordination.call("watch.events", { taskIds: [task.id], timeoutMs: 0 })).cursor;
  expect(await engine["checks"].runProductChecks(scope, [], new AbortController().signal)).toBe(1);
  const hooks = await coordination.call("watch.events", { taskIds: [task.id], cursor, kinds: ["check.finished"], timeoutMs: 0 });
  const finished = (hooks.events as WorkflowEvent[])[0]!;
  expect(finished).toMatchObject({ name: "Pre-commit hook", result: "fail", versions: { definition: scope.work.checks!.definition } });
  expect((finished.versions as { definition: string }).definition).not.toBe((event.versions as { definition: string }).definition);
});

it("retains live check progress and every original diagnostic through repeated preparation and restart", async () => {
  const { root, home, engine, task, coordination } = fixture();
  const release = join(root, "release");
  const checks: ProductCheck[] = [
    { name: "Quick", argv: [process.execPath, "-e", 'console.log("First preparation diagnostic")'] },
    { name: "Held", argv: [process.execPath, "-e", 'while (!(await Bun.file(process.argv[1]).exists())) await Bun.sleep(20);', release] },
  ];
  const cursor = (await coordination.call("watch.events", { taskIds: [task.id], timeoutMs: 0 })).cursor;
  const work = executionFor(task).work;
  const firstSha = git(work.worktree!, "rev-parse", "HEAD");
  const running = engine["checks"].runProductChecks(executionFor(task), checks, new AbortController().signal);
  try {
    await waitFor(() => task.journey![0]!.productChecks?.[0]?.result === "pass" && task.journey![0]!.productChecks?.[1]?.result === "running", "a completed check beside a running check");
    const node = await coordination.call("journey.node", { taskId: task.id, nodeId: "notes" });
    const recorded = JSON.parse(String(node.text)).productChecks;
    expect(recorded[0].run.logComplete).toBe(true);
    expect(recorded[1].startedAt).toBeNumber();
    const visible = journeyView(task, engine.activeState()).nodes[0]!.productChecks!;
    expect(visible[1]).toHaveProperty("id", "check-1");
    expect(visible[1]).toHaveProperty("startedAt");
    expect(visible[1]).toMatchObject({ attemptId: "run-0", productId: "product", queuedAt: expect.any(Number) });
    expect(visible[0]!.run).toEqual(task.journey![0]!.productChecks![0]!.run);
    expect(visible[0]!.run!.source).toEqual({ stepId: "notes", attemptId: "run-0", checkId: "check-0" });
    const batch = await coordination.call("watch.events", { taskIds: [task.id], cursor, timeoutMs: 0, limit: 100 });
    const completed = (batch.events as WorkflowEvent[]).find(event => event.kind === "check.finished")!;
    expect(completed).toEqual(expect.objectContaining({ name: "Quick", result: "pass", versions: expect.objectContaining({ sha: firstSha, tree: git(work.worktree!, "rev-parse", "HEAD^{tree}"), definition: expect.any(String), attemptId: "run-0" }) }));
    expect(completed.versions).not.toHaveProperty("passed");
  } finally { writeFileSync(release, "go"); }
  expect(await running).toBe(0);
  const firstLog = task.journey![0]!.productChecks![0]!.run!.logPath;
  const firstVersion = structuredClone(task.journey![0]!.checkAttempts![0]!);
  writeFileSync(join(work.worktree!, "changed.txt"), "New code for the next attempt\n");
  git(work.worktree!, "add", "."); git(work.worktree!, "commit", "-qm", "Change the checked code");
  const nextSha = git(work.worktree!, "rev-parse", "HEAD");
  const repeatCursor = (await coordination.call("watch.events", { taskIds: [task.id], timeoutMs: 0 })).cursor;
  const failure = "Original failure near the beginning\n" + "Later diagnostic line\n".repeat(9000);
  expect(await engine["checks"].runProductChecks(executionFor(task), [{ name: "Quick", argv: [process.execPath, "-e", 'await Bun.write(Bun.stderr, "Original failure near the beginning\\n" + "Later diagnostic line\\n".repeat(9000)); process.exit(1);'] }], new AbortController().signal)).toBe(1);
  const evidence = task.journey![0]!.productChecks!;
  expect(evidence).toHaveLength(3);
  expect(evidence[2]!.attemptId).not.toBe(evidence[0]!.attemptId);
  expect(new Set(evidence.map((check) => check.id)).size).toBe(3);
  expect(evidence[0]!.run!.logPath).toBe(firstLog);
  expect(evidence[2]!.run!.logPath).not.toBe(firstLog);
  const repeated = await coordination.call("watch.events", { taskIds: [task.id], cursor: repeatCursor, timeoutMs: 0, limit: 100 });
  const failed = (repeated.events as WorkflowEvent[]).find(event => event.kind === "check.finished")!;
  expect(failed).toMatchObject({ result: "fail", ok: false, versions: { attemptId: evidence[2]!.attemptId, sha: nextSha } });
  expect((failed.versions as { definition: string }).definition).not.toBe(firstVersion.definition);
  expect(failed.versions).not.toHaveProperty("passed", true);
  expect(task.journey![0]!.checkAttempts![0]).toEqual(firstVersion);
  // A newer successful run cannot replace the earlier failed run's diagnostics.
  expect(await engine["checks"].runProductChecks(executionFor(task), checks.slice(0, 1), new AbortController().signal)).toBe(0);
  task.state = "paused";
  engine.setPoolPaused(true);
  await engine.shutdown();
  const replacement = new Engine(home, { ...options, admissionsClosed: true });
  engines.push(replacement);
  const focused = new Coordination(replacement);
  expect(replacement.task(task.id)!.journey![0]!.productChecks![2]!.attemptId).toBe(evidence[2]!.attemptId);
  let page = await focused.call("journey.check", { taskId: task.id, nodeId: "notes", index: 2 });
  expect(page.commandOutcome).toBe("failed");
  expect(page.completeness).toBe("complete");
  let full = String(page.text);
  while (page.next) {
    page = await focused.call("journey.check", { taskId: task.id, nodeId: "notes", index: 2, cursor: page.next });
    full += page.text;
  }
  expect(full).toBe(failure);
  expect((await focused.call("journey.check", { taskId: task.id, nodeId: "notes", index: 0 })).text).toContain("First preparation diagnostic");
});

it("reuses the recorded attempt within repeated release preparation without linking another run's diagnostics", async () => {
  const { engine, task, coordination } = fixture();
  const scope = executionFor(task);
  const checks = [{ name: "Quick", argv: [process.execPath, "-e", "console.log('checked')"] }];
  engine.s.products[0]!.checks = checks;
  engine.s.products[0]!.checksBy = "coordinator";
  expect(await engine["checks"].runProductChecks(scope, checks, new AbortController().signal)).toBe(0);
  writeFileSync(join(scope.work.worktree!, "changed.txt"), "A new version for release preparation\n");
  git(scope.work.worktree!, "add", "."); git(scope.work.worktree!, "commit", "-qm", "Change the checked version");
  expect(await engine["checks"].runProductChecks(scope, checks, new AbortController().signal)).toBe(0);
  expect(task.journey).toHaveLength(1);
  const attempts = task.journey![0]!.checkAttempts!;
  expect(attempts).toHaveLength(2);
  expect(attempts.every(attempt => attempt.passed === true)).toBe(true);
  expect(attempts[0]!.sha).not.toBe(attempts[1]!.sha);
  expect(scope.work.checks!.provenance).toEqual({ nodeId: "notes", attemptId: attempts[1]!.id });
  const cursor = (await coordination.call("watch.events", { taskIds: [task.id], timeoutMs: 0 })).cursor;
  expect(await engine["checks"].failing(scope, new AbortController().signal, checks, "review")).toBe(false);
  const page = await coordination.call("watch.events", { taskIds: [task.id], cursor, timeoutMs: 0, kinds: ["check.reused"] });
  expect(page.events).toEqual([expect.objectContaining({ nodeId: "notes", attemptId: attempts[1]!.id, passed: true, refs: { node: { taskId: task.id, nodeId: "notes" }, checks: [{ taskId: task.id, nodeId: "notes", index: 1 }], details: expect.any(Object) } })]);
  expect(task.journey![0]!.reuses![0]!.attemptId).toBe(attempts[1]!.id);
});

it("keeps stopped check diagnostics beside completed peers without duplicating progress entries", async () => {
  const { engine, task, coordination } = fixture();
  const stop = new AbortController();
  const running = engine["checks"].runProductChecks(executionFor(task), [
    { name: "Quick", argv: [process.execPath, "-e", 'console.log("Completed peer")'] },
    { name: "Held", argv: [process.execPath, "-e", 'console.log("Before interruption"); await Bun.sleep(60000);'] },
  ], stop.signal).then(() => "finished", () => "stopped");
  try {
    await waitFor(() => task.journey![0]!.productChecks?.[0]?.result === "pass" && task.journey![0]!.productChecks?.[1]?.result === "running", "a completed peer before interruption");
  } finally { stop.abort(); }
  expect(await running).toBe("stopped");
  const checks = task.journey![0]!.productChecks!;
  expect(checks).toHaveLength(2);
  expect(checks[0]!.result).toBe("pass");
  expect(checks[0]!.run!.ok).toBe(true);
  expect(checks[1]!.result).toBe("stopped");
  expect(checks[1]!.run!.interrupted).toBe(true);
  const batch = await coordination.call("watch.events", { taskIds: [task.id], from: "oldest", timeoutMs: 0, limit: 100 });
  const completed = (batch.events as WorkflowEvent[]).filter(event => event.kind === "check.finished");
  expect(completed.map(event => event.result)).toEqual(["pass", "stopped"]);
  expect(completed.every(event => (event.versions as { sha?: string } | null)?.sha === git(executionFor(task).work.worktree!, "rev-parse", "HEAD"))).toBe(true);
  expect(task.journey![0]!.checkAttempts![0]).not.toHaveProperty("passed");
  expect((await coordination.call("journey.check", { taskId: task.id, nodeId: "notes", index: 1 })).commandOutcome).toBe("unfinished");
});

it("records a run with nothing to run, so reviewers start on none-configured rather than unavailable, directly and through reuse", async () => {
  const { engine, task, coordination } = fixture();
  const scope = executionFor(task);
  task.journey = [];
  engine.s.products[0]!.checks = [];
  engine.s.products[0]!.checksBy = "coordinator";
  const cursor = (await coordination.call("watch.events", { taskIds: [task.id], timeoutMs: 0 })).cursor;
  expect(await engine["checks"].failing(scope, new AbortController().signal, [], "review")).toBe(false);
  const step = task.journey![0]!;
  expect(step).toMatchObject({ kind: "petrina", work: "checks", end: "done", outcome: W.checks(0, 0), reason: W.noChecks, productChecks: [] });
  expect(step.checkAttempts).toEqual([expect.objectContaining({ id: "run-0", commands: [], passed: true, definition: expect.any(String) })]);
  expect(scope.work.checks).toMatchObject({ current: true, results: [], provenance: { nodeId: step.id, attemptId: "run-0" } });
  task.journey!.push({ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", stageId: "release", round: 1, sub: 0, startedAt: Date.now(), trigger: { after: step.id, reason: step.reason! } });
  engine.commit(task);
  const first = (await coordination.call("watch.events", { taskIds: [task.id], cursor, timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
  expect(first.find((event) => event.kind === "node.finished")).toMatchObject({ nodeId: step.id, checks: { configured: 0, attempts: 1, attemptId: "run-0", ran: 0 }, versions: { attemptId: "run-0", passed: true } });
  expect(first.find((event) => event.kind === "node.started" && event.nodeId === "review")).toMatchObject({ checks: { basis: "none-configured", passed: null, configured: 0, nodeId: step.id, versions: { attemptId: "run-0" } } });
  // The same empty run is reused on unchanged code: still none-configured, never a pass.
  Object.assign(task.journey![1]!, { endedAt: Date.now(), end: "done" });
  engine.commit(task);
  const later = (await coordination.call("watch.events", { taskIds: [task.id], timeoutMs: 0 })).cursor;
  expect(await engine["checks"].failing(scope, new AbortController().signal, [], "acceptance")).toBe(false);
  expect(task.journey).toHaveLength(2);
  expect(step.reuses).toEqual([expect.objectContaining({ purpose: "acceptance", attemptId: "run-0", passed: true })]);
  task.journey!.push({ id: "tester", kind: "agent", roleId: "tester", profileId: "opus-high", stageId: "release", round: 1, sub: 0, startedAt: Date.now() });
  engine.commit(task);
  const second = (await coordination.call("watch.events", { taskIds: [task.id], cursor: later, timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
  expect(second.map((event) => event.kind)).toEqual(["check.reused", "node.started"]);
  expect(second[1]).toMatchObject({ nodeId: "tester", checks: { basis: "none-configured", reused: true, passed: null, configured: 0, purpose: "acceptance", attemptId: "run-0", nodeId: step.id } });
});

it("keeps uncommitted edits when there is nothing to run, and still records the empty run", async () => {
  const { engine, task } = fixture();
  const scope = executionFor(task);
  task.journey = [];
  engine.s.products[0]!.checks = [];
  engine.s.products[0]!.checksBy = "coordinator";
  const readme = join(scope.work.worktree!, "README.md");
  writeFileSync(readme, "# Demo\n\nAn edit nobody committed yet\n");
  const inspections = spyOn(gitOps, "worktreeStatus"), restores = spyOn(gitOps, "restoreTracked"), resets = spyOn(gitOps, "resetTo");
  try {
    // A check with no command counts as nothing to run, the same as an empty list.
    expect(await engine["checks"].runProductChecks(scope, [{ name: "Nothing", argv: [] }], new AbortController().signal)).toBe(0);
    expect(readFileSync(readme, "utf8")).toContain("An edit nobody committed yet");
    expect(task.journey![0]).toMatchObject({ kind: "petrina", work: "checks", end: "done", reason: W.noChecks, productChecks: [] });
    expect(task.journey![0]!.checkAttempts).toEqual([expect.objectContaining({ id: "run-0", commands: [] })]);
    // Nothing ran, so nothing is put back: the only inspection captured the versions before the run.
    expect(inspections).toHaveBeenCalledTimes(1);
    expect(restores).not.toHaveBeenCalled();
    expect(resets).not.toHaveBeenCalled();
    // Control: a check that changes a tracked file is put back, so nothing unreviewed joins the work.
    git(scope.work.worktree!, "add", "."); git(scope.work.worktree!, "commit", "-qm", "Keep the edit");
    const changing = { name: "Changing", argv: [process.execPath, "-e", "require('node:fs').appendFileSync('README.md', 'Added by a check\\n')"] };
    engine.s.products[0]!.checks = [changing];
    expect(await engine["checks"].runProductChecks(scope, [changing], new AbortController().signal)).toBe(0);
    expect(readFileSync(readme, "utf8")).not.toContain("Added by a check");
    expect(restores).toHaveBeenCalledTimes(1);
  } finally { inspections.mockRestore(); restores.mockRestore(); resets.mockRestore(); }
});

it("describes a resumed attempt with nothing left to run as nothing configured, not as the stopped attempt", async () => {
  const { root, engine, task, coordination } = fixture();
  const scope = executionFor(task);
  task.journey = [];
  const controller = new AbortController();
  const release = join(root, "release");
  const check = { name: "Quick", argv: [process.execPath, "-e", "if (!require('node:fs').existsSync(process.argv[1])) setTimeout(() => process.exit(0), 20000); else process.exit(0)", release] };
  engine.s.products[0]!.checks = [check];
  engine.s.products[0]!.checksBy = "coordinator";
  const running = engine["checks"].runProductChecks(scope, [check], controller.signal);
  await waitFor(() => task.journey![0]?.productChecks?.[0]?.result === "running", "the held check running");
  controller.abort();
  expect(await rejectionOf(running)).toBeInstanceOf(Aborted);
  writeFileSync(release, "go");
  const step = task.journey![0]!;
  expect(step.endedAt).toBeUndefined();
  // The coordinator removed the check before the retry: the second attempt records its versions and nothing else.
  engine.s.products[0]!.checks = [];
  const cursor = (await coordination.call("watch.events", { taskIds: [task.id], timeoutMs: 0 })).cursor;
  expect(await engine["checks"].runProductChecks(scope, [], new AbortController().signal)).toBe(0);
  expect(task.journey).toHaveLength(1);
  expect(step).toMatchObject({ end: "done", reason: W.noChecks });
  expect(step.productChecks!.map((entry) => [entry.attemptId, entry.result])).toEqual([["run-0", "stopped"]]);
  expect(step.checkAttempts!.map((attempt) => [attempt.id, attempt.commands.length, attempt.passed])).toEqual([["run-0", 1, undefined], ["run-1", 0, true]]);
  task.journey!.push({ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", stageId: "release", round: 1, sub: 0, startedAt: Date.now(), trigger: { after: step.id, reason: step.reason! } });
  engine.commit(task);
  const events = (await coordination.call("watch.events", { taskIds: [task.id], cursor, timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
  expect(events.find((event) => event.kind === "node.finished")).toMatchObject({ nodeId: step.id, checks: { attemptId: "run-1", attempts: 2, configured: 0, ran: 0, failed: 0, unfinished: 0 }, versions: { attemptId: "run-1", passed: true }, refs: { checks: [] } });
  expect(events.find((event) => event.kind === "node.started" && event.nodeId === "review")).toMatchObject({ checks: { basis: "none-configured", passed: null, configured: 0, attemptId: "run-1", attempts: 2, nodeId: step.id, versions: { attemptId: "run-1" } } });
});

it("describes the latest attempt when an interrupted run is resumed on the same step", async () => {
  const { root, engine, task, coordination } = fixture();
  const scope = executionFor(task);
  task.journey = [];
  const controller = new AbortController();
  const release = join(root, "release");
  // The same check definition both times: it waits until released, bounded on its own so a missed abort cannot hold the test.
  const check = { name: "Quick", argv: [process.execPath, "-e", "if (!require('node:fs').existsSync(process.argv[1])) setTimeout(() => process.exit(0), 20000); else process.exit(0)", release] };
  engine.s.products[0]!.checks = [check];
  engine.s.products[0]!.checksBy = "coordinator";
  const running = engine["checks"].runProductChecks(scope, [check], controller.signal);
  await waitFor(() => task.journey![0]?.productChecks?.[0]?.result === "running", "the held check running");
  controller.abort();
  expect(await rejectionOf(running)).toBeInstanceOf(Aborted);
  const step = task.journey![0]!;
  expect(step.endedAt).toBeUndefined();
  expect(step.productChecks![0]).toMatchObject({ attemptId: "run-0", result: "stopped" });
  writeFileSync(release, "go");
  const cursor = (await coordination.call("watch.events", { taskIds: [task.id], timeoutMs: 0 })).cursor;
  expect(await engine["checks"].runProductChecks(scope, [check], new AbortController().signal)).toBe(0);
  expect(task.journey).toHaveLength(1);
  expect(step.productChecks!.map((check) => [check.attemptId, check.result])).toEqual([["run-0", "stopped"], ["run-1", "pass"]]);
  task.journey!.push({ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", stageId: "release", round: 1, sub: 0, startedAt: Date.now(), trigger: { after: step.id, reason: step.reason! } });
  engine.commit(task);
  const events = (await coordination.call("watch.events", { taskIds: [task.id], cursor, timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
  expect(events.find((event) => event.kind === "node.finished")).toMatchObject({ nodeId: step.id, checks: { attemptId: "run-1", attempts: 2, configured: 1, ran: 1, passed: 1, failed: 0, unfinished: 0 }, versions: { attemptId: "run-1", passed: true }, refs: { checks: [{ nodeId: step.id, index: 1 }] } });
  expect(events.find((event) => event.kind === "node.started" && event.nodeId === "review")).toMatchObject({ checks: { basis: "ran", passed: true, attemptId: "run-1", attempts: 2, failed: 0, unfinished: 0, versions: { attemptId: "run-1" } } });
});
