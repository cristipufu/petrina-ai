import type { EngineCaseOwner } from "./fixtures/engine-cases.js";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { CLEANUP_MS, type Started } from "@petrina/test-support/commands";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { writeFileSync } from "node:fs";
import { expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, type ExtraValidation } from "@petrina/core";
import type { Engine, EngineOptions } from "./engine.js";
import { git, makeProduct, SLOW, waitFor } from "./fixtures.js";
import { Coordination } from "../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import { EngineClient } from "./client.js";
import { serve } from "../src/server.js";
import { writeConnection } from "../src/instance.js";
import { completeAll } from "@petrina/core";

/** Native actors keep the original bodies/payloads; their lease precedes runnable work. */
export async function extraActors(owner: EngineCaseOwner) {
  let commandLease: ProcessLease | undefined;
  const actorReady = Promise.withResolvers<ProcessLease>();
  void actorReady.promise.catch(() => undefined);
  owner.afterBody(async () => { await commandLease?.close(); });
  owner.onStop(() => {
    // Request every actual Engine before closing the actors' independent lease. Command
    // clients keep their separate lease until Engine ps/stop/rm work has really settled.
    const stopped = (async () => { await owner.stopAll(); })();
    const actors = (async () => { await (await actorReady.promise).close(); })();
    return Promise.allSettled([stopped, actors]).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Extra-validation Engine and independent actor cleanup failed");
    });
  });
  let actorLease: ProcessLease;
  try {
    commandLease = await createProcessLease();
    owner.check();
    actorLease = await createProcessLease();
    actorReady.resolve(actorLease);
    owner.check();
  } catch (error) { actorReady.reject(error); throw error; }
  const client = join(owner.root, "owned-extra-client.ts"), child = join(owner.root, "owned-extra-child.ts");
  writeFileSync(client, commandLease.program(`await import(${JSON.stringify(import.meta.resolve("./fake-extra-container.ts"))}); process.exit(process.exitCode ?? 0);`));
  writeFileSync(child, actorLease.program(`process.once('SIGUSR1', () => process.exit(0)); console.log('child-ready'); setInterval(() => {}, 1000); await new Promise(() => {});`));
  const unrelated = join(owner.root, "owned-unrelated-extra-control.ts");
  writeFileSync(unrelated, actorLease.program(`console.log('ready'); setInterval(() => {}, 1000); await new Promise(() => {});`));
  const actor = (entry: "extra-crash-engine.ts" | "extra-checkpoint-crash.ts") => {
    owner.check();
    const file = join(owner.root, "owned-" + entry);
    writeFileSync(file, actorLease.program(`await import(${JSON.stringify(import.meta.resolve("./" + entry))});`, entry === "extra-checkpoint-crash.ts" ? { monitor: "worker" } : undefined));
    return file;
  };
  return { client, child, unrelated, actor, capture: <T extends Started>(start: () => T) => captureExtraActor(owner, start) };
}

/** Capture the actual starter/handle and drain its output before any fixture disposal. */
function captureExtraActor<T extends Started>(owner: EngineCaseOwner, start: () => T) {
  const started = Promise.withResolvers<{ process: T; stdout?: ReadableStream<Uint8Array>; stderr: Promise<string>; drained: Promise<void> }>();
  void started.promise.catch(() => undefined);
  let native: T | undefined;
  owner.onStop(async () => {
    const observed = await started.promise.then(actor => ({ actor }), error => ({ error }));
    if (!native) {
      if ("error" in observed) throw observed.error;
      throw new Error("The actor starter did not publish a native handle; root retained");
    }
    const actor = "actor" in observed ? observed.actor : undefined;
    const stopped = await stopOwnedProcess(native, { graceMs: 1, forceMs: CLEANUP_MS * SLOW - 1 }, (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); });
    if (stopped !== "confirmed") throw new Error("The captured extra-validation actor did not confirm native termination; root retained");
    if (actor) await actor.drained;
    if ("error" in observed) throw observed.error;
  });
  let result: { process: T; stdout?: ReadableStream<Uint8Array>; stderr: Promise<string>; drained: Promise<void> } | undefined;
  let failure: { error: unknown } | undefined;
  const preparing = owner.prepare(async () => {
    try {
      owner.check();
      const process = native = start(), output = process.stdout?.tee();
      const stdout = output ? new Response(output[1]).text() : Promise.resolve("");
      const stderr = process.stderr ? new Response(process.stderr).text() : Promise.resolve("");
      const drained = completeAll([process.exited.then(() => undefined), stdout.then(() => undefined), stderr.then(() => undefined)]).then(() => undefined);
      void drained.catch(() => undefined); void stderr.catch(() => undefined);
      result = { process, ...(output ? { stdout: output[0] } : {}), stderr, drained };
      started.resolve(result);
      await drained;
    } catch (error) { failure = { error }; started.reject(error); throw error; }
  });
  void preparing.catch(() => undefined);
  if (failure) throw failure.error;
  if (!result) throw new Error("The extra-validation actor did not synchronously publish its actual handle");
  return result;
}

