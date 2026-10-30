import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { waitFor } from "../../fixtures.js";
import { Coordination } from "../../../src/coordination.js";

import * as processTree from "@petrina/platform/process-tree";
import { expectRejection } from "@petrina/test-support/rejections";
import { preparedServiceExtraFixture as extraFixture, failPrelaunchSave, type ExtraFixture } from "../../extra-fixtures.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
for (const phase of ["admission", "start evidence", "log registration"] as const) it(`settles a pre-launch ${phase} save failure without false start evidence or a pending diagnostic`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    await f.engine.waitUntilReady();
    const record = await f.submit("admission-save", ["probe", "pass"]), extra = f.engine.extraValidations;
    const prepare = spyOn(extra["container"], "prepare");
    owner.onStop(() => prepare.mockRestore());
    const fault = failPrelaunchSave(owner, f.engine, record.id, phase, 1);
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => fault.injected && extra.active === 0, "the failed registration to settle");
      const reply = extra.get(record.requestId)!;
      expect(reply.outcome).toBe("completed");
      const result = reply.validation as ExtraValidation;
      expect(result.result).toBe("not run"); expect(result.detail).toBe(fault.failure.message);
      expect(result.startedAt).toBeUndefined(); expect(result.clientPid).toBeUndefined(); expect(result.run).toBeUndefined();
      expect(result.stoppingAt).toBeUndefined(); expect(result.durationMs).toBe(0);
      expect(prepare).toHaveBeenCalledTimes(phase === "admission" ? 0 : 1);
      expect(f.task.timeline.some(line => line.text.includes("is running") || line.text.includes("Stopping extra validation"))).toBe(false);
      expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind.startsWith("extra.")).map(event => event.kind)).toEqual(["extra.queued", "extra.finished"]);
      expect((await f.coordination.call("validation.log", { requestId: record.requestId })).outcome).toBe("unavailable");
      expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
      expect(f.engine.s.extraValidations).toEqual([]); expect(existsSync(record.snapshot)).toBe(false);
      expect(existsSync(join(f.service, "started")) ? readdirSync(join(f.service, "started")) : []).toEqual([]);
      expect(await f.coordination.call("validation.run", f.request(record.requestId, ["probe", "pass"]))).toEqual(reply);
      await extra.retryCleanup();
      expect(extra.get(record.requestId)).toEqual(reply);
    } finally { fault.restore(); prepare.mockRestore(); await owner.stop(f.engine); }

  }, {}, { fastClientStop: true, actorLease: false, commandLease: false, scriptedNonHoldRuns: true });

  });
});

