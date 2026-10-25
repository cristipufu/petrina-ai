import { emptyState, task } from "../../fixtures/simulator.js";
import { describe, expect, it } from "vitest";

import { Simulator } from "../../../src/sim.js";

describe("Simulator", () => {
  it("delivers a queued message at the next step and an interrupt right away", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Search", kind: "chore" });
    sim.sendMessage(id, "Keep it simple", "queue");
    expect(task(sim, id).queued).toHaveLength(1);

    sim.tick();
    expect(task(sim, id).queued).toHaveLength(0);
    expect(task(sim, id).session.some((line) => line.from === "you" && line.text === "Keep it simple")).toBe(true);

    sim.sendMessage(id, "Actually, stop and use the old icons", "interrupt");
    expect(task(sim, id).session.some((line) => line.text === "Actually, stop and use the old icons")).toBe(true);
  });

  it("sends live guidance by default while keeping the demo's active step", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Search", kind: "chore" });
    const before = task(sim, id);
    const step = before.agent?.step;
    const journey = before.journey?.at(-1)?.id;
    sim.sendMessage(id, "Keep the guest view");
    const after = task(sim, id);
    expect(after.queued).toHaveLength(1);
    expect(after.queued[0]?.deliveries?.main?.state).toBe("accepted");
    expect(after.journey?.at(-1)?.agentInputs?.at(-1)?.updates?.at(-1)).toMatchObject({ text: "Keep the guest view", delivery: "accepted" });
    expect(after.agent?.step).toBe(step);
    expect(after.journey?.at(-1)?.id).toBe(journey);
    expect(after.session.filter(line => line.text === "Keep the guest view")).toHaveLength(1);
    expect(after.session.some(line => line.text === "You interrupted the current step")).toBe(false);
    sim.tick();
    const later = task(sim, id);
    // One beat of a step that is still going must not call accepted guidance heard.
    expect(later.state).toBe("running");
    expect(later.queued.find(message => message.text === "Keep the guest view")?.deliveries?.main?.state).toBe("accepted");
    expect(later.journey?.flatMap(step => step.agentInputs ?? []).flatMap(input => input.updates ?? []).find(update => update.text === "Keep the guest view")?.delivery).toBe("accepted");
  });
});
