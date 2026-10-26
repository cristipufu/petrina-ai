import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";


import { waitFor } from "../../fixtures.js";
import { executionFor } from "@petrina/orchestrator";


import { EngineLifecycle } from "../../../src/lifecycle.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { WaitingForUsage } from "../../../src/usage.js";
import { ExtraFixtures } from "../../extra-fixtures.js";

const owned = new ExtraFixtures();
const {  } = owned;
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
for (const extra of [false, true]) for (const timing of ["before release", "during pause", "during handoff"] as const) it(`keeps product check evidence pending when pausing ${timing}${extra ? " ahead of a later extra run" : " without any extra run"}`, async () => {
    const f = await fixture();
    const productTask = await f.add();
    productTask.state = "running";
    // Exercise check admission and evidence without starting unrelated agent workflows.
    f.engine.schedule = () => { f.engine.extraValidations.pump(); f.engine.checkQueue.pump(); };
    f.engine.setPoolPaused(false);
    const busy = await f.engine.checkQueue.acquire(new AbortController().signal);
    const controller = new AbortController();
    const productRun = f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Ordinary check", argv: [process.execPath, "-e", "console.log('ordinary check passed')"] }], controller.signal).then(result => ({ failures: nonpassingChecks(result) }), error => ({ error }));
    try {
      await waitFor(() => f.engine.checkQueue.waiting === 1 && productTask.journey?.at(-1)?.productChecks?.[0]?.result === "pending", "the product check to join the line with its pending evidence");
      const step = productTask.journey!.at(-1)!;
      const pending = structuredClone(step.productChecks);
      const following = extra ? await f.submit("pause-order", ["probe", "pass"]) : undefined;
      if (timing === "during handoff") busy();
      f.engine.setPoolPaused(true);
      if (timing === "during pause") busy();
      await Promise.resolve();
      expect(step.productChecks).toEqual(pending);
      expect(step.productChecks![0]!.result).toBe("pending");
      expect(f.engine.checkQueue.waiting).toBe(extra ? 2 : 1);
      expect(f.engine.checkQueue.running).toBe(timing === "before release" ? 1 : 0);
      expect(f.engine.task(productTask.id)!.state).toBe("waiting");
      expect(productTask.statusLine).toBe("Waiting for the pool to resume");
      if (following) expect(f.engine.s.extraValidations![0]!.state).toBe("queued");
      f.engine.setPoolPaused(false);
      if (timing === "before release") {
        expect(productTask.state).toBe("running");
        expect(productTask.statusLine).toBe("Waiting to run the checks: another task's run comes first");
      }
      busy();
      expect(await productRun).toEqual({ failures: 0 });
      expect(f.engine.waitingChecks.size).toBe(0);
      expect(step.productChecks).toHaveLength(1);
      expect(step.productChecks![0]!.result).toBe("pass");
      if (following) {
        await f.finished(following);
        const events = f.engine.events.log.collect({}, 0, 100).events;
        const productStart = events.findIndex(event => event.kind === "check.started" && event.taskId === productTask.id);
        expect(productStart).toBeGreaterThanOrEqual(0);
        expect(productStart).toBeLessThan(events.findIndex(event => event.kind === "extra.started"));
      }
    } finally { controller.abort(); busy(); await productRun; }
  });

