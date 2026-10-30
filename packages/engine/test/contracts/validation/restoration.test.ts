import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { Engine } from "../../engine.js";
import { waitFor } from "../../fixtures.js";
import { Coordination } from "../../../src/coordination.js";

import { EngineLifecycle } from "../../../src/lifecycle.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import * as processTree from "@petrina/platform/process-tree";
import { ExtraContainer } from "../../../src/extra-container.js";
import { CheckQueue } from "../../../src/check-queue.js";
import { preparedServiceExtraFixture as extraFixture } from "../../extra-fixtures.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
for (const action of ["stop", "restart"] as const) it(`keeps a genuinely started extra run in the ${action} drain`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const record = await f.submit("started-drain");
    owner.check();
    const store = new LifecycleStore(join(f.root, "running-lifecycle"));
    const closeStore = owner.afterBody(() => store.close());
    const handoffs: boolean[] = [];
    const lifecycle = new EngineLifecycle(f.engine, store, async restart => { handoffs.push(restart); });
    owner.onStop(() => lifecycle.close());
    try {
      f.engine.setPoolPaused(false); await f.started(record);
      await lifecycle.request(action, { requestId: `started-${action}` });
      await lifecycle["settle"]();
      expect(handoffs).toEqual([]); expect(lifecycle.status().drained).toBe(false);
      expect(f.engine.extraValidations.active).toBe(1); expect(f.engine.checkQueue.running).toBe(1);
      f.release(record); expect((await f.finished(record)).result).toBe("passed");
      await waitFor(() => f.engine.extraValidations.active === 0, "started work to settle");
      await lifecycle["settle"](); expect(handoffs).toEqual([action === "restart"]);
    } finally { lifecycle.close(); await closeStore(); await owner.stop(f.engine); }

  });

  });
});

