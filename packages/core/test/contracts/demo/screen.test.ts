import { describe, expect, it } from "vitest";
import { createDemoState, createPortfolioDemo, DEMO_TRIGGERS } from "../../../src/demo.js";

import type { Task } from "../../../src/model.js";
import { inboxOrder } from "../../../src/navigation.js";

import { onScreen } from "../../../src/screen.js";

import { Simulator } from "../../../src/sim.js";

const task = (sim: Simulator, id: string): Task => sim.getState().tasks.find((entry) => entry.id === id)!;

describe("the demo", () => {
  it("shows a builder waiting for the screen with its reason, listed last in the inbox, and Allow now continues it", () => {
    const state = createDemoState(1_000_000_000);
    const waiting = state.tasks.find((entry) => entry.screen)!;
    expect(waiting.title).toBe("Quick note window opens behind others");
    expect(waiting.state).toBe("waiting");
    expect(waiting.holdsSlot).toBe(false);
    expect(waiting.statusLine).toBe(`Needs the screen for: ${DEMO_TRIGGERS["quick-note|builder|1|3"]!.title}`);
    expect(inboxOrder(state).at(-1)).toMatchObject({ kind: "screen", taskId: waiting.id, blocking: false });

    const sim = new Simulator(state, { triggers: DEMO_TRIGGERS });
    sim.allowScreen(waiting.id);
    expect(task(sim, waiting.id).state).toBe("running");
    expect(onScreen(sim.getState().tasks)?.id).toBe(waiting.id);

    const portfolio = createPortfolioDemo(1_000_000_000).state;
    expect(portfolio.tasks.filter((entry) => entry.screen && entry.state === "waiting")).toHaveLength(1);
    expect(portfolio.inbox.filter((item) => item.kind === "screen")).toHaveLength(1);
  });
});
