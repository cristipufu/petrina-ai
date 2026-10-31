import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckId } from "@petrina/core";

import { checkAdmissionFixture } from "../../fixtures/check-admission.js";
import * as gitOps from "@petrina/repositories/git";
import { checksFingerprint } from "../../../src/checks.js";
import { waitFor, waitForFile } from "../../fixtures.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


for (const paused of [false, true]) it(`prepares queued review checks on current main exactly once${paused ? " after a pool pause" : ""}`, async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = await f.add("first"), second = await f.add("second", true);
  const updates = spyOn(f.engine["updates"], "upToDate");
    owner.onStop(() => updates.mockRestore());
  const firstReview = f.review(first);
  let secondReview: ReturnType<typeof f.review> | undefined;
  try {
    await waitForFile(join(f.root, "first.started"), { during: firstReview });
    secondReview = f.review(second);
    await waitFor(() => f.engine.checkQueue.waiting === 1, "second review checks to queue");
    const queuedHead = f.head(second.copy);
    const latest = await f.land();
    expect(f.head(second.copy)).toBe(queuedHead);
    if (paused) f.engine.setPoolPaused(true);
    f.release(); expect(await firstReview).toBe("continue");
    if (paused) {
      expect(f.evidence().map(run => run.name)).toEqual(["first"]);
      expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(1);
      f.engine.setPoolPaused(false);
    }
    expect(await secondReview).toBe("continue");
    const checked = f.evidence();
    expect(checked.map(run => [run.name, run.fix])).toEqual([["first", false], ["second", true]]);
    const run = checked[1]!;
    expect(run.sha).not.toBe(queuedHead);
    expect(await f.mergeBase(second.copy, latest, run.sha)).toBe(latest);
    expect(second.scope.work.checks).toMatchObject({ sha: run.sha, tree: run.tree, current: true });
    expect(second.scope.work.tamper?.sha).toBe(run.sha);
    const attempts = second.task.journey!.flatMap(step => step.checkAttempts ?? []);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ sha: run.sha, tree: run.tree, passed: true });
    expect(second.task.stageIndex).toBe(1); expect(second.task.fixing).not.toBe(true);
    expect(second.task.findings.filter(finding => finding.text.startsWith("Check failed"))).toEqual([]);
    expect(updates.mock.calls.filter(call => call[0].task.id === first.task.id)).toHaveLength(1);
    expect(updates.mock.calls.filter(call => call[0].task.id === second.task.id)).toHaveLength(2);
    expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
  } finally { f.release(); await firstReview; if (secondReview) await secondReview; updates.mockRestore(); await owner.stop(f.engine); }

  }));
});

it("returns a queued conflict to the Builder without commands and hands the place to the next review", async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = await f.add("first"), conflict = await f.add("conflict", false, true), next = await f.add("next");
  conflict.scope.work.approvedSha = f.head(conflict.copy);
  conflict.scope.work.approvedPatch = "approved-patch";
  conflict.task.reviewSessions = { review: { "reviewer:0": { sessionId: "old-review", profileId: "sol-high", plannedProfileId: "sol-high", toolId: "codex", model: "stand-in", scope: "old", round: 1 } } };
  const firstReview = f.review(first);
  let conflictReview: ReturnType<typeof f.review> | undefined, nextReview: ReturnType<typeof f.review> | undefined;
  try {
    await waitForFile(join(f.root, "first.started"), { during: firstReview });
    conflictReview = f.review(conflict); await waitFor(() => f.engine.checkQueue.waiting === 1, "conflicting review checks to queue");
    nextReview = f.review(next); await waitFor(() => f.engine.checkQueue.waiting === 2, "next review checks to queue");
    const latest = await f.land(true);
    f.release(); expect(await firstReview).toBe("continue");
    expect(await conflictReview).toBe("continue"); expect(await nextReview).toBe("continue");
    expect(f.evidence().map(run => run.name)).toEqual(["first", "next"]);
    expect(conflict.task.stageIndex).toBe(0); expect(conflict.scope.work.updating?.onto).toBe(latest);
    expect(conflict.scope.work.approvedSha).toBeUndefined(); expect(conflict.scope.work.approvedPatch).toBeUndefined();
    expect(conflict.task.reviewSessions).toBeUndefined();
    expect(conflict.task.reviewFreshReasons?.review?.["reviewer:0"]).toContain("conflicted");
    expect(conflict.task.findings.filter(finding => finding.text.startsWith("Check failed"))).toEqual([]);
    expect(conflict.scope.work.checkReturns).toBeUndefined();
    const skipped = conflict.task.journey!.flatMap(step => step.productChecks ?? []);
    expect(skipped).toHaveLength(1); expect(skipped[0]!.result).toBe("skipped");
    expect(skipped[0]!.detail).toContain("conflict");
    expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
  } finally { f.release(); await firstReview; if (conflictReview) await conflictReview; if (nextReview) await nextReview; await owner.stop(f.engine); }

  }));
});

