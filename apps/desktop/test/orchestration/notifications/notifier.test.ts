// @vitest-environment node
import { notificationFixture } from "../../fixtures/notifications";
import { beforeEach, describe, expect, it } from "vitest";
import { type InboxItem, type InboxKind, type State } from "@petrina/core";
import { Notifier, PAUSE_MS, type NotifierHost } from "../../../src/notify/notifier";
import { type Notice } from "../../../src/notify/words";

const demo = notificationFixture();

const guestCheckout = demo.tasks.find((task) => task.title === "Guest checkout")!;

const darkMode = demo.tasks.find((task) => task.title === "Dark mode")!;

const giftCards = demo.tasks.find((task) => task.title === "Gift cards")!;

let next = 0;

function item(kind: InboxKind, extra: Partial<InboxItem> = {}): InboxItem {
  next += 1;
  return { id: `inbox-${next}`, taskId: guestCheckout.id, kind, title: "Something", at: 0, blocking: false, ...extra };
}

function withInbox(inbox: readonly InboxItem[]): State {
  return { ...demo, inbox };
}

class Clock {
  now = 0;
  private timers: { at: number; run: () => void; id: number }[] = [];
  private ids = 0;
  schedule = (run: () => void, ms: number) => {
    const id = (this.ids += 1);
    this.timers.push({ at: this.now + ms, run, id });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    };
  };
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.now = due.at;
      due.run();
    }
    this.now = until;
  }
}

function setUp(options: { front?: boolean; on?: boolean; showable?: boolean } = {}) {
  const clock = new Clock();
  const world = { front: options.front ?? false, on: options.on ?? true, showable: options.showable ?? true };
  const shown: { at: number; notice: Notice }[] = [];
  const toasts: Notice[] = [];
  const host: NotifierHost = {
    inFront: () => world.front,
    canNotify: () => world.on,
    show: (notice) => {
      if (!world.showable) return false;
      shown.push({ at: clock.now, notice });
      return true;
    },
    toast: (notice) => toasts.push(notice),
    schedule: clock.schedule,
  };
  return { clock, world, shown, toasts, notifier: new Notifier(host) };
}

// The host result settles in a microtask; pacing itself uses the explicit Clock.
const flush = () => Promise.resolve();

beforeEach(() => {
  next = 0;
});

describe("what is new", () => {
  it("learns what is already waiting when the app opens: counts only, no notification and no message", () => {
    const { notifier, shown, toasts } = setUp();
    notifier.update(withInbox([item("question"), item("permission")]), true);
    expect(shown).toEqual([]);
    expect(toasts).toEqual([]);
  });
});

describe("in front or away", () => {
  it("away: a system notification; in front: the in-app message instead", () => {
    const { notifier, world, shown, toasts } = setUp();
    notifier.update(withInbox([]), true);
    const first = item("question", { title: "Opt-in first?" });
    notifier.update(withInbox([first]), true);
    expect(shown.map((entry) => entry.notice.itemIds)).toEqual([[first.id]]);
    expect(toasts).toEqual([]);

    world.front = true;
    const second = item("permission");
    notifier.update(withInbox([first, second]), true);
    expect(shown).toHaveLength(1);
    expect(toasts.map((notice) => notice.itemIds)).toEqual([[second.id]]);
  });

  it("when the shell finds Petrina in front after all, the in-app message shows instead", async () => {
    const { notifier, shown, toasts } = setUp({ showable: false });
    notifier.update(withInbox([]), true);
    const fresh = item("stuck");
    notifier.update(withInbox([fresh]), true);
    await flush();
    expect(shown).toEqual([]);
    expect(toasts.map((notice) => notice.itemIds)).toEqual([[fresh.id]]);
  });
});

