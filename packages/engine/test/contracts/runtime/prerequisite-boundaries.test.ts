import type { CheckVerification } from "../../../src/product-checks.js";
import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeWaitView, type ProductCheck } from "@petrina/core";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { SourceRefreshRequired } from "../../../src/kernel.js";
import { WaitingForUsage } from "../../../src/usage.js";
import { git, makeProduct, removeDir, tempDir, waitFor, waitForFile } from "../../fixtures.js";
import { rejectionOf } from "@petrina/test-support/rejections";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(withRepositories: boolean | "first" = true) {
  const root = tempDir("petrina-wait-boundaries-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  const makeTask = async (name: string) => {
    const productRoot = join(root, name);
    const nativeRepository = withRepositories === true || withRepositories === "first" && name === "first";
    if (nativeRepository) mkdirSync(productRoot);
    const product = nativeRepository ? await makeProduct(productRoot) : undefined;
    const productId = `product-${name}`;
    engine.s.products.push({ id: productId, name, repo: `local/${name}`, path: product, tone: "blue", delivery: "local" });
    const task = engine.task(engine.addTask({ productId, title: name }))!;
    task.startedAt = 20; task.state = "running";
    if (product) executionFor(task).work.worktree = product;
    return task;
  };
  const prerequisite = await makeTask("prerequisite"), first = await makeTask("first"), second = await makeTask("second");
  const hold = (task = first) => engine.setRuntimeWait(task.id, [prerequisite.id], "The required fix must land", `wait-${task.id}`);
  const checks = engine["checks"];
  return { root, engine, first, second, prerequisite, hold, checks };
}