for (const limit of [1, 2]) for (const mode of ["preparation", "passed"] as const) it(`serializes slow startup recovery and cleanup retries for ${mode} records (limit ${limit})`, async () => {
  return cases.use("petrina-extra-", async owner => {
    const reverseStarts = mode === "preparation" && limit === 2;
    return await extraFixture(owner, async f => {
    const first = await f.submit("recover-first", ["probe", "pass"]);
    const second = await f.submit("recover-second", ["probe", reverseStarts ? "hold" : "pass"], (await f.add()).id);
    if (mode === "passed") {
      writeFileSync(join(f.service, "cleanup-off"), "service unavailable");
      f.engine.setPoolPaused(false);
      await waitFor(() => f.engine.s.extraValidations!.every(record => record.state === "held") && f.engine.extraValidations.active === 0, "both completed commands to hold cleanup");
      expect(f.engine.s.extraValidations!.map(record => record.result)).toEqual(["passed", "passed"]);
      f.engine.setPoolPaused(true);
    } else {
      const records = f.engine.s.extraValidations!;
      records[0]!.state = "preparing";
      records[1]!.state = "held"; records[1]!.resumeQueued = true;
      records.forEach(record => { mkdirSync(record.snapshot, { recursive: true }); });
    }
    f.engine.commitNow(); await owner.stop(f.engine);
    rmSync(join(f.service, "cleanup-off"), { force: true });
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    owner.onStop(() => released.resolve());
    const preparingFirst = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>();
    owner.onStop(() => releaseFirst.resolve());
    const grants: number[] = [];
    const acquire = CheckQueue.prototype.acquire;
    const admission = spyOn(CheckQueue.prototype, "acquire");
    owner.onStop(() => admission.mockRestore());
    admission.mockImplementation(function(this: CheckQueue, ...args: Parameters<CheckQueue["acquire"]>) {
      return acquire.apply(this, args).then(place => {
        if (args[2] === first.queueOrder || args[2] === second.queueOrder) grants.push(args[2]);
        return place;
      });
    });
    const prepare = ExtraContainer.prototype.prepare;
    const preparation = spyOn(ExtraContainer.prototype, "prepare");
    owner.onStop(() => preparation.mockRestore());
    preparation.mockImplementation(async function(this: ExtraContainer, record) {
      const result = await prepare.call(this, record);
      if (reverseStarts && record.id === first.id) { preparingFirst.resolve(); await releaseFirst.promise; }
      return result;
    });
    const clean = ExtraContainer.prototype.cleanup, interval = globalThis.setInterval;
    let active = 0, maximum = 0, calls = 0, available = false;
    owner.onStop(() => { available = true; });
    let tick: (() => void) | undefined;
    const timer = spyOn(globalThis, "setInterval");
    owner.onStop(() => timer.mockRestore());
    timer.mockImplementation(((...parameters: Parameters<typeof globalThis.setInterval>) => {
      const [callback, ms, ...args] = parameters;
      if (ms === 23_457) { tick = () => { (callback as () => void)(); }; return interval(callback, 60_000, ...args); }
      return interval(callback, ms, ...args);
    }) as typeof globalThis.setInterval);
    const cleanup = spyOn(ExtraContainer.prototype, "cleanup");
    owner.onStop(() => cleanup.mockRestore());
    cleanup.mockImplementation(async function(this: ExtraContainer, record) {
      active++; maximum = Math.max(maximum, active);
      try {
        if (++calls === 1) { entered.resolve(); await released.promise; }
        if (record.id === second.id && !available) return false;
        return await clean.call(this, record);
      } finally { active--; }
    });
    let replacement: Engine | undefined;
    const retries: Promise<void>[] = [];
    try {
      replacement = owner.open(f.data, { ...f.settings, checkRuns: limit });
      const current = replacement;
      await entered.promise;
      retries.push(current.extraValidations.retryCleanup(), current.extraValidations.retryCleanup());
      expect(tick).toBeUndefined(); // Periodic cleanup cannot race startup recovery.
      expect(maximum).toBe(1); expect(calls).toBe(1);
      expect(current.checkQueue.running).toBe(2);
      released.resolve();
      await current.waitUntilReady(); await Promise.all(retries);
      expect(maximum).toBe(1);
      expect(current.s.extraValidations!.find(record => record.id === second.id)!.state).toBe("held");
      expect(current.checkQueue.running).toBe(1);
      if (mode === "preparation") {
        expect(current.extraValidations.get(first.requestId)!.outcome).toBe("pending");
        expect(current.extraValidations.get(second.requestId)!.outcome).toBe("pending");
        expect(current.events.log.collect({}, 0, 100).events.filter(event => event.kind === "extra.finished")).toEqual([]);
      }
      expect(tick).toBeDefined();
      available = true;
      const retry = current.extraValidations.retryCleanup(); tick!(); await retry;
      if (mode === "preparation") current.setPoolPaused(false);
      if (reverseStarts) {
        await preparingFirst.promise; await f.started(second);
        expect(current.s.extraValidations!.find(run => run.id === first.id)!.state).toBe("preparing");
        expect(current.checkQueue.running).toBe(2);
        releaseFirst.resolve(); f.release(second);
      }
      await waitFor(() => [first, second].every(record => current.extraValidations.get(record.requestId)?.outcome === "completed"), "both recovered records to settle");
      expect([first, second].map(record => (current.extraValidations.get(record.requestId)!.validation as ExtraValidation).result)).toEqual(["passed", "passed"]);
      // FIFO governs capacity handoff. Concurrent preparations may finish in the opposite order.
      expect(grants).toEqual(mode === "preparation" ? [first.queueOrder, second.queueOrder] : []);
      expect(current.checkQueue.running).toBe(0); expect(current.checkQueue.waiting).toBe(0);
      current.setPoolPaused(false);
      const place = await current.checkQueue.acquire(new AbortController().signal, true); place();
      const runs = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      // Both slots may start clients together; OS scheduling need not preserve their log-write order.
      expect(runs.map(args => args[args.indexOf("--name") + 1]).sort()).toEqual([first.containerName, second.containerName].sort());
      expect(current.events.log.collect({}, 0, 100).events.filter(event => event.kind === "extra.started").map(event => event.validationId)).toEqual(mode === "preparation" ? reverseStarts ? [second.id, first.id] : [first.id, second.id] : []);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally {
      released.resolve(); releaseFirst.resolve(); available = true;
      await Promise.allSettled(retries);
      await replacement?.extraValidations.ready.catch(() => undefined);
      await (replacement ? owner.stop(replacement) : undefined); admission.mockRestore(); preparation.mockRestore(); cleanup.mockRestore(); timer.mockRestore();
    }

  }, { checkRuns: 2, extraCleanupEveryMs: 23_457 }, { fastClientStop: true, actorLease: false, scriptedNonHoldRuns: true });

  });
});

it("holds an unverified saved process number across restart without claiming or signalling an unrelated program", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const unrelatedCapture = f.actors.capture(() => Bun.spawn([process.execPath, f.actors.unrelated], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" }));
    const unrelated = unrelatedCapture.process;
    const signals = spyOn(process, "kill");
    owner.onStop(() => signals.mockRestore());
    let replacement: Engine | undefined;
    try {
      const reader = unrelatedCapture.stdout!.getReader(); await reader.read(); reader.releaseLock();
      const queued = await f.submit("uncertain-client");
      const record = f.engine.s.extraValidations![0]!;
      record.container = await f.engine.extraValidations["container"].prepare(record);
      record.state = "held"; record.startedAt = Date.now(); record.clientPid = unrelated.pid;
      f.engine.commitNow(); await owner.stop(f.engine);
      replacement = owner.open(f.data, f.settings);
      await replacement.extraValidations.ready;
      expect(replacement.checkQueue.running).toBe(1);
      const detail = replacement.extraValidations.blocker!;
      expect(detail).toContain("may be unrelated"); expect(detail).toContain("Do not stop");
      expect(detail).not.toContain("Stop those owned programs"); expect(detail).toContain("restart this computer");
      const status = await new Coordination(replacement).call("engine.status", {});
      expect(JSON.stringify(status.checkBlockers)).toContain("may be unrelated");
      expect(process.kill(unrelated.pid, 0)).toBe(true);
      expect(signals.mock.calls.filter(([pid, signal]) => Math.abs(pid) === unrelated.pid && signal !== 0)).toEqual([]);
      const unavailable = spyOn(processTree, "processList");
    owner.onStop(() => unavailable.mockRestore());
    unavailable.mockResolvedValueOnce(undefined);
      try { await replacement.extraValidations.retryCleanup(); } finally { unavailable.mockRestore(); }
      expect(replacement.checkQueue.running).toBe(1);
      unrelated.kill("SIGKILL"); await unrelated.exited; await unrelatedCapture.drained;
      await replacement.extraValidations.retryCleanup();
      expect(replacement.extraValidations.get(queued.requestId)!.outcome).toBe("completed");
      expect(replacement.checkQueue.running).toBe(0);
    } finally { unrelated.kill("SIGKILL"); await unrelated.exited; await unrelatedCapture.drained; signals.mockRestore(); await replacement?.extraValidations.retryCleanup(); await (replacement ? owner.stop(replacement) : undefined); }

  }, {}, { fastClientStop: false, actorLease: true });

  });
});