describe("pacing: at most one notification every ten seconds", () => {
  it("sends the first at once, holds the rest, and sends them as one summary when the pause ends", () => {
    const { notifier, clock, shown } = setUp();
    notifier.update(withInbox([]), true);
    const a = item("question");
    notifier.update(withInbox([a]), true);
    expect(shown.map((entry) => entry.at)).toEqual([0]);

    clock.advance(2_000);
    const b = item("permission", { taskId: darkMode.id });
    notifier.update(withInbox([a, b]), true);
    clock.advance(3_000);
    const c = item("stuck", { taskId: giftCards.id });
    notifier.update(withInbox([a, b, c]), true);
    expect(shown).toHaveLength(1);

    clock.advance(PAUSE_MS - 5_000);
    expect(shown).toHaveLength(2);
    const summary = shown[1]!;
    expect(summary.at).toBe(PAUSE_MS);
    expect(summary.notice.title).toBe("2 more things need you");
    expect(summary.notice.lines).toEqual(["Dark mode and Gift cards"]);
    expect(summary.notice.itemIds).toEqual([b.id, c.id]);
    expect(summary.notice.target).toEqual({ kind: "inbox" });
  });

  it("sends a single held item as its own notification", () => {
    const { notifier, clock, shown } = setUp();
    notifier.update(withInbox([]), true);
    const a = item("question");
    const b = item("design");
    // Two at once: the first goes out, the second waits for the pause to end.
    notifier.update(withInbox([a, b]), true);
    expect(shown.map((entry) => entry.notice.itemIds)).toEqual([[a.id]]);
    clock.advance(PAUSE_MS);
    expect(shown.map((entry) => entry.notice.itemIds)).toEqual([[a.id], [b.id]]);
    expect(shown[1]!.notice.target).toEqual({ kind: "item", id: b.id });
  });

  it("never sends more than one in any ten seconds, however many arrive", () => {
    const { notifier, clock, shown } = setUp();
    const inbox: InboxItem[] = [];
    notifier.update(withInbox(inbox), true);
    for (let second = 0; second < 60; second += 1) {
      inbox.push(item("question"));
      notifier.update(withInbox([...inbox]), true);
      clock.advance(1_000);
    }
    clock.advance(PAUSE_MS);
    const times = shown.map((entry) => entry.at);
    for (let index = 1; index < times.length; index += 1) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(PAUSE_MS);
    // Every item went out exactly once, alone or inside a summary.
    const ids = shown.flatMap((entry) => entry.notice.itemIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(inbox.map((entry) => entry.id).sort());
  });

  it("drops held items that were handled meanwhile, and sends nothing when none are left", () => {
    const { notifier, clock, shown } = setUp();
    notifier.update(withInbox([]), true);
    const a = item("question");
    notifier.update(withInbox([a]), true);
    const b = item("permission");
    const c = item("plan");
    notifier.update(withInbox([a, b, c]), true);
    // b was answered, here or in another window.
    notifier.update(withInbox([a, c]), true);
    clock.advance(PAUSE_MS);
    expect(shown.map((entry) => entry.notice.itemIds)).toEqual([[a.id], [c.id]]);

    const d = item("question");
    notifier.update(withInbox([a, c, d]), true);
    notifier.update(withInbox([a, c]), true);
    clock.advance(PAUSE_MS);
    expect(shown).toHaveLength(2);
    // The pause is over and nothing waited: the next one goes out at once.
    const e = item("stuck");
    notifier.update(withInbox([a, c, e]), true);
    expect(shown.at(-1)!.notice.itemIds).toEqual([e.id]);
    expect(shown.at(-1)!.at).toBe(clock.now);
  });

  it("drops held items once Petrina comes to the front: they are in plain view", () => {
    const { notifier, clock, shown, world } = setUp();
    notifier.update(withInbox([]), true);
    const a = item("question");
    const b = item("permission");
    notifier.update(withInbox([a, b]), true);
    world.front = true;
    notifier.cameToFront();
    clock.advance(PAUSE_MS);
    expect(shown.map((entry) => entry.notice.itemIds)).toEqual([[a.id]]);
  });
});

describe("the off switch", () => {
  it("with notifications off, nothing goes to the system: in-app messages and counts still work", () => {
    const { notifier, shown, toasts } = setUp({ on: false });
    notifier.update(withInbox([]), true);
    const fresh = item("question");
    notifier.update(withInbox([fresh]), true);
    expect(shown).toEqual([]);
    expect(toasts.map((notice) => notice.itemIds)).toEqual([[fresh.id]]);
  });

  it("switching off drops what was held: nothing more goes out", () => {
    const { notifier, clock, shown, world } = setUp();
    notifier.update(withInbox([]), true);
    const a = item("question");
    const b = item("question");
    notifier.update(withInbox([a, b]), true);
    world.on = false;
    notifier.switchedOff();
    clock.advance(PAUSE_MS);
    expect(shown).toHaveLength(1);
  });
});
