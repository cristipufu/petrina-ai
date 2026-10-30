import { installPreparedProduct, privateCloneProduct } from "./fixtures/prepared-product.js";
import type { EngineCaseOwner } from "./fixtures/engine-cases.js";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { createHash } from "node:crypto";
import { CLEANUP_MS, type Started } from "@petrina/test-support/commands";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { expect, spyOn } from "bun:test";
import { join } from "node:path";
import { beginAgentStep, type ExtraValidation } from "@petrina/core";
import type { Engine, EngineOptions } from "./engine.js";
import { makeProduct, SLOW, waitFor } from "./fixtures.js";
import { commitVersion } from "@petrina/repositories/git";
import { Coordination } from "../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import { EngineClient } from "./client.js";
import { serve } from "../src/server.js";
import { writeConnection } from "../src/instance.js";
import { completeAll } from "@petrina/core";
import { RUN_LABEL } from "../src/extra-container.js";
import { privateContainerCall, scriptedContainerControl, scriptedContainerInspection } from "./fixtures/container-inspection.js";
import { preparedValidationSnapshots } from "./fixtures/validation-snapshots.js";
import { installSharedWorkflowFastPaths, readWorktreeCommit } from "./fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "./scripted-probes.js";

/** Native actors keep the original bodies/payloads; their lease precedes runnable work. */
export async function extraActors(owner: EngineCaseOwner, useActorLease = true, useCommandLease = true) {
  let commandLease: ProcessLease | undefined;
  const actorReady = Promise.withResolvers<ProcessLease | undefined>();
  void actorReady.promise.catch(() => undefined);
  owner.afterBody(async () => { await commandLease?.close(); });
  owner.onStop(() => {
    // Request every actual Engine before closing the actors' independent lease. Command
    // clients keep their separate lease until Engine ps/stop/rm work has really settled.
    const stopped = (async () => { await owner.stopAll(); })();
    const actors = (async () => { await (await actorReady.promise)?.close(); })();
    return Promise.allSettled([stopped, actors]).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Extra-validation Engine and independent actor cleanup failed");
    });
  });
  let actorLease: ProcessLease | undefined;
  try {
    if (useCommandLease) {
      commandLease = await createProcessLease();
      owner.check();
    }
    if (useActorLease) {
      actorLease = await createProcessLease();
      owner.check();
    }
    actorReady.resolve(actorLease);
  } catch (error) { actorReady.reject(error); throw error; }
  const client = join(owner.root, "owned-extra-client.ts");
  if (commandLease) {
    writeFileSync(client, commandLease.program(`await import(${JSON.stringify(import.meta.resolve("./fake-extra-container.ts"))}); process.exit(process.exitCode ?? 0);`));
  }
  const child = actorLease ? join(owner.root, "owned-extra-child.ts") : undefined;
  if (actorLease && child) {
    writeFileSync(child, actorLease.program(`process.once('SIGUSR1', () => process.exit(0)); console.log('child-ready'); setInterval(() => {}, 1000); await new Promise(() => {});`));
  }
  const unrelatedPath = actorLease ? join(owner.root, "owned-unrelated-extra-control.ts") : undefined;
  if (actorLease && unrelatedPath) {
    writeFileSync(unrelatedPath, actorLease.program(`console.log('ready'); setInterval(() => {}, 1000); await new Promise(() => {});`));
  }
  const actor = (entry: "extra-crash-engine.ts" | "extra-checkpoint-crash.ts") => {
    if (!actorLease) throw new Error("Enable actorLease on ExtraFixturePolicy when spawning independent actors");
    owner.check();
    const file = join(owner.root, "owned-" + entry);
    writeFileSync(file, actorLease.program(`await import(${JSON.stringify(import.meta.resolve("./" + entry))});`, entry === "extra-checkpoint-crash.ts" ? { monitor: "worker" } : undefined));
    return file;
  };
  return {
    client,
    get child(): string {
      if (!child) throw new Error("Enable actorLease on ExtraFixturePolicy when spawning independent child actors");
      return child;
    },
    get unrelated(): string {
      if (!unrelatedPath) throw new Error("Enable actorLease on ExtraFixturePolicy when spawning unrelated actors");
      return unrelatedPath;
    },
    hasActorLease: Boolean(actorLease),
    actor,
    capture: <T extends Started>(start: () => T) => captureExtraActor(owner, start),
  };
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