async function prepareExtraFixture(owner: EngineCaseOwner, options: EngineOptions = {}) {
  const root = owner.root;
  const actors = await extraActors(owner);
  owner.check();
    const service = join(root, "service"); mkdirSync(service);
    const data = join(root, "data");
    const settings: EngineOptions = { agentCommand: () => { throw new Error("Extra-validation controls must not start agents"); }, containerTool: [process.execPath, actors.client, service, `--fixture-child=${actors.child}`],
      extraCleanupEveryMs: 60_000, ...options };
    const engine = owner.open(data, settings); engine.setPoolPaused(true);
    const product = await makeProduct(root);
    owner.check();
    const productId = await engine.addProduct(product);
    const add = () => owner.prepare(async () => {
      const task = engine.task(engine.addTask({ productId, title: "Required platform acceptance", backlog: true }))!;
      task.held = true; task.startedAt = Date.now();
      const scope = executionFor(task);
      scope.work.worktree = engine.s.products.find(product => product.id === productId)!.path;
      scope.work.savedVersion = { commit: await git(scope.work.worktree!, "rev-parse", "HEAD"), tree: await git(scope.work.worktree!, "rev-parse", "HEAD^{tree}") };
      beginAgentStep(task, "tester", "sol-high", Date.now(), engine.s.roles, undefined, scope.work);
      // Stay in Backlog through async setup, then use a checkpoint that also survives restart.
      engine.raise(task, "delivery", "Waiting for required platform validation", false);
      return task;
    });
    const task = await add();
    const coordination = new Coordination(engine);
    const request = (requestId: string, argv = ["probe", "hold"], taskId = task.id) => ({ taskId, name: "Required Linux suite", reason: "Explicit platform acceptance", image: "local:ready", argv, requestId });
    const submit = (reference: string, argv?: string[], taskId?: string) => owner.prepare(async () => {
      const reply = await coordination.call("validation.run", request(reference, argv, taskId));
      expect(reply.outcome).toBe("pending");
      return reply.validation as ExtraValidation;
    });
    const started = async (record: ExtraValidation, during?: Promise<unknown>) => waitFor(() => existsSync(join(service, "started", record.id)), "owned container to start", undefined, { during });
    const release = (record: ExtraValidation) => process.kill(JSON.parse(readFileSync(join(service, "started", record.id), "utf8")).pid, "SIGUSR1");
    const finished = async (record: ExtraValidation) => {
      await waitFor(() => engine.extraValidations.get(record.requestId)?.outcome === "completed", "extra evidence to finish");
      return engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
    };
    return { root, data, settings, service, engine, productId, task, add, coordination, request, submit, started, release, finished, owner, actors };
}

export type ExtraFixture = Awaited<ReturnType<typeof prepareExtraFixture>>;

/** Every setup and consumer callback belongs to the same canonical Engine case. */
export function extraFixture<T>(owner: EngineCaseOwner, body: (fixture: ExtraFixture) => Promise<T>, options: EngineOptions = {}): Promise<T> {
  return owner.prepare(async () => {
    const fixture = await prepareExtraFixture(owner, options);
    owner.check();
    return body(fixture);
  });
}

export function connection(f: ExtraFixture) {
  const token = "isolated-extra-validation-connection-key";
  f.owner.check();
  const server = serve(f.engine, { port: 0, token });
  f.owner.onStop(() => server.stop(true));
  writeConnection(f.data, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
  return { server, client: new EngineClient(f.data, () => { throw new Error("This connection must not launch an engine"); }) };
}

type PrelaunchSave = "admission" | "start evidence" | "log registration";
export function failPrelaunchSave(owner: EngineCaseOwner, engine: Engine, id: string, phase: PrelaunchSave, failures: number) {
  const commit = engine.commitNow.bind(engine), evidence = engine.saveExtraValidationTask.bind(engine);
  const failure = new Error(`${phase} disk unavailable`);
  let remaining = failures, injected = false;
  const fail = () => { injected = true; remaining--; throw failure; };
  owner.check();
  const save = spyOn(engine, "commitNow");
  owner.onStop(() => save.mockRestore());
  save.mockImplementation((...args) => {
    const record = engine.s.extraValidations?.find(record => record.id === id);
    if (remaining && record && (injected ? record.result === "not run"
      : phase === "admission" ? record.state === "preparing" && !record.container
      : phase === "log registration" && record.state === "running" && !!record.run)) fail();
    return commit(...args);
  });
  owner.check();
  const note = spyOn(engine, "saveExtraValidationTask");
  owner.onStop(() => note.mockRestore());
  note.mockImplementation((...args) => {
    evidence(...args);
    if (remaining && !injected && phase === "start evidence" && args[0] === id
      && engine.s.extraValidations?.find(record => record.id === id)?.state === "running") fail();
  });
  return { failure, get remaining() { return remaining; }, get injected() { return injected; }, restore() { save.mockRestore(); note.mockRestore(); } };
}
