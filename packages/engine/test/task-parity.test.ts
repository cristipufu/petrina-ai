import { afterAll, expect, it } from "bun:test";
import { Simulator, type NewTaskInput, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { removeDir, tempDir } from "./support.js";

const roots: string[] = [], engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.shutdown()));
  roots.forEach(removeDir);
});
function pair() {
  const home = tempDir("petrina-parity-"); roots.push(home);
  const engine = new Engine(home, { admissionsClosed: true, agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null, terminals: () => [] });
  engines.push(engine); engine.schedule = () => {}; engine.setPoolPaused(true);
  engine.s.products.push(
    { id: "a", name: "Shop", repo: "local/shop", tone: "blue", delivery: "local", approveDelivery: false },
    { id: "b", name: "Notes", repo: "local/notes", tone: "green", delivery: "pull-request", approveDelivery: true },
  );
  const sim = new Simulator(structuredClone(engine.getState()));
  return { engine, sim };
}
function requestView(task: Task) {
  return {
    title: task.title, description: task.description, selectedProducts: task.selectedProducts, workChoice: task.workChoice,
    approvePlan: task.approvePlan, approveDelivery: task.approveDelivery, explicitStart: task.explicitStart,
    delivery: task.delivery, state: task.state, column: task.column, held: task.held, holdsSlot: task.holdsSlot,
    statusLine: task.statusLine,
  };
}

it("keeps queue, backlog and multi-product request rules identical in the engine and demo", () => {
  const { engine, sim } = pair();
  for (const input of [
    { productId: "a", title: "  One product  ", backlog: true },
    { productId: "a", title: "Two products", worksOn: ["a", "b"].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "local" })), backlog: true, approvePlan: false },
  ] satisfies NewTaskInput[]) {
    const identified = { ...input, clientId: input.title };
    const realId = engine.addTask(identified), demoId = sim.addTask(identified);
    expect(engine.addTask(identified)).toBe(realId);
    expect(sim.addTask(identified)).toBe(demoId);
    const compare = () => expect(requestView(engine.taskDetails(realId)!)).toEqual(requestView(sim.getState().tasks.find((task) => task.id === demoId)!));
    compare();
    engine.updateBacklog(realId, { title: "Revised request", description: "  Keep this detail  " });
    sim.updateBacklog(demoId, { title: "Revised request", description: "  Keep this detail  " }); compare();
    engine.queueTask(realId); sim.queueTask(demoId); compare();
    engine.moveToBacklog(realId); sim.moveToBacklog(demoId); compare();
  }
  for (const target of [engine, sim]) {
    const before = target.getState().tasks.length;
    expect(() => target.addTask({ productId: "unknown", title: "Bad scope" })).toThrow("registered products");
    expect(() => target.addTask({ productId: "a", title: "  " })).toThrow("title");
    expect(target.getState().tasks).toHaveLength(before);
  }
});

it("keeps partial reviewer-role assignments aligned when both front ends add a reviewer", () => {
  const { engine, sim } = pair();
  const input = { productId: "a", title: "A review", backlog: true };
  const realId = engine.addTask(input), demoId = sim.addTask(input);
  const plan = {
    rationale: "Review after building", plannerProfileId: "sonnet-medium", stages: [
      { id: "review", kind: "review-chain" as const, roleId: "code-reviewer", title: "Review", maxRounds: 2, profileIds: ["sol-high", "opus-high"], roleIds: ["security-reviewer"] },
    ],
  };
  // Both callers receive the same saved plan, including a partially specified roles list.
  engine.task(realId)!.plan = structuredClone(plan);
  const state = structuredClone(sim.getState());
  const seeded = state.tasks.map((task) => task.id === demoId ? { ...task, plan } : task);
  const demo = new Simulator({ ...state, tasks: seeded });
  engine.addReviewer(realId, "review", "sol-xhigh"); demo.addReviewer(demoId, "review", "sol-xhigh");
  expect(engine.task(realId)!.plan!.stages[0]!.roleIds).toEqual(["security-reviewer", "code-reviewer", "code-reviewer"]);
  expect(JSON.stringify(engine.task(realId)!.plan)).toBe(JSON.stringify(demo.getState().tasks.find((task) => task.id === demoId)!.plan));
});
