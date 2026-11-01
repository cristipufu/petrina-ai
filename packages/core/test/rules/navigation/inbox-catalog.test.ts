import { describe, expect, it } from "vitest";
import {
  countableInboxItems,
  decisionsForInboxItem,
  INBOX_CATALOG,
  INBOX_KINDS,
  notifiableInboxItem,
  Simulator,
  type InboxItem,
} from "../../../src/index.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

describe("INBOX_CATALOG contracts", () => {
  it("covers every InboxKind and keeps quiet screen requests out of badge counts and notifications", () => {
    expect(Object.keys(INBOX_CATALOG).sort()).toEqual([...INBOX_KINDS].sort());
    const items: InboxItem[] = INBOX_KINDS.map((kind, index) => ({
      id: `item-${index}`,
      taskId: "task-1",
      kind,
      title: kind,
      at: index,
      blocking: false,
    }));
    expect(countableInboxItems(items).map((item) => item.kind)).not.toContain("screen");
    expect(countableInboxItems(items)).toHaveLength(INBOX_KINDS.length - 1);
    expect(items.filter(notifiableInboxItem).map((item) => item.kind)).not.toContain("screen");
    expect(items.filter(notifiableInboxItem).map((item) => item.kind)).not.toContain("driving");
    expect(INBOX_CATALOG.driving.visibility.showInSession).toBe(false);
    expect(INBOX_CATALOG.driving.visibility.showInOverview).toBe(true);
    expect(decisionsForInboxItem("maintenance-settings")).toEqual(["inbox.maintenance-settings"]);
  });

  it("routes Simulator.approve on maintenance-settings to resolveMaintenanceSettings('keep')", () => {
    const initial = stateFixture();
    const task = taskFixture(initial, {
      id: "maint-task",
      state: "needs-you",
      maintenance: {
        routineId: "routine-1",
        routineName: "Nightly audit",
        scheduledAt: initial.now,
        queuedAt: initial.now,
        zone: "UTC",
        focus: "Security",
        role: initial.roles[0]!,
        profile: initial.profiles[0]!,
        input: "Audit",
        product: initial.products[0]!,
        settingsDecision: { requested: "high", actual: "medium", at: initial.now },
      },
    });
    const sim = new Simulator({
      ...initial,
      tasks: [task],
      inbox: [
        {
          id: "maint-item",
          taskId: task.id,
          kind: "maintenance-settings",
          title: "Keep reported agent settings?",
          at: initial.now,
          blocking: true,
        },
      ],
    });

    sim.approve("maint-item");
    const updated = sim.getState();
    expect(updated.inbox.some((item) => item.id === "maint-item")).toBe(false);
    const updatedTask = updated.tasks.find((entry) => entry.id === task.id)!;
    expect(updatedTask.maintenance?.settingsDecision?.choice).toBe("keep");
    expect(updatedTask.state).not.toBe("needs-you");
  });
});