for (const phase of ["preparation", "another run", "handoff preparation"] as const) it(`shows a quiet paused check as waiting and lets the Mac sleep after ${phase}`, async () => {
    const awake: boolean[] = [];
    const f = await fixture({ awakeObserver: active => awake.push(active) });
    const productTask = await f.add(); productTask.state = "running";
    f.engine.schedule = () => { f.engine.extraValidations.pump(); f.engine.checkQueue.pump(); };
    f.engine.setPoolPaused(false);
    const controller = new AbortController();
    f.engine.drivers.set(productTask.id, controller);
    let releasePreparation = () => {};
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { releasePreparation = resolve; });
    const capture = f.engine["checks"]["captureState"].bind(f.engine["checks"]);
    let captures = 0, ended = false;
    f.engine["checks"]["captureState"] = async (...args: Parameters<typeof capture>) => {
      const state = await capture(...args);
      const held = ++captures === (phase === "handoff preparation" ? 2 : 1);
      if (held) entered();
      if (held && phase !== "another run") await released;
      return state;
    };
    const busy = phase !== "preparation" ? await f.engine.checkQueue.acquire(new AbortController().signal) : undefined;
    if (busy) f.engine.settling.set(f.task.id, new Promise<void>(() => {}));
    const productRun = f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Ordinary check", argv: [process.execPath, "-e", "console.log('ordinary check passed')"] }], controller.signal).then(result => ({ failures: nonpassingChecks(result) }), error => ({ error })).finally(() => { ended = true; });
    f.engine.settling.set(productTask.id, productRun.then(() => undefined));
    try {
      if (phase === "handoff preparation") {
        await waitFor(() => f.engine.checkQueue.waiting === 1, "the check to wait before recapture");
        busy!();
      }
      await preparing;
      if (phase === "another run") await waitFor(() => f.engine.checkQueue.waiting === 1, "the check to wait behind another run");
      const following = phase === "handoff preparation" ? await f.submit("after-paused-recapture", ["probe", "pass"]) : undefined;
      f.engine.commitNow();
      expect(awake.at(-1)).toBe(true);
      f.engine.setPoolPaused(true);
      expect(awake.at(-1)).toBe(true); // Preparation or the other actual run still owns work.
      releasePreparation();
      busy?.(); f.engine.settling.delete(f.task.id);
      await waitFor(() => {
        if (ended) throw new Error("The paused attempt ended instead of queueing: " + productTask.statusLine);
        return f.engine.checkQueue.waiting === (following ? 2 : 1) && f.engine.checkQueue.running === 0;
      }, "only the paused checks to remain");
      f.engine.commitNow();
      expect(f.engine.task(productTask.id)!.state).toBe("waiting");
      expect(productTask.statusLine).toBe("Waiting for the pool to resume");
      expect(awake.at(-1)).toBe(false);
      const events = f.engine.events.log.collect({ taskIds: [productTask.id] }, 0, 100).events;
      expect(events.some(event => event.kind === "task.state" && event.from === "running" && event.to === "waiting" && event.reason === "Waiting for the pool to resume")).toBe(true);
      const pending = structuredClone(productTask.journey!.at(-1)!.productChecks);
      f.engine.setPoolPaused(false);
      expect(awake.at(-1)).toBe(true);
      expect(await productRun).toEqual({ failures: 0 });
      expect(productTask.state).toBe("running");
      expect(productTask.journey!.at(-1)!.productChecks).toHaveLength(1);
      expect(productTask.journey!.at(-1)!.productChecks![0]!.queuedAt).toBe(pending![0]!.queuedAt);
      expect(f.engine.events.log.collect({ taskIds: [productTask.id], kinds: ["check.started"] }, 0, 100).events).toHaveLength(1);
      if (following) {
        expect((await f.finished(following)).result).toBe("passed");
        const events = f.engine.events.log.collect({}, 0, 100).events;
        expect(events.findIndex(event => event.kind === "check.started")).toBeLessThan(events.findIndex(event => event.kind === "extra.started"));
      }
    } finally {
      releasePreparation(); controller.abort(); busy?.(); f.engine["checks"]["captureState"] = capture;
      await productRun;
      f.engine.drivers.delete(productTask.id); f.engine.settling.delete(productTask.id); f.engine.settling.delete(f.task.id);
      f.engine.syncIdleSleep();
    }
    expect(awake.at(-1)).toBe(false);
  });

