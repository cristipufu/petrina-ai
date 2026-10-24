import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { Engine } from "./engine.js";
import { currentSlow, waitFor } from "./fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { McpPending, mcpRequest } from "../src/mcp.js";
import { AgentRun } from "../src/acp-run.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { WaitClock } from "@petrina/storage/worklog";
import { EngineLifecycle, LifecycleStore } from "../src/lifecycle.js";
import { WaitingForUsage } from "../src/usage.js";
import { ExtraFixtures, connection } from "./extra-fixtures.js";

const owned = new ExtraFixtures();
const { engines } = owned;
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
    const productRun = f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Ordinary check", argv: [process.execPath, "-e", "console.log('ordinary check passed')"] }], controller.signal).then(failures => ({ failures }), error => ({ error }));
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
    const productRun = f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Ordinary check", argv: [process.execPath, "-e", "console.log('ordinary check passed')"] }], controller.signal).then(failures => ({ failures }), error => ({ error })).finally(() => { ended = true; });
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
    const productRun = f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Queued check", argv: [process.execPath, "-e", "process.exit(0)"] }], controller.signal).then(failures => ({ failures }), error => ({ error }));
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

  it("keeps a validation wait open past the ordinary connection cutoff and returns still pending", async () => {
    const f = await fixture();
    const { server, client } = connection(f);
    const baseline = f.engine.listeners.size;
    try {
      const from = Date.now();
      const pending = client.call("validation.run", { ...f.request("connection-deadline"), wait: true, timeoutMs: 11_500 });
      // The first submission adds separate queue-owner and caller-wait subscriptions.
      await waitFor(() => f.engine.listeners.size === baseline + 2, "the queue owner and server-side validation wait");
      // The request's wait must not retain the coordination decision queue.
      expect((await client.call("pool.inspect")).outcome).toBe("completed");
      const result = await pending;
      expect(result.outcome).toBe("pending");
      expect(result.message).toContain("Still pending");
      expect(Date.now() - from).toBeGreaterThanOrEqual(11_400);
      expect(f.engine.listeners.size).toBe(baseline + 1); // Only the durable queued owner remains.
      const record = result.validation as ExtraValidation;
      expect(record.state).toBe("queued");
      expect(record.commit).toBe(executionFor(f.task).work.savedVersion!.commit);
      expect(record.tree).toBe(executionFor(f.task).work.savedVersion!.tree);
      expect((await client.call("validation.run", f.request("connection-deadline"))).validation).toEqual(record);
      expect(existsSync(join(f.service, "started"))).toBe(false);
    } finally { server.stop(true); }
  });

  it("cancels validation waits through the client and MCP without cancelling or duplicating queued work", async () => {
    const f = await fixture();
    const record = await f.submit("connection-cancel");
    const { server, client } = connection(f);
    const baseline = f.engine.listeners.size;
    const deadline = spyOn(AbortSignal, "timeout");
    const mcp = new McpPending();
    try {
      const controller = new AbortController();
      const wait = client.call("validation.run", { ...f.request("connection-cancel"), wait: true }, { signal: controller.signal });
      await waitFor(() => f.engine.listeners.size === baseline + 1, "the default thirty-second wait");
      expect(deadline).toHaveBeenCalledWith(35_000);
      const from = Date.now(); controller.abort();
      expect(await wait).toMatchObject({ outcome: "disconnected", cancelled: true });
      await waitFor(() => f.engine.listeners.size === baseline, "the cancelled subscription to release", 2_000);
      expect(Date.now() - from).toBeLessThan(2_000 * currentSlow());
      const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
      const before = Date.now();
      expect(await client.call("validation.run", { ...f.request("connection-cancel"), wait: true, timeoutMs: 6_000 }, { signal: alreadyCancelled.signal })).toMatchObject({ outcome: "disconnected", cancelled: true });
      expect(Date.now() - before).toBeLessThan(2_000 * currentSlow());
      const tool = mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "petrina_validation_run", arguments: { ...f.request("connection-cancel"), wait: true, timeoutMs: 6_000 } } }, client, mcp);
      await waitFor(() => f.engine.listeners.size === baseline + 1, "the MCP validation wait");
      await mcpRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }, client, mcp);
      expect(await tool).toBeUndefined();
      await waitFor(() => f.engine.listeners.size === baseline, "the MCP subscription to release", 2_000);
      expect(mcp.size).toBe(0);
      expect((await client.call("validation.run", f.request("connection-cancel"))).validation).toMatchObject({ id: record.id, state: "queued" });
      expect(f.engine.s.extraValidations).toHaveLength(1);
      f.engine.setPoolPaused(false); await f.started(record);
      const runningBaseline = f.engine.listeners.size; // The queue owner's subscription ends at handoff.
      const runningCaller = new AbortController();
      const runningWait = client.call("validation.run", { ...f.request("connection-cancel"), wait: true, timeoutMs: 6_000 }, { signal: runningCaller.signal });
      await waitFor(() => f.engine.listeners.size === runningBaseline + 1, "the running validation wait");
      runningCaller.abort();
      expect(await runningWait).toMatchObject({ outcome: "disconnected", cancelled: true });
      await waitFor(() => f.engine.listeners.size === runningBaseline, "the running wait subscription to release", 2_000);
      const completed = client.call("validation.run", { ...f.request("connection-cancel"), wait: true, timeoutMs: 6_000 });
      await waitFor(() => f.engine.listeners.size === runningBaseline + 1, "the wait for a completed validation");
      f.release(record);
      expect(await completed).toMatchObject({ outcome: "completed", validation: { id: record.id, result: "passed" } });
      expect((await client.call("validation.run", f.request("connection-cancel"))).validation).toMatchObject({ id: record.id, state: "finished", result: "passed" });
      expect(f.engine.listeners.size).toBe(runningBaseline);
      expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
    } finally { deadline.mockRestore(); mcp.cancelAll(); server.stop(true); }
  });

  for (const mode of ["none", "queued", "running"] as const) it(`saves ordinary work and closes its log immediately on shutdown with ${mode} extra work`, async () => {
    const f = await fixture();
    const ordinary = await f.add(); ordinary.title = "Unrelated interrupted turn";
    const profile = ENGINE_PROFILES.find(profile => profile.id === "sol-high")!;
    const controller = new AbortController();
    const run = await AgentRun.start({ profile, cwd: executionFor(ordinary).work.worktree!, command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), "--tool=codex"],
      callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" }, signal: controller.signal, browser: false });
    f.engine.runs.set(ordinary.id, run); f.engine.drivers.set(ordinary.id, controller);
    const turn = f.engine.tracking.turn(ordinary, { roleId: "builder", profile, waits: new WaitClock(), journeyId: ordinary.journey!.at(-1)!.id, agentSeat: "main" }, run, "HANG-FOREVER please", "first", controller.signal).catch(() => undefined);
    let releaseCleanup = () => {};
    let stopped: Promise<void> | undefined;
    try {
      await waitFor(() => run.prompting, "the ordinary turn to start");
      const record = mode === "none" ? undefined : await f.submit("shutdown-" + mode);
      if (mode === "running") { f.engine.setPoolPaused(false); await f.started(record!); f.engine.setPoolPaused(true); }
      let entered = false;
      if (mode === "running") {
        const cleanup = f.engine.extraValidations["container"].cleanup.bind(f.engine.extraValidations["container"]);
        const released = new Promise<void>(resolve => { releaseCleanup = resolve; });
        f.engine.extraValidations["container"].cleanup = async record => { entered = true; await released; return cleanup(record); };
      }
      // No earlier save contains this last ordinary change. Shutdown must save it before
      // any slow cleanup, and a turn ending during that cleanup must remain unfinished.
      ordinary.description = "Saved at the instant Petrina stops";
      stopped = f.engine.shutdown();
      if (mode !== "none") {
        expect(f.engine.store.loadActive()!.tasks.find(task => task.id === ordinary.id)!.description).toBe(ordinary.description);
        expect(f.engine.store.loadActive()!.extraValidations).toHaveLength(1);
      }
      await turn;
      let stoppedEvidence: ExtraValidation | undefined;
      if (mode === "running") {
        await waitFor(() => entered, "container cleanup to wait for its release");
        expect(f.engine.tracking.log.turns({ taskId: ordinary.id })[0]!.end).toBeUndefined();
        stoppedEvidence = structuredClone(f.engine.s.extraValidations![0]!);
      }
      releaseCleanup(); await stopped;
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      const [lost] = replacement.tracking.log.turns({ taskId: ordinary.id });
      expect(lost).toMatchObject({ end: "lost" });
      expect(lost!.workMs).toBeUndefined();
      expect(replacement.task(ordinary.id)!.description).toBe(ordinary.description);
      const usage = replacement.usage({ view: "task", taskId: ordinary.id });
      expect(usage.time.atLeast && usage.tokens.atLeast).toBe(true);
      expect(usage.atLeast).toContain("cut off when Petrina stopped");
      if (record) {
        const recovered = replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation;
        expect(recovered.state).toBe(mode === "queued" ? "queued" : "finished");
        if (mode === "running") {
          expect(recovered.result).toBe("stopped");
          expect(recovered.run!.logComplete).toBe(true);
          expect(recovered.run).toEqual(stoppedEvidence!.run);
          expect(recovered.durationMs).toBe(stoppedEvidence!.durationMs);
          expect(recovered.endedAt).toBe(stoppedEvidence!.endedAt);
          expect(readdirSync(join(f.service, "containers"))).toEqual([]);
          expect(existsSync(record.snapshot)).toBe(false);
        }
      }
    } finally { releaseCleanup(); await (stopped ?? f.engine.shutdown()); await turn; }
  });
});