it("captures changed check definitions at admission and preserves the earlier run's evidence", async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = await f.add("first"), second = await f.add("second");
  const firstReview = f.review(first);
  let secondReview: ReturnType<typeof f.review> | undefined;
  try {
    await waitForFile(join(f.root, "first.started"), { during: firstReview });
    secondReview = f.review(second); await waitFor(() => f.engine.checkQueue.waiting === 1, "second review checks to queue");
    await f.land(); f.define("new-required-command"); f.release();
    expect(await firstReview).toBe("continue"); expect(await secondReview).toBe("continue");
    expect(f.evidence().map(run => [run.name, run.command])).toEqual([["first", "original"], ["second", "new-required-command"], ["first", "new-required-command"]]);
    const firstAttempt = first.task.journey!.flatMap(step => step.checkAttempts ?? [])[0]!;
    const secondAttempt = second.task.journey!.flatMap(step => step.checkAttempts ?? [])[0]!;
    expect(firstAttempt.definition).not.toBe(secondAttempt.definition);
    expect(firstAttempt.passed).toBe(false); expect(secondAttempt.passed).toBe(true);
    expect(first.task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(2);
    expect(first.scope.work.checks?.current).toBe(true); expect(second.scope.work.checks?.current).toBe(true);
  } finally { f.release(); await firstReview; if (secondReview) await secondReview; await owner.stop(f.engine); }

  }));
});

it("gives up check capacity while new check inputs need discovery, then rejoins at its original order", async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = await f.add("first"), second = await f.add("second", true);
  const entered = Promise.withResolvers<void>(), releaseDiscovery = Promise.withResolvers<void>();
    owner.onStop(() => releaseDiscovery.resolve());
  const checks = f.engine["checks"], ensure = checks.ensureChecks.bind(checks);
  const discovery = spyOn(checks, "ensureChecks");
    owner.onStop(() => discovery.mockRestore());
    discovery.mockImplementation(async (scope, signal) => {
    if (scope.task.id === second.task.id && f.engine.productOf(scope)!.checksBy === "finder") {
      entered.resolve(); await releaseDiscovery.promise;
      f.define("rediscovered-command");
      return f.engine.productOf(scope)!.checks!;
    }
    return ensure(scope, signal);
  });
  const firstReview = f.review(first);
  const controller = new AbortController();
    owner.onStop(() => controller.abort());
  let secondReview: ReturnType<typeof f.review> | undefined;
  let follower: Promise<() => void> | undefined, late: Promise<() => void> | undefined;
  let followerPlace: (() => void) | undefined, latePlace: (() => void) | undefined;
    owner.onStop(() => followerPlace?.());
    owner.onStop(() => latePlace?.());
  try {
    await waitForFile(join(f.root, "first.started"), { during: firstReview });
    secondReview = f.review(second); await waitFor(() => f.engine.checkQueue.waiting === 1, "second review to queue before discovery");
    const product = f.engine.productOf(second.scope)!;
    product.checksBy = "finder"; product.checksFingerprint = checksFingerprint(second.copy);
    const latest = await f.land(false, true);
    follower = f.engine.checkQueue.acquire(controller.signal);
    f.release(); await entered.promise;
    followerPlace = await follower;
    expect(await firstReview).toBe("continue");
    expect(f.engine.checkQueue.running).toBe(1); expect(f.evidence().map(run => run.name)).toEqual(["first"]);
    expect(second.task.holdsSlot).toBe(false); expect(second.task.agent).toBeUndefined();
    late = f.engine.checkQueue.acquire(controller.signal);
    releaseDiscovery.resolve();
    await waitFor(() => f.engine.checkQueue.waiting === 2, "discovered run to rejoin ahead of the later arrival");
    followerPlace();
    expect(await secondReview).toBe("continue"); latePlace = await late;
    const run = f.evidence()[1]!;
    expect(f.evidence().map(run => [run.name, run.command])).toEqual([["first", "original"], ["second", "rediscovered-command"]]);
    expect(run.fix).toBe(true); expect(await f.mergeBase(second.copy, latest, run.sha)).toBe(latest);
    expect(second.scope.work.checks).toMatchObject({ sha: run.sha, tree: run.tree, current: true });
    expect(second.task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(1);
    latePlace(); expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
  } finally {
    controller.abort(); releaseDiscovery.resolve(); f.release(); followerPlace?.(); latePlace?.();
    if (follower) await follower.then(place => place(), () => {});
    if (late) await late.then(place => place(), () => {});
    await firstReview; if (secondReview) await secondReview;
    discovery.mockRestore(); await owner.stop(f.engine);
  }

  }));
});