it("completes a coordinator pool pause while preserving queued check work for resume", async () => {
    const f = await fixture();
    const productTask = await f.add();
    productTask.state = "running";
    f.engine.schedule = () => { f.engine.extraValidations.pump(); f.engine.checkQueue.pump(); };
    f.engine.setPoolPaused(false);
    const busy = await f.engine.checkQueue.acquire(new AbortController().signal);
    let endBusy!: () => void;
    const busyWork = new Promise<void>(resolve => { endBusy = resolve; });
    f.engine.settling.set(f.task.id, busyWork);
    void busyWork.then(() => f.engine.settling.delete(f.task.id));
    const controller = new AbortController();
    const productRun = f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Queued check", argv: [process.execPath, "-e", "process.exit(0)"] }], controller.signal).then(result => ({ failures: nonpassingChecks(result) }), error => ({ error }));
    // The real task driver owns this promise until checks and their file handling end.
    const productWork = productRun.then(() => undefined);
    f.engine.settling.set(productTask.id, productWork);
    void productWork.then(() => f.engine.settling.delete(productTask.id));
    const store = new LifecycleStore(join(f.root, "lifecycle"));
    const lifecycle = new EngineLifecycle(f.engine, store, async () => { throw new Error("Pool pause must not stop the engine"); });
    try {
      await waitFor(() => f.engine.checkQueue.waiting === 1 && productTask.journey?.at(-1)?.productChecks?.[0]?.result === "pending", "the ordinary check to wait for capacity");
      const extra = await f.submit("pause-completion", ["probe", "pass"]);
      expect((await lifecycle.request("pause", { requestId: "pool-pause-completion" })).outcome).toBe("pending");
      expect(lifecycle.status().activeCount).toBe(1);
      busy(); endBusy(); await busyWork;
      await lifecycle["settle"]();
      expect(store.receipt("pool-pause-completion")!.outcome).toBe("completed");
      expect(lifecycle.status()).toMatchObject({ status: "paused", activeCount: 0, drained: true });
      expect(f.engine.checkQueue.waiting).toBe(2);
      expect(productTask.journey!.at(-1)!.productChecks![0]!.result).toBe("pending");
      await lifecycle.request("resume", { requestId: "resume-completion" });
      expect(await productRun).toEqual({ failures: 0 });
      await f.finished(extra);
    } finally { lifecycle.close(); store.close(); controller.abort(); busy(); endBusy(); await productRun; }
  });

for (const entry of ["direct drain", "coordinator restart"] as const) it(`drains a paused product waiter when capacity is already free through ${entry}`, async () => {
    const f = await fixture();
    const productTask = await f.add();
    productTask.state = "running";
    f.engine.schedule = () => { f.engine.extraValidations.pump(); f.engine.checkQueue.pump(); };
    f.engine.setPoolPaused(false);
    const busy = await f.engine.checkQueue.acquire(new AbortController().signal);
    const controller = new AbortController();
    const productRun = f.engine.trackWork(f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Queued check", argv: [process.execPath, "-e", "process.exit(0)"] }], controller.signal).then(() => undefined, error => error));
    let lifecycle: EngineLifecycle | undefined, store: LifecycleStore | undefined;
    try {
      await waitFor(() => f.engine.checkQueue.waiting === 1 && productTask.journey?.at(-1)?.productChecks?.[0]?.result === "pending", "the product check to wait with pending evidence");
      const extra = await f.submit("drain-paused-waiter", ["probe", "pass"]);
      f.engine.setPoolPaused(true); busy();
      await Promise.resolve();
      expect(f.engine.checkQueue.running).toBe(0);
      expect(f.engine.checkQueue.waiting).toBe(2);
      let handedOff = false;
      if (entry === "direct drain") await f.engine.drain(0);
      else {
        store = new LifecycleStore(join(f.root, "lifecycle"));
        lifecycle = new EngineLifecycle(f.engine, store, async () => { handedOff = true; });
        await lifecycle.request("restart", { requestId: "drain-paused-check" });
      }
      // Entering a drain wakes the line even though no running check remains to release it.
      expect(f.engine.checkQueue.waiting).toBe(1);
      expect(await productRun).toBeInstanceOf(WaitingForUsage);
      expect(productTask.journey!.at(-1)!.productChecks![0]!.result).toBe("stopped");
      expect(f.engine.s.extraValidations![0]).toMatchObject({ id: extra.id, state: "queued" });
      expect(f.engine.checkQueue.running).toBe(0);
      expect(existsSync(join(f.service, "started"))).toBe(false);
      if (entry === "direct drain") expect(await f.engine.drain(0)).toBe(0);
      else await waitFor(() => handedOff, "the coordinator restart to finish draining");
    } finally { lifecycle?.close(); store?.close(); controller.abort(); busy(); await productRun; }
  });
});
