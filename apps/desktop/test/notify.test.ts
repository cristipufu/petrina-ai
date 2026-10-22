import { beforeEach, describe, expect, it } from "vitest";
import { createDemoState, historyItem, reviewStats, type InboxItem, type InboxKind, type State } from "@petrina/core";
import { ALREADY_HANDLED, canLand, landingFor, planJump } from "../src/notify/jump";
import { InboxWatch, Notifier, PAUSE_MS, type NotifierHost } from "../src/notify/notifier";
import { getSettings, sendTest, setNotificationsOn } from "../src/notify/settings";
import { noticeFor, plainWords, summaryOf, waitingLine, whoAsks, type Notice } from "../src/notify/words";

const demo = createDemoState(1_000_000_000);
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

/** A clock the tests move by hand. */
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

/** A window for the notifier: in front or away, notifications on or off, and what it was shown. */
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it.each(["failed", "interrupted", "passing", "outdated", "outdated-failed", "outdated-interrupted"] as const)("keeps %s check decisions consistent in notifications and in-app messages", (result) => {
  const failed = result.endsWith("failed"), interrupted = result.endsWith("interrupted");
  const task = { ...guestCheckout, findings: [], acceptanceUnverified: false, checks: { at: 1, current: !result.startsWith("outdated"), results: [{ name: "Tests", command: "tests", ms: 1, output: "original result", ok: !failed && !interrupted, ...(interrupted ? { interruption: { source: "macOS power log" as const, at: 0, event: "Sleep" } } : {}) }] } };
  const decision = item("delivery");
  const state = { ...demo, tasks: [task], inbox: [decision] };
  const words = failed ? "checks still failing, your call" : interrupted ? "checks unverified, your call" : "a task is ready to ship";
  expect(noticeFor(decision, state).title).toBe(`Petrina: ${words}`);
  expect(waitingLine(decision, state)).toContain(words);
  const shared = { ...task, repositories: [{ productId: demo.products[0]!.id, delivery: "local" as const, completedStages: [], checks: task.checks }, { productId: demo.products[1]!.id, delivery: "local" as const, completedStages: [], checks: { at: 1, results: [{ name: "Build", command: "build", ms: 1, ok: true, output: "pass" }] } }] };
  expect(noticeFor(decision, { ...state, tasks: [shared] }).title).toBe(`Petrina: ${words}`);
});

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

  it("names up to two tasks in a summary", () => {
    const items = [item("question"), item("plan", { taskId: darkMode.id }), item("stuck", { taskId: giftCards.id }), item("question", { taskId: darkMode.id })];
    const summary = summaryOf(items, withInbox(items));
    expect(summary.title).toBe("4 more things need you");
    expect(summary.lines).toEqual(["Guest checkout, Dark mode and 1 more task"]);
    expect(summaryOf(items.slice(0, 2), withInbox(items)).lines).toEqual(["Guest checkout and Dark mode"]);
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

describe("the test notification", () => {
  it("a Mac test that is still waiting never goes out once notifications are switched off", async () => {
    setNotificationsOn(true);
    const sent: string[] = [];
    let release = () => undefined as void;
    const waiting = sendTest(async () => sent.push("test"), 5000, () => new Promise<void>((resolve) => (release = resolve)));
    setNotificationsOn(false);
    release();
    expect(await waiting).toBe("off");
    expect(sent).toEqual([]);
    expect(getSettings().on).toBe(false);
  });

  it("goes out after the wait while notifications stay on", async () => {
    setNotificationsOn(true);
    const sent: string[] = [];
    expect(await sendTest(async () => sent.push("test"), 5000, async () => undefined)).toBe("sent");
    expect(sent).toEqual(["test"]);
  });
});

describe("wording", () => {
  it("keeps a finished learning's task and product names from the historical inbox summary", () => {
    const archived = { ...guestCheckout, state: "done" as const };
    const learning = item("learnings");
    const state: State = { ...demo, tasks: demo.tasks.filter((task) => task.id !== archived.id), inbox: [learning], history: { revision: 1, total: 1, products: [], reviews: reviewStats([]), reviewsByProduct: {}, steps: [], dependencies: [{ ...historyItem(archived), blocksDependents: false }] } };
    expect(noticeFor(learning, state).lines).toEqual(["Guest checkout, Shop"]);
    expect(waitingLine(learning, state)).toContain("Guest checkout");
  });
  it("says what is needed, for which task and product, and which role asks", () => {
    const permission = item("permission", { title: "Add a new package: Stripe.js", detail: "npm install @stripe/stripe-js", roleId: "builder", body: "Claude Code's own safety check wants your OK before this." });
    const notice = noticeFor(permission, withInbox([permission]));
    expect(notice.title).toBe("Builder needs your permission");
    expect(notice.lines).toEqual(["Add a new package: Stripe.js", "Guest checkout, Shop"]);
    expect(notice.target).toEqual({ kind: "item", id: permission.id });
  });

  it("says Petrina when the item records no agent, and never a blank name", () => {
    const stuck = item("stuck", { title: "“Guest checkout” is stuck", body: "Error: ENOENT /Users/me/secret/.env at https://internal.example.com/build" });
    const notice = noticeFor(stuck, withInbox([stuck]));
    expect(notice.title).toBe("Petrina: Guest checkout is stuck");
    expect(notice.lines).toEqual(["Shop"]);
    // The error text of a stuck task stays in the app.
    expect(JSON.stringify(notice)).not.toMatch(/ENOENT|secret|https?:|example\.com/);

    const unknownRole = item("question", { roleId: "nobody-here" });
    expect(whoAsks(unknownRole, demo)).toBe("Petrina");
    const blankRole = { ...demo, roles: demo.roles.map((role) => (role.id === "builder" ? { ...role, name: "   " } : role)) };
    expect(whoAsks(item("question", { roleId: "builder" }), blankRole)).toBe("Petrina");
  });

  it("words each kind of item", () => {
    const by = (kind: InboxKind, roleId?: string) => noticeFor(item(kind, roleId ? { roleId } : {}), demo);
    expect(by("question", "architect").title).toBe("Architect has a question");
    expect(by("permission", "builder").title).toBe("Builder needs your permission");
    expect(by("plan").title).toBe("Petrina: a plan needs your OK");
    expect(by("design").title).toBe("Petrina: a design needs your check");
    expect(by("disagreement").title).toBe("Petrina: the architects need your call");
    expect(by("delivery").title).toBe("Petrina: a task is ready to ship");
    expect(by("stuck").title).toBe("Petrina: Guest checkout is stuck");
    expect(by("shipping").title).toBe("Petrina: shipping a task was interrupted");
    for (const kind of ["plan", "design", "disagreement", "delivery", "shipping"] as const) expect(by(kind).lines).toEqual(["Guest checkout, Shop"]);
  });

  it("shortens long questions and turns web addresses into 'a link'", () => {
    const question = item("question", {
      roleId: "architect",
      title: `Should we follow https://example.com/guide?ref=1, the [design notes](https://notes.example.com/x) or www.other.org/page? ${"More context here. ".repeat(12)}`,
    });
    const [line] = noticeFor(question, withInbox([question])).lines;
    expect(line).toMatch(/^Should we follow a link, the design notes or a link\? More context/);
    expect(line).not.toMatch(/https?:|www\.|example|other\.org/);
    expect(Array.from(line!).length).toBeLessThanOrEqual(140);
    expect(line!.endsWith("…")).toBe(true);
    expect(plainWords("See docs.example.com/setup.", 80)).toBe("See a link.");
    expect(plainWords("Add a new package: Stripe.js", 80)).toBe("Add a new package: Stripe.js");
  });

  it("turns every kind of address into 'a link': bare domains, local addresses and IP addresses", () => {
    const hidden: [string, string][] = [
      ["Should I use example.com?", "Should I use a link?"],
      ["Deploy to staging.shop.example.co.uk now", "Deploy to a link now"],
      ["Is EXAMPLE.COM ours?", "Is a link ours?"],
      ["Preview at my-app.vercel.app", "Preview at a link"],
      ["Is `api.example.dev` right?", "Is a link right?"],
      ["Open localhost:3000/checkout.", "Open a link."],
      ["Is localhost fine?", "Is a link fine?"],
      ["Use host.docker.internal:5432 or printer.local:631", "Use a link or a link"],
      ["Server at 127.0.0.1:8080", "Server at a link"],
      ["Try 192.168.1.20.", "Try a link."],
      ["Admin at 10.0.0.1/admin", "Admin at a link"],
      ["Use [::1]:5173, ::1 or fe80::1", "Use a link, a link or a link"],
      ["Push to git@github.com:shop/web.git", "Push to a link"],
      ["Mail a.b@example.org.", "Mail an email address."],
      ["See [example.com](https://example.com)", "See a link"],
      ["Run x_https://evil.example", "Run a link"],
    ];
    for (const [text, said] of hidden) expect(plainWords(text, 140)).toBe(said);
    // File names, versions, times and code keep their words.
    for (const text of ["Edit README.md, setup.py, main.rs and run.sh", "Use node.js 22 and package.json", "Is item.id a string? Use Object.is(a, b)", "Rename App.tsx:42 and .env.local", "Version 1.2.3, at 10:30:00", "Use std::vector", "Done.It works"]) {
      expect(plainWords(text, 140)).toBe(text);
    }
  });

  it("never shows the command behind a permission", () => {
    const repeats = item("permission", { roleId: "builder", title: "rm -rf build && npm ci", detail: "rm -rf build && npm ci" });
    const notice = noticeFor(repeats, withInbox([repeats]));
    expect(notice.lines[0]).toBe("It wants your OK before going ahead");
    expect(JSON.stringify(notice)).not.toContain("rm -rf");
    const plain = item("permission", { roleId: "builder", title: "Installing packages", detail: "npm install left-pad" });
    expect(JSON.stringify(noticeFor(plain, demo))).not.toContain("npm install");
  });

  it("names what is waiting in a dialog's line", () => {
    const permission = item("permission", { title: "Add a new package: Stripe.js", roleId: "builder" });
    expect(waitingLine(permission, withInbox([permission]))).toBe("Builder needs your permission. Guest checkout");
    expect(waitingLine(item("stuck"), demo)).toBe("Petrina: Guest checkout is stuck");
  });
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