for (const [phase, failures, recovery] of [
    // Actual SQLite/restart, log identity and native follow-on execution anchors. Save-count
    // permutations exercise the production ValidationRun with explicit failing persistence effects.
    ["admission", 0, "restart"], ["admission", 2, "cleanup retry"],
    ["start evidence", 1, "restart"], ["log registration", 2, "restart"],
  ] as const) it(`preserves pre-launch ${phase} outcomes through ${recovery} (${failures} failed saves)`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    await f.engine.waitUntilReady();
    const extra = f.engine.extraValidations, container = extra["container"], cleanup = container.cleanup.bind(container);
    let confirm = false;
    owner.onStop(() => { confirm = true; });
    container.cleanup = record => confirm ? cleanup(record) : Promise.resolve(false);
    const record = await f.submit("admission-recovery", ["probe", "pass"]);
    const following = await f.submit("after-admission-recovery", ["probe", "pass"], (await f.add()).id);
    const fault = failPrelaunchSave(owner, f.engine, record.id, phase, failures);
    let current = f.engine;
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => extra.active === 0 && f.engine.s.extraValidations?.[0]?.state === "held", "the attempt to retain cleanup ownership");
      expect(fault.remaining).toBe(0);
      const held = extra.get(record.requestId)!.validation as ExtraValidation;
      expect(held.result).toBe(failures ? "not run" : "passed");
      if (failures) {
        expect(held.detail).toBe(fault.failure.message); expect(held.startedAt).toBeUndefined(); expect(held.run).toBeUndefined(); expect(held.stoppingAt).toBeUndefined();
        expect(f.task.timeline.some(line => line.text.includes("is running") || line.text.includes("Stopping extra validation"))).toBe(false);
        expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.taskId === record.taskId && event.kind.startsWith("extra.")).map(event => event.kind)).toEqual(["extra.queued", "extra.held"]);
      }
      else { expect(held.startedAt).toBeDefined(); expect(held.run!.ok).toBe(true); }
      expect((await f.coordination.call("validation.log", { requestId: record.requestId })).outcome).toBe(failures ? "unavailable" : "completed");
      expect([held.commit, held.tree, held.queueOrder, held.queuedAt]).toEqual([record.commit, record.tree, record.queueOrder, record.queuedAt]);
      expect(f.engine.store.load()!.extraValidations![0]).toEqual(held);
      expect(held).toEqual(f.task.journey!.at(-1)!.extraValidations![0]!);
      expect(f.engine.checkQueue.running).toBe(1); expect(f.engine.checkQueue.waiting).toBe(1);
      expect(() => f.engine.removeProduct(f.productId)).toThrow("Extra validation");
      expect(await f.coordination.call("validation.run", f.request(record.requestId, ["probe", "pass"]))).toEqual(extra.get(record.requestId)!);
      fault.restore();
      confirm = true;
      if (recovery === "restart") {
        f.engine.setPoolPaused(true); await owner.stop(f.engine);
        current = owner.open(f.data, f.settings);  await current.waitUntilReady();
      } else await extra.retryCleanup();
      const reply = current.extraValidations.get(record.requestId)!;
      expect(reply.outcome).toBe("completed");
      const result = reply.validation as ExtraValidation;
      expect(result.result).toBe(failures ? "not run" : "passed"); expect(result.detail).toBe(held.detail);
      expect(result.run).toEqual(held.run); expect(result.durationMs).toBe(held.durationMs);
      expect(result).toEqual(current.task(record.taskId)!.journey!.at(-1)!.extraValidations![0]!);
      expect((await new Coordination(current).call("validation.log", { requestId: record.requestId })).outcome).toBe(failures ? "unavailable" : "completed");
      current.setPoolPaused(false);
      await waitFor(() => current.extraValidations.get(following.requestId)?.outcome === "completed", "the following request to get its place");
      expect((current.extraValidations.get(following.requestId)!.validation as ExtraValidation).result).toBe("passed");
      await current.extraValidations.retryCleanup();
      expect(await new Coordination(current).call("validation.run", f.request(record.requestId, ["probe", "pass"]))).toEqual(reply);
      const runs = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(runs.map(args => args[args.indexOf("--name") + 1])).toEqual(failures ? [following.containerName] : [record.containerName, following.containerName]);
      expect(current.checkQueue.running).toBe(0); expect(current.checkQueue.waiting).toBe(0);
      expect(current.s.extraValidations).toEqual([]); expect(existsSync(record.snapshot)).toBe(false);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally { fault.restore(); confirm = true; await owner.stop(current); await owner.stop(f.engine); }

  }, {}, { fastClientStop: true, actorLease: false, commandLease: false, scriptedNonHoldRuns: true });

  });
});