function patchFastClientStop(eng: Engine): Engine {
  installSharedWorkflowFastPaths(eng, { fastCheckCapture: true });
  const container = eng.extraValidations["container"];
  const origStop = container["stopClient"].bind(container);
  const groupOrPidAlive = (pid: number) => {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 0);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EPERM") return true;
      }
    }
    return false;
  };
  container["stopClient"] = async (record) => {
    const pid = record.clientPid;
    if (!pid || !groupOrPidAlive(pid)) return true;
    for (const target of [-pid, pid]) {
      try { process.kill(target, "SIGKILL"); } catch {}
    }
    const deadline = Date.now() + 250;
    while (Date.now() < deadline) {
      if (!groupOrPidAlive(pid)) return true;
      await Bun.sleep(5);
    }
    return origStop(record);
  };
  return eng;
}

export interface ExtraFixturePolicy {
  fastClientStop?: boolean;
  actorLease?: boolean;
  commandLease?: boolean;
  scriptedNonHoldRuns?: boolean;
}

export function scriptedExtraCheckRunner(clientPath: string, serviceDir: string, prev?: EngineOptions["runCheckCommand"]): NonNullable<EngineOptions["runCheckCommand"]> {
  return async (req) => {
    if (prev) {
      const prior = await prev(req);
      if (prior) return prior;
    }
    if (req.argv[0] !== process.execPath || req.argv[1] !== clientPath || req.argv[2] !== serviceDir) {
      return undefined;
    }
    const raw = req.argv.slice(3);
    let args = raw[0]?.startsWith("--fixture-child=") ? raw.slice(1) : raw;
    while (args[0] === "--host" || args[0] === "--config") args = args.slice(2);
    if (args[0] !== "run") return undefined;
    const mode = args.at(-1);
    if (mode?.startsWith("hold")) return undefined;
    let reply: string | undefined;
    try {
      reply = privateContainerCall(serviceDir, args);
    } catch (error) {
      return { code: 1, ...(error instanceof Error && error.message ? { stderr: `${error.message}\n` } : {}) };
    }
    if (reply !== undefined) {
      return { code: 0, ...(reply ? { stdout: `${reply}\n` } : {}) };
    }
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const labels = args.flatMap((word, index) => (word === "--label" ? [args[index + 1]!] : []));
    const name = value("--name");
    const id = labels.find((label) => label.startsWith(`${RUN_LABEL}=`))!.split("=")[1]!;
    const snapshot = value("--mount").match(/src=(.*),dst=/)?.[1];
    if (!snapshot) throw new Error("The private snapshot mount is required");
    const record = { args, labels, pid: process.pid, childPid: undefined, id, name, snapshot };
    writeFileSync(`${join(serviceDir, "started", id)}.tmp`, JSON.stringify(record));
    renameSync(`${join(serviceDir, "started", id)}.tmp`, join(serviceDir, "started", id));
    return {
      code: mode === "fail" ? 1 : 0,
      stdout: `Original complete diagnostic for ${id}\nOriginal ending for ${id}\n`,
    };
  };
}

