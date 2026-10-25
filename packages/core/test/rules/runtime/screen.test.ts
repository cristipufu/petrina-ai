import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";

import { onScreen, screenNext, screenQueue, screenReason, screenWait } from "../../../src/screen.js";

const REASON = "Click through the quick note window";

describe("the screen switch", () => {
  it.each(["waiting", "needs-you"] as const)("keeps an unapproved held request answerable while %s without putting it in the screen line", (taskState) => {
    const { state, ids } = waitingScreenRequests(1);
    const held = state.tasks.find(task => task.id === ids[0])!;
    held.state = taskState;
    held.runtimeWait = { after: ["fix"], reason: "Wait for the fix", changes: [] };
    expect(screenWait(held, state, state.now)).toBe("ask");
    expect(screenQueue(state.tasks)).toEqual([]);
    expect(screenNext(state, state.now)).toBeUndefined();
    held.screen!.allowed = true;
    expect(screenWait(held, state, state.now)).toBeUndefined();
    expect(screenQueue(state.tasks)).toEqual([]);
    expect(screenNext(state, state.now)).toBeUndefined();
    held.runtimeWait.releasedAt = state.now;
    expect(screenNext(state, state.now)).toBe(held.id);
  });

  it("keeps a held request out of the screen line and restores its saved place when released", () => {
    const { state: initial } = waitingScreenRequests(2);
    const state = { ...initial, tasks: initial.tasks.map(task => ({ ...task })), pool: { ...initial.pool, screen: { mode: "on" as const } } };
    const [first, second] = screenQueue(state.tasks);
    expect(screenNext(state, state.now)).toBe(first!.id);
    Object.assign(first!, { runtimeWait: { after: ["fix"], reason: "Wait for the fix", changes: [] } });
    expect(screenQueue(state.tasks).map(task => task.id)).toEqual([second!.id]);
    expect(screenNext(state, state.now)).toBe(second!.id);
    expect(screenWait(first!, state, state.now)).toBeUndefined();
    Object.assign(first!.runtimeWait!, { releasedAt: state.now });
    expect(screenNext(state, state.now)).toBe(first!.id);
    // A currently admitted screen agent retains exclusive use until the engine records its boundary.
    Object.assign(first!, { state: "running", runtimeWait: { after: ["fix"], reason: "Wait for the fix", changes: [] }, screen: { ...first!.screen!, granted: true } });
    expect(onScreen(state.tasks)?.id).toBe(first!.id);
    expect(screenNext(state, state.now)).toBeUndefined();
  });

  it("keeps an agent's reason on one short line", () => {
    expect(screenReason("  Click the menu\n  bar icon ")).toBe("Click the menu bar icon");
    expect(screenReason("x".repeat(400))).toHaveLength(160);
  });
});
function waitingScreenRequests(count: number) {
  const state = stateFixture({ now: 100 });
  const ids = Array.from({ length: count }, (_, index) => 'screen-' + index);
  state.tasks = ids.map((id, index) => taskFixture(state, { id, state: 'waiting', screen: { at: index, reason: REASON, roleId: 'builder', profileId: 'opus-high' } }));
  return { state, ids };
}