for (const failures of [0, 1, 2]) for (const recovery of ["cleanup retry", "restart"] as const) it(`keeps launched-client save errors unfinished through ${recovery} (${failures} failed saves)`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    await f.engine.waitUntilReady();
    const extra = f.engine.extraValidations, container = extra["container"], cleanup = container.cleanup.bind(container);
    let confirm = false;
    owner.onStop(() => { confirm = true; });
    container.cleanup = record => confirm ? cleanup(record) : Promise.resolve(false);
    const record = await f.submit("launched-client-save", ["probe", "pass"]);
    const following = await f.submit("after-client-save", ["probe", "pass"], (await f.add()).id);
    const commit = f.engine.commitNow.bind(f.engine), failure = new Error("Launched client save unavailable");
    let remaining = failures;
    const save = spyOn(f.engine, "commitNow");
    owner.onStop(() => save.mockRestore());
    save.mockImplementation((...args) => {
      if (remaining && f.engine.s.extraValidations?.find(entry => entry.id === record.id)?.clientPid !== undefined) { remaining--; throw failure; }
      return commit(...args);
    });
    let current = f.engine;
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => extra.active === 0 && f.engine.s.extraValidations?.[0]?.state === "held", "the launched attempt to retain cleanup ownership");
      expect(remaining).toBe(0);
      const held = extra.get(record.requestId)!.validation as ExtraValidation;
      expect(held.startedAt).toBeDefined(); expect(held.clientPid).toBeDefined(); expect(held.run!.endedAt).toBeDefined();
      expect(await processTree.childState(held.clientPid!)).toBe("ended");
      expect(held.result).toBe(failures ? "did not finish" : "passed");
      expect(held.run!.ok).toBe(!failures);
      if (failures) {
        expect(held.run!.interrupted).toBe(true); expect(held.detail).toContain(failure.message);
        expect(held.run!.output).toContain(failure.message); expect(held.run!.output).not.toContain("Could not start");
        expect(f.task.timeline.some(line => line.text.includes("failed ("))).toBe(false);
      } else expect(held.run!.logComplete).toBe(true);
      const log = await f.coordination.call("validation.log", { requestId: record.requestId, section: "result" });
      expect(log.outcome).toBe("completed"); expect(log.commandOutcome).toBe(failures ? "unfinished" : "passed");
      if (failures) { expect(log.text).toContain(failure.message); expect(log.text).not.toContain("Could not start"); }
      expect(f.engine.store.load()!.extraValidations![0]).toEqual(held);
      expect(held).toEqual(f.task.journey!.at(-1)!.extraValidations![0]!);
      expect(f.engine.checkQueue.running).toBe(1); expect(f.engine.checkQueue.waiting).toBe(1);
      save.mockRestore(); confirm = true;
      if (recovery === "restart") {
        f.engine.setPoolPaused(true); await owner.stop(f.engine);
        current = owner.open(f.data, f.settings);  await current.waitUntilReady();
      } else await extra.retryCleanup();
      const reply = current.extraValidations.get(record.requestId)!;
      expect(reply.outcome).toBe("completed");
      const result = reply.validation as ExtraValidation;
      expect(result.result).toBe(held.result); expect(result.detail).toBe(held.detail);
      expect(result.run).toEqual(held.run); expect(result.durationMs).toBe(held.durationMs); expect(result.clientPid).toBe(held.clientPid);
      const coordination = new Coordination(current);
      expect(await coordination.call("validation.log", { requestId: record.requestId, section: "result" })).toEqual({ ...log, validationState: "finished" });
      expect(await coordination.call("validation.run", f.request(record.requestId, ["probe", "pass"]))).toEqual(reply);
      current.setPoolPaused(false);
      await waitFor(() => current.extraValidations.get(following.requestId)?.outcome === "completed", "the following validation to start once cleanup settles");
      expect((current.extraValidations.get(following.requestId)!.validation as ExtraValidation).result).toBe("passed");
      const runs = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(runs.filter(args => args.includes(record.containerName)).length).toBeLessThanOrEqual(1);
      expect(runs.filter(args => args.includes(following.containerName))).toHaveLength(1);
      expect(current.checkQueue.running).toBe(0); expect(current.checkQueue.waiting).toBe(0); expect(current.s.extraValidations).toEqual([]);
      expect(existsSync(record.snapshot)).toBe(false); expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally { save.mockRestore(); confirm = true; await current.extraValidations.retryCleanup(); await owner.stop(current); await owner.stop(f.engine); }

  });

  });
});