it("captures a newly configured commit hook before a queued review starts", async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = await f.add("first"), second = await f.add("second");
  const firstReview = f.review(first);
  let secondReview: ReturnType<typeof f.review> | undefined;
  try {
    await waitForFile(join(f.root, "first.started"), { during: firstReview });
    secondReview = f.review(second); await waitFor(() => f.engine.checkQueue.waiting === 1, "second review to queue before the hook changes");
    await f.land();
    const folder = join(f.root, "hooks"), hookLog = join(f.root, "hook-runs"), hookScript = join(folder, "pre-commit.ts");
    mkdirSync(folder);
    writeFileSync(hookScript, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(hookLog)}, "hook\\n");\n`);
    writeFileSync(join(folder, "pre-commit"), `#!/bin/sh\n"${process.execPath.replaceAll("\\", "/")}" "${hookScript.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
    const cfgPath = join(f.clone, ".git", "config");
    writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/^\[core\]\r?\n/im, (header) => `${header}\thooksPath = ${folder.replaceAll("\\", "/")}\n`));
    f.release(); expect(await firstReview).toBe("continue"); expect(await secondReview).toBe("continue");
    expect(readFileSync(hookLog, "utf8").trim().split("\n")).toHaveLength(2);
    expect(second.scope.work.checks!.results.map(run => run.name)).toEqual(["Tests", "Pre-commit hook"]);
    expect(second.scope.work.checks!.results.every(run => run.ok)).toBe(true);
    const original = first.task.journey!.flatMap(step => step.checkAttempts ?? [])[0]!;
    const current = second.task.journey!.flatMap(step => step.checkAttempts ?? [])[0]!;
    expect(original.definition).not.toBe(current.definition);
    expect(original.passed).toBe(false); expect(current.passed).toBe(true);
    expect(f.evidence().filter(run => run.name === "second")).toHaveLength(1);
  } finally { f.release(); await firstReview; if (secondReview) await secondReview; await owner.stop(f.engine); }

  }));
});

for (const savedTester of [false, true]) it(`acceptance ${savedTester ? "finishes its saved Tester version without updating or rerunning checks" : "updates queued checks before a fresh Tester starts"}`, async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = await f.add("first"), acceptance = await f.add("acceptance", !savedTester);
  acceptance.task.plan!.stages[1] = { id: "accept", title: "Try the product", kind: "do", roleId: "tester", profileIds: ["sol-high"] };
  f.engine.s.setup!.checks = f.engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  f.engine.s.tools.forEach(tool => { tool.status = "ready"; });
  const before = f.head(acceptance.copy);
  if (savedTester) acceptance.scope.work.conversation = { step: "accept:1:0", roleId: "tester", profileId: "sol-high", toolId: "codex", model: "stand-in", sessionId: "saved-tester", startedAt: 1, head: before, briefed: true };
  const began = Promise.withResolvers<string>();
  const work = spyOn(f.engine["work"], "runDo");
    owner.onStop(() => work.mockRestore());
    work.mockImplementation(async scope => { began.resolve(f.head(scope.work.worktree!)); return "stop"; });
  const updates = spyOn(f.engine["updates"], "upToDate");
    owner.onStop(() => updates.mockRestore());
  const firstReview = f.review(first);
  let driving: Promise<void> | undefined;
  try {
    await waitForFile(join(f.root, "first.started"), { during: firstReview });
    if (savedTester) await f.land();
    f.engine.startDriver(acceptance.task.id, true); driving = f.engine.settling.get(acceptance.task.id)!;
    if (savedTester) {
      expect(await began.promise).toBe(before);
      expect(f.engine.checkQueue.waiting).toBe(0);
      expect(updates.mock.calls.filter(call => call[0].task.id === acceptance.task.id)).toHaveLength(0);
    } else {
      await waitFor(() => f.engine.checkQueue.waiting === 1, "fresh acceptance checks to queue");
      const latest = await f.land(); f.release();
      const tested = await began.promise;
      const run = f.evidence().find(run => run.name === "acceptance")!;
      expect(run).toMatchObject({ sha: tested, fix: true });
      expect(await f.mergeBase(acceptance.copy, tested, latest)).toBe(latest);
      expect(acceptance.scope.work.checks).toMatchObject({ sha: tested, tree: run.tree, current: true });
      expect(updates.mock.calls.filter(call => call[0].task.id === acceptance.task.id)).toHaveLength(2);
    }
    f.release(); expect(await firstReview).toBe("continue"); await driving;
    expect(f.evidence().map(run => run.name)).toEqual(savedTester ? ["first"] : ["first", "acceptance"]);
    expect(work).toHaveBeenCalledTimes(1);
  } finally { f.release(); await firstReview; if (driving) await driving; updates.mockRestore(); work.mockRestore(); await owner.stop(f.engine); }

  }));
});

