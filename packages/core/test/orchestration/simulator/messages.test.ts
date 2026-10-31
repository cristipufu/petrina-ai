import { emptyState, task } from "../../fixtures/simulator.js";
import { taskFixture } from "../../fixtures/state.js";
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

  it("queues live guidance until the next turn on OpenCode while delivering live guidance on Pi", () => {
    const seed = emptyState();
    seed.tasks = [
      taskFixture(seed, {
        id: "opencode-task",
        state: "running",
        holdsSlot: true,
        agent: { roleId: "builder", profileId: "opencode-sonnet-high", since: 0, step: 0 },
      }),
      taskFixture(seed, {
        id: "pi-task",
        state: "running",
        holdsSlot: true,
        agent: { roleId: "builder", profileId: "pi-sonnet-high", since: 0, step: 0 },
      }),
    ];
    const sim = new Simulator(seed);
    sim.sendMessage("opencode-task", "Hold until next turn");
    expect(task(sim, "opencode-task").queued[0]?.deliveries?.main).toEqual({
      state: "waiting",
      reason: "unsupported",
      toolId: "opencode",
    });

    sim.sendMessage("pi-task", "Steer right now");
    expect(task(sim, "pi-task").queued[0]?.deliveries?.main).toEqual({
      state: "accepted",
      via: "live",
      toolId: "pi",
    });
  });
});