it("keeps added extra-only tasks out of agent admission while their saved version is read", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const admitted: string[] = [];
    const start = spyOn(f.engine["driver"].workflow, "startDriver");
    owner.onStop(() => start.mockRestore());
    start.mockImplementation(id => { admitted.push(id); });
    let adding: ReturnType<typeof f.add> | undefined;
    try {
      f.engine.s.tools.forEach(tool => { tool.status = "ready"; });
      f.engine.setPoolPaused(false);
      adding = f.add(); // Preparation is now waiting for its first asynchronous Git result.
      f.engine.schedule();
      expect(admitted).toEqual([]);
      const task = await adding;
      expect(task.state).toBe("needs-you");
      expect(f.engine.s.inbox.some(item => item.taskId === task.id && item.kind === "delivery")).toBe(true);
    } finally {
      f.engine.setPoolPaused(true); await adding;
      start.mockRestore(); await owner.stop(f.engine);
    }

  });

  });
});

it("keeps extra-only tasks at a coordinator checkpoint through resume and restart", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    let replacement: Engine | undefined;
    const noAgentAdmission = (engine: Engine) => {
      const admitted: string[] = [];
      const start = spyOn(engine["driver"].workflow, "startDriver");
    owner.onStop(() => start.mockRestore());
    start.mockImplementation(id => { admitted.push(id); });
      try {
        // Ready tools must not turn an extra-only control into a real agent workflow.
        engine.s.tools.forEach(tool => { tool.status = "ready"; });
        engine.setPoolPaused(false); engine.schedule();
        expect(admitted).toEqual([]);
        expect(engine.task(f.task.id)!.state).toBe("needs-you");
        expect(engine.s.inbox.some(item => item.taskId === f.task.id && item.kind === "delivery")).toBe(true);
      } finally { engine.setPoolPaused(true); start.mockRestore(); }
    };
    try {
      await f.engine.waitUntilReady();
      noAgentAdmission(f.engine);
      const record = await f.submit("isolated-extra-control", ["probe", "pass"]);
      f.engine.setPoolPaused(false);
      expect((await f.finished(record)).result).toBe("passed");
      f.engine.setPoolPaused(true); await owner.stop(f.engine);
      replacement = owner.open(f.data, f.settings);
      await replacement.extraValidations.ready;
      noAgentAdmission(replacement);
      expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
    } finally { await (replacement ? owner.stop(replacement) : undefined); await owner.stop(f.engine); }

  }, {}, { fastClientStop: true, actorLease: false, commandLease: false, scriptedNonHoldRuns: true });

  });
});

