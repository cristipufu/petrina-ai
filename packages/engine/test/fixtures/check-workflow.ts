import { join } from "node:path";
import { displayTask, type DeepMutable, type State } from "@petrina/core";
import { Store } from "@petrina/storage/store";
import { Engine } from "../engine.js";
import { coordinator, itemOf, makeProduct, taskOf, traceTaskWait, until } from "../support.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { checkAgents, type CheckScript } from "./check-agents.js";
import { checkCommand } from "./check-command.js";

/** Real Git, checks, SQLite, restarts and driver composition; provider replies use the shared session interface. */
export async function checkWorkflow(root: string, approveDelivery = true, scenario: CheckScript = { planner: "short" }, extra?: { checkArgs?: string[] } | string) {
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
  let engine = new Engine(join(root, "data"), options);
  try {
    const repo = await makeProduct(root);
    const productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "local", approveDelivery);
    const setCheck = (...args: string[]) => engine.setProductChecks(productId, [{ name: "Welcome", command: command(...args) }]);
    setCheck(...(checkOptions.checkArgs ?? []));
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
    let deliveryWaits = 0;
    return {
      agents, repo, taskId, productId, root, log, command, setCheck,
      get engine() { return engine; },
      runs,
      delivery: () => traceTaskWait(trace ? `${trace}: delivery ${++deliveryWaits}` : undefined, () => engine.getState(), taskId,
        () => until(engine, (state) => !!itemOf(state, taskId, "delivery"), coordinator(["plan"])).then((state) => taskOf(state, taskId))),
      async restart(edit?: (state: DeepMutable<State>) => void) {
        await engine.shutdown();
        if (edit) {
          const store = new Store(join(root, "data", "petrina.db"));
          try {
            const loaded = store.load()!;
            const state = { ...loaded, tasks: loaded.tasks.map(displayTask) };
            edit(state as DeepMutable<State>);
            store.save(state);
          } finally { store.close(); }
        }
        engine = new Engine(join(root, "data"), options);
      },
    };
  } catch (error) { await engine.shutdown(); throw error; }
}