for (const admission of ["queued", "immediate", "conflict"] as const) it(`updates acceptance after a saved Check finder finishes (${admission})`, async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = admission === "immediate" ? undefined : await f.add("first");
  const acceptance = await f.add("acceptance", admission !== "conflict", admission === "conflict");
  acceptance.task.plan!.stages[1] = { id: "accept", title: "Try the product", kind: "do", roleId: "tester", profileIds: ["sol-high"] };
  f.engine.s.setup!.checks = f.engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  f.engine.s.tools.forEach(tool => { tool.status = "ready"; });
  const before = f.head(acceptance.copy);
  acceptance.scope.work.conversation = { step: "accept:1:0", roleId: "check-finder", profileId: "sol-high", toolId: "codex", model: "stand-in", sessionId: "saved-finder", startedAt: 1, head: before, briefed: true };
  const entered = Promise.withResolvers<void>(), releaseDiscovery = Promise.withResolvers<void>();
    owner.onStop(() => releaseDiscovery.resolve());
  const finder = spyOn(f.engine["turns"], "turn");
    owner.onStop(() => finder.mockRestore());
    finder.mockImplementation(async (scope, roleId, _profile, _given, schema) => {
    expect(scope.task.id).toBe(acceptance.task.id); expect(roleId).toBe("check-finder");
    entered.resolve(); await releaseDiscovery.promise;
    return schema.parse({ summary: "Continue the saved discovery", checks: f.engine.productOf(scope)!.checks!.map(check => ({ ...check, why: "Required product verification" })) });
  });
  let tested: string | undefined;
  const work = spyOn(f.engine["work"], "runDo");
    owner.onStop(() => work.mockRestore());
    work.mockImplementation(async (scope, stage) => {
    if (f.engine.role(stage.roleId, scope.task)?.result === "checks") tested = f.head(scope.work.worktree!);
    return "stop";
  });
  const updates = spyOn(f.engine["updates"], "upToDate");
    owner.onStop(() => updates.mockRestore());
  const firstReview = first ? f.review(first) : undefined;
  let driving: Promise<void> | undefined;
  try {
    if (firstReview) await waitForFile(join(f.root, "first.started"), { during: firstReview });
    f.engine.startDriver(acceptance.task.id, true); driving = f.engine.settling.get(acceptance.task.id)!;
    await Promise.race([entered.promise, driving.then(() => { throw new Error(`Acceptance ended before its saved discovery: ${acceptance.task.statusLine}`); })]);
    expect(updates.mock.calls.filter(call => call[0].task.id === acceptance.task.id)).toHaveLength(0);
    let latest: string;
    if (admission === "queued") {
      releaseDiscovery.resolve();
      await waitFor(() => f.engine.checkQueue.waiting === 1, "resumed acceptance checks to join the queue");
      latest = await f.land();
    } else { latest = await f.land(admission === "conflict"); releaseDiscovery.resolve(); }
    f.release(); if (firstReview) expect(await firstReview).toBe("continue"); await driving;
    expect(finder).toHaveBeenCalledTimes(1);
    const runs = f.evidence().filter(run => run.name === "acceptance");
    expect(acceptance.scope.work.checkReturns).toBeUndefined();
    expect(acceptance.task.findings.filter(finding => finding.text.startsWith("Check failed"))).toEqual([]);
    if (admission === "conflict") {
      expect(runs).toEqual([]); expect(tested).toBeUndefined();
      expect(acceptance.task.stageIndex).toBe(0); expect(acceptance.scope.work.updating?.onto).toBe(latest);
    } else {
      expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ sha: tested, fix: true });
      expect(await f.mergeBase(acceptance.copy, latest, tested!)).toBe(latest);
      expect(acceptance.scope.work.checks).toMatchObject({ sha: tested, tree: runs[0]!.tree, current: true });
      expect(acceptance.task.stageIndex).toBe(1);
    }
    expect(updates.mock.calls.filter(call => call[0].task.id === acceptance.task.id)).toHaveLength(admission === "queued" ? 2 : 1);
  } finally {
    releaseDiscovery.resolve(); f.release();
    try { if (firstReview) await firstReview; if (driving) await driving; }
    finally { finder.mockRestore(); work.mockRestore(); updates.mockRestore(); await owner.stop(f.engine); }
  }

  }));
});

