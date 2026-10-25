import { expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, type ExtraValidation } from "@petrina/core";
import { Engine, type EngineOptions } from "./engine.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";
import { Coordination } from "../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import { EngineClient } from "./client.js";
import { serve } from "../src/server.js";
import { writeConnection } from "../src/instance.js";
import { completeAll } from "@petrina/core";

/** Owned writable state for every extra-validation test, including failed setup and replaced engines. */
export class ExtraFixtures {
  readonly roots: string[] = [];
  readonly engines: Engine[] = [];
  async close(): Promise<void> {
    await completeAll(this.engines.splice(0).map(engine => engine.shutdown()));
    for (const root of this.roots.splice(0)) removeDir(root);
  }
  async fixture(options: EngineOptions = {}) {
    const root = tempDir("petrina-extra-"); this.roots.push(root);
    const service = join(root, "service"); mkdirSync(service);
    const data = join(root, "data");
    const settings: EngineOptions = { agentCommand: () => { throw new Error("Extra-validation controls must not start agents"); }, containerTool: [process.execPath, join(import.meta.dir, "fake-extra-container.ts"), service],
      extraCleanupEveryMs: 60_000, ...options };
    const engine = new Engine(data, settings); this.engines.push(engine); engine.setPoolPaused(true);
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
}

export function connection(f: Awaited<ReturnType<ExtraFixtures["fixture"]>>) {
  const token = "isolated-extra-validation-connection-key";
  const server = serve(f.engine, { port: 0, token });
  writeConnection(f.data, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
  return { server, client: new EngineClient(f.data, () => { throw new Error("This connection must not launch an engine"); }) };
}

type PrelaunchSave = "admission" | "start evidence" | "log registration";
export function failPrelaunchSave(engine: Engine, id: string, phase: PrelaunchSave, failures: number) {
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