async function prepareExtraFixture(owner: EngineCaseOwner, options: EngineOptions = {}, preparedCopies = false, serviceControls = false, policy: ExtraFixturePolicy = {}) {
  if (preparedCopies && options.validationSnapshots) throw new Error("Choose either the prepared copy input or an explicit validation snapshot effect");
  const root = owner.root;
  const useActorLease = policy.actorLease ?? (!serviceControls || policy.fastClientStop === false);
  const actors = await extraActors(owner, useActorLease, policy.commandLease ?? true);
  owner.check();
    const service = join(root, "service"); mkdirSync(service);
    const data = join(root, "data");
    const suppliedProduct = preparedCopies ? await makeProduct(root, { origin: "none" }) : undefined;
    owner.check();
    let snapshotProductId: string | undefined;
    const rawSnapshots = suppliedProduct ? await preparedValidationSnapshots(owner, suppliedProduct, data, () => snapshotProductId) : undefined;
    type SnapshotRecord = Parameters<NonNullable<typeof rawSnapshots>["snapshot"]>[0];
    const baseSnapshot = rawSnapshots ? async (record: SnapshotRecord) => {
      if (snapshotProductId && record.productId !== snapshotProductId && existsSync(record.source)) {
        owner.check();
        await mkdir(join(data, "extra-snapshots"), { recursive: true });
        await cp(record.source, record.snapshot, { recursive: true, force: false, errorOnExist: true });
        owner.check();
        return;
      }
      return rawSnapshots.snapshot(record);
    } : undefined;
    let currentEngine: Engine | undefined;
    const snapshots = rawSnapshots && baseSnapshot ? {
      version: rawSnapshots.version,
      snapshot: (record: SnapshotRecord) => currentEngine ? currentEngine.extraValidations["container"].snapshot(record) : baseSnapshot(record),
    } : undefined;
    owner.check();
    const containerTool = actors.hasActorLease
      ? [process.execPath, actors.client, service, `--fixture-child=${actors.child}`]
      : [process.execPath, actors.client, service];
    const nativeSettings: EngineOptions = { agentCommand: () => { throw new Error("Extra-validation controls must not start agents"); }, containerTool,
      extraCleanupEveryMs: 60_000, ...options };
    // Explicit transport/deadline overrides keep native metadata. Child fixtures serialize that
    // native recipe; in-process generations retain this process-local service observation.
    const settings: EngineOptions = { ...nativeSettings, ...(policy.scriptedNonHoldRuns ? { runCheckCommand: scriptedExtraCheckRunner(actors.client, service, options.runCheckCommand) } : {}), ...(options.toolProbe ? {} : { toolProbe: privateAgentToolProbe() }), ...(snapshots ? { validationSnapshots: snapshots } : {}),
      ...(serviceControls && !["containerControl", "containerInspection", "containerTool", "containerCommandTimeoutMs"].some(key => Object.hasOwn(options, key))
        && process.env.DOCKER_HOST === undefined && process.env.DOCKER_CONTEXT === undefined && process.env.DOCKER_CONFIG === undefined
        ? { containerControl: scriptedContainerControl(service, () => createHash("sha256").update(realpathSync(data)).digest("hex")) } : {}),
      ...(["containerInspection", "containerTool", "containerCommandTimeoutMs"].some(key => Object.hasOwn(options, key))
        || process.env.DOCKER_HOST !== undefined || process.env.DOCKER_CONTEXT !== undefined
        ? {} : { containerInspection: scriptedContainerInspection(service) }) };
    if (baseSnapshot || policy.fastClientStop) {
      const rawOpen = owner.open.bind(owner);
      owner.open = (targetData: string, targetOptions: EngineOptions = {}) => {
        const opened = rawOpen(targetData, targetOptions);
        currentEngine = opened;
        if (baseSnapshot) opened.extraValidations["container"].snapshot = baseSnapshot;
        return policy.fastClientStop ? patchFastClientStop(opened) : opened;
      };
    }
    const engine = owner.open(data, settings); engine.setPoolPaused(true);
    const product = suppliedProduct ?? await makeProduct(root, { origin: "none" });
    owner.check(); await engine.waitUntilReady(); owner.check(); engine.stopRequested.signal.throwIfAborted();
    const productId = installPreparedProduct(engine, privateCloneProduct(product));
    snapshotProductId = productId;
    const add = () => owner.prepare(async () => {
      const task = engine.task(engine.addTask({ productId, title: "Required platform acceptance", backlog: true }))!;
      task.held = true; task.startedAt = Date.now();
      const scope = executionFor(task);
      scope.work.worktree = engine.s.products.find(product => product.id === productId)!.path;
      const fast = !snapshots ? readWorktreeCommit(scope.work.worktree!) : undefined;
      const version = snapshots?.version ?? (fast ? { head: fast.commit, tree: fast.tree } : await commitVersion(scope.work.worktree!));
      owner.check();
      if (!version.head || !version.tree) throw new Error("The validation fixture has no committed version");
      scope.work.savedVersion = { commit: version.head, tree: version.tree };
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
    return { root, data, settings, nativeSettings, service, engine, productId, task, add, coordination, request, submit, started, release, finished, owner, actors };
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

/** Explicit copy input; native commands, logs, client ownership, cleanup and SQLite still execute normally. */
export function preparedExtraFixture<T>(owner: EngineCaseOwner, body: (fixture: ExtraFixture) => Promise<T>, options: EngineOptions = {}): Promise<T> {
  return owner.prepare(async () => {
    const fixture = await prepareExtraFixture(owner, options, true);
    owner.check();
    return body(fixture);
  });
}

/** Explicit private service controls; the workload, diagnostic and local client cleanup still run natively. */
export function serviceExtraFixture<T>(owner: EngineCaseOwner, body: (fixture: ExtraFixture) => Promise<T>, options: EngineOptions = {}, policy: ExtraFixturePolicy = { actorLease: false }): Promise<T> {
  return owner.prepare(async () => {
    const fixture = await prepareExtraFixture(owner, options, false, true, policy);
    owner.check();
    return body(fixture);
  });
}

/** Supplied saved-copy input plus explicit private service controls for their declared independent subjects. */
export function preparedServiceExtraFixture<T>(owner: EngineCaseOwner, body: (fixture: ExtraFixture) => Promise<T>, options: EngineOptions = {}, policy: ExtraFixturePolicy = { fastClientStop: true, actorLease: false }): Promise<T> {
  return owner.prepare(async () => {
    const fixture = await prepareExtraFixture(owner, options, true, true, policy);
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
