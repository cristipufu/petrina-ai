import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { Engine } from "./engine.js";
import { git, waitFor } from "./fixtures.js";
import { Coordination } from "../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import * as processTree from "../src/process-tree.js";
import { expectRejection } from "./rejections.js";
import { ExtraFixtures, failPrelaunchSave } from "./extra-fixtures.js";

const owned = new ExtraFixtures();
const { engines } = owned;
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());

describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
  for (const checkRuns of [1, 2]) it(`reserves the final place atomically and keeps FIFO between product and extra runs (limit ${checkRuns})`, async () => {
    const f = await fixture({ checkRuns });
    const { engine } = f;
    engine.setPoolPaused(false);
    const acquire = () => engine["checks"]["turnToRun"](executionFor(f.task), new AbortController().signal);
    const occupying = [];
    for (let i = 0; i < checkRuns; i++) occupying.push(await acquire());
    const extra = await f.submit("race");
    expect(engine.checkQueue.running).toBe(checkRuns);
    expect(engine.checkQueue.waiting).toBe(1);
    occupying.pop()!();
    // New product arrival is in the same JS turn as release, before the extra continuation resumes.
    const product = acquire();
    await f.started(extra);
    expect(engine.checkQueue.running).toBe(checkRuns);
    expect(engine.checkQueue.waiting).toBe(1);
    expect(extra.state).toBe("queued"); // the immediate reply is truthful and immutable
    f.release(extra);
    const releaseProduct = await product;
    expect((await f.finished(extra)).result).toBe("passed");
    releaseProduct();
    for (const release of occupying) release();
    expect(engine.checkQueue.running).toBe(0);
    // Reverse arrival order: the product waiter cannot be overtaken by an extra run.
    const held = [];
    for (let i = 0; i < checkRuns; i++) held.push(await acquire());
    const older = acquire();
    const next = await f.submit("reverse", ["probe", "pass"]);
    held.pop()!();
    const releaseOlder = await older;
    expect(existsSync(join(f.service, "started", next.id))).toBe(false);
    releaseOlder(); await f.finished(next);
    for (const release of held) release();
  });

  for (const checkRuns of [1, 2]) it(`admits two extra requests in order without starvation or double execution (limit ${checkRuns})`, async () => {
    const f = await fixture({ checkRuns });
    const secondTask = await f.add();
    const first = await f.submit("first");
    const second = await f.submit("second", ["probe", "hold"], secondTask.id);
    expect([first.queuePosition, second.queuePosition]).toEqual([1, 2]);
    expect(f.engine.checkQueue.running).toBe(0);
    f.engine.setPoolPaused(false);
    await f.started(first);
    if (checkRuns === 1) expect(existsSync(join(f.service, "started", second.id))).toBe(false);
    else await f.started(second);
    f.release(first); await f.finished(first); await f.started(second);
    f.release(second); await f.finished(second);
    expect(readdirSync(join(f.service, "started")).length).toBe(2);
    expect(f.engine.checkQueue.running).toBe(0);
  });

  it("caller cancellation ends only its wait; retries return the same saved run and original log", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const waiting = f.coordination.call("validation.run", { ...f.request("lost-reply"), wait: true, timeoutMs: 60_000 }, controller.signal);
    await waitFor(() => f.engine.s.extraValidations?.length === 1, "durable queued request");
    controller.abort();
    const first = (await waiting).validation as ExtraValidation;
    expect(first.state).toBe("queued");
    const other = await f.coordination.call("pool.inspect", {});
    expect(other.outcome).toBe("completed");
    f.engine.setPoolPaused(false); await f.started(first);
    const retry = await f.coordination.call("validation.run", { ...f.request("lost-reply"), timeoutMs: 0 });
    expect((retry.validation as ExtraValidation).id).toBe(first.id);
    const runningCaller = new AbortController();
    const runningWait = f.coordination.call("validation.run", { ...f.request("lost-reply"), wait: true }, runningCaller.signal);
    await f.coordination.call("pool.inspect", {});
    runningCaller.abort();
    expect(((await runningWait).validation as ExtraValidation).state).toBe("running");
    expect((await f.coordination.call("validation.run", { ...f.request("lost-reply"), reason: "Changed reason" })).outcome).toBe("conflict");
    f.release(first);
    const record = await f.finished(first);
    const final = await f.coordination.call("validation.run", f.request("lost-reply"));
    expect(final.validation).toEqual(record);
    expect(readdirSync(join(f.service, "started"))).toEqual([first.id]);
    const log = await f.coordination.call("validation.log", { requestId: "lost-reply" });
    expect(log.completeness).toBe("complete");
    expect(log.text).toContain("Original complete diagnostic");
    writeFileSync(record.run!.logPath!, "replacement");
    expect((await f.coordination.call("validation.log", { requestId: "lost-reply" })).completeness).toBe("missing-file");
  });

  it("holds capacity after the client dies while its container remains, survives cancellation and refuses removal until confirmed", async () => {
    const f = await fixture();
    f.engine.setPoolPaused(false);
    const record = await f.submit("held"); await f.started(record);
    expect(await git(record.snapshot, "rev-parse", "HEAD")).toBe(record.commit);
    expect(await git(record.snapshot, "rev-parse", "HEAD^{tree}")).toBe(record.tree);
    expect(readFileSync(join(record.snapshot, ".git", "config"), "utf8")).not.toContain("alternates");
    expect(existsSync(join(record.snapshot, ".git", "objects", "info", "alternates"))).toBe(false);
    writeFileSync(join(f.service, "cleanup-off"), "unavailable");
    const running = f.engine.s.extraValidations![0]!;
    process.kill(running.clientPid!, "SIGKILL");
    await waitFor(() => running.state === "held", "unconfirmed workload to hold its place");
    f.engine.cancel(f.task.id);
    expect(f.engine.checkQueue.running).toBe(1);
    expect(existsSync(record.snapshot)).toBe(true);
    expect(() => f.engine.removeProduct(f.productId)).toThrow("still needs this product for cleanup");
    const status = await f.coordination.call("engine.status", {});
    expect(status.checkBlockers).toEqual([f.engine.extraValidations.blocker]);
    const controller = new AbortController();
    const pending = f.engine.checkQueue.acquire(controller.signal);
    expect(f.engine.checkQueue.waiting).toBe(1);
    rmSync(join(f.service, "cleanup-off"));
    await f.engine.extraValidations.retryCleanup();
    const release = await pending; release();
    expect((await f.finished(record)).result).toBe("did not finish");
    expect((await f.coordination.call("validation.log", { requestId: record.requestId })).commandOutcome).toBe("unfinished");
    expect(existsSync(record.snapshot)).toBe(false);
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(f.engine.extraValidations.outstanding(f.productId)).toBeUndefined();
    f.engine.removeProduct(f.productId);
    expect(f.engine.s.products).toEqual([]);
  });

  for (const phase of ["admission", "start evidence", "log registration"] as const) it(`settles a pre-launch ${phase} save failure without false start evidence or a pending diagnostic`, async () => {
    const f = await fixture();
    await f.engine.waitUntilReady();
    const record = await f.submit("admission-save", ["probe", "pass"]), extra = f.engine.extraValidations;
    const prepare = spyOn(extra["container"], "prepare");
    const fault = failPrelaunchSave(f.engine, record.id, phase, 1);
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
    } finally { fault.restore(); prepare.mockRestore(); await f.engine.shutdown(); }
  });

  for (const [phase, failures, recovery] of [
    ["admission", 0, "cleanup retry"], ["admission", 0, "restart"],
    ["admission", 1, "cleanup retry"], ["admission", 1, "restart"],
    ["admission", 2, "cleanup retry"], ["admission", 2, "restart"],
    ["start evidence", 1, "cleanup retry"], ["start evidence", 1, "restart"], ["start evidence", 2, "cleanup retry"],
    ["log registration", 1, "cleanup retry"], ["log registration", 1, "restart"], ["log registration", 2, "restart"],
  ] as const) it(`preserves pre-launch ${phase} outcomes through ${recovery} (${failures} failed saves)`, async () => {
    const f = await fixture();
    await f.engine.waitUntilReady();
    const extra = f.engine.extraValidations, container = extra["container"], cleanup = container.cleanup.bind(container);
    let confirm = false;
    container.cleanup = record => confirm ? cleanup(record) : Promise.resolve(false);
    const record = await f.submit("admission-recovery", ["probe", "pass"]);
    const following = await f.submit("after-admission-recovery", ["probe", "pass"], (await f.add()).id);
    const fault = failPrelaunchSave(f.engine, record.id, phase, failures);
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
        f.engine.setPoolPaused(true); await f.engine.shutdown();
        current = new Engine(f.data, f.settings); engines.push(current); await current.waitUntilReady();
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
    } finally { fault.restore(); confirm = true; await current.shutdown(); await f.engine.shutdown(); }
  });

  for (const failures of [0, 1, 2]) for (const recovery of ["cleanup retry", "restart"] as const) it(`keeps launched-client save errors unfinished through ${recovery} (${failures} failed saves)`, async () => {
    const f = await fixture();
    await f.engine.waitUntilReady();
    const extra = f.engine.extraValidations, container = extra["container"], cleanup = container.cleanup.bind(container);
    let confirm = false;
    container.cleanup = record => confirm ? cleanup(record) : Promise.resolve(false);
    const record = await f.submit("launched-client-save", ["probe", "pass"]);
    const following = await f.submit("after-client-save", ["probe", "pass"], (await f.add()).id);
    const commit = f.engine.commitNow.bind(f.engine), failure = new Error("Launched client save unavailable");
    let remaining = failures;
    const save = spyOn(f.engine, "commitNow").mockImplementation((...args) => {
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
        f.engine.setPoolPaused(true); await f.engine.shutdown();
        current = new Engine(f.data, f.settings); engines.push(current); await current.waitUntilReady();
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
    } finally { save.mockRestore(); confirm = true; await current.extraValidations.retryCleanup(); await current.shutdown(); await f.engine.shutdown(); }
  });

  it("reports a periodic cleanup save failure, retains ownership and drains the next retry on shutdown", async () => {
    const interval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    const timer = spyOn(globalThis, "setInterval").mockImplementation(((...parameters: Parameters<typeof globalThis.setInterval>) => {
      const [callback, ms, ...args] = parameters;
      if (ms === 23_459) { tick = () => { (callback as () => void)(); }; return interval(callback, 60_000, ...args); }
      return interval(callback, ms, ...args);
    }) as typeof globalThis.setInterval);
    const log = spyOn(console, "error").mockImplementation(() => {});
    const released = Promise.withResolvers<void>();
    const controller = new AbortController();
    let restoreSave = () => {}, restoreCleanup = () => {};
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    let waiting: Promise<boolean> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      f = await fixture({ checkRuns: 2, extraCleanupEveryMs: 23_459 });
      await f.engine.waitUntilReady();
      expect(tick).toBeDefined();
      const record = await f.submit("periodic-save-failure");
      f.engine.setPoolPaused(false); await f.started(record);
      writeFileSync(join(f.service, "cleanup-off"), "unavailable");
      process.kill(f.engine.s.extraValidations![0]!.clientPid!, "SIGKILL");
      const extra = f.engine.extraValidations;
      await waitFor(() => extra.active === 0 && f!.engine.s.extraValidations![0]?.state === "held", "unconfirmed cleanup to hold capacity");
      const container = extra["container"], cleanup = container.cleanup.bind(container);
      const probe = spyOn(container, "cleanup").mockRejectedValueOnce(new Error("Cleanup probe failed"));
      restoreCleanup = () => probe.mockRestore();
      const failure = new Error("Saved state unavailable");
      const save = spyOn(f.engine, "commitNow").mockImplementationOnce(() => { throw failure; });
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
      const confirming = spyOn(container, "cleanup").mockImplementation(async record => { entered.resolve(); await released.promise; return cleanup(record); });
      restoreCleanup = () => confirming.mockRestore();
      rmSync(join(f.service, "cleanup-off"));
      tick!(); await entered.promise;
      let stopped = false;
      stopping = f.engine.shutdown().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(f.engine.checkQueue.running).toBe(1);
      released.resolve(); await stopping;
      expect(extra["retrying"]).toBeUndefined();
      expect(f.engine.checkQueue.running).toBe(0);
      expect(admitted).toBe(false);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.waitUntilReady();
      expect((replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("did not finish");
      expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
    } finally {
      released.resolve(); restoreSave(); restoreCleanup();
      controller.abort(); await waiting;
      if (f) {
        rmSync(join(f.service, "cleanup-off"), { force: true });
        await f.engine.extraValidations.retryCleanup();
        await f.engine.shutdown();
      }
      await stopping;
      log.mockRestore(); timer.mockRestore();
    }
  });

  for (const mode of ["completion", "preparation", "cancelled preparation"] as const) it(`retains cleanup ownership when saving ${mode} settlement fails`, async () => {
    const f = await fixture({ checkRuns: 2 });
    const extra = f.engine.extraValidations, container = extra["container"];
    const cleanup = container.cleanup.bind(container), snapshot = container.snapshot.bind(container);
    let confirm = false;
    container.cleanup = record => confirm ? cleanup(record) : Promise.resolve(false);
    if (mode !== "completion") container.snapshot = async record => { await snapshot(record); f.engine.setPoolPaused(true); };
    const record = await f.submit("settlement-save", ["probe", "pass"]);
    const controller = new AbortController();
    let waiting: Promise<boolean> | undefined;
    let restoreSave = () => {};
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => extra.active === 0 && f.engine.s.extraValidations![0]?.state === "held", "the settlement to wait on cleanup");
      // Preparation paused before any client started; completion keeps its original result.
      expect(f.engine.s.extraValidations![0]!.resumeQueued).toBe(mode === "completion" ? undefined : true);
      const following = await f.submit("after-settlement-save", ["probe", "pass"], (await f.add()).id);
      const failure = new Error("Settlement save unavailable");
      const save = spyOn(f.engine, "commitNow").mockImplementationOnce(() => { throw failure; });
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
      container.snapshot = snapshot;
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
      restoreSave(); confirm = true; container.snapshot = snapshot;
      controller.abort(); await waiting;
      await f.engine.shutdown();
    }
  });

  it("keeps the remaining cleanup blocker on waiting checks after one of two held runs finishes", async () => {
    const f = await fixture({ checkRuns: 3 });
    f.engine.schedule = () => { f.engine.extraValidations.pump(); f.engine.checkQueue.pump(); };
    const first = await f.submit("first-held");
    const second = (await f.coordination.call("validation.run", { ...f.request("second-held", undefined, (await f.add()).id), name: "Second required suite" })).validation as ExtraValidation;
    f.engine.setPoolPaused(false);
    const productTask = await f.add(); productTask.state = "running";
    const controller = new AbortController();
    let productRun: Promise<unknown> | undefined;
    let confirmSecond = false;
    const container = f.engine.extraValidations["container"];
    const cleanup = container.cleanup.bind(container);
    container.cleanup = record => record.id === second.id && !confirmSecond ? Promise.resolve(false) : cleanup(record);
    try {
      await f.started(first); await f.started(second);
      writeFileSync(join(f.service, "cleanup-off"), "unavailable");
      for (const record of f.engine.s.extraValidations!) process.kill(record.clientPid!, "SIGKILL");
      await waitFor(() => f.engine.s.extraValidations!.every(record => record.state === "held") && f.engine.extraValidations.active === 0, "both runs to hold cleanup");
      productRun = f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Ordinary check", argv: [process.execPath, "-e", "process.exit(0)"] }], controller.signal).then(failures => ({ failures }), error => ({ error }));
      await waitFor(() => f.engine.checkQueue.waiting === 1, "the product check to wait on cleanup");
      expect(productTask.statusLine).toBe(f.engine.extraValidations.blocker!);
      rmSync(join(f.service, "cleanup-off"));
      await f.engine.extraValidations.retryCleanup();
      expect(f.engine.s.extraValidations!.map(record => record.id)).toEqual([second.id]);
      expect(f.engine.checkQueue.running).toBe(1);
      expect(productTask.statusLine).toBe(f.engine.extraValidations.blocker!);
      expect(productTask.statusLine).toContain("Second required suite");
      expect(productTask.journey!.at(-1)!.productChecks![0]!.result).toBe("pending");
      f.engine.setPoolPaused(true);
      expect(productTask.statusLine).toBe("Waiting for the pool to resume");
      confirmSecond = true;
      await f.engine.extraValidations.retryCleanup();
      expect(productTask.statusLine).toBe("Waiting for the pool to resume");
      expect(f.engine.checkQueue.running).toBe(0);
      f.engine.setPoolPaused(false);
      expect(await productRun).toEqual({ failures: 0 });
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally {
      confirmSecond = true; controller.abort();
      rmSync(join(f.service, "cleanup-off"), { force: true });
      await f.engine.extraValidations.retryCleanup(); await productRun;
      await f.engine.shutdown();
    }
  });
});
