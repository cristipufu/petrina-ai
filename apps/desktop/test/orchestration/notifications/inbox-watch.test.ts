// @vitest-environment node
import { notificationFixture } from "../../fixtures/notifications";
import { beforeEach, describe, expect, it } from "vitest";
import { type InboxItem, type InboxKind } from "@petrina/core";
import { InboxWatch } from "../../../src/notify/notifier";

const demo = notificationFixture();

const guestCheckout = demo.tasks.find((task) => task.title === "Guest checkout")!;

let next = 0;

function item(kind: InboxKind, extra: Partial<InboxItem> = {}): InboxItem {
  next += 1;
  return { id: `inbox-${next}`, taskId: guestCheckout.id, kind, title: "Something", at: 0, blocking: false, ...extra };
}

beforeEach(() => {
  next = 0;
});

describe("what is new", () => {
  it("waits for the engine's own inbox: the empty start teaches nothing", () => {
    const watch = new InboxWatch();
    expect(watch.update([], false)).toEqual([]);
    const waiting = [item("question"), item("stuck")];
    // The first state from the engine: all of it was already waiting.
    expect(watch.update(waiting, true)).toEqual([]);
    const fresh = item("permission");
    expect(watch.update([...waiting, fresh], true)).toEqual([fresh]);
  });

  it("notifies each new item exactly once", () => {
    const watch = new InboxWatch();
    const old = item("plan");
    watch.update([old], true);
    const fresh = item("question");
    expect(watch.update([old, fresh], true)).toEqual([fresh]);
    expect(watch.update([old, fresh], true)).toEqual([]);
    // Handled, then the same state again: still never twice.
    expect(watch.update([fresh], true)).toEqual([]);
  });

  it("after the connection drops and comes back, only what arrived during the gap is new", () => {
    const watch = new InboxWatch();
    const before = [item("question"), item("design")];
    watch.update(before, true);
    // While reconnecting the window keeps the last state; then the engine sends its own again:
    // one item was handled during the gap, two arrived.
    const arrived = [item("permission"), item("stuck")];
    expect(watch.update([before[0]!, ...arrived], true)).toEqual(arrived);
    // Items Petrina already knew about are never notified again.
    expect(watch.update([before[0]!, ...arrived], true)).toEqual([]);
  });

  it("never notifies \"You're driving\": the coordinator just took over themselves", () => {
    const watch = new InboxWatch();
    watch.update([], true);
    const fresh = item("question");
    expect(watch.update([item("driving"), fresh], true)).toEqual([fresh]);
  });

  it("never notifies a screen request: it waits quietly in the inbox", () => {
    const watch = new InboxWatch();
    watch.update([], true);
    const fresh = item("question");
    expect(watch.update([item("screen"), fresh], true)).toEqual([fresh]);
  });
});