describe.concurrent("runtime waits at check boundaries", () => {
  it("refuses new check preparation only for the held task", async () => {
    const { engine, first, second, hold, checks } = await fixture(false);
    try {
      hold();
      expect(checks.claimPreparation(first.id)).toBe(false);
      expect(checks.claimPreparation(second.id)).toBe(true);
      expect(checks.preparingCount).toBe(1);
      checks.releasePreparation(second.id);
      expect(checks.preparingCount).toBe(0);
    } finally { await engine.shutdown(); }
  });

  for (const refusal of ["prerequisite", "pool", "capacity"] as const) it(`names the actual check-preparation wait (${refusal})`, async () => {
    const { engine, first, second, hold, checks } = await fixture("first");
    try {
      engine.s.pool.limit = 1;
      if (refusal === "prerequisite") hold();
      else if (refusal === "pool") engine.setPoolPaused(true);
      else expect(checks.claimPreparation(second.id)).toBe(true);
      const expected = refusal === "capacity" ? "Waiting for room to prepare the product checks" : engine.taskAdmissionWait(first);
      const error = await rejectionOf(checks.runProductChecks(executionFor(first), [], new AbortController().signal));
      expect(error).toBeInstanceOf(WaitingForUsage);
      expect((error as WaitingForUsage).words).toBe(expected);
      expect(checks.preparingCount).toBe(refusal === "capacity" ? 1 : 0);
      expect(first.journey?.flatMap(step => step.checkAttempts ?? []) ?? []).toHaveLength(0);
      expect(executionFor(first).work.checks).toBeUndefined();
    } finally { checks.releasePreparation(second.id); await engine.shutdown(); }
  });

  it("removes held checks from the line while an admitted batch finishes and records its result", async () => {
    const { root, engine, first, second, hold, checks } = await fixture();
    const release = join(root, "release"), started = join(root, "started"), unwanted = join(root, "unwanted");
    const script = join(root, "check.ts");
    writeFileSync(script, `import { existsSync, writeFileSync, renameSync } from "node:fs";
const [started, release] = process.argv.slice(2); writeFileSync(started + ".tmp", "ready"); renameSync(started + ".tmp", started);
while (!existsSync(release)) await Bun.sleep(10);`);
    const firstCheck: ProductCheck = { name: "Admitted", argv: [process.execPath, script, started, release] };
    let active: Promise<CheckVerification> | undefined, queued: Promise<unknown> | undefined;
    const controller = new AbortController();
    try {
      active = checks.runProductChecks(executionFor(first), [firstCheck], controller.signal);
      await waitForFile(started);
      const queuedWork = checks.runProductChecks(executionFor(second), [{ name: "Queued", argv: [process.execPath, "-e", `await Bun.write(process.argv[1], "wrong");`, unwanted] }], controller.signal);
      queued = rejectionOf(queuedWork);
      await waitFor(() => second.statusLine.startsWith("Waiting to run the checks"), "second checks to queue");
      hold(second);
      expect(await queued).toBeInstanceOf(WaitingForUsage);
      expect(existsSync(unwanted)).toBe(false);
      expect(first.journey?.at(-1)?.productChecks?.[0]?.result).toBe("running");
      hold(first);
      expect(runtimeWaitView(first, id => engine.task(id))?.phase).toBe("after-current-work");
      writeFileSync(release, "go");
      expect(nonpassingChecks(await active!)).toBe(0);
      expect(executionFor(first).work.checks?.results[0]?.ok).toBe(true);
      expect(first.journey?.flatMap(step => step.checkAttempts ?? [])).toHaveLength(1);
      expect(second.journey?.at(-1)?.productChecks?.[0]?.result).toBe("stopped");
      expect(executionFor(second).work.checks).toBeUndefined();
      expect(await rejectionOf(checks.runProductChecks(executionFor(first), [firstCheck], controller.signal))).toBeInstanceOf(WaitingForUsage);
    } finally {
      writeFileSync(release, "go"); controller.abort();
      await Promise.allSettled([active, queued]);
      await engine.shutdown();
    }
  });

  for (const action of ["prerequisite", "pool pause", "drain"] as const) it(`does not begin an empty batch if ${action} arrives during check preparation`, async () => {
    const { engine, first, hold, checks } = await fixture();
    const capture = checks["captureState"].bind(checks);
    let captured!: () => void, proceed!: () => void;
    const ready = new Promise<void>(resolve => { captured = resolve; });
    const released = new Promise<void>(resolve => { proceed = resolve; });
    checks["captureState"] = async (...args) => { const result = await capture(...args); captured(); await released; return result; };
    let work: Promise<unknown> | undefined;
    try {
      work = rejectionOf(checks.runProductChecks(executionFor(first), [], new AbortController().signal));
      await ready;
      if (action === "prerequisite") hold();
      else if (action === "pool pause") engine.setPoolPaused(true);
      else engine.draining = true;
      proceed();
      expect(await work).toBeInstanceOf(WaitingForUsage);
      expect(first.journey?.flatMap(step => step.checkAttempts ?? []) ?? []).toHaveLength(0);
      expect(executionFor(first).work.checks).toBeUndefined();
    } finally { proceed(); await work; await engine.shutdown(); }
  });

  for (const boundary of ["queued", "pool paused", "handoff"] as const) it(`removes only the prerequisite-held task from the shared check queue during ${boundary}`, async () => {
    const { engine, first, second, hold, checks } = await fixture(false);
    engine.schedule = () => engine.checkQueue.pump(); // Keep queue wakeups while excluding agent admission.
    // An occupied shared place can belong to either an ordinary batch or an extra validation.
    const occupied = engine.checkQueue.hold(), controller = new AbortController();
    let waiting: Promise<unknown> | undefined, following: Promise<() => void> | undefined, releaseFollowing: (() => void) | undefined;
    try {
      waiting = rejectionOf(checks["turnToRun"](executionFor(first), controller.signal));
      following = checks["turnToRun"](executionFor(second), controller.signal).then(place => { releaseFollowing = place; return place; });
      expect(engine.checkQueue.waiting).toBe(2);
      if (boundary === "pool paused") engine.setPoolPaused(true);
      if (boundary === "handoff") occupied(); // Reserved, but not yet admitted by the continuation.
      hold(first);
      const error = await waiting;
      expect(error).toBeInstanceOf(WaitingForUsage);
      expect((error as WaitingForUsage).words).toBe(engine.taskAdmissionWait(first));
      expect(engine.waitingChecks.has(first.id)).toBe(false);
      if (boundary === "pool paused") {
        occupied();
        expect(engine.checkQueue.running).toBe(0);
        expect(engine.checkQueue.waiting).toBe(1);
        engine.setPoolPaused(false);
      } else occupied();
      const release = await following;
      expect(engine.checkQueue.running).toBe(1);
      expect(engine.checkQueue.waiting).toBe(0);
      expect(engine.waitingChecks.size).toBe(0);
      release();
      expect(engine.checkQueue.running).toBe(0);
    } finally {
      controller.abort(); occupied(); releaseFollowing?.();
      await Promise.allSettled([waiting, following]); await engine.shutdown();
    }
  });

  for (const boundary of ["preparation", "queue handoff"] as const) it(`refreshes the required source before admitting checks after asynchronous ${boundary}`, async () => {
    const { root, engine, first, second, hold, checks } = await fixture();
    const scope = executionFor(first), source = scope.work.worktree!;
    const product = engine.s.products.find(product => product.id === scope.work.productId)!;
    const worktree = join(root, "first-checks-work"), branch = "task-checks", baseSha = await git(source, "rev-parse", "HEAD");
    await git(source, "worktree", "add", "-qb", branch, worktree, "main");
    Object.assign(scope.work, { worktree, branch, base: "main", baseSha, delivery: "local",
      source: { product: { ...product, defaultBranch: "main" }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: baseSha } });
    const observed = join(root, "checked-source.jsonl"), blockerStarted = join(root, "blocker-started"), blockerRelease = join(root, "blocker-release");
    const sourceCheck: ProductCheck = { name: "Verify the required source", argv: [process.execPath, "-e", `import { appendFileSync, existsSync } from "node:fs"; appendFileSync(process.argv[1], JSON.stringify({ fix: existsSync("required-fix.txt") }) + "\\n");`, observed] };
    const blockerCheck: ProductCheck = { name: "Already admitted", argv: [process.execPath, "-e", `import { existsSync, renameSync, writeFileSync } from "node:fs"; writeFileSync(process.argv[1] + ".tmp", "ready"); renameSync(process.argv[1] + ".tmp", process.argv[1]); while (!existsSync(process.argv[2])) await Bun.sleep(10);`, blockerStarted, blockerRelease] };
    const controller = new AbortController();
    const capture = checks["captureState"].bind(checks);
    let captured!: () => void, proceed!: () => void;
    const ready = new Promise<void>(resolve => { captured = resolve; });
    const released = new Promise<void>(resolve => { proceed = resolve; });
    let captures = 0;
    checks["captureState"] = async (...args) => {
      const result = await capture(...args);
      if (args[0].task.id === first.id && ++captures === (boundary === "preparation" ? 1 : 2)) { captured(); await released; }
      return result;
    };
    let blocker: Promise<CheckVerification> | undefined, work: Promise<unknown> | undefined;
    try {
      if (boundary === "queue handoff") {
        blocker = checks.runProductChecks(executionFor(second), [blockerCheck], controller.signal);
        await waitForFile(blockerStarted);
      }
      work = checks.runProductChecks(scope, [sourceCheck], controller.signal).catch(error => error);
      if (blocker) {
        await waitFor(() => first.statusLine.startsWith("Waiting to run the checks"), "the source-sensitive checks to queue");
        writeFileSync(blockerRelease, "go");
        expect(nonpassingChecks(await blocker!)).toBe(0);
      }
      await ready;
      hold();
      writeFileSync(join(source, "required-fix.txt"), "The required prerequisite fix\n");
      await git(source, "add", "."); await git(source, "commit", "-qm", "Land the required prerequisite");
      const latest = await git(source, "rev-parse", "HEAD");
      engine.setRuntimeWait(first.id, [], "The required prerequisite is available", `clear-${boundary}`);
      expect(first.runtimeWait?.refreshPending).toBe(true);
      proceed();
      expect(await work).toBeInstanceOf(SourceRefreshRequired);
      expect(existsSync(observed)).toBe(false);
      expect(first.journey?.flatMap(step => step.checkAttempts ?? []) ?? []).toHaveLength(0);
      expect(scope.work.checks).toBeUndefined();
      expect(checks.preparingCount).toBe(0);
      expect(await engine["driver"]["refreshAfterWait"](first, controller.signal)).toBe(false);
      expect(scope.work.baseSha).toBe(latest);
      expect(readFileSync(join(worktree, "required-fix.txt"), "utf8")).toBe("The required prerequisite fix\n");
      expect(first.runtimeWait?.refreshPending).toBeUndefined();
      expect(nonpassingChecks(await checks.runProductChecks(scope, [sourceCheck], controller.signal))).toBe(0);
      expect(readFileSync(observed, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([{ fix: true }]);
      expect(first.journey?.flatMap(step => step.checkAttempts ?? [])).toHaveLength(1);
      expect(scope.work.checks?.results[0]?.ok).toBe(true);
    } finally {
      proceed(); writeFileSync(blockerRelease, "go"); controller.abort();
      await Promise.allSettled([blocker, work]); await engine.shutdown();
    }
  });

  it("leaves an open plan checkpoint answerable with the same identity", async () => {
    const { engine, first, hold } = await fixture();
    try {
      first.stageIndex = -1;
      first.plan = { rationale: "A small change", plannerProfileId: "sol-high", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] }] };
      engine.gate(first, "plan");
      const checkpoint = structuredClone(engine.s.inbox.find(item => item.taskId === first.id)!);
      hold();
      expect(engine.s.inbox.find(item => item.taskId === first.id)).toEqual(checkpoint);
      expect(first.journey?.at(-1)?.waitsFor).toBe("plan");
      await engine.approve(checkpoint.id);
      expect(engine.s.inbox.some(item => item.id === checkpoint.id)).toBe(false);
      expect(first.runtimeWait?.after).toHaveLength(1);
      expect(first.state).toBe("waiting");
      expect(first.stageIndex).toBe(0);
    } finally { await engine.shutdown(); }
  });

  for (const historical of [false, true]) it(`saves a terminal hand-back while admission is held (historical released wait: ${historical})`, async () => {
    const { root, engine, first, hold } = await fixture();
    const work = executionFor(first).work;
    const head = await git(work.worktree!, "rev-parse", "HEAD");
    let starts = 0;
    engine.startDriver = () => { starts += 1; };
    try {
      first.stageIndex = 0;
      first.plan = { rationale: "A small change", plannerProfileId: "sol-high", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] }] };
      work.branch = "main"; work.base = "main"; work.baseSha = head;
      work.conversation = { step: "build:1:0", roleId: "builder", profileId: "sol-high", toolId: "codex", model: "model", sessionId: "saved-session", head, startedAt: 20, briefed: true };
      first.agent = { roleId: "builder", profileId: "sol-high", since: 20, step: 0 };
      first.holdsSlot = true;
      first.driving = { since: 25, roleId: "builder", profileId: "sol-high", toolId: "codex", head };
      const terminal = join(root, "data", "takeover", first.id); mkdirSync(terminal, { recursive: true });
      writeFileSync(join(terminal, "status"), "state=ended\n");
      hold();
      expect(runtimeWaitView(first, id => engine.task(id))?.phase).toBe("after-current-work");
      expect(first.driving).toBeDefined(); expect(first.holdsSlot).toBe(true);
      if (historical) {
        engine.setRuntimeWait(first.id, [], "The remaining work can proceed", `clear-${first.id}`);
        engine.setPoolPaused(true);
      }
      writeFileSync(join(work.worktree!, "manual.txt"), "The coordinator's change\n");
      await engine.handBack(first.id, "Keep this change when the fix arrives");
      expect(starts).toBe(historical ? 1 : 0);
      expect(first.driving).toBeUndefined(); expect(first.state).toBe(historical ? "running" : "waiting"); expect(first.holdsSlot).toBe(historical);
      expect(work.conversation?.sessionId).toBe("saved-session");
      expect(work.conversation?.handback).toContain("Keep this change when the fix arrives");
      expect(first.handChanges).toBe(true);
      expect(await git(work.worktree!, "status", "--porcelain")).toBe("");
      expect(await git(work.worktree!, "log", "-1", "--format=%s")).toContain("changes made by hand");
      expect(first.runtimeWait?.changes).toHaveLength(historical ? 2 : 1);
    } finally { await engine.shutdown(); }
  });

  it("checks the task hold again when queued publication reaches the product's turn", async () => {
    const { engine, first, hold } = await fixture();
    const scope = executionFor(first);
    scope.work.shipping = { moves: 0, failures: 0, prepared: { tested: "checked", summary: "Ready" } };
    let admitted!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const previous = engine["connections"].serial(scope.work.productId, async () => { admitted(); await gate; });
    let result: Promise<unknown> | undefined;
    let published = 0;
    try {
      await ready;
      result = rejectionOf(engine["shipping"]["publishStep"](scope, new AbortController().signal, "push", "Publishing", async () => { published += 1; }));
      hold(); release(); await previous;
      expect(await result).toBeInstanceOf(WaitingForUsage);
      expect(published).toBe(0); expect(scope.work.shipping.step).toBeUndefined();
    } finally { release(); await Promise.allSettled([previous, result]); await engine.shutdown(); }
  });

  it("lets an admitted delivery finish its saved publication sequence after a wait applies", async () => {
    const { engine, first, hold } = await fixture();
    const scope = executionFor(first);
    scope.work.shipping = { moves: 0, failures: 0, prepared: { tested: "checked", summary: "Ready" } };
    let admitted!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let publication: Promise<string> | undefined;
    const finished: string[] = [];
    try {
      publication = engine["shipping"]["publishStep"](scope, new AbortController().signal, "push", "Publishing", async () => { admitted(); await gate; finished.push("push"); return "pushed"; });
      await ready;
      expect(scope.work.shipping.step).toBe("push"); hold(); release();
      expect(await publication).toBe("pushed");
      expect(await engine["shipping"]["publishStep"](scope, new AbortController().signal, "open", "Recording publication", async () => { finished.push("record"); return "recorded"; })).toBe("recorded");
      expect(finished).toEqual(["push", "record"]);
      expect(scope.work.shipping.step).toBe("open");
      expect(first.runtimeWait?.changes).toHaveLength(1);
    } finally { release(); await publication; await engine.shutdown(); }
  });

  it("returns queued publication to the driver if the wait was released before its turn", async () => {
    const { engine, first, hold } = await fixture();
    const scope = executionFor(first), shipping = engine["shipping"];
    scope.work.shipping = { moves: 1, failures: 1, prepared: { tested: "checked", summary: "Ready" } };
    let release!: () => void, queued!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { queued = resolve; });
    let writes = 0;
    shipping["checkDelivery"] = async () => "continue";
    shipping["publish"] = async (scope, signal) => {
      // Hold the product's real queue until the wait has both been set and released.
      const previous = engine["connections"].serial(scope.work.productId, async () => { queued(); await gate; });
      try {
        await shipping["publishStep"](scope, signal, "push", "Publishing", async () => { writes += 1; });
        return "done";
      } finally { await previous; }
    };
    const stage = { id: "publish", kind: "do" as const, title: "Publish", roleId: "release-manager", profileIds: [] };
    const result = shipping.deliver(first, stage, new AbortController().signal).catch(error => error);
    try {
      await entered; hold();
      engine.setRuntimeWait(first.id, [], "The prerequisite is resolved", "clear-queued-publication");
      release();
      expect(await result).toBe("continue");
      expect(writes).toBe(0);
      expect(scope.work.shipping).toEqual({ moves: 1, failures: 1, prepared: { tested: "checked", summary: "Ready" } });
      expect(first.runtimeWait?.refreshPending).toBe(true);
    } finally { release(); await result; await engine.shutdown(); }
  });
});
