import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { join } from "node:path";
import { completeAll, displayTask, type DeepMutable, type State } from "@petrina/core";
import { Store } from "@petrina/storage/store";
import { directDrivers } from "./direct-drivers.js";
import { installPreparedProduct } from "./prepared-product.js";
import { coordinator, itemOf, makeProduct, taskOf, traceTaskWait, until, tempDir } from "../support.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { checkAgents, type CheckScript } from "./check-agents.js";
import { checkCommand } from "./check-command.js";
import { checksPrepared } from "./checks-prepared.js";

export type CheckWorkflowStart = "workflow" | "built";

/** Real Git, checks, SQLite, restarts and driver composition; provider replies use the shared session interface. */
async function prepareWorkflow(entry: CheckWorkflowStart, root: string, lifetime: ReturnType<typeof directDrivers>, available: () => void, approveDelivery = true, scenario: CheckScript = { planner: "short" }, extra?: { checkArgs?: string[] } | string) {
  // Check-command options, or a trace label when a wait needs one.
  const checkOptions = typeof extra === "string" || extra == null ? {} : extra;
  const trace = typeof extra === "string" ? extra : undefined;
  const agents = checkAgents();
  agents.scenario(scenario);
  const { log, command, runs } = checkCommand(root);
  const options = { startAgentSession: agents.start,
    agentCommand: () => [process.execPath, join(import.meta.dir, "..", "unconfigured-service.ts"), "check workflow"],
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" },
      antigravity: { status: "logged-out" }, gh: { status: "unknown" }, git: { status: "ready" }, node: { status: "ready" } }),
  };
  const repo = await makeProduct(root);
  available();
  let engine = lifetime.open(join(root, "data"), options);
  const productId = installPreparedProduct(engine, { id: "clone", name: "Clone", repo: "local/clone", tone: "blue", path: repo,
    remote: join(root, "origin.git"), defaultBranch: "main", delivery: "local", approveDelivery: true });
  engine.setProductDelivery(productId, "local", approveDelivery);
  const setCheck = (...args: string[]) => engine.setProductChecks(productId, [{ name: "Welcome", command: command(...args) }]);
  setCheck(...(checkOptions.checkArgs ?? []));
  const taskId = entry === "built" ? await checksPrepared(engine, root, productId, scenario, available)
    : engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  let started = entry === "workflow", deliveryWaits = 0;
  const start = () => {
    available();
    if (started) return;
    started = true;
    engine.setPoolPaused(false); engine.schedule();
  };
  return {
    agents, repo, taskId, productId, root, log, command, setCheck,
    get engine() { return engine; },
    runs, start,
    run: <T>(start: () => Promise<T>) => { available(); return lifetime.run(engine, start); },
    delivery: () => {
      start();
      const generation = engine;
      return lifetime.run(generation, () => traceTaskWait(trace ? `${trace}: delivery ${++deliveryWaits}` : undefined, () => generation.getState(), taskId,
        () => until(generation, (state) => !!itemOf(state, taskId, "delivery"), coordinator(["plan"])).then((state) => taskOf(state, taskId))));
    },
    restart: (edit?: (state: DeepMutable<State>) => void) => lifetime.prepare(async () => {
      available();
      await lifetime.stop(engine);
      available();
      if (edit) {
        const store = new Store(join(root, "data", "petrina.db"));
        let failure: { error: unknown } | undefined;
        try {
          const loaded = store.load()!;
          const state = { ...loaded, tasks: loaded.tasks.map(displayTask) };
          edit(state as DeepMutable<State>);
          store.save(state);
        } catch (error) { failure = { error }; }
        try { store.close(); } catch (error) {
          if (failure) throw new AggregateError([failure.error, error], "Saved fixture edit and Store close failed");
          throw error;
        }
        if (failure) throw failure.error;
      }
      available();
      engine = lifetime.open(join(root, "data"), options);
    }),
  };
}

export type CheckWorkflow = Awaited<ReturnType<typeof prepareWorkflow>>;

/** Each root is registered before native setup; the file fallback also owns a timed-out callback. */
export function checkWorkflowFixtures() {
  const active = new Map<ReturnType<typeof directDrivers>, string>(), retained = new Set<string>();
  let closing = false;
  const closeOwner = (owner: ReturnType<typeof directDrivers>, root: string) => {
    const stopped = owner.close();
    void stopped.then(() => active.delete(owner), () => { active.delete(owner); retained.add(root); });
    return stopped;
  };
  async function use<T>(entry: CheckWorkflowStart, body: (fixture: CheckWorkflow) => Promise<T>, approveDelivery = true, scenario: CheckScript = { planner: "short" }, extra?: { checkArgs?: string[] } | string): Promise<T> {
    if (closing) throw new Error("Check workflow fixtures are closing");
    const root = tempDir("petrina-check-failure-"), owner = directDrivers(root);
    active.set(owner, root);
    let closed = false;
    const close = () => { closed = true; return closeOwner(owner, root); };
    const available = () => { if (closed || closing) throw new Error("Check workflow fixture is closing"); };
    const value = await setupWithCleanup(() => owner.prepare(async () => {
      const fixture = await prepareWorkflow(entry, root, owner, available, approveDelivery, scenario, extra);
      available();
      return body(fixture);
    }), close);
    await close();
    return value;
  }
  async function close(): Promise<void> {
    closing = true;
    await completeAll([...active].map(([owner, root]) => closeOwner(owner, root)));
  }
  return { use, close, retained };
}
