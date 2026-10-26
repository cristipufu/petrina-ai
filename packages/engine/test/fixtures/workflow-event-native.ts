import { expect } from "bun:test";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { join } from "node:path";
import type { WorkflowEvent } from "@petrina/core";
import { Engine } from "../engine.js";
import { Coordination, type Result } from "../../src/coordination.js";
import { EngineClient } from "../client.js";
import { serve } from "../../src/server.js";
import { writeConnection } from "../../src/instance.js";
import { Fakes, makeProduct, removeDir, tempDir } from "../support.js";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";

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
  interface RootOwner { root: string; engines: Set<Engine>; servers: Set<Server>; errors: unknown[] }
  const roots = new Map<string, RootOwner>();
  const engines = new Map<Engine, { root: RootOwner; stopping?: Promise<void> }>();
  const servers = new Map<Server, { root: RootOwner; stopping?: Promise<void> }>();
  const createRoot = (prefix: string) => {
    const root = tempDir(prefix);
    registerFixtureRoot(root);
    roots.set(root, { root, engines: new Set(), servers: new Set(), errors: [] });
    return root;
  };
  const ownEngine = (root: string, engine: Engine) => {
    const owner = roots.get(root);
    if (!owner) throw new Error("The Engine's private root has no cleanup owner");
    owner.engines.add(engine); engines.set(engine, { root: owner });
    return engine;
  };
  const shutdown = (engine: Engine): Promise<void> => {
    const owner = engines.get(engine);
    if (!owner) return engine.shutdown();
    if (owner.stopping) return owner.stopping;
    const work = (async () => {
      try {
        await engine.shutdown();
        owner.root.engines.delete(engine); engines.delete(engine);
      } catch (error) { owner.root.errors.push(error); throw error; }
    })();
    owner.stopping = work;
    const clear = () => { owner.stopping = undefined; };
    void work.then(clear, clear);
    return work;
  };
  const stopServer = (server: Server): Promise<void> => {
    const owner = servers.get(server);
    if (!owner) return Promise.resolve(server.stop(true));
    if (owner.stopping) return owner.stopping;
    const work = (async () => {
      try {
        await server.stop(true);
        owner.root.servers.delete(server); servers.delete(server);
      } catch (error) { owner.root.errors.push(error); throw error; }
    })();
    owner.stopping = work;
    const clear = () => { owner.stopping = undefined; };
    void work.then(clear, clear);
    return work;
  };
  const close = async () => {
    await Promise.allSettled([
      ...[...servers.keys()].map(server => stopServer(server)),
      ...[...engines.keys()].map(engine => shutdown(engine)),
    ]);
    const errors: unknown[] = [];
    for (const owner of roots.values()) {
      if (owner.errors.length || owner.engines.size || owner.servers.size) {
        errors.push(new AggregateError(owner.errors, `Event fixture cleanup is unconfirmed; retained ${owner.root}`));
        continue;
      }
      try { removeDir(owner.root); roots.delete(owner.root); }
      catch (error) { owner.errors.push(error); errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Event fixture cleanup could not be confirmed");
  };
  const fake = join(import.meta.dir, "../fake-agent.ts");

  /** An engine that admits no agents: decisions and persistence only. */
  function fixture(options: ConstructorParameters<typeof Engine>[1] = {}) {
    const home = createRoot("petrina-events-");
    const e = ownEngine(home, new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [], ...options }));
    e.setPoolPaused(true);
    e.schedule = () => {};
    e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
    const c = new Coordination(e);
    const events = (args: Record<string, unknown>) => c.call("watch.events", args);
    return { e, c, home, events };
  }

  async function served() {
    const { e, home, events, c } = fixture();
    let server: Server | undefined;
    return setupWithCleanup(async () => {
      const token = "events-key-0123456789012345678901";
      const started = server = serve(e, { port: 0, token });
      const owner = roots.get(home)!;
      owner.servers.add(started); servers.set(started, { root: owner });
      writeConnection(home, { api: `http://127.0.0.1:${started.port}`, url: `ws://127.0.0.1:${started.port}/ws`, token, pid: process.pid });
      const client = new EngineClient(home, () => { throw new Error("A wait must never launch an engine"); });
      const taskId = e.addTask({ productId: "product", title: "Served" });
      return { e, home, events, c, server: started, client, taskId, token };
    }, async () => {
      const outcomes = await Promise.allSettled([shutdown(e), ...(server ? [stopServer(server)] : [])]);
      const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Served event fixture setup cleanup could not be confirmed");
    });
  }

  async function setup(scenario: Parameters<Fakes["scenario"]>[0]) {
    const root = createRoot("petrina-events-flow-");
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario(scenario);
    const engine = ownEngine(root, new Engine(join(root, "data"), { agentCommand: () => [process.execPath, fake, fakes.dir] }));
    return setupWithCleanup(async () => {
      const productId = await engine.addProduct(await makeProduct(root));
      engine.setProductDelivery(productId, "local", true);
      return { engine, productId, fakes, root };
    }, () => shutdown(engine));
  }

  return { fixture, served, setup, ownEngine, shutdown, stopServer, close };
}
