import { installPreparedProduct, privateCloneProduct } from "./prepared-product.js";
import { expect } from "bun:test";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { join } from "node:path";
import type { WorkflowEvent } from "@petrina/core";
import type { Engine } from "../engine.js";
import { engineCaseFixtures, type EngineCaseOwner } from "./engine-cases.js";
import { Coordination, type Result } from "../../src/coordination.js";
import { EngineClient } from "../client.js";
import { serve } from "../../src/server.js";
import { writeConnection } from "../../src/instance.js";
import { Fakes, makeProduct } from "../support.js";
import { fakeAgentSessions } from "./fake-agent-sessions.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";
import { privateAgentToolProbe } from "../scripted-probes.js";

export const kinds = (result: Result) => (result.events as WorkflowEvent[]).map((event) => event.kind);
export const all = (result: Result) => result.events as WorkflowEvent[];
export async function drain(c: Coordination, args: Record<string, unknown>): Promise<WorkflowEvent[]> {
    const collected: WorkflowEvent[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await c.call("watch.events", { ...args, limit: 100, timeoutMs: 0, ...(cursor ? { cursor } : { from: "oldest" }) });
      expect(page.outcome).toBe("completed");
      collected.push(...all(page));
      if (!page.more) return collected;
      cursor = String(page.cursor);
    }
  }

export function createWorkflowEventFixtures() {
  type Server = ReturnType<typeof serve>;
  const cases = engineCaseFixtures();
  const fake = join(import.meta.dir, "../fake-agent.ts");

  /** An engine that admits no agents: decisions and persistence only. */
  function fixture(owner: EngineCaseOwner, options: ConstructorParameters<typeof Engine>[1] = {}) {
    const home = owner.root;
    const e = owner.open(home, { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), usageCommands: { codex: null, grok: null }, terminals: () => [], ...options });
    e.setPoolPaused(true);
    e.schedule = () => {};
    e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
    const c = new Coordination(e);
    const events = (args: Record<string, unknown>) => owner.run(e, () => c.call("watch.events", args));
    return { e, c, home, events, owner };
  }

  async function served(owner: EngineCaseOwner) {
    const { e, home, events, c } = fixture(owner);
    let server: Server | undefined;
    const stopServer = owner.onStop(async () => { await server?.stop(true); });
    return setupWithCleanup(async () => {
      owner.check();
      const token = "events-key-0123456789012345678901";
      const started = server = serve(e, { port: 0, token });
      writeConnection(home, { api: `http://127.0.0.1:${started.port}`, url: `ws://127.0.0.1:${started.port}/ws`, token, pid: process.pid });
      const client = new EngineClient(home, () => { throw new Error("A wait must never launch an engine"); });
      const taskId = e.addTask({ productId: "product", title: "Served" });
      return { e, home, events, c, server: started, client, taskId, token, owner, stopServer };
    }, async () => {
      const outcomes = await Promise.allSettled([owner.stop(e), stopServer()]);
      const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Served event fixture setup cleanup could not be confirmed");
    });
  }

  async function setup(owner: EngineCaseOwner, scenario: Parameters<Fakes["scenario"]>[0]) {
    const root = owner.root;
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario(scenario);
    const engine = owner.open(join(root, "data"), { agentCommand: () => [process.execPath, fake, fakes.dir], startAgentSession: fakeAgentSessions(fakes), toolProbe: privateAgentToolProbe() });
    installSharedWorkflowFastPaths(engine, {
      skipUpToDate: true,
      skipPrepareChecks: true,
      skipReviewCopies: true,
      fastCheckCapture: true,
      fastCleanup: true,
    });
    return setupWithCleanup(() => owner.run(engine, async () => {
      owner.check();
      const repo = await makeProduct(root); owner.check();
      const productId = installPreparedProduct(engine, privateCloneProduct(repo)); owner.check();
      engine.setProductDelivery(productId, "local", true);
      return { engine, productId, fakes, root, owner };
    }), () => owner.stop(engine));
  }

  return { fixture, served, setup, use: cases.use, close: cases.close };
}
