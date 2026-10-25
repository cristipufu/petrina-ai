// @vitest-environment node
import { notificationFixture } from "../../fixtures/notifications";
import { beforeEach, describe, expect, it } from "vitest";
import { type InboxItem, type InboxKind } from "@petrina/core";
import { ALREADY_HANDLED, canLand, landingFor, planJump } from "../../../src/notify/jump";

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

describe("a click on a notification", () => {
  it("opens at once when nothing is open, and closes a task sheet with nothing typed", () => {
    expect(planJump({ dialog: false, sheet: false, sheetTyped: false })).toEqual({ closeSheet: false, sheetHolds: false, wait: false });
    expect(planJump({ dialog: false, sheet: true, sheetTyped: false })).toEqual({ closeSheet: true, sheetHolds: false, wait: false });
  });

  it("waits for New task or Add product to close, finished or cancelled, keeping what was typed", () => {
    const plan = planJump({ dialog: true, sheet: false, sheetTyped: false });
    expect(plan).toEqual({ closeSheet: false, sheetHolds: false, wait: true });
    expect(canLand({ dialog: true, sheet: false }, plan.sheetHolds)).toBe(false);
    expect(canLand({ dialog: false, sheet: false }, plan.sheetHolds)).toBe(true);
  });

  it("waits for a task sheet with an unsent message or note, and only for that", () => {
    const plan = planJump({ dialog: false, sheet: true, sheetTyped: true });
    expect(plan).toEqual({ closeSheet: false, sheetHolds: true, wait: true });
    expect(canLand({ dialog: false, sheet: true }, plan.sheetHolds)).toBe(false);
    expect(canLand({ dialog: false, sheet: false }, plan.sheetHolds)).toBe(true);
    // New task over a sheet with something typed: both have to close.
    const both = planJump({ dialog: true, sheet: true, sheetTyped: true });
    expect(canLand({ dialog: false, sheet: true }, both.sheetHolds)).toBe(false);
  });

  it("lands on the item while it waits, and says 'Already handled' when it no longer does", () => {
    const waiting = item("question");
    expect(landingFor({ kind: "item", id: waiting.id }, [waiting])).toEqual({ item: waiting });
    // Handled here, in another window, or its task was cancelled, even while a dialog held the jump.
    expect(landingFor({ kind: "item", id: waiting.id }, [])).toEqual({ note: ALREADY_HANDLED });
  });

  it("never guesses: a summary, or a click the system cannot trace, opens the inbox with nothing selected", () => {
    const waiting = item("question");
    expect(landingFor({ kind: "inbox" }, [waiting])).toEqual({});
  });
});