it("updates a queued delivery check before capturing the change the coordinator will approve", async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = await f.add("first"), delivery = await f.add("delivery-check", true);
  delivery.task.plan!.stages[1] = { id: "approval", title: "Delivery check", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] };
  const firstReview = f.review(first);
  let driving: Promise<void> | undefined;
  try {
    await waitForFile(join(f.root, "first.started"), { during: firstReview });
    f.engine.startDriver(delivery.task.id, true); driving = f.engine.settling.get(delivery.task.id)!;
    await waitFor(() => f.engine.checkQueue.waiting === 1, "delivery-check commands to queue");
    const latest = await f.land(); f.release(); expect(await firstReview).toBe("continue"); await driving;
    const run = f.evidence().find(run => run.name === "delivery-check")!;
    expect(f.evidence().map(run => run.name)).toEqual(["first", "delivery-check"]);
    expect(run.fix).toBe(true); expect(await f.mergeBase(delivery.copy, latest, run.sha)).toBe(latest);
    expect(delivery.scope.work.checkedSha).toBe(run.sha);
    expect(delivery.scope.work.checks).toMatchObject({ sha: run.sha, tree: run.tree, current: true });
    expect(delivery.task.state).toBe("needs-you");
    expect(f.engine.s.inbox.find(item => item.taskId === delivery.task.id && item.kind === "delivery")).toBeDefined();
    expect(delivery.scope.work.approvedSha).toBeUndefined();
  } finally { f.release(); await firstReview; if (driving) await driving; await owner.stop(f.engine); }

  }));
});

it("retains an earlier failure and its return allowance until the combined current tree really passes", async () => {
  return cases.use("petrina-check-admission-", owner => checkAdmissionFixture(owner, async f => {
  const first = await f.add("first"), second = await f.add("second", true);
  const checks = f.engine["checks"];
  expect((await checks.failing(second.scope, new AbortController().signal)).kind).toBe("product-failed");
  expect(checks.backToBuilder(second.scope, "before review", new Set((second.scope.task.repositories ?? [second.scope.work]).map(work => work.productId)))).toBe(true);
  const original = structuredClone(second.task.journey!.flatMap(step => step.checkAttempts ?? [])[0]!);
  expect(original.passed).not.toBe(true); expect(second.scope.work.checkReturns).toBe(1);
  // The Builder returned a changed tree; its incomplete repair remains a real failure until fresh proof.
  writeFileSync(join(second.copy, "builder-return.txt"), "A focused repair was returned\n");
  await gitOps.commitChanges(second.copy, "Try the focused repair");
  second.task.stageIndex = 1;
  const firstReview = f.review(first);
  let secondReview: ReturnType<typeof f.review> | undefined;
  try {
    await waitForFile(join(f.root, "first.started"), { during: firstReview });
    secondReview = f.review(second); await waitFor(() => f.engine.checkQueue.waiting === 1, "repaired review to queue");
    await f.land();
    expect(second.scope.work.checks!.results[0]!.ok).toBe(false);
    expect(second.task.findings.find(finding => finding.text.startsWith("Check failed"))!.status).toBe("open");
    expect(second.scope.work.checkReturns).toBe(1);
    expect(second.task.journey!.flatMap(step => step.checkAttempts ?? [])[0]).toEqual(original);
    f.release(); expect(await firstReview).toBe("continue"); expect(await secondReview).toBe("continue");
    expect(f.evidence().map(run => [run.name, run.fix])).toEqual([["second", false], ["first", false], ["second", true]]);
    expect(second.task.findings.find(finding => finding.text.startsWith("Check failed"))!.status).toBe("fixed");
    expect(second.scope.work.checkReturns).toBeUndefined();
    const attempts = second.task.journey!.flatMap(step => step.checkAttempts ?? []);
    expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(original); expect(attempts[1]!.passed).toBe(true);
    expect(attempts[0]!.tree).not.toBe(attempts[1]!.tree);
  } finally { f.release(); await firstReview; if (secondReview) await secondReview; await owner.stop(f.engine); }

  }));
});