it("reports a periodic cleanup save failure, retains ownership and drains the next retry on shutdown", async () => {
  return cases.use("petrina-extra-", async owner => {
    const interval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    const timer = spyOn(globalThis, "setInterval");
    owner.onStop(() => timer.mockRestore());
    timer.mockImplementation(((...parameters: Parameters<typeof globalThis.setInterval>) => {
      const [callback, ms, ...args] = parameters;
      if (ms === 23_459) { tick = () => { (callback as () => void)(); }; return interval(callback, 60_000, ...args); }
      return interval(callback, ms, ...args);
    }) as typeof globalThis.setInterval);
    const log = spyOn(console, "error");
    owner.onStop(() => log.mockRestore());
    log.mockImplementation(() => {});
    const released = Promise.withResolvers<void>();
    owner.onStop(() => released.resolve());
    const controller = new AbortController();
    owner.onStop(() => controller.abort());
    let restoreSave = () => {}, restoreCleanup = () => {};
    let f: ExtraFixture | undefined;
    let waiting: Promise<boolean> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      return await extraFixture(owner, async actualFixture => {f = actualFixture;
      await f.engine.waitUntilReady();
      expect(tick).toBeDefined();
      const record = await f.submit("periodic-save-failure");
      f.engine.setPoolPaused(false); await f.started(record);
      writeFileSync(join(f.service, "cleanup-off"), "unavailable");
      process.kill(f.engine.s.extraValidations![0]!.clientPid!, "SIGKILL");
      const extra = f.engine.extraValidations;
      await waitFor(() => extra.active === 0 && f!.engine.s.extraValidations![0]?.state === "held", "unconfirmed cleanup to hold capacity");
      const container = extra["container"], cleanup = container.cleanup.bind(container);
      const probe = spyOn(container, "cleanup");
    owner.onStop(() => probe.mockRestore());
    probe.mockRejectedValueOnce(new Error("Cleanup probe failed"));
      restoreCleanup = () => probe.mockRestore();
      const failure = new Error("Saved state unavailable");
      const save = spyOn(f.engine, "commitNow");
    owner.onStop(() => save.mockRestore());
    save.mockImplementationOnce(() => { throw failure; });
      restoreSave = () => save.mockRestore();
      tick!();
      // Observe the operation too: explicit callers still receive its error, while the
      // interval must report it itself rather than leave it to a process-wide handler.
      await expectRejection(extra["retrying"]!, failure);
      expect(log).toHaveBeenCalledWith("Could not retry extra validation cleanup:", failure);
      expect(extra["retrying"]).toBeUndefined();
      expect(f.engine.s.extraValidations![0]!.state).toBe("held");
      expect(f.engine.store.load()!.extraValidations![0]!.id).toBe(record.id);
      expect(f.engine.checkQueue.running).toBe(1);
      expect(existsSync(record.snapshot)).toBe(true);
      expect(readdirSync(join(f.service, "containers"))).toEqual([record.containerName]);
      let admitted = false;
      waiting = f.engine.checkQueue.acquire(controller.signal).then(place => { admitted = true; place(); return true; }, () => false);
      expect(f.engine.checkQueue.waiting).toBe(1); // Held cleanup blocks even the spare place.
      restoreSave(); restoreCleanup();
      tick!(); await extra["retrying"];
      expect(admitted).toBe(false);
      expect(f.engine.checkQueue.running).toBe(1);
      expect(extra.get(record.requestId)!.outcome).toBe("pending");
      const entered = Promise.withResolvers<void>();
      const confirming = spyOn(container, "cleanup");
    owner.onStop(() => confirming.mockRestore());
    confirming.mockImplementation(async record => { entered.resolve(); await released.promise; return cleanup(record); });
      restoreCleanup = () => confirming.mockRestore();
      rmSync(join(f.service, "cleanup-off"));
      tick!(); await entered.promise;
      let stopped = false;
      stopping = owner.stop(f.engine).then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(f.engine.checkQueue.running).toBe(1);
      released.resolve(); await stopping;
      expect(extra["retrying"]).toBeUndefined();
      expect(f.engine.checkQueue.running).toBe(0);
      expect(admitted).toBe(false);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      const replacement = owner.open(f.data, f.settings);
      await replacement.waitUntilReady();
      expect((replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("did not finish");
      expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);

  }, { checkRuns: 2, extraCleanupEveryMs: 23_459 });
} finally {
      released.resolve(); restoreSave(); restoreCleanup();
      controller.abort(); await waiting;
      if (f) {
        rmSync(join(f.service, "cleanup-off"), { force: true });
        await f.engine.extraValidations.retryCleanup();
        await owner.stop(f.engine);
      }
      await stopping;
      log.mockRestore(); timer.mockRestore();
    }

  });
});

