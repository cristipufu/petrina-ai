import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { Engine, writeFixtureEngineOptions } from "./engine.js";
import { git, makeProduct, tempDir, waitFor } from "./fixtures.js";
import { Coordination } from "../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import * as processTree from "../src/process-tree.js";
import { Store } from "@petrina/storage/store";
import { ExtraFixtures } from "./extra-fixtures.js";

const owned = new ExtraFixtures();
const { roots, engines } = owned;
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());

describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
  it("cleans interrupted fake-service publication without inventing a leftover container", async () => {
    const f = await fixture();
    const record = await f.submit("interrupted-publication", ["probe", "hold-before-create"]);
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => existsSync(join(f.service, "creating", record.id)), "the client to prepare its atomic publication");
      const temporary = join(record.snapshot, ".git", `fake-container-${record.containerName}`);
      expect(existsSync(temporary)).toBe(true);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      f.engine.cancel(f.task.id);
      const finished = await f.finished(record);
      expect(finished.result).toBe("stopped");
      expect(finished.run?.interrupted).toBe(true);
      expect(finished.clientPid).toBeDefined();
      expect(await processTree.childState(finished.clientPid!)).toBe("ended");
      expect(existsSync(temporary)).toBe(false);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      expect(f.engine.checkQueue.running).toBe(0);
      expect(f.engine.s.extraValidations).toEqual([]);
    } finally { await f.engine.shutdown(); }
  });

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
    writeFixtureEngineOptions(settings, f.settings);
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
});
