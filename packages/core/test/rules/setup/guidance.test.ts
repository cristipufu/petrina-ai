import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";

import type { InboxItem, InboxKind, RunState, State } from "../../../src/model.js";
import { inboxSummary } from "../../../src/navigation.js";
import { firstTaskTip } from "../../../src/setup.js";

function afterFirstRun(options: { approvePlan: boolean; state?: RunState; stageIndex?: number; asks?: InboxKind[] }): State {
  const demo = stateFixture({ now: 1_000_000 });
  demo.tasks = [taskFixture(demo)];
  const task = { ...demo.tasks[0]!, approvePlan: options.approvePlan, state: options.state ?? "running", stageIndex: options.stageIndex ?? -1 };
  const inbox = (options.asks ?? []).map((kind, index): InboxItem => ({ id: `ask-${index}`, taskId: task.id, kind, title: kind, at: 1, blocking: false }));
  return { ...demo, tasks: [task], inbox, setup: { done: true, platform: "darwin", checks: [], firstTaskId: task.id } };
}

describe("the board's first-task tip", () => {
  it("follows Show me the plan first", () => {
    expect(firstTaskTip(afterFirstRun({ approvePlan: true }))).toMatchObject({ text: expect.stringContaining("will arrive in Needs you for your approval"), toInbox: true });
    expect(firstTaskTip(afterFirstRun({ approvePlan: true, state: "needs-you", asks: ["plan"] }))?.text).toContain("is waiting in Needs you for your approval");
    const started = firstTaskTip(afterFirstRun({ approvePlan: false }));
    expect(started).toMatchObject({ text: expect.stringContaining("The squad has started"), toInbox: false });
    expect(started?.text).not.toMatch(/approv/);
    // Approved: no plan still to come.
    expect(firstTaskTip(afterFirstRun({ approvePlan: true, stageIndex: 0 }))?.text).toContain("You approved the plan");
  });

  it("promises no plan while the first task is stuck", () => {
    for (const approvePlan of [true, false]) {
      for (const stuck of [afterFirstRun({ approvePlan, state: "failed", asks: ["stuck"] }), afterFirstRun({ approvePlan, asks: ["stuck"] }), afterFirstRun({ approvePlan, state: "failed" })]) {
        const tip = firstTaskTip(stuck)!;
        expect(tip.text).toContain("is stuck");
        expect(tip.text).not.toMatch(/plan|approv|has started/i);
        expect(tip.toInbox).toBe(true);
      }
    }
  });

  it("says nothing once dismissed, or once the first task is finished", () => {
    const dismissed = afterFirstRun({ approvePlan: true });
    expect(firstTaskTip({ ...dismissed, setup: { ...dismissed.setup!, tipDismissed: true } })).toBeUndefined();
    for (const state of ["done", "cancelled", "pr-open"] as const) expect(firstTaskTip(afterFirstRun({ approvePlan: true, state }))).toBeUndefined();
  });
});

describe("the line under Needs you", () => {
  const item = (kind: InboxKind, blocking = false): InboxItem => ({ id: kind, taskId: "t", kind, title: kind, at: 1, blocking });

  it("never says nobody is stuck next to a Stuck item", () => {
    expect(inboxSummary([item("stuck")])).toBe("1 task is stuck until you act on it.");
    expect(inboxSummary([item("stuck"), item("plan")])).toBe("1 task is stuck until you act on it. The rest wait at checkpoints.");
    expect(inboxSummary([item("question", true), item("stuck"), item("stuck")])).toBe("1 agent is waiting on you. 2 tasks are stuck until you act on them.");
    for (const items of [[item("stuck")], [item("stuck"), item("plan")], [item("question", true), item("stuck")]]) expect(inboxSummary(items)).not.toMatch(/nobody is stuck/i);
  });

  it("keeps its words when nothing is stuck", () => {
    expect(inboxSummary([])).toBe("You're not blocking anyone.");
    expect(inboxSummary([item("plan")])).toBe("Nobody is stuck. These wait at checkpoints.");
    expect(inboxSummary([item("question", true), item("plan")])).toBe("1 agent is waiting on you. The rest wait at checkpoints.");
  });

  it("does not call a screen request a checkpoint", () => {
    expect(inboxSummary([item("screen")])).toBe("You're not blocking anyone.");
    expect(inboxSummary([item("plan"), item("screen")])).toBe("Nobody is stuck. These wait at checkpoints.");
    expect(inboxSummary([item("question", true), item("screen")])).toBe("1 agent is waiting on you.");
  });
});