for (const mode of ["completion", "preparation", "cancelled preparation"] as const) it(`retains cleanup ownership when saving ${mode} settlement fails`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const extra = f.engine.extraValidations, container = extra["container"];
    const snapshots = f.settings.validationSnapshots!;
    const cleanup = container.cleanup.bind(container), snapshot = snapshots.snapshot.bind(snapshots);
    let confirm = false;
    owner.onStop(() => { confirm = true; });
    container.cleanup = record => confirm ? cleanup(record) : Promise.resolve(false);
    if (mode !== "completion") snapshots.snapshot = async record => { await snapshot(record); f.engine.setPoolPaused(true); };
    const record = await f.submit("settlement-save", ["probe", "pass"]);
    const controller = new AbortController();
    owner.onStop(() => controller.abort());
    let waiting: Promise<boolean> | undefined;
    let restoreSave = () => {};
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => extra.active === 0 && f.engine.s.extraValidations![0]?.state === "held", "the settlement to wait on cleanup");
      // Preparation paused before any client started; completion keeps its original result.
      expect(f.engine.s.extraValidations![0]!.resumeQueued).toBe(mode === "completion" ? undefined : true);
      const following = await f.submit("after-settlement-save", ["probe", "pass"], (await f.add()).id);
      const failure = new Error("Settlement save unavailable");
      const save = spyOn(f.engine, "commitNow");
    owner.onStop(() => save.mockRestore());
    save.mockImplementationOnce(() => { throw failure; });
      restoreSave = () => save.mockRestore();
      confirm = true;
      await extra.retryCleanup(); // The ordinary hold save succeeds after the settlement save fails.
      expect(save).toHaveBeenCalledTimes(2);
      restoreSave();
      const held = f.engine.s.extraValidations!.find(entry => entry.id === record.id)!;
      expect(held).toBeDefined();
      expect(held.state).toBe("held");
      expect(held.resumeQueued).toBe(mode === "completion" ? undefined : true);
      expect(extra.get(record.requestId)!.outcome).toBe("pending");
      expect(f.engine.store.load()!.extraValidations!.find(entry => entry.id === record.id)?.state).toBe("held");
      expect(f.engine.checkQueue.running).toBe(1);
      // Even the spare place stays blocked until settlement has been saved successfully.
      let admitted = false;
      waiting = f.engine.checkQueue.acquire(controller.signal).then(place => { admitted = true; place(); return true; }, () => false);
      expect(admitted).toBe(false);
      snapshots.snapshot = snapshot;
      if (mode === "cancelled preparation") f.engine.cancel(f.task.id);
      await extra.retryCleanup();
      f.engine.setPoolPaused(false);
      expect((await f.finished(record)).result).toBe(mode === "cancelled preparation" ? "stopped" : "passed");
      expect((await f.finished(following)).result).toBe("passed");
      expect(await waiting).toBe(true);
      expect(f.engine.checkQueue.running).toBe(0);
      expect(f.engine.checkQueue.waiting).toBe(0);
      const runs = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(runs.map(args => args[args.indexOf("--name") + 1]).sort()).toEqual((mode === "cancelled preparation" ? [following.containerName] : [record.containerName, following.containerName]).sort());
      expect(existsSync(record.snapshot)).toBe(false);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally {
      restoreSave(); confirm = true; snapshots.snapshot = snapshot;
      controller.abort(); await waiting;
      await owner.stop(f.engine);
    }

  }, { checkRuns: 2 }, { fastClientStop: true, actorLease: false, commandLease: false, scriptedNonHoldRuns: true });

  });
});
});
