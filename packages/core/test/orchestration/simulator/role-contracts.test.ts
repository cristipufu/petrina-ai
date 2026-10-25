import { describe, expect, it } from "vitest";
import { workflowFixture } from "../../fixtures/workflow.js";

import { Simulator } from "../../../src/sim.js";
import { JOURNEY_WORDS as W } from "../../../src/journey.js";

import type { Role } from "../../../src/model.js";

const { state: initial } = workflowFixture();

const custom = (result: Role["result"]) => ({ ...initial.roles.find(role => role.result === result)!, id: `custom-${result}`, name: `Custom ${result}`, added: true });

describe("role contracts and queued work", () => {
  it.each(["pull-request", "release"] as const)("runs custom build/checks/delivery roles through the demo for %s", delivery => {
    const roles = [...initial.roles, custom("build"), custom("checks"), custom("delivery")];
    const simulator = new Simulator({ ...initial, roles, tasks: [], inbox: [], pool: { ...initial.pool, paused: true } });
    const id = simulator.addTask({ productId: initial.products[0]!.id, title: "Custom workflow", kind: "chore", delivery, approvePlan: false, approveDelivery: false });
    const task = simulator.getState().tasks.find(task => task.id === id)!;
    Object.assign(task, { state: "waiting", stageIndex: 0, fixing: true, plan: { rationale: "Custom roles", plannerProfileId: "opus-high", stages: ["build", "checks", "delivery"].map(result => ({ id: result, roleId: `custom-${result}`, kind: "do", title: result, profileIds: ["opus-high"] })) }, findings: [{ id: "bug", text: "A confirmed bug", severity: "blocking", status: "open", raisedBy: "opus-high", confirmedBy: [] }] });
    simulator.setPoolPaused(false);
    for (let tick = 0; tick < 100 && !["done", "pr-open"].includes(simulator.getState().tasks[0]!.state); tick++) simulator.tick();
    const finished = simulator.getState().tasks[0]!;
    expect(["done", "pr-open"]).toContain(finished.state);
    expect(finished.findings[0]!.status).toBe("fixed");
    expect(finished.journey!.find(step => step.roleId === "custom-build")?.outcome).toBe("Changes returned; 1 fix claimed");
    expect(finished.journey!.find(step => step.roleId === "custom-checks")?.outcome).toBe(W.checks(0, finished.brief?.acceptance.length ?? 0));
    expect(finished.journey!.some(step => step.kind === "agent" && step.roleId === "custom-delivery")).toBe(delivery === "release");
  });
});