it("reports live extra evidence as pending rather than restarted", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const queued = await f.submit("live-evidence");
    f.engine.setPoolPaused(false); await f.started(queued);
    const live = await f.coordination.call("validation.inspect", { requestId: queued.requestId });
    const record = live.validation as ExtraValidation;
    expect(live.outcome).toBe("pending"); expect(record.state).toBe("running");
    expect(record.result).toBeUndefined(); expect(record.run!.endedAt).toBeUndefined();
    expect(record.run!.interrupted).toBeUndefined();
    expect(record.run!.output).not.toContain("restarted");
    expect(record.run!.output).toContain("in progress");
    const log = await f.coordination.call("validation.log", { requestId: queued.requestId });
    expect(log.outcome).toBe("pending");
    f.release(queued);
    const finished = await f.finished(queued);
    expect(finished.result).toBe("passed"); expect(finished.run!.logComplete).toBe(true);
    expect(finished.run!.output).toContain(`Original complete diagnostic for ${queued.id}`);
    await owner.stop(f.engine);

  });

  });
});

it("recovers ownership saved before a command log exists without inventing an outcome", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const queued = await f.submit("crash-before-log");
    const record = f.engine.s.extraValidations![0]!, container = f.engine.extraValidations["container"];
    record.container = await container.prepare(record);
    await container.snapshot(record);
    // This saved boundary precedes log creation and client startup. Recovery still owns it.
    record.state = "running"; record.startedAt = Date.now();
    f.engine.commitNow(); await owner.stop(f.engine);
    writeFileSync(join(f.service, "cleanup-off"), "service unavailable");
    const replacement = owner.open(f.data, f.settings);
    await replacement.extraValidations.ready;
    expect(replacement.s.extraValidations![0]!.state).toBe("held");
    expect(replacement.checkQueue.running).toBe(1);
    rmSync(join(f.service, "cleanup-off"));
    await replacement.extraValidations.retryCleanup();
    const recovered = replacement.extraValidations.get(queued.requestId)!.validation as ExtraValidation;
    expect(recovered.result).toBe("stopped"); expect(recovered.detail).toContain("uncertain run was not repeated");
    expect(recovered.run).toBeUndefined();
    expect((await new Coordination(replacement).call("validation.log", { requestId: queued.requestId })).outcome).toBe("unavailable");
    expect(readdirSync(join(f.service, "started"))).toEqual([]);
    expect(existsSync(queued.snapshot)).toBe(false); expect(replacement.checkQueue.running).toBe(0);
    await owner.stop(replacement);

  });

  });
});
});
