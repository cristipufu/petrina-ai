// @vitest-environment node
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { notificationFixture } from "../../fixtures/notifications";
import { setupObservation } from "../../fixtures/check-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { checkProblem, recordedCheckBatch, historyItem, reviewStats, type CheckRun, type InboxItem, type InboxKind, type State } from "@petrina/core";
import { noticeFor, plainWords, summaryOf, waitingLine, whoAsks } from "../../../src/notify/words";

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

/** Modeled complete records for the intentional modern-pass branch, never native qualification. */
function modernSetup(productId: string, checks: { at: number; current?: boolean; results: readonly CheckRun[] }) {
  const before = setupObservation(productId, 0, 100), after = setupObservation(productId, 0, 200); after.position = "after-checks";
  return { checkSetup: after, checks: { ...checks, at: 200, sha: after.input.sha, tree: after.input.tree, definition: after.input.definition,
    results: checks.results.map(run => ({ ...run, executor: after.executor })), environment: { ...after.identity!, setupAttempts: { before: before.id, after: after.id } } } };
}

it.each(["failed", "interrupted", "passing", "outdated", "outdated-failed", "outdated-interrupted", "missing"] as const)("keeps %s check decisions consistent in notifications and in-app messages", (result) => {
  const failed = result.endsWith("failed"), interrupted = result.endsWith("interrupted");
  const checks = { at: 1, current: !result.startsWith("outdated"), results: [{ name: "Tests", command: "tests", ms: 1, output: "original result", ok: !failed && !interrupted, execution: completeCheckExecution(failed || interrupted ? 7 : 0), ...(interrupted ? { interruption: { source: "macOS power log" as const, at: 0, event: "Sleep" } } : {}) }] };
  const task = { ...guestCheckout, findings: [], acceptanceUnverified: false, checks, ...(result === "passing" ? modernSetup(guestCheckout.productId, checks) : {}) };
  const decision = item("delivery");
  const state = { ...demo, tasks: [task], inbox: [decision] };
  const words = failed ? "checks still failing, your call" : interrupted || result.startsWith("outdated") || result === "missing" ? "checks unverified, your call" : "a task is ready to ship";
  expect(noticeFor(decision, state).title).toBe(`Petrina: ${words}`);
  expect(waitingLine(decision, state)).toContain(words);
  const companion = { at: 1, results: [{ name: "Build", command: "build", ms: 1, ok: true, execution: completeCheckExecution(0), output: "pass" }] };
  const shared = { ...task, repositories: [
    { productId: demo.products[0]!.id, delivery: "local" as const, completedStages: [], checks: task.checks, ...(result === "passing" ? { checkSetup: task.checkSetup } : {}) },
    { productId: demo.products[1]!.id, delivery: "local" as const, completedStages: [], checks: companion, ...(result === "passing" ? modernSetup(demo.products[1]!.id, companion) : {}) },
  ] };
  expect(noticeFor(decision, { ...state, tasks: [shared] }).title).toBe(`Petrina: ${words}`);
});

beforeEach(() => {
  next = 0;
});

describe("pacing: at most one notification every ten seconds", () => {
  it("names up to two tasks in a summary", () => {
    const items = [item("question"), item("plan", { taskId: darkMode.id }), item("stuck", { taskId: giftCards.id }), item("question", { taskId: darkMode.id })];
    const summary = summaryOf(items, withInbox(items));
    expect(summary.title).toBe("4 more things need you");
    expect(summary.lines).toEqual(["Guest checkout, Dark mode and 1 more task"]);
    expect(summaryOf(items.slice(0, 2), withInbox(items)).lines).toEqual(["Guest checkout and Dark mode"]);
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

  it("matches InboxAsk headlines when a review decision or requested proof gap is pending", () => {
    const outdated = {
      at: 1,
      current: false,
      results: [{ name: "Tests", command: "tests", ms: 1, output: "ok", ok: true, execution: completeCheckExecution(0) }],
    };
    const reviewTask = {
      ...guestCheckout,
      checks: outdated,
      reviewDecision: { stageId: "review", round: 3, accepted: false },
      findings: [
        {
          id: "f1",
          text: "Blocking bug",
          severity: "blocking" as const,
          status: "open" as const,
          raisedBy: "opus-high",
          confirmedBy: [],
          round: 3,
        },
      ],
    };
    const decision = item("delivery");
    expect(noticeFor(decision, { ...demo, tasks: [reviewTask], inbox: [decision] }).title).toBe(
      "Petrina: review rounds ran out with blocking findings open, your call",
    );

    const passing = modernSetup(guestCheckout.productId, {
      at: 1,
      current: true,
      results: [{ name: "Tests", command: "tests", ms: 1, output: "ok", ok: true, execution: completeCheckExecution(0) }],
    });
    const proofTask = {
      ...guestCheckout,
      ...passing,
      findings: [],
      acceptanceUnverified: false,
      proofRequests: [
        {
          id: "p1",
          text: "Screenshot of checkout",
          reason: "Visual confirmation",
          productIds: [guestCheckout.productId],
          requestedBy: { stageId: "review", round: 1, seat: "reviewer:1", roleId: "code-reviewer", profileId: "opus-high" },
          reviewedVersions: { [guestCheckout.productId]: "abc1234" },
          ownerStageId: "test",
          status: "pending" as const,
          source: "review:1:0",
        },
      ],
    };
    expect(noticeFor(decision, { ...demo, tasks: [proofTask], inbox: [decision] }).title).toBe(
      "Petrina: requested proof needs your call",
    );
  });
});

for (const outcome of ["published-pass", "published-fail", "unfinished-fail"] as const) it(`notifies only the remaining delivery authority for ${outcome}, while raw history stays intact`, () => {
  const run = (code: number): CheckRun => ({ name: "Tests", command: "tests", ms: 1, ok: code === 0, output: "Original recorded diagnostic", execution: completeCheckExecution(code) });
  const published = { productId: demo.products[0]!.id, delivery: "pull-request" as const, completedStages: [],
    ...modernSetup(demo.products[0]!.id, { at: 1, current: false, results: [run(outcome === "published-pass" ? 0 : 7)] }),
    pr: { number: 7, url: "https://github.com/acme/shop/pull/7", state: "open" as const, openedAt: 200 },
    checkSetupInvalidated: { id: "published-old-declaration", kind: "requirements-changed" as const, at: 250 } };
  const remaining = { productId: demo.products[1]!.id, delivery: "local" as const, completedStages: [],
    ...modernSetup(demo.products[1]!.id, { at: 1, current: true, results: [run(outcome === "unfinished-fail" ? 7 : 0)] }) };
  const task = { ...guestCheckout, findings: [], acceptanceUnverified: false, repositories: [published, remaining] };
  const decision = item("delivery"), state = { ...demo, tasks: [task], inbox: [decision] }, original = JSON.stringify(published);
  expect(recordedCheckBatch(remaining).kind).toBe(outcome === "unfinished-fail" ? "product-failed" : "passed");
  expect(checkProblem(task)).toBe(outcome === "published-pass" ? "unverified" : "failing");
  const words = outcome === "unfinished-fail" ? "checks still failing, your call" : "a task is ready to ship";
  expect(noticeFor(decision, state).title).toBe(`Petrina: ${words}`);
  expect(waitingLine(decision, state)).toContain(words);
  expect(JSON.stringify(published)).toBe(original);
});
