import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, checkProblem, type ExtraValidation } from "@petrina/core";
import { Engine, type EngineOptions } from "./engine.js";
import { currentSlow, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";
import { Coordination } from "../src/coordination.js";
import { executionFor } from "../src/repository-context.js";
import { EngineClient } from "../src/engine-client.js";
import { serve } from "../src/server.js";
import { writeConnection } from "../src/instance.js";
import { McpPending, mcpRequest } from "../src/mcp.js";
import { AgentRun } from "../src/acp-run.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { WaitClock } from "../src/worklog.js";
import { EngineLifecycle, LifecycleStore } from "../src/lifecycle.js";
import { WaitingForUsage } from "../src/usage.js";
import * as files from "node:fs/promises";
import * as processTree from "../src/process-tree.js";
import { ExtraContainer } from "../src/extra-container.js";
import { CheckQueue } from "../src/check-queue.js";
import { expectRejection } from "./rejections.js";
import { Store } from "../src/store.js";
import { readGitHub, writeGitHub } from "./fake-gh.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterAll(async () => { for (const engine of engines.splice(0)) await engine.shutdown(); for (const root of roots.splice(0)) removeDir(root); });

async function fixture(options: EngineOptions = {}) {
  const root = tempDir("petrina-extra-"); roots.push(root);
  const service = join(root, "service"); mkdirSync(service);
  const data = join(root, "data");
  const settings: EngineOptions = { agentCommand: () => { throw new Error("Extra-validation controls must not start agents"); }, containerTool: [process.execPath, join(import.meta.dir, "fake-extra-container.ts"), service],
    extraCleanupEveryMs: 60_000, ...options };
  const engine = new Engine(data, settings); engines.push(engine); engine.setPoolPaused(true);
  const productId = await engine.addProduct(await makeProduct(root));
  const add = async () => {
    const task = engine.task(engine.addTask({ productId, title: "Required platform acceptance", backlog: true }))!;
    task.held = true; task.startedAt = Date.now();
    const scope = executionFor(task);
    scope.work.worktree = engine.s.products.find(product => product.id === productId)!.path;
    scope.work.savedVersion = { commit: await git(scope.work.worktree!, "rev-parse", "HEAD"), tree: await git(scope.work.worktree!, "rev-parse", "HEAD^{tree}") };
    beginAgentStep(task, "tester", "sol-high", Date.now(), engine.s.roles, undefined, scope.work);
    // Stay in Backlog through async setup, then use a checkpoint that also survives restart.
    engine.raise(task, "delivery", "Waiting for required platform validation", false);
    return task;
  };
  const task = await add();
  const coordination = new Coordination(engine);
  const request = (requestId: string, argv = ["probe", "hold"], taskId = task.id) => ({ taskId, name: "Required Linux suite", reason: "Explicit platform acceptance", image: "local:ready", argv, requestId });
  const submit = async (reference: string, argv?: string[], taskId?: string) => {
    const reply = await coordination.call("validation.run", request(reference, argv, taskId));
    expect(reply.outcome).toBe("pending");
    return reply.validation as ExtraValidation;
  };
  const started = async (record: ExtraValidation) => waitFor(() => existsSync(join(service, "started", record.id)), "owned container to start");
  const release = (record: ExtraValidation) => process.kill(JSON.parse(readFileSync(join(service, "started", record.id), "utf8")).pid, "SIGUSR1");
  const finished = async (record: ExtraValidation) => {
    await waitFor(() => engine.extraValidations.get(record.requestId)?.outcome === "completed", "extra evidence to finish");
    return engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
  };
  return { root, data, settings, service, engine, productId, task, add, coordination, request, submit, started, release, finished };
}

function connection(f: Awaited<ReturnType<typeof fixture>>) {
  const token = "isolated-extra-validation-connection-key";
  const server = serve(f.engine, { port: 0, token });
  writeConnection(f.data, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
  return { server, client: new EngineClient(f.data, () => { throw new Error("This connection must not launch an engine"); }) };
}

type PrelaunchSave = "admission" | "start evidence" | "log registration";
function failPrelaunchSave(engine: Engine, id: string, phase: PrelaunchSave, failures: number) {
  const commit = engine.commitNow.bind(engine), evidence = engine.saveExtraValidationTask.bind(engine);
  const failure = new Error(`${phase} disk unavailable`);
  let remaining = failures, injected = false;
  const fail = () => { injected = true; remaining--; throw failure; };
  const save = spyOn(engine, "commitNow").mockImplementation((...args) => {
    const record = engine.s.extraValidations?.find(record => record.id === id);
    if (remaining && record && (injected ? record.result === "not run"
      : phase === "admission" ? record.state === "preparing" && !record.container
      : phase === "log registration" && record.state === "running" && !!record.run)) fail();
    return commit(...args);
  });
  const note = spyOn(engine, "saveExtraValidationTask").mockImplementation((...args) => {
    evidence(...args);
    if (remaining && !injected && phase === "start evidence" && args[0] === id
      && engine.s.extraValidations?.find(record => record.id === id)?.state === "running") fail();
  });
  return { failure, get remaining() { return remaining; }, get injected() { return injected; }, restore() { save.mockRestore(); note.mockRestore(); } };
}

describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
  for (const fail of [false, true]) it(`keeps submission and identical-reference replay consistent when saving ${fail ? "fails" : "succeeds"}`, async () => {
    const f = await fixture();
    await f.engine.waitUntilReady();
    const save = spyOn(f.engine, "save");
    if (fail) save.mockImplementationOnce(() => { throw new Error("Submission save unavailable"); });
    let reply;
    try { reply = await f.coordination.call("validation.run", f.request("atomic-submit", ["probe", "pass"])); }
    finally { save.mockRestore(); }
    expect(reply.outcome).toBe(fail ? "invalid" : "pending");
    expect(f.engine.s.extraValidations?.length ?? 0).toBe(fail ? 0 : 1);
    expect(f.engine.store.load()!.extraValidations?.length ?? 0).toBe(fail ? 0 : 1);
    expect(f.task.journey!.at(-1)!.extraValidations?.length ?? 0).toBe(fail ? 0 : 1);
    expect(f.task.timeline.filter(entry => entry.text.includes("Extra validation"))).toHaveLength(fail ? 0 : 1);
    expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind === "extra.queued")).toHaveLength(fail ? 0 : 1);
    expect(await f.coordination.call("validation.run", f.request("atomic-submit", ["probe", "pass"]))).toEqual(reply);
    await f.engine.shutdown();
    const current = new Engine(f.data, f.settings); engines.push(current);
    await current.waitUntilReady();
    const coordination = new Coordination(current);
    expect(await coordination.call("validation.run", f.request("atomic-submit", ["probe", "pass"]))).toEqual(reply);
    current.setPoolPaused(false);
    const record = fail ? (await coordination.call("validation.run", f.request("after-refusal", ["probe", "pass"]))).validation as ExtraValidation : reply.validation as ExtraValidation;
    await waitFor(() => current.extraValidations.get(record.requestId)?.outcome === "completed", "only the accepted request to finish");
    const runs = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
    expect(runs.map(args => args[args.indexOf("--name") + 1])).toEqual([record.containerName]);
    expect(current.checkQueue.running).toBe(0);
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
  });

  for (const kind of ["extra.queued", "extra.finished"] as const) it(`keeps committed ownership and receipts consistent when a ${kind} listener fails`, async () => {
    const f = await fixture();
    const failure = new Error("Event listener unavailable");
    const log = spyOn(console, "error").mockImplementation(() => {});
    const off = f.engine.events.log.subscribe(() => {
      if (f.engine.events.log.collect({}, f.engine.events.log.newest - 1, 1).events[0]?.kind === kind) throw failure;
    });
    try {
      const record = await f.submit("event-listener", ["probe", "pass"]);
      f.engine.setPoolPaused(false);
      expect((await f.finished(record)).result).toBe("passed");
      expect(f.engine.s.extraValidations).toEqual([]);
      expect(f.engine.checkQueue.running).toBe(0);
      expect(await f.coordination.call("validation.run", f.request("event-listener", ["probe", "pass"]))).toEqual(f.engine.extraValidations.get(record.requestId)!);
      expect(log).toHaveBeenCalledWith("Could not publish extra validation event:", failure);
    } finally { off(); log.mockRestore(); await f.engine.shutdown(); }
  });

  for (const mode of ["success", "failed save then retry", "failed save then restart"] as const) it(`keeps queued cancellation recoverable: ${mode}`, async () => {
    const f = await fixture();
    const record = await f.submit("atomic-cancel", ["probe", "pass"]);
    let current = f.engine;
    if (mode !== "success") {
      const save = spyOn(current, "save").mockImplementationOnce(() => { throw new Error("Cancellation save unavailable"); });
      try { expect(() => current.cancel(f.task.id)).toThrow("Cancellation save unavailable"); }
      finally { save.mockRestore(); }
      expect((current.extraValidations.get(record.requestId)!.validation as ExtraValidation).state).toBe("queued");
      expect(current.store.load()!.extraValidations![0]!.state).toBe("queued");
      expect(current.task(f.task.id)!.journey!.at(-1)!.extraValidations![0]!.state).toBe("queued");
      expect(current.task(f.task.id)!.timeline.some(entry => entry.text.includes("Extra validation") && entry.text.includes("stopped"))).toBe(false);
      await current.extraValidations.retryCleanup();
      expect(current.extraValidations.get(record.requestId)!.outcome).toBe("pending");
      if (mode === "failed save then restart") {
        await current.shutdown(); current = new Engine(f.data, f.settings); engines.push(current);
        await current.waitUntilReady();
      }
    }
    current.cancel(f.task.id); current.commitNow();
    const result = current.extraValidations.get(record.requestId)!;
    expect(result.outcome).toBe("completed"); expect((result.validation as ExtraValidation).result).toBe("stopped");
    expect(await new Coordination(current).call("validation.run", f.request("atomic-cancel", ["probe", "pass"]))).toEqual(result);
    expect(current.extraValidations.outstanding(f.productId)).toBeUndefined();
    expect(current.checkQueue.running).toBe(0); expect(current.checkQueue.waiting).toBe(0);
    expect(existsSync(join(f.service, "started"))).toBe(false);
    current.removeProduct(f.productId);
    expect(current.s.products).toEqual([]);
  });

  for (const mode of ["uncached shutdown", "cached shutdown", "uncached failed-save shutdown", "uncached ordinary", "live ordinary"] as const) it(`saves finished extra evidence in History after ${mode}`, async () => {
    const f = await fixture();
    const work = executionFor(f.task).work;
    const copy = join(f.data, "worktrees", f.productId, f.task.id); mkdirSync(join(f.data, "worktrees", f.productId), { recursive: true });
    await git(work.worktree!, "worktree", "add", "--detach", copy, "HEAD"); work.worktree = copy;
    const record = await f.submit("history-finish"); f.engine.setPoolPaused(false); await f.started(record);
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const container = f.engine.extraValidations["container"], cleanup = container.cleanup.bind(container);
    container.cleanup = async record => { entered.resolve(); await released.promise; return cleanup(record); };
    let stopping: Promise<void> | undefined;
    let restoreSave = () => {};
    try {
      if (mode === "live ordinary") f.release(record); else f.engine.cancel(f.task.id);
      await entered.promise;
      if (mode !== "live ordinary") {
        await waitFor(() => executionFor(f.task).work.cleanup?.removedAt !== undefined, "the cancelled working copy to be removed");
        f.engine.save();
        expect(f.engine.s.tasks.some(task => task.id === f.task.id)).toBe(false);
        expect(f.engine.store.history.get(f.task.id)).toBeDefined();
        // Ordinary reads may already have warmed this cache. Establish the selected boundary explicitly.
        expect(f.engine.task(f.task.id)).toBeDefined();
        if (mode !== "cached shutdown") f.engine["projection"]["archiveCache"].delete(f.task.id);
        expect(f.engine["projection"]["archiveCache"].has(f.task.id)).toBe(mode === "cached shutdown");
      }
      if (mode === "uncached failed-save shutdown") {
        const save = spyOn(f.engine.store, "saveExtraValidationOwnership").mockImplementationOnce(() => { throw new Error("Late ownership save unavailable"); });
        restoreSave = () => save.mockRestore();
      }
      if (mode.endsWith("shutdown")) stopping = f.engine.shutdown();
      released.resolve();
      if (stopping) await stopping;
      else { await f.finished(record); await f.engine.shutdown(); }
      restoreSave();
      if (mode === "uncached failed-save shutdown") {
        expect(f.engine.s.extraValidations![0]!.state).toBe("held");
        expect(f.engine.checkQueue.running).toBe(1);
      }
      const current = new Engine(f.data, f.settings); engines.push(current); await current.waitUntilReady();
      const result = current.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      const task = current.task(f.task.id)!;
      expect(result.state).toBe("finished");
      const evidence: ExtraValidation | undefined = task.journey!.find(node => node.id === record.nodeId)!.extraValidations!.find(run => run.id === record.id);
      expect(evidence).toEqual(result);
      expect(task.timeline.filter(entry => entry.text.includes("Extra validation") && entry.text.includes("seconds"))).toHaveLength(1);
      expect(current.s.extraValidations).toEqual([]);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally { released.resolve(); await stopping; restoreSave(); await f.engine.shutdown(); }
  });

  it("merges two products' late validation settlements without saving other edits on their shared task", async () => {
    const f = await fixture({ checkRuns: 2 });
    const secondRoot = tempDir("petrina-extra-shared-"); roots.push(secondRoot);
    const productId = await f.engine.addProduct(await makeProduct(secondRoot), "Second product");
    const worktree = f.engine.s.products.find(product => product.id === productId)!.path!;
    const first = executionFor(f.task).work;
    f.task.repositories = [{ ...first, delivery: first.delivery ?? "local", completedStages: first.completedStages ?? [] },
      { productId, worktree, delivery: "local", completedStages: [], savedVersion: { commit: await git(worktree, "rev-parse", "HEAD"), tree: await git(worktree, "rev-parse", "HEAD^{tree}") } }];
    delete f.task.repository; f.task.activeProductId = f.productId;
    const records: ExtraValidation[] = [];
    for (const product of [f.productId, productId]) {
      const reply = await f.coordination.call("validation.run", { ...f.request("shared-shutdown-" + product), productId: product });
      expect(reply.outcome).toBe("pending"); records.push(reply.validation as ExtraValidation);
    }
    f.engine.setPoolPaused(false);
    await Promise.all(records.map(record => f.started(record)));
    const entered = records.map(() => Promise.withResolvers<void>()), released = records.map(() => Promise.withResolvers<void>());
    const container = f.engine.extraValidations["container"], cleanup = container.cleanup.bind(container);
    container.cleanup = async record => { const index = records.findIndex(run => run.id === record.id); entered[index]!.resolve(); await released[index]!.promise; return cleanup(record); };
    const description = f.task.description, stopping = f.engine.shutdown();
    try {
      await Promise.all(entered.map(gate => gate.promise));
      f.task.description = "An unrelated edit after the shutdown snapshot";
      released[0]!.resolve();
      await waitFor(() => f.engine.extraValidations.get(records[0]!.requestId)?.outcome === "completed", "the first shared cleanup settlement");
      expect(f.engine.store.loadActive()!.tasks.find(task => task.id === f.task.id)!.description).toBe(description);
      released[1]!.resolve(); await stopping;
      const replacement = new Engine(f.data, f.settings); engines.push(replacement); await replacement.waitUntilReady();
      const task = replacement.task(f.task.id)!;
      expect(task.description).toBe(description);
      for (const record of records) {
        const result = replacement.extraValidations.get(record.requestId)!;
        expect(result.outcome).toBe("completed");
        expect(result.validation as ExtraValidation).toEqual(task.journey!.find(node => node.id === record.nodeId)!.extraValidations!.find(run => run.id === record.id)!);
        expect(existsSync(record.snapshot)).toBe(false);
      }
      expect(task.timeline.filter(line => line.text.includes("Extra validation") && line.text.includes("seconds"))).toHaveLength(2);
      expect(replacement.s.extraValidations).toEqual([]); expect(replacement.checkQueue.running).toBe(0);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally { for (const gate of released) gate.resolve(); await stopping; }
  });

  for (const storage of ["live", "archive"] as const) for (const phase of ["inside", "checkpoint", "finished"] as const) it(`recovers a killed late ${storage} checkpoint ${phase === "inside" ? "between evidence and ownership writes" : `after the ${phase} commit`}`, async () => {
    const f = await fixture(), record = await f.submit("atomic-late-crash", ["probe", "pass"]);
    await f.engine.shutdown();
    const settings = join(f.root, "checkpoint-settings.json"), marker = join(f.root, "checkpoint-marker.json");
    writeFileSync(settings, JSON.stringify(f.settings));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "extra-checkpoint-crash.ts"), f.data, settings, marker, phase, storage], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    let replacement: Engine | undefined;
    try {
      await waitFor(async () => {
        if (existsSync(marker)) return true;
        if (child.exitCode !== null) throw new Error("Checkpoint fixture exited: " + await new Response(child.stderr).text());
        return false;
      }, "the real command's late checkpoint boundary");
      const outcome = JSON.parse(readFileSync(marker, "utf8")) as ExtraValidation;
      expect(outcome.result).toBe("passed"); expect(outcome.run!.ok).toBe(true); expect(outcome.run!.logComplete).toBe(true);
      child.kill("SIGKILL"); await child.exited;
      // Capture persistent facts before startup recovery modifies the interrupted owner.
      const store = new Store(join(f.data, "petrina.db"));
      const state = store.load()!; store.close();
      const task = state.tasks.find(task => task.id === record.taskId)!;
      const evidence = task.journey!.find(node => node.id === record.nodeId)!.extraValidations!.find(run => run.id === record.id)!;
      const ownership = state.extraValidations?.find(run => run.id === record.id);
      if (phase === "inside") {
        expect(evidence.result).toBe(ownership?.result); // The old split commit left passed/unknown here.
        expect(evidence.result).toBeUndefined(); expect(ownership?.run?.endedAt).toBeUndefined();
      } else {
        expect(evidence.result).toBe("passed"); expect(evidence.run).toEqual(outcome.run);
        expect(ownership?.result).toBe(phase === "finished" ? undefined : "passed");
      }
      const saved = new Engine(f.data, f.settings); engines.push(saved); replacement = saved;
      await saved.waitUntilReady();
      const result = saved.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      expect(result.state).toBe("finished"); expect(result.result).toBe(phase === "inside" ? "stopped" : "passed");
      if (phase === "inside") expect(result.run!.interrupted).toBe(true);
      else { expect(result.run).toEqual(outcome.run); expect(result.durationMs).toBe(outcome.durationMs); expect(result.endedAt).toBe(outcome.endedAt); }
      const log = await new Coordination(saved).call("validation.log", { requestId: record.requestId });
      expect(log.text).toContain("Original complete diagnostic for " + record.id); expect(log.text).toContain("Original ending for " + record.id);
      expect(result).toEqual(saved.task(record.taskId)!.journey!.find(node => node.id === record.nodeId)!.extraValidations!.find(run => run.id === record.id)!);
      expect(saved.s.extraValidations).toEqual([]); expect(saved.checkQueue.running).toBe(0);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]); expect(existsSync(record.snapshot)).toBe(false);
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
      expect(calls.filter(args => args[0] === "run")).toHaveLength(1);
    } finally { child.kill("SIGKILL"); await child.exited; await replacement?.shutdown(); }
  });

  for (const phase of ["inspection", "copy", "log"] as const) for (const action of ["pause", "stop", "restart"] as const) it(`defers an extra run when ${action} arrives during ${phase} preparation`, async () => {
    const f = await fixture();
    const record = await f.submit("prepare-admission", ["probe", "pass"]);
    const following = await f.submit("prepare-follower", ["probe", "pass"], (await f.add()).id);
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const container = f.engine.extraValidations["container"];
    let restore = () => {};
    if (phase === "log") {
      const open = files.open;
      const read = spyOn(files, "open").mockImplementation(async (...args) => {
        const file = await open(...args);
        if (String(args[0]).startsWith(join(f.data, "checks")) && args[1] === "wx+") { entered.resolve(); await released.promise; }
        return file;
      });
      restore = () => read.mockRestore();
    } else if (phase === "inspection") {
      const prepare = container.prepare.bind(container);
      container.prepare = async record => { const result = await prepare(record); entered.resolve(); await released.promise; return result; };
    } else {
      const snapshot = container.snapshot.bind(container);
      container.snapshot = async record => { await snapshot(record); entered.resolve(); await released.promise; };
    }
    const store = new LifecycleStore(join(f.root, "admission-lifecycle"));
    const handoffs: boolean[] = [];
    const lifecycle = new EngineLifecycle(f.engine, store, async restart => { handoffs.push(restart); });
    let replacement: Engine | undefined;
    try {
      f.engine.setPoolPaused(false); await entered.promise;
      expect(f.engine.checkQueue.running).toBe(1);
      await lifecycle.request(action, { requestId: `admission-${action}` });
      released.resolve();
      await waitFor(() => f.engine.extraValidations.active === 0, "preparation to relinquish its place");
      const pending = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      expect(pending.state).toBe("queued"); expect(pending.startedAt).toBeUndefined(); expect(pending.result).toBeUndefined();
      expect([pending.commit, pending.tree, pending.queueOrder, pending.queuedAt]).toEqual([record.commit, record.tree, record.queueOrder, record.queuedAt]);
      expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(2);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(existsSync(join(f.service, "started")) ? readdirSync(join(f.service, "started")) : []).toEqual([]);
      expect(f.engine.events.log.collect({}, 0, 100).events.some(event => event.kind === "extra.started")).toBe(false);
      await lifecycle["settle"]();
      let current = f.engine;
      if (action === "pause") await lifecycle.request("resume", { requestId: "admission-resume" });
      else {
        expect(handoffs).toEqual([action === "restart"]);
        lifecycle.close(); await f.engine.shutdown();
        replacement = new Engine(f.data, f.settings); engines.push(replacement); current = replacement;
        await current.extraValidations.ready; current.setPoolPaused(false);
      }
      await waitFor(() => current.extraValidations.get(following.requestId)?.outcome === "completed", "both requests to run once in order");
      expect((current.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("passed");
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([record.containerName, following.containerName]);
      expect(current.checkQueue.running).toBe(0);
    } finally { released.resolve(); restore(); lifecycle.close(); store.close(); await replacement?.shutdown(); await f.engine.shutdown(); }
  });

  for (const holdAt of ["submission", "queued"] as const) it(`reports prerequisite deferral separately from a queue place at ${holdAt}`, async () => {
    const f = await fixture(), prerequisite = await f.add();
    if (holdAt === "submission") f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "deferred-hold");
    const first = await f.submit("deferred-place", ["probe", "pass"]);
    if (holdAt === "queued") await f.coordination.call("task.wait", { taskId: f.task.id, after: [prerequisite.id], reason: "Wait for the required fix", requestId: "deferred-hold" });
    const deferred = f.engine.extraValidations.get(first.requestId)!.validation as ExtraValidation;
    if (holdAt === "submission") { expect(first.queuePosition).toBeUndefined(); expect(first.waitingReason).toBe(deferred.waitingReason); }
    expect(deferred.queuePosition).toBeUndefined();
    expect(deferred.waitingReason).toContain("prerequisite");
    expect(f.engine.extraValidations.get(first.requestId)!.message).toContain(deferred.waitingReason!);
    expect(f.engine.store.load()!.extraValidations![0]!.waitingReason).toBe(deferred.waitingReason);
    expect(f.engine.checkQueue.waiting).toBe(0); expect(f.engine.checkQueue.running).toBe(0);
    const note = f.task.timeline.filter(line => line.text.includes("Extra validation")).at(-1)!;
    expect(note.text).toContain("before joining the check queue"); expect(note.text).not.toContain("place");
    const second = await f.submit("ready-place", ["probe", "pass"], (await f.add()).id);
    expect(second.queuePosition).toBe(1);
    expect(f.engine.checkQueue.waiting).toBe(1);
    expect((await f.coordination.call("validation.run", f.request(first.requestId, ["probe", "pass"]))).validation).toEqual(deferred);
    await f.coordination.call("task.wait", { taskId: f.task.id, after: [], reason: "The fix is available", requestId: "deferred-clear" });
    const joined = f.engine.extraValidations.get(first.requestId)!.validation as ExtraValidation;
    expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(1);
    expect(f.engine.checkQueue.waiting).toBe(2);
    f.engine.setPoolPaused(false);
    expect((await f.finished(first)).result).toBe("passed"); expect((await f.finished(second)).result).toBe("passed");
    const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
    expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([first.containerName, second.containerName]);
  });

  it("keeps deferred ownership and evidence consistent when saving queue re-entry fails", async () => {
    const f = await fixture(), prerequisite = await f.add();
    f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "failed-reentry-hold");
    const record = await f.submit("failed-reentry", ["probe", "pass"]), timeline = structuredClone(f.task.timeline);
    f.engine.setRuntimeWait(f.task.id, [], "The fix is available", "failed-reentry-clear");
    const afterClear = structuredClone(f.task.timeline);
    const save = spyOn(f.engine, "commitNow").mockImplementationOnce(() => { throw new Error("Queue re-entry save unavailable"); });
    try { expect(() => f.engine.extraValidations.pump()).toThrow("Queue re-entry save unavailable"); }
    finally { save.mockRestore(); }
    expect(f.engine.extraValidations.get(record.requestId)!.validation).toEqual(record);
    expect(f.engine.store.load()!.extraValidations![0]).toEqual(record);
    expect(f.task.timeline).toEqual(afterClear); expect(afterClear.length).toBeGreaterThan(timeline.length);
    expect(f.engine.checkQueue.waiting).toBe(0); expect(f.engine.checkQueue.running).toBe(0);
    expect(existsSync(join(f.service, "started"))).toBe(false);
    f.engine.extraValidations.pump();
    const joined = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
    expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(1);
    f.engine.setPoolPaused(false); expect((await f.finished(record)).result).toBe("passed");
  });

  for (const restart of [false, true]) it(`joins a deferred extra run during the scheduling pass that observes landing${restart ? " after restart" : ""}`, async () => {
    const f = await fixture(), prerequisite = await f.add();
    f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "landing-hold");
    const first = await f.submit("landing-extra", ["probe", "pass"]);
    const second = await f.submit("landing-ready", ["probe", "pass"], (await f.add()).id);
    f.engine.setPoolPaused(false); expect((await f.finished(second)).result).toBe("passed");
    expect(existsSync(join(f.service, "started", first.id))).toBe(false);
    let current = f.engine;
    if (restart) {
      await current.shutdown(); current = new Engine(f.data, f.settings); engines.push(current); await current.waitUntilReady();
    }
    try {
      const required = current.task(prerequisite.id)!;
      const work = executionFor(required).work;
      work.delivery = "local"; work.landed = { branch: "main", sha: work.savedVersion!.commit }; required.state = "done";
      current.schedule(); // Use the real prerequisite release, with no second scheduling call or timer.
      expect(current.task(f.task.id)!.runtimeWait!.releasedAt).toBeDefined();
      expect(current.checkQueue.running).toBe(1);
      const joined = current.extraValidations.get(first.requestId)!.validation as ExtraValidation;
      expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(1);
      expect([joined.commit, joined.tree, joined.queueOrder, joined.queuedAt]).toEqual([first.commit, first.tree, first.queueOrder, first.queuedAt]);
      await waitFor(() => current.extraValidations.get(first.requestId)?.outcome === "completed", "the released extra request to finish");
      expect((current.extraValidations.get(first.requestId)!.validation as ExtraValidation).result).toBe("passed");
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([second.containerName, first.containerName]);
      expect(current.s.extraValidations).toEqual([]); expect(current.checkQueue.running).toBe(0);
    } finally { await current.shutdown(); }
  });

  it("joins a deferred extra run when its prerequisite's driver finishes delivery", async () => {
    const f = await fixture(), prerequisite = await f.add();
    await f.engine.waitUntilReady();
    f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "driver-landing-hold");
    const record = await f.submit("driver-landing-extra", ["probe", "pass"]);
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const shipping = f.engine["shipping"];
    const delivery = spyOn(shipping, "deliver").mockImplementation(async task => {
      entered.resolve(); await released.promise;
      const scope = executionFor(task);
      scope.work.delivery = "local"; scope.work.landed = { branch: "main", sha: scope.work.savedVersion!.commit };
      shipping["finished"](scope, "Committed to main");
      f.engine.commitNow();
      return "stop";
    });
    const tidy = spyOn(f.engine, "tidy").mockImplementation(() => {});
    prerequisite.plan = { stages: [{ id: "ship", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: [] }], rationale: "Deliver the required fix", plannerProfileId: "sol-high" };
    prerequisite.stageIndex = 0; prerequisite.state = "running";
    try {
      f.engine.setPoolPaused(false);
      f.engine.startDriver(prerequisite.id, true);
      const driving = f.engine.settling.get(prerequisite.id)!;
      await Promise.race([entered.promise, driving.then(() => { throw new Error(`Delivery ended before landing: ${prerequisite.statusLine}`); })]);
      expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
      released.resolve(); await driving; // Its registered completion callback runs before this continuation, without a timer or explicit scheduling call.
      expect(f.task.runtimeWait!.releasedAt).toBeDefined();
      expect(f.engine.checkQueue.running).toBe(1);
      const joined = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(1);
      expect([joined.commit, joined.tree, joined.queueOrder, joined.queuedAt]).toEqual([record.commit, record.tree, record.queueOrder, record.queuedAt]);
      expect((await f.finished(record)).result).toBe("passed");
      expect(delivery).toHaveBeenCalledTimes(1);
      expect(f.engine.checkQueue.running).toBe(0);
    } finally { released.resolve(); delivery.mockRestore(); tidy.mockRestore(); await f.engine.shutdown(); }
  });

  it("joins a deferred extra run in the pass that notices its prerequisite pull request merged", async () => {
    const githubRoot = tempDir("petrina-extra-pr-wake-"); roots.push(githubRoot);
    const githubState = join(githubRoot, "github.json");
    const f = await fixture({ gh: [process.execPath, join(import.meta.dir, "fake-gh.ts"), githubState, githubRoot] });
    await f.engine.waitUntilReady();
    const prerequisite = await f.add(), work = executionFor(prerequisite).work;
    f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the merged fix", "pr-merge-hold");
    const first = await f.submit("pr-merge-deferred", ["probe", "hold"]);
    const second = await f.submit("pr-merge-ready", ["probe", "pass"], (await f.add()).id);
    prerequisite.state = "pr-open";
    work.delivery = "pull-request";
    work.pr = { number: 7, url: "https://github.com/acme/demo/pull/7", state: "open", openedAt: Date.now() };
    const product = f.engine.s.products.find(product => product.id === f.productId)!;
    writeGitHub(githubState, { repo: product.repo, prs: [{ number: 7, url: work.pr.url, headRefName: "required-fix", baseRefName: "main",
      headRefOid: work.savedVersion!.commit, state: "MERGED", isCrossRepository: false, title: "Required fix", body: "" }], releases: [], calls: [] });
    // The saved request stays on its original version even if the task's next saved version changes.
    writeFileSync(join(product.path!, "later.txt"), "Saved after the extra request\n");
    await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Later saved version");
    executionFor(f.task).work.savedVersion = { commit: await git(product.path!, "rev-parse", "HEAD"), tree: await git(product.path!, "rev-parse", "HEAD^{tree}") };
    const occupied = f.engine.checkQueue.hold();
    const tidy = spyOn(f.engine, "tidy").mockImplementation(() => {});
    const scheduled = spyOn(f.engine, "schedule");
    try {
      f.engine.setPoolPaused(false);
      expect(f.engine.checkQueue.waiting).toBe(1);
      expect((f.engine.extraValidations.get(first.requestId)!.validation as ExtraValidation).waitingReason).toContain("prerequisite");
      scheduled.mockClear();
      await f.engine["shipping"].monitor.pollPullRequests(); // The monitor owns the only scheduling call.
      expect(scheduled).toHaveBeenCalledTimes(1);
      expect(work.pr.state).toBe("merged"); expect(f.engine.task(prerequisite.id)!.state).toBe("done");
      expect(f.task.runtimeWait!.releasedAt).toBeDefined();
      expect(f.engine.checkQueue.running).toBe(1); expect(f.engine.checkQueue.waiting).toBe(2);
      const joined = f.engine.extraValidations.get(first.requestId)!.validation as ExtraValidation;
      expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(2);
      expect([joined.commit, joined.tree, joined.queueOrder, joined.queuedAt]).toEqual([first.commit, first.tree, first.queueOrder, first.queuedAt]);
      occupied(); await f.started(first);
      expect(await git(first.snapshot, "rev-parse", "HEAD")).toBe(first.commit);
      expect(existsSync(join(first.snapshot, "later.txt"))).toBe(false);
      f.release(first);
      expect((await f.finished(first)).result).toBe("passed"); expect((await f.finished(second)).result).toBe("passed");
      const runs = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(runs.map(args => args[args.indexOf("--name") + 1])).toEqual([first.containerName, second.containerName]);
      expect(readGitHub(githubState).calls.filter(args => args[0] === "pr" && args[1] === "view")).toHaveLength(1);
      expect(f.engine.s.extraValidations).toEqual([]); expect(f.engine.checkQueue.running).toBe(0);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally { occupied(); scheduled.mockRestore(); tidy.mockRestore(); await f.engine.shutdown(); }
  });

  for (const boundary of ["queued", "handoff", "inspection", "copy", "log", "running"] as const) it(`honors a task prerequisite wait for extra validation at ${boundary}`, async () => {
    const f = await fixture(), prerequisite = await f.add();
    const record = await f.submit("prerequisite-extra", ["probe", boundary === "running" ? "hold" : "pass"]);
    const following = await f.submit("prerequisite-follower", ["probe", "pass"], (await f.add()).id);
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const container = f.engine.extraValidations["container"];
    let restore = () => {}, occupied = () => {};
    if (boundary === "inspection") {
      const prepare = container.prepare.bind(container);
      container.prepare = async current => {
        const result = await prepare(current);
        if (current.id === record.id) { entered.resolve(); await released.promise; }
        return result;
      };
    } else if (boundary === "copy") {
      const snapshot = container.snapshot.bind(container);
      container.snapshot = async current => {
        await snapshot(current);
        if (current.id === record.id) { entered.resolve(); await released.promise; }
      };
    } else if (boundary === "log") {
      const open = files.open;
      const read = spyOn(files, "open").mockImplementation(async (...args) => {
        const file = await open(...args);
        if (String(args[0]).startsWith(join(f.data, "checks", record.taskId)) && args[1] === "wx+") { entered.resolve(); await released.promise; }
        return file;
      });
      restore = () => read.mockRestore();
    }
    try {
      if (boundary === "handoff") occupied = f.engine.checkQueue.hold();
      if (boundary !== "queued") f.engine.setPoolPaused(false);
      if (["inspection", "copy", "log"].includes(boundary)) await entered.promise;
      if (boundary === "running") await f.started(record);
      if (boundary === "handoff") occupied(); // Apply the wait before the reserved continuation runs.
      if (boundary === "handoff") {
        f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "hold-extra");
        f.engine.schedule();
      } else {
        const reply = await f.coordination.call("task.wait", { taskId: f.task.id, after: [prerequisite.id], reason: "Wait for the required fix", requestId: "hold-extra" });
        expect(reply.outcome).toBe("completed");
      }
      released.resolve();
      if (boundary === "queued") f.engine.setPoolPaused(false);
      if (boundary === "running") {
        expect(f.engine.s.extraValidations!.find(run => run.id === record.id)!.state).toBe("running");
        f.release(record); expect((await f.finished(record)).result).toBe("passed");
      }
      expect((await f.finished(following)).result).toBe("passed");
      if (boundary !== "running") {
        const pending = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
        expect(pending.state).toBe("queued"); expect(pending.startedAt).toBeUndefined(); expect(pending.result).toBeUndefined();
        expect([pending.commit, pending.tree, pending.queueOrder, pending.queuedAt]).toEqual([record.commit, record.tree, record.queueOrder, record.queuedAt]);
        expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
        expect(existsSync(record.snapshot)).toBe(false);
        expect(existsSync(join(f.service, "started", record.id))).toBe(false);
      }
      expect((await f.coordination.call("task.wait", { taskId: f.task.id, after: [], reason: "The required fix is available", requestId: "clear-extra" })).outcome).toBe("completed");
      expect((await f.finished(record)).result).toBe("passed");
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual(boundary === "running" ? [record.containerName, following.containerName] : [following.containerName, record.containerName]);
      expect(f.engine.checkQueue.running).toBe(0);
    } finally { released.resolve(); occupied(); restore(); await f.engine.shutdown(); }
  });

  for (const held of [false, true]) it(`keeps cancellation final during deferred preparation cleanup${held ? " across held cleanup and restart" : ""}`, async () => {
    const f = await fixture();
    const record = await f.submit("cancel-deferred", ["probe", "pass"]);
    const copied = Promise.withResolvers<void>(), releaseCopy = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>(), releaseCleanup = Promise.withResolvers<void>();
    const container = f.engine.extraValidations["container"];
    const snapshot = container.snapshot.bind(container), cleanup = container.cleanup.bind(container);
    container.snapshot = async record => { await snapshot(record); copied.resolve(); await releaseCopy.promise; };
    container.cleanup = async record => { cleaning.resolve(); await releaseCleanup.promise; return held ? false : cleanup(record); };
    let replacement: Engine | undefined;
    try {
      f.engine.setPoolPaused(false); await copied.promise;
      f.engine.setPoolPaused(true); releaseCopy.resolve(); await cleaning.promise;
      f.engine.cancel(f.task.id); releaseCleanup.resolve();
      await waitFor(() => f.engine.extraValidations.active === 0, "cancelled preparation to settle");
      if (held) {
        expect(f.engine.checkQueue.running).toBe(1);
        expect(f.engine.s.extraValidations![0]!.state).toBe("held");
        await f.engine.shutdown();
        replacement = new Engine(f.data, f.settings); engines.push(replacement);
        await replacement.extraValidations.ready;
      }
      const current = replacement ?? f.engine;
      expect((current.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("stopped");
      expect(current.checkQueue.running).toBe(0); expect(current.checkQueue.waiting).toBe(0);
      current.setPoolPaused(false);
      expect(existsSync(join(f.service, "started")) ? readdirSync(join(f.service, "started")) : []).toEqual([]);
      expect(existsSync(record.snapshot)).toBe(false);
    } finally { releaseCopy.resolve(); releaseCleanup.resolve(); await replacement?.shutdown(); await f.engine.shutdown(); }
  });

  for (const action of ["stop", "restart"] as const) it(`keeps a genuinely started extra run in the ${action} drain`, async () => {
    const f = await fixture();
    const record = await f.submit("started-drain");
    const store = new LifecycleStore(join(f.root, "running-lifecycle"));
    const handoffs: boolean[] = [];
    const lifecycle = new EngineLifecycle(f.engine, store, async restart => { handoffs.push(restart); });
    try {
      f.engine.setPoolPaused(false); await f.started(record);
      await lifecycle.request(action, { requestId: `started-${action}` });
      await lifecycle["settle"]();
      expect(handoffs).toEqual([]); expect(lifecycle.status().drained).toBe(false);
      expect(f.engine.extraValidations.active).toBe(1); expect(f.engine.checkQueue.running).toBe(1);
      f.release(record); expect((await f.finished(record)).result).toBe("passed");
      await waitFor(() => f.engine.extraValidations.active === 0, "started work to settle");
      await lifecycle["settle"](); expect(handoffs).toEqual([action === "restart"]);
    } finally { lifecycle.close(); store.close(); await f.engine.shutdown(); }
  });

  for (const limit of [1, 2]) for (const mode of ["preparation", "passed"] as const) it(`serializes slow startup recovery and cleanup retries for ${mode} records (limit ${limit})`, async () => {
    const reverseStarts = mode === "preparation" && limit === 2;
    const f = await fixture({ checkRuns: 2, extraCleanupEveryMs: 23_457 });
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
    f.engine.commitNow(); await f.engine.shutdown();
    rmSync(join(f.service, "cleanup-off"), { force: true });
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const preparingFirst = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>();
    const grants: number[] = [];
    const acquire = CheckQueue.prototype.acquire;
    const admission = spyOn(CheckQueue.prototype, "acquire").mockImplementation(function(this: CheckQueue, ...args: Parameters<CheckQueue["acquire"]>) {
      return acquire.apply(this, args).then(place => {
        if (args[2] === first.queueOrder || args[2] === second.queueOrder) grants.push(args[2]);
        return place;
      });
    });
    const prepare = ExtraContainer.prototype.prepare;
    const preparation = spyOn(ExtraContainer.prototype, "prepare").mockImplementation(async function(this: ExtraContainer, record) {
      const result = await prepare.call(this, record);
      if (reverseStarts && record.id === first.id) { preparingFirst.resolve(); await releaseFirst.promise; }
      return result;
    });
    const clean = ExtraContainer.prototype.cleanup, interval = globalThis.setInterval;
    let active = 0, maximum = 0, calls = 0, available = false;
    let tick: (() => void) | undefined;
    const timer = spyOn(globalThis, "setInterval").mockImplementation(((...parameters: Parameters<typeof globalThis.setInterval>) => {
      const [callback, ms, ...args] = parameters;
      if (ms === 23_457) { tick = () => { (callback as () => void)(); }; return interval(callback, 60_000, ...args); }
      return interval(callback, ms, ...args);
    }) as typeof globalThis.setInterval);
    const cleanup = spyOn(ExtraContainer.prototype, "cleanup").mockImplementation(async function(this: ExtraContainer, record) {
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
      replacement = new Engine(f.data, { ...f.settings, checkRuns: limit }); engines.push(replacement);
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
      await replacement?.shutdown(); admission.mockRestore(); preparation.mockRestore(); cleanup.mockRestore(); timer.mockRestore();
    }
  });

  it("holds an unverified saved process number across restart without claiming or signalling an unrelated program", async () => {
    const f = await fixture();
    const unrelated = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const signals = spyOn(process, "kill");
    let replacement: Engine | undefined;
    try {
      const reader = unrelated.stdout.getReader(); await reader.read(); reader.releaseLock();
      const queued = await f.submit("uncertain-client");
      const record = f.engine.s.extraValidations![0]!;
      record.container = await f.engine.extraValidations["container"].prepare(record);
      record.state = "held"; record.startedAt = Date.now(); record.clientPid = unrelated.pid;
      f.engine.commitNow(); await f.engine.shutdown();
      replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.checkQueue.running).toBe(1);
      const detail = replacement.extraValidations.blocker!;
      expect(detail).toContain("may be unrelated"); expect(detail).toContain("Do not stop");
      expect(detail).not.toContain("Stop those owned programs"); expect(detail).toContain("restart this computer");
      const status = await new Coordination(replacement).call("engine.status", {});
      expect(JSON.stringify(status.checkBlockers)).toContain("may be unrelated");
      expect(process.kill(unrelated.pid, 0)).toBe(true);
      expect(signals.mock.calls.filter(([pid, signal]) => Math.abs(pid) === unrelated.pid && signal !== 0)).toEqual([]);
      const unavailable = spyOn(processTree, "processList").mockResolvedValueOnce(undefined);
      try { await replacement.extraValidations.retryCleanup(); } finally { unavailable.mockRestore(); }
      expect(replacement.checkQueue.running).toBe(1);
      unrelated.kill("SIGKILL"); await unrelated.exited;
      await replacement.extraValidations.retryCleanup();
      expect(replacement.extraValidations.get(queued.requestId)!.outcome).toBe("completed");
      expect(replacement.checkQueue.running).toBe(0);
    } finally { unrelated.kill("SIGKILL"); await unrelated.exited; signals.mockRestore(); await replacement?.extraValidations.retryCleanup(); await replacement?.shutdown(); }
  });

  it("keeps added extra-only tasks out of agent admission while their saved version is read", async () => {
    const f = await fixture();
    const admitted: string[] = [];
    const start = spyOn(f.engine["driver"], "startDriver").mockImplementation(id => { admitted.push(id); });
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
      start.mockRestore(); await f.engine.shutdown();
    }
  });

  it("keeps extra-only tasks at a coordinator checkpoint through resume and restart", async () => {
    const f = await fixture();
    let replacement: Engine | undefined;
    const noAgentAdmission = (engine: Engine) => {
      const admitted: string[] = [];
      const start = spyOn(engine["driver"], "startDriver").mockImplementation(id => { admitted.push(id); });
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
      f.engine.setPoolPaused(true); await f.engine.shutdown();
      replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      noAgentAdmission(replacement);
      expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
    } finally { await replacement?.shutdown(); await f.engine.shutdown(); }
  });

  for (const route of ["failed preparation", "shared needs-you", "shared paused", "shared failed", "delivery retry", "proof decision", "acceptance decision", "no version change", "working edits"] as const) it(`pins the restored saved work after ${route}`, async () => {
    const f = await fixture();
    const scope = executionFor(f.task), path = scope.work.worktree!, shipping = f.engine["shipping"];
    scope.work.branch = await git(path, "branch", "--show-current");
    scope.work.delivery = "release";
    writeFileSync(join(path, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await git(path, "add", "."); await git(path, "commit", "-qm", "Declare the release version");
    await f.engine.rememberVersion(scope);
    const saved = structuredClone(scope.work.savedVersion!);
    scope.work.shipping = { start: saved.commit, moves: 0, failures: 0, version: route === "no version change" ? "1.0.0" : "1.0.1", tag: "v1.0.1" };
    const tested = await shipping.releases.setVersion(scope, await shipping.releases["declaredVersions"](path, saved.commit));
    expect(scope.work.savedVersion!.commit).toBe(tested);
    if (route !== "no version change") expect(tested).not.toBe(saved.commit);
    f.task.plan = { rationale: "Deliver the reviewed work", plannerProfileId: "sol-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "delivery", title: "Approve delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: ["sol-high"] },
      { id: "ship", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    f.task.stageIndex = 2;
    if (route.startsWith("shared ")) {
      f.task.repositories = [Object.assign(f.task.repository!, { completedStages: [] })]; delete f.task.repository;
      const state = route.slice("shared ".length) as "needs-you" | "paused" | "failed";
      // Control the shared driver's outcome; its real finalizer must restore unpublished work.
      const deliverMany = shipping["deliverMany"];
      shipping["deliverMany"] = async () => {
        f.task.state = state;
        if (state === "failed") throw new Error("Delivery stopped before publication");
        return "stop";
      };
      try {
        const outcome = await shipping.deliver(f.task, f.task.plan.stages[2]!, new AbortController().signal).then(value => value, error => error.message);
        expect(outcome).toBe(state === "failed" ? "Delivery stopped before publication" : "stop");
        expect(f.task.state).toBe(state);
      } finally { shipping["deliverMany"] = deliverMany; }
      f.task.state = "waiting"; // The coordinator can resume the task before requesting validation.
    } else if (route === "failed preparation") {
      expect(await shipping["preparationFailed"](scope, "Release checks failed", new AbortController().signal)).toBe("continue");
    } else if (route === "delivery retry") {
      expect(await shipping["prepareAgain"](scope, "Main moved before publication")).toBe("again");
    } else if (route === "proof decision" || route === "acceptance decision") {
      await shipping["returnForDecision"](f.task, route === "proof decision" ? "proof" : "acceptance");
      expect(f.task.stageIndex).toBe(1);
    } else {
      await shipping.clearUnpublishedVersion(scope);
    }
    expect(await git(path, "rev-parse", "HEAD")).toBe(saved.commit);
    expect(await git(path, "status", "--porcelain")).toBe("");
    expect(scope.work.savedVersion).toEqual(saved);
    f.engine.commitNow();
    const stored = f.engine.store.load()!.tasks.find(task => task.id === f.task.id)!;
    expect((stored.repositories?.[0] ?? stored.repository)!.savedVersion).toEqual(saved);
    if (route === "working edits") writeFileSync(join(path, "unrecorded-work.txt"), "New work awaiting handoff\n");
    const reply = await f.coordination.call("validation.run", f.request("restored-release-work"));
    const record = reply.validation as ExtraValidation;
    expect(reply.outcome).toBe("pending");
    expect(record.commit).toBe(saved.commit); expect(record.tree).toBe(saved.tree);
    expect(record.workingEdits).toBe(route === "working edits");
    expect(reply.message!.includes("The working copy currently has changes that are excluded")).toBe(route === "working edits");
    await f.engine.shutdown();
  });

  it("keeps an already queued release snapshot when restoring the saved work", async () => {
    const f = await fixture(), scope = executionFor(f.task), path = scope.work.worktree!;
    scope.work.branch = await git(path, "branch", "--show-current");
    writeFileSync(join(path, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await git(path, "add", "."); await git(path, "commit", "-qm", "Declare the release version");
    await f.engine.rememberVersion(scope);
    const saved = structuredClone(scope.work.savedVersion!);
    scope.work.shipping = { start: saved.commit, moves: 0, failures: 0, version: "1.0.1", tag: "v1.0.1" };
    const release = f.engine["shipping"].releases;
    await release.setVersion(scope, await release["declaredVersions"](path, saved.commit));
    const queued = await f.submit("version-before-rollback");
    await f.engine["shipping"].clearUnpublishedVersion(scope);
    expect(scope.work.savedVersion).toEqual(saved);
    const retry = await f.coordination.call("validation.run", f.request(queued.requestId));
    expect(retry.validation).toEqual(queued);
    f.engine.setPoolPaused(false);
    await f.started(queued);
    expect(await git(queued.snapshot, "rev-parse", "HEAD")).toBe(queued.commit);
    expect(await git(queued.snapshot, "rev-parse", "HEAD^{tree}")).toBe(queued.tree);
    f.release(queued);
    const result = await f.finished(queued);
    expect(result.result).toBe("passed");
    expect(result.commit).toBe(queued.commit); expect(result.tree).toBe(queued.tree);
    expect(result.commit).not.toBe(saved.commit);
    await f.engine.shutdown();
  });

  it("reports live extra evidence as pending rather than restarted", async () => {
    const f = await fixture();
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
    await f.engine.shutdown();
  });

  it("recovers ownership saved before a command log exists without inventing an outcome", async () => {
    const f = await fixture();
    const queued = await f.submit("crash-before-log");
    const record = f.engine.s.extraValidations![0]!, container = f.engine.extraValidations["container"];
    record.container = await container.prepare(record);
    await container.snapshot(record);
    // This saved boundary precedes log creation and client startup. Recovery still owns it.
    record.state = "running"; record.startedAt = Date.now();
    f.engine.commitNow(); await f.engine.shutdown();
    writeFileSync(join(f.service, "cleanup-off"), "service unavailable");
    const replacement = new Engine(f.data, f.settings); engines.push(replacement);
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
    await replacement.shutdown();
  });

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

  for (const identity of ["saved number", "verified client", "surviving helper", "unknown command"] as const) it(`gives ${identity === "verified client" || identity === "surviving helper" ? `direct advice for a ${identity}` : `safe uncertainty for a ${identity}`}`, async () => {
    const verified = identity === "verified client" || identity === "surviving helper";
    const f = await fixture();
    const record = await f.submit("client-advice");
    const current = { ...record, clientPid: 712345 };
    const command = verified ? `docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image` : "unrelated-program";
    const start = "Fri Oct 23 08:00:00 2026";
    const before = `712345 712345 S ${start} ${command}\n712346 712345 S ${start} helper\n`;
    const read = spyOn(processTree, "processList").mockResolvedValue(identity === "unknown command" ? "712345 712345 S\n" : before);
    let reads = 0;
    if (identity === "surviving helper") read.mockImplementation(async () => reads++ === 0 ? before : `712346 712345 S ${start} helper\n`);
    const kill = spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Cannot stop client"), { code: "EPERM" }); });
    try {
      expect(await f.engine.extraValidations["container"]["stopClient"](current)).toBe(false);
      expect(current.cleanupDetail).toContain(identity === "surviving helper" ? "verified local helpers" : verified ? "verified local client" : "may be unrelated");
      if (verified) expect(current.cleanupDetail).not.toContain("restart this computer");
      else { expect(kill).not.toHaveBeenCalled(); expect(current.cleanupDetail).toContain("Do not stop programs based on the saved number"); }
    } finally { read.mockRestore(); kill.mockRestore(); }
  });

  for (const identity of ["same helper", "changed start", "changed command", "new member", "missing start", "new observer"] as const) it(`revalidates an observed helper identity: ${identity}`, async () => {
    const f = await fixture(), record = await f.submit("observed-helper");
    const current = { ...record, clientPid: 712345 };
    const start = "Fri Oct 23 08:00:00 2026";
    const client = `712345 712345 S ${start} docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image`;
    const read = spyOn(processTree, "processList").mockResolvedValue(`${client}\n712346 712345 S ${start} helper\n`);
    const kill = spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Cannot stop client"), { code: "EPERM" }); });
    try {
      const observer = f.engine.extraValidations["container"];
      expect(await observer["stopClient"](current)).toBe(false);
      expect(current.cleanupDetail).toContain("verified local client");
      read.mockResolvedValue(identity === "missing start" ? "712346 712345 S helper\n" : `${identity === "new member" ? 712347 : 712346} 712345 S ${identity === "changed start" ? "Fri Oct 23 08:00:01 2026" : start} ${identity === "changed command" ? "unrelated" : "helper"}\n`);
      kill.mockClear();
      expect(await (identity === "new observer" ? new ExtraContainer(f.engine) : observer)["stopClient"](current)).toBe(false);
      expect(kill).not.toHaveBeenCalled(); // A remembered identity authorizes advice, never a signal.
      expect(current.cleanupDetail).toContain(identity === "same helper" ? "verified local helpers (712346)" : "may be unrelated");
      if (identity === "same helper") expect(current.cleanupDetail).toContain("Stop those owned programs");
      else expect(current.cleanupDetail).toContain("Do not stop programs based on the saved number");
    } finally { read.mockRestore(); kill.mockRestore(); }
  });

  it("holds a client first identified by the final lookup even without a saved client number", async () => {
    const f = await fixture(), record = await f.submit("final-client-identity");
    const current = { ...record, clientPid: undefined };
    const identified = `712345 712345 S Fri Oct 23 08:00:00 2026 docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image\n`;
    let reads = 0;
    const read = spyOn(processTree, "processList").mockImplementation(async () => reads++ === 0 ? "712345 712345 S\n" : identified);
    const kill = spyOn(process, "kill").mockImplementation(() => { throw new Error("Unexpected signal from an unidentified first lookup"); });
    try {
      expect(await f.engine.extraValidations["container"]["stopClient"](current)).toBe(false);
      expect(current.cleanupDetail).toContain("verified local client");
      expect(kill).not.toHaveBeenCalled();
    } finally { read.mockRestore(); kill.mockRestore(); }
  });

  for (const observed of [false, true]) it(`stops the labelled workload but keeps capacity for a local child that outlives its client ${observed ? "after observing its identity" : "without observing its identity"}`, async () => {
    const f = await fixture(); f.engine.setPoolPaused(false);
    const record = await f.submit("client-child", ["probe", "hold-child"]); await f.started(record);
    const started = JSON.parse(readFileSync(join(f.service, "started", record.id), "utf8"));
    try {
      // Establish product evidence while both client and helper are live; fixture knowledge alone is not ownership.
      if (observed) {
        const signal = process.kill;
        const blocked = spyOn(process, "kill").mockImplementation(((pid: number, how?: NodeJS.Signals | number) => {
          if (pid === -started.pid && how === "SIGKILL") throw Object.assign(new Error("Controlled client stop refusal"), { code: "EPERM" });
          return signal(pid, how);
        }) as typeof process.kill);
        try {
          const current = f.engine.s.extraValidations![0]!;
          expect(await f.engine.extraValidations["container"]["stopClient"](current)).toBe(false);
          expect(current.cleanupDetail).toContain("verified local client");
        } finally { blocked.mockRestore(); }
      }
      process.kill(started.pid, "SIGKILL");
      await waitFor(() => f.engine.s.extraValidations?.[0]?.state === "held", "surviving owned local child");
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      expect(f.engine.checkQueue.running).toBe(1);
      if (observed) {
        expect(f.engine.extraValidations.blocker).toContain(`verified local helpers (${started.childPid})`);
        expect(f.engine.extraValidations.blocker).toContain("Stop those owned programs");
        expect(f.engine.extraValidations.blocker).not.toContain("restart this computer");
      } else {
        expect(f.engine.extraValidations.blocker).toContain("may be unrelated");
        expect(f.engine.extraValidations.blocker).toContain("Do not stop programs based on the saved number");
        expect(f.engine.extraValidations.blocker).not.toContain("Stop those owned programs");
      }
      const pending = f.engine.checkQueue.acquire(new AbortController().signal);
      process.kill(started.childPid, "SIGUSR1");
      await waitFor(async () => { await f.engine.extraValidations.retryCleanup(); return f.engine.extraValidations.get(record.requestId)?.outcome === "completed"; }, "local child cleanup confirmation");
      const release = await pending; release();
      expect(existsSync(record.snapshot)).toBe(false);
    } finally { try { process.kill(started.childPid, "SIGKILL"); } catch { /* Already stopped. */ } }
  });

  for (const mode of ["slow removal", "short remaining window", "unresponsive"] as const) it(`confirms removal with an unchanged service-read allowance: ${mode}`, async () => {
    const f = await fixture({ containerCommandTimeoutMs: 4_000 });
    await f.engine.waitUntilReady();
    const record = await f.submit("confirmation-budget"), container = f.engine.extraValidations["container"];
    let now = Date.now(), reads = 0;
    const start = now, budgets: number[] = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const sleep = spyOn(Bun, "sleep").mockImplementation(async ms => { now += ms instanceof Date ? ms.getTime() - now : ms; });
    const inspections = container as unknown as { labelled(record: ExtraValidation, timeout?: number): Promise<string[]> };
    const inspect = spyOn(inspections, "labelled").mockImplementation(async (_record, timeout = 4_000) => {
      budgets.push(timeout); reads++;
      const latency = mode === "unresponsive" ? 4_001 : mode === "short remaining window" && reads === 1 ? 3_900 : 100;
      await Bun.sleep(Math.min(latency, timeout));
      if (latency > timeout) throw new Error("Controlled container inspection timed out");
      return mode === "slow removal" && now - start < 1_500 || mode === "short remaining window" && reads === 1 ? [record.containerName] : [];
    });
    try {
      expect(await container["removed"](record)).toBe(mode !== "unresponsive");
      expect(budgets.every(budget => budget === 4_000)).toBe(true);
      expect(now - start).toBeLessThan(8_000);
      if (mode === "unresponsive") { expect(reads).toBe(1); expect(now - start).toBe(4_000); }
      else expect(now - start).toBeGreaterThan(1_000);
    } finally { inspect.mockRestore(); sleep.mockRestore(); clock.mockRestore(); await f.engine.shutdown(); }
  });

  for (const stalled of [false, true]) it(`${stalled ? "holds boundedly unconfirmed removal" : "confirms removal in progress without a false held state"} before handing off capacity`, async () => {
    const f = await fixture();
    const record = await f.submit("removal-in-progress");
    f.engine.setPoolPaused(false); await f.started(record);
    writeFileSync(join(f.service, "removal-pending"), "service is removing the stopped container");
    const controller = new AbortController();
    let admitted = false;
    const pending = f.engine.checkQueue.acquire(controller.signal).then(place => { admitted = true; return place; }, () => undefined);
    try {
      f.engine.cancel(f.task.id);
      await waitFor(() => existsSync(join(f.service, "removal-observed")), "the owned container to be listed during removal");
      expect(admitted).toBe(false); expect(f.engine.checkQueue.running).toBe(1);
      if (!stalled) expect(f.engine.s.extraValidations![0]!.state).toBe("stopping");
      if (stalled) {
        await waitFor(() => f.engine.s.extraValidations![0]?.state === "held", "bounded removal confirmation to stay held");
        expect(f.engine.extraValidations.blocker).toContain("still unconfirmed after its stop/removal request");
        expect(f.engine.extraValidations.blocker).not.toContain("Make the local container service available");
      }
      writeFileSync(join(f.service, "finish-removal"), "release removal");
      if (stalled) await f.engine.extraValidations.retryCleanup();
      await waitFor(() => f.engine.extraValidations.get(record.requestId)?.outcome === "completed", "normal product cleanup to release capacity");
      const place = await pending;
      expect((await f.finished(record)).result).toBe("stopped");
      expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind === "extra.held")).toHaveLength(stalled ? 1 : 0);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      place!(); expect(f.engine.checkQueue.running).toBe(0);
    } finally {
      writeFileSync(join(f.service, "finish-removal"), "release removal"); controller.abort(); (await pending)?.();
      await f.engine.extraValidations.retryCleanup(); await f.engine.shutdown();
    }
  });

  it("a time limit stops the workload before releasing the next place", async () => {
    const f = await fixture({ checkTimeoutMs: 1_000 * currentSlow() }); f.engine.setPoolPaused(false);
    const record = await f.submit("deadline"); await f.started(record);
    const next = f.engine.checkQueue.acquire(new AbortController().signal);
    const release = await next;
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(existsSync(record.snapshot)).toBe(false);
    expect((await f.finished(record)).result).toBe("did not finish");
    release();
  });

  it("cancels queued work without execution and running work with confirmed cleanup", async () => {
    const f = await fixture();
    const queued = await f.submit("queued-cancel");
    f.engine.cancel(f.task.id);
    expect((await f.finished(queued)).result).toBe("stopped");
    expect(existsSync(join(f.service, "started"))).toBe(false);
    const task = await f.add(); f.engine.setPoolPaused(false);
    const running = await f.submit("running-cancel", undefined, task.id); await f.started(running);
    f.engine.cancel(task.id); await f.finished(running);
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(f.engine.checkQueue.running).toBe(0);
  });

  it("restarts a queued request once, preserves evidence binding and excludes working edits", async () => {
    const f = await fixture();
    writeFileSync(join(executionFor(f.task).work.worktree!, "working-only"), "not committed");
    const queued = await f.submit("restart-queued", ["probe", "pass"]);
    expect(queued.workingEdits).toBe(true);
    expect(queued.versionNote).toContain("working edits are not included");
    await f.engine.shutdown();
    const replacement = new Engine(f.data, f.settings); engines.push(replacement);
    const coordination = new Coordination(replacement); replacement.setPoolPaused(false);
    await waitFor(() => replacement.extraValidations.get(queued.requestId)?.outcome === "completed", "recovered queued validation");
    const result = (await coordination.call("validation.inspect", { requestId: queued.requestId })).validation as ExtraValidation;
    expect(result.commit).toBe(queued.commit); expect(result.tree).toBe(queued.tree);
    expect(result.container).toEqual(expect.objectContaining({ imageId: "sha256:" + "a".repeat(64), os: "linux", arch: "arm64" }));
    expect(readdirSync(join(f.service, "started"))).toEqual([queued.id]);
    expect(existsSync(queued.snapshot)).toBe(false);
  });

  for (const output of ["saved output", "no output", "no log file", "interrupted observation"] as const) it(`recovers an abruptly stopped engine with ${output} by label before any check starts, keeping its original incomplete log`, async () => {
    const f = await fixture();
    const record = await f.submit("crash-running", ["probe", output === "saved output" ? "hold" : "hold-silent"]);
    await f.engine.shutdown();
    const settings = join(f.root, "settings.json");
    writeFileSync(settings, JSON.stringify(f.settings));
    const folder = join(f.data, "checks", record.taskId);
    if (output === "no log file") {
      mkdirSync(join(f.data, "checks"), { recursive: true });
      writeFileSync(folder, "A file prevents creating the command log folder");
    }
    const crashed = Bun.spawn([process.execPath, join(import.meta.dir, "extra-crash-engine.ts"), f.data, settings], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let replacement: Engine | undefined;
    let cleanupOutcome: string | undefined;
    const interrupted = new Error("The diagnostic observer stopped before recovery started");
    try {
      await f.started(record);
      if (output === "interrupted observation") throw interrupted;
      // The service's start marker does not mean the engine has read stdout or written its log.
      // Crash only after observing the bytes we expect recovery to preserve; the silent control
      // proves a started workload can truthfully have an empty, incomplete diagnostic.
      const files = output === "no log file" ? [] : readdirSync(folder);
      expect(files).toHaveLength(output === "no log file" ? 0 : 1);
      const path = output === "no log file" ? undefined : join(folder, files[0]!);
      const diagnostic = `Original complete diagnostic for ${record.id}\n`;
      if (output === "saved output") await waitFor(() => readFileSync(path!, "utf8") === diagnostic, "the engine to save the original diagnostic before crashing");
      const original = path ? readFileSync(path, "utf8") : "";
      if (output === "no output") expect(original).toBe("");
      crashed.kill("SIGKILL"); await crashed.exited;
      expect(readdirSync(join(f.service, "containers"))).toEqual([record.containerName]);
      writeFileSync(join(f.service, "cleanup-off"), "service unavailable");
      replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.s.extraValidations![0]!.state).toBe("held");
      expect(replacement.checkQueue.running).toBe(1);
      const next = replacement.checkQueue.acquire(new AbortController().signal, true);
      expect(replacement.checkQueue.waiting).toBe(1);
      rmSync(join(f.service, "cleanup-off"));
      await replacement.extraValidations.retryCleanup();
      const release = await next;
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      expect(existsSync(record.snapshot)).toBe(false);
      release();
      const final = replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      expect(final.result).toBe("stopped");
      expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
      const log = await new Coordination(replacement).call("validation.log", { requestId: record.requestId });
      expect(log.outcome).not.toBe("pending");
      expect(log.completeness).toBe(path ? "incomplete" : "excerpt-only");
      expect(log.commandOutcome).toBe("unfinished");
      expect(final.run!.logPath).toBe(path);
      expect(final.run!.logFileLength).toBe(path ? Buffer.byteLength(original) : undefined);
      expect(final.run!.logComplete).toBe(false);
      if (path) expect(readFileSync(path, "utf8")).toBe(original);
      if (output === "saved output") {
        expect(log.text).toBe(original);
      } else {
        if (path) expect(log.source).toBe("saved-result");
        expect(log.text).toContain("Petrina restarted before the command outcome was recorded");
      }
    } catch (error) {
      if (output !== "interrupted observation") throw error;
      expect(error).toBe(interrupted);
    } finally {
      crashed.kill("SIGKILL"); await crashed.exited;
      rmSync(join(f.service, "cleanup-off"), { force: true });
      // Recovery owns the detached client even when an earlier observation failed. Closed
      // admissions prevent a never-started request from beginning during emergency cleanup.
      if (!replacement) { replacement = new Engine(f.data, { ...f.settings, admissionsClosed: true }); engines.push(replacement); }
      try {
        await replacement.extraValidations.ready;
        await replacement.extraValidations.retryCleanup();
        cleanupOutcome = replacement.extraValidations.get(record.requestId)?.outcome;
      } finally { await replacement.shutdown(); }
    }
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(existsSync(record.snapshot)).toBe(false);
    expect(replacement.checkQueue.running).toBe(0);
    expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
    expect(cleanupOutcome).toBe("completed");
  });

  for (const phase of ["service inspection", "copying", "copying with held cleanup", "failed service inspection"] as const) it(`preserves never-started requests when force-stopped during ${phase}`, async () => {
    const f = await fixture();
    const record = await f.submit("force-stop-preparing", ["probe", "pass"]);
    const following = await f.submit("after-forced-stop", ["probe", "pass"], (await f.add()).id);
    const container = f.engine.extraValidations["container"];
    let entered!: () => void, releasePreparation!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { releasePreparation = resolve; });
    if (phase.includes("service inspection")) {
      const prepare = container.prepare.bind(container);
      container.prepare = async record => {
        entered(); await released;
        if (phase === "failed service inspection") throw new Error("Service inspection interrupted");
        return prepare(record);
      };
    } else {
      const snapshot = container.snapshot.bind(container);
      container.snapshot = async record => { await snapshot(record); entered(); await released; };
    }
    if (phase === "copying with held cleanup") container.cleanup = async () => false;
    let stopped: Promise<void> | undefined;
    try {
      f.engine.setPoolPaused(false); await preparing;
      f.engine.setPoolPaused(true);
      stopped = f.engine.shutdown();
      expect(f.engine.checkQueue.running).toBe(1);
      expect(f.engine.extraValidations.get(record.requestId)!.outcome).toBe("pending");
      releasePreparation(); await stopped;
      expect(f.engine.s.extraValidations!.map(entry => entry.state)).toEqual([phase === "copying with held cleanup" ? "held" : "queued", "queued"]);
      expect(f.engine.checkQueue.running).toBe(phase === "copying with held cleanup" ? 1 : 0);
      expect(existsSync(join(f.service, "started")) ? readdirSync(join(f.service, "started")) : []).toEqual([]);

      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.s.extraValidations!.map(entry => entry.state)).toEqual(["queued", "queued"]);
      expect(replacement.checkQueue.running).toBe(0);
      expect(existsSync(record.snapshot)).toBe(false);
      const retry = await new Coordination(replacement).call("validation.run", f.request(record.requestId, ["probe", "pass"]));
      const retried = retry.validation as ExtraValidation;
      expect(retry.outcome).toBe("pending");
      expect(retried).toEqual(expect.objectContaining({ id: record.id, state: "queued", commit: record.commit, tree: record.tree, queueOrder: record.queueOrder, queuedAt: record.queuedAt }));
      expect(retried.result).toBeUndefined();
      expect(retried.startedAt).toBeUndefined();
      expect(retried.endedAt).toBeUndefined();
      replacement.setPoolPaused(false);
      await waitFor(() => replacement.extraValidations.get(following.requestId)?.outcome === "completed", "both force-stopped requests to finish in order");
      expect((replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("passed");
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([record.containerName, following.containerName]);
      expect(replacement.checkQueue.running).toBe(0);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(existsSync(following.snapshot)).toBe(false);
    } finally { releasePreparation(); await (stopped ?? f.engine.shutdown()); }
  });

  for (const heldCopy of [false, true]) it(`returns interrupted preparation to its original place${heldCopy ? " after cleanup was held" : ""}`, async () => {
    const f = await fixture();
    const record = await f.submit("crash-preparing", ["probe", "pass"]);
    const second = await f.add();
    const following = await f.submit("after-preparation", ["probe", "pass"], second.id);
    const current = f.engine.s.extraValidations![0]!;
    current.state = "preparing";
    mkdirSync(current.snapshot, { recursive: true }); writeFileSync(join(current.snapshot, "partial"), "incomplete copy");
    if (heldCopy) chmodSync(current.snapshot, 0);
    try {
      f.engine.commitNow(); await f.engine.shutdown();
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.s.extraValidations!.map(entry => entry.state)).toEqual([heldCopy ? "held" : "queued", "queued"]);
      replacement.setPoolPaused(false);
      if (heldCopy) {
        expect(replacement.checkQueue.waiting).toBe(1);
        expect(existsSync(join(f.service, "started", following.id))).toBe(false);
        chmodSync(current.snapshot, 0o755);
        await replacement.extraValidations.retryCleanup();
      }
      await waitFor(() => replacement.extraValidations.get(following.requestId)?.outcome === "completed", "both never-started requests to finish once");
      expect(readdirSync(join(f.service, "started")).sort()).toEqual([record.id, following.id].sort());
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([record.containerName, following.containerName]);
    } finally { if (existsSync(current.snapshot)) chmodSync(current.snapshot, 0o755); }
  });

  it("preserves an already completed outcome through held cleanup and restart, and drains only running work", async () => {
    const f = await fixture();
    const record = await f.submit("held-result");
    f.engine.setPoolPaused(false); await f.started(record);
    expect(f.engine.backgroundWork.size).toBeGreaterThan(0);
    writeFileSync(join(f.service, "cleanup-off"), "service unavailable");
    f.release(record);
    await waitFor(() => f.engine.s.extraValidations?.[0]?.state === "held", "held successful result");
    expect(f.engine.s.extraValidations![0]!.result).toBe("passed");
    await waitFor(() => f.engine.extraValidations.active === 0, "cleanup attempt to settle");
    await f.engine.shutdown();
    const replacement = new Engine(f.data, f.settings); engines.push(replacement);
    await replacement.extraValidations.ready;
    expect(replacement.s.extraValidations![0]!.result).toBe("passed");
    expect(replacement.extraValidations.blocker).toContain(record.containerName);
    expect(replacement.extraValidations.blocker).toContain("container service available");
    rmSync(join(f.service, "cleanup-off"));
    await replacement.extraValidations.retryCleanup();
    expect((replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("passed");
  });

  it("keeps paused and draining submissions queued without taking capacity; ordinary no-extra evidence is unchanged", async () => {
    const f = await fixture();
    const work = executionFor(f.task).work;
    const checks = JSON.stringify(work.checks);
    const eventsBefore = f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind.startsWith("check."));
    expect(f.engine.s.extraValidations).toBeUndefined();
    const queued = await f.submit("draining");
    expect(f.engine.checkQueue.running).toBe(0);
    f.engine.draining = true;
    f.engine.s.pool.paused = false; f.engine.schedule();
    expect(f.engine.checkQueue.running).toBe(0);
    expect(f.engine.s.extraValidations![0]!.state).toBe("queued");
    f.engine.draining = false; f.engine.schedule(); await f.started(queued);
    f.release(queued); await f.finished(queued);
    expect(JSON.stringify(work.checks)).toBe(checks);
    expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind.startsWith("check."))).toEqual(eventsBefore);
    // No extra work: ordinary check execution and product removal continue under their old rules.
    const release = await f.engine["checks"]["turnToRun"](executionFor(f.task), new AbortController().signal);
    release();
    f.engine.cancel(f.task.id);
    f.engine.removeProduct(f.productId);
    expect(f.engine.s.products).toEqual([]);
  });

  it("cancelling during preparation keeps ownership and capacity until the admitted work settles", async () => {
    const f = await fixture();
    let entered!: () => void, releasePreparation!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { releasePreparation = resolve; });
    f.engine.extraValidations["container"].snapshot = async () => { entered(); await released; };
    const record = await f.submit("preparation-cancel");
    f.engine.setPoolPaused(false); await preparing;
    expect(f.engine.s.extraValidations![0]!.state).toBe("preparing");
    f.engine.cancel(f.task.id);
    expect(f.engine.extraValidations.get(record.requestId)!.outcome).toBe("pending");
    expect(f.engine.checkQueue.running).toBe(1);
    expect(() => f.engine.removeProduct(f.productId)).toThrow("still needs this product");
    const next = f.engine.checkQueue.acquire(new AbortController().signal);
    expect(f.engine.checkQueue.waiting).toBe(1);
    releasePreparation();
    const release = await next; release();
    expect((await f.finished(record)).result).toBe("stopped");
    expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind === "extra.finished")).toHaveLength(1);
  });

  it("keeps a task cancellation final when Petrina also stops during preparation", async () => {
    const f = await fixture();
    let entered!: () => void, releasePreparation!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { releasePreparation = resolve; });
    f.engine.extraValidations["container"].snapshot = async () => { entered(); await released; };
    const record = await f.submit("cancel-before-shutdown");
    let stopped: Promise<void> | undefined;
    try {
      f.engine.setPoolPaused(false); await preparing;
      f.engine.cancel(f.task.id);
      stopped = f.engine.shutdown();
      releasePreparation(); await stopped;
      expect(f.engine.checkQueue.running).toBe(0);
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.extraValidations.get(record.requestId)).toEqual(expect.objectContaining({ outcome: "completed",
        validation: expect.objectContaining({ id: record.id, result: "stopped", detail: "The task stopped before the container started." }) }));
      expect(replacement.s.extraValidations).toEqual([]);
      expect(readdirSync(join(f.service, "started"))).toEqual([]);
    } finally { releasePreparation(); await (stopped ?? f.engine.shutdown()); }
  });

  it("makes copy-cleanup failures visible across restart and retries them without leaking a hidden place", async () => {
    const f = await fixture();
    const record = await f.submit("copy-cleanup");
    f.engine.setPoolPaused(false); await f.started(record);
    chmodSync(record.snapshot, 0);
    try {
      f.release(record);
      await waitFor(() => f.engine.s.extraValidations?.[0]?.state === "held", "inaccessible copy to hold cleanup");
      expect(f.engine.s.extraValidations![0]!.result).toBe("passed");
      await f.engine.shutdown();
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.s.extraValidations![0]!.state).toBe("held");
      expect(replacement.extraValidations.blocker).toContain("copy");
      expect(replacement.checkQueue.running).toBe(1);
      chmodSync(record.snapshot, 0o755);
      await replacement.extraValidations.retryCleanup();
      expect((replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("passed");
      expect(replacement.checkQueue.running).toBe(0);
    } finally { if (existsSync(record.snapshot)) chmodSync(record.snapshot, 0o755); }
  });

  it("reports distinct queue positions before registration and refuses unrelated receipts or ineligible tasks", async () => {
    const f = await fixture();
    const secondTask = await f.add();
    f.engine.extraRecovery = true;
    const first = await f.submit("pre-register-first");
    const second = await f.submit("pre-register-second", ["probe", "pass"], secondTask.id);
    expect([first.queuePosition, second.queuePosition]).toEqual([1, 2]);
    f.engine.extraRecovery = false;
    f.engine.cancel(f.task.id); f.engine.cancel(secondTask.id);
    const other = await f.coordination.call("pool.limit", { limit: 2, requestId: "pool-change" });
    expect(other.outcome).toBe("completed");
    expect((await f.coordination.call("validation.inspect", { requestId: "pool-change" })).outcome).toBe("missing");
    for (const state of ["backlog", "paused", "done", "cancelled", "pr-open"] as const) {
      const task = await f.add(); task.state = state;
      expect((await f.coordination.call("validation.run", f.request("ineligible-" + state, ["probe", "pass"], task.id))).outcome).toBe("invalid");
    }
    const task = await f.add(); delete executionFor(task).work.savedVersion;
    expect((await f.coordination.call("validation.run", f.request("unsaved", ["probe", "pass"], task.id))).message).toContain("no saved version");
  });

  it("keeps extra passes and failures independent of ordinary checks, findings, approvals and repair allowance", async () => {
    const f = await fixture();
    const work = executionFor(f.task).work;
    work.checks = { at: 1, current: true, results: [{ name: "Configured suite", command: "configured", ok: false, output: "failure", ms: 2 }] };
    work.checkReturns = 2; work.approvedSha = "approval";
    f.engine.s.inbox.push({ id: "ordinary-delivery", taskId: f.task.id, kind: "delivery", title: "Delivery", at: Date.now(), blocking: false });
    const before = JSON.stringify({ checks: work.checks, returns: work.checkReturns, approved: work.approvedSha, findings: f.task.findings, stage: f.task.stageIndex });
    f.engine.setPoolPaused(false);
    for (const [ref, mode] of [["extra-pass", "pass"], ["extra-fail", "fail"]]) {
      const record = await f.submit(ref!, ["probe", mode!]);
      const result = await f.finished(record);
      expect(result.result).toBe(mode === "pass" ? "passed" : "failed");
      expect(JSON.stringify({ checks: work.checks, returns: work.checkReturns, approved: work.approvedSha, findings: f.task.findings, stage: f.task.stageIndex })).toBe(before);
      expect(checkProblem({ checks: work.checks })).toBe("failing");
      expect(() => f.engine.approve("ordinary-delivery")).toThrow("checks are failing or unverified");
    }
    const events = f.engine.events.log.collect({}, 0, 100).events;
    expect(events.filter(event => event.kind.startsWith("extra.")).map(event => event.kind)).toEqual(["extra.queued", "extra.started", "extra.stopping", "extra.finished", "extra.queued", "extra.started", "extra.stopping", "extra.finished"]);
    expect(events.filter(event => event.kind.startsWith("check."))).toEqual([]);
  });

  it("refuses unsupported and invalid requests without queueing; missing local images/services are not-run", async () => {
    const f = await fixture();
    for (const change of [{ mode: "native" }, { options: ["--privileged"] }, { remote: "elsewhere" }, { argv: [] }, { argv: [""] }, { name: " " }, { image: "--pull" }, { taskId: "unknown" }]) {
      const reply = await f.coordination.call("validation.run", { ...f.request("refuse-" + Math.random().toString().slice(2)), ...change });
      expect(["invalid", "missing"]).toContain(reply.outcome);
      expect(f.engine.s.extraValidations ?? []).toEqual([]);
    }
    const record = await f.submit("only-one");
    expect((await f.coordination.call("validation.run", f.request("second-request"))).message).toContain("only-one");
    writeFileSync(join(f.service, "missing-image"), "missing");
    f.engine.setPoolPaused(false);
    expect((await f.finished(record)).result).toBe("not run");
    rmSync(join(f.service, "missing-image"));
    writeFileSync(join(f.service, "offline"), "missing");
    const offline = await f.submit("offline", ["probe", "pass"]);
    expect((await f.finished(offline)).result).toBe("not run");
    expect(f.engine.checkQueue.running).toBe(0);
    expect(existsSync(join(f.service, "started"))).toBe(true); // CLI creates empty service folders, never a workload
    expect(readdirSync(join(f.service, "started"))).toEqual([]);
  });
});

// Process-group ownership is the bounded host contract; Windows must refuse before queueing.
it.skipIf(process.platform !== "win32")("refuses an extra run on a host without supported process-group ownership", async () => {
  const f = await fixture();
  const result = await f.coordination.call("validation.run", f.request("unsupported-host", ["probe", "pass"]));
  expect(result.outcome).toBe("invalid");
  expect(result.message).toContain("Unix host");
  expect(f.engine.s.extraValidations).toBeUndefined();
  expect(f.engine.checkQueue.running).toBe(0);
});
