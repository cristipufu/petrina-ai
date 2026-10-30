// A synthetic demo squad: three made-up products and a board with work in every state.
// Tasks are fast-forwarded through the real simulator, so their histories (and the work
// log behind every usage number) are consistent.

import type { InboxItem, Product, State, Task, TaskKind } from "./model.js";
import type { SimQuirk, Trigger } from "./sim.js";
import { MemoryWorkLog } from "./worklog.js";
import {
  addHistory, attachSampleFollowUps, baseState, byId, demoClones, demoUsage, fastForward,
  queuedTask, recordProducts, recordUsageHistory, remembered, trackingStart, waitingFor,
  DEMO_PRODUCTS, DEMO_TRIGGERS, DemoBuilder, MINUTE, type Demo, type Spec,
} from "./demo-builder.js";
export { demoClones, DEMO_PRODUCTS, DEMO_TRIGGERS, type Demo };

/** Quirks on the board's own tasks: helpers, a second model, a settings mismatch, a turn without tokens. */
const DEMO_QUIRKS: Readonly<Record<string, SimQuirk>> = {
  "guest-checkout|design-reviewer": { toolId: "codex", ran: { model: "gpt-6.1", name: "gpt-6.1", effort: "medium" } },
  "guest-checkout|builder": { toolId: "codex", helpers: 2 },
  "login-loop|builder": { toolId: "claude-code", extraModel: "claude-haiku-5-5" },
  "sentry|code-reviewer": { toolId: "codex", noTokens: true },
};

/** The demo board as it looks when the app opens at `now`, with thirty days of history behind it. */
export function createDemo(now: number): Demo {
  return remembered(`board:${now}`, () => buildDemo(now));
}

function buildDemo(now: number): Demo {
  const since = trackingStart(now);
  const builder = new DemoBuilder(now, since);
  const quirks: Record<string, SimQuirk> = { ...DEMO_QUIRKS };
  const place = (
    id: string,
    ago: number,
    until: (task: Task, inbox: readonly InboxItem[]) => boolean,
    priority: number
  ) => builder.place(
    fastForward(
    byId(id),
    until,
    DEMO_TRIGGERS,
    DEMO_PRODUCTS,
    quirks
  ),
    now,
    ago,
    priority
  );

  addHistory(builder, DEMO_PRODUCTS, quirks);
  place("guest-checkout", 2 * MINUTE, (_task, items) => items.some((item) => item.kind === "permission"), 100);
  // Mid-step: its to-do item "Trying to prove done wrong", with its first action under it.
  place("login-loop", 0, (task) => task.column === "reviewing" && task.sub === 0 && (task.agent?.step ?? 0) === 5, 101);
  place("dark-mode", 4 * MINUTE, (_task, items) => items.some((item) => item.kind === "question"), 102);
  place("gift-cards", 6 * MINUTE, (_task, items) => items.some((item) => item.kind === "disagreement"), 107);
  place("quick-note", 3 * MINUTE, (_task, items) => items.some((item) => item.kind === "screen"), 108);
  place("weekly-digest", 9 * MINUTE, (_task, items) => items.some((item) => item.kind === "plan"), 103);
  place("pricing-refresh", 26 * MINUTE, (_task, items) => items.some((item) => item.kind === "delivery"), 104);
  place("sentry", 3 * 60 * MINUTE, (task) => task.cleanup?.removedAt !== undefined, 105);
  place("footer-typo", 26 * 60 * MINUTE, (task) => task.state === "done", 106);

  // The coordinator sent back what every reviewer passed: the Guide keeper offers a point for the review guide.
  const sentry = builder.tasks.find((task) => task.title === "Report errors to Sentry");
  if (sentry) {
    builder.inbox.push({
      id: "guide-offer",
      taskId: sentry.id,
      kind: "guide",
      title: "Add a point to Shop's review guide?",
      body: "Every error report leaves out personal data such as email addresses.",
      detail: "The reviewers checked that errors were sent, not what they carried: the first reports included customers' email addresses.",
      roleId: "guide-keeper",
      profileId: "opus-high",
      at: now - 2 * 60 * MINUTE,
      blocking: false,
    });
  }

  // What agents learned on the way, offered for the Learnings section of AGENTS.md.
  const pricing = builder.tasks.find((task) => task.title === "Refresh the pricing page");
  if (pricing) {
    builder.inbox.push({
      id: "learnings-offer",
      taskId: pricing.id,
      kind: "learnings",
      title: "What agents learned about Shop",
      body: "- Run the checkout tests with STRIPE_MOCK=1: without it they call the real test API and take minutes.\n- Prices come from config/plans.yml; never hard-code them in components.",
      detail: "From the Builder and the Code reviewer. What you add joins the Learnings section of AGENTS.md with the next delivery. Claude Code and Codex both read that file by themselves, whether Petrina starts them or you do.",
      roleId: "builder",
      profileId: "opus-xhigh",
      at: now - 25 * MINUTE,
      blocking: false,
    });
  }

  ["export-pdf", "onboarding", "tag-search", "stripe-retries"].forEach((id, priority) => {
    const task = queuedTask(byId(id), priority, now - (40 - priority * 7) * MINUTE);
    // Search by tag builds on the dark theme, so it waits for Dark mode to land.
    const darkMode = builder.tasks.find((entry) => entry.id === "dark-mode")!;
    builder.tasks.push(id === "stripe-retries" ? {
      ...task,
      held: true,
      statusLine: "On hold"
    } : id === "tag-search" ? waitingFor(
      task,
      darkMode,
      task.createdAt + MINUTE
    ) : task);
  });

  recordProducts(builder.log, DEMO_PRODUCTS, now);
  recordUsageHistory(builder.log, now);
  attachSampleFollowUps(builder.tasks, DEMO_PRODUCTS, now);
  const state: State = { ...baseState(now, builder.tasks, builder.inbox), seq: 10_000, work: { version: 1, since } };
  return { state, triggers: DEMO_TRIGGERS, log: builder.log, open: builder.openWork(), quirks };
}

/** The demo board as it looks when the app opens at `now`. */
export function createDemoState(now: number): State {
  return createDemo(now).state;
}

// ── A portfolio: twenty products, to see how the app holds up at scale ───────────────────

const PORTFOLIO_NAMES = [
  "Shop", "Notes", "Site", "Billing", "Mobile app", "Admin console", "Docs", "Blog", "CRM", "Analytics",
  "Help desk", "Status page", "Marketplace", "Payments API", "Search", "Auth service", "Email", "Data pipeline", "Design system", "Partner portal",
];

const TONES: readonly Product["tone"][] = ["blue", "green", "orange", "violet", "pink", "teal", "indigo", "purple", "amber", "slate"];

const PORTFOLIO_WORK: readonly { title: string; area: string; kind: TaskKind; description: string }[] = [
  { title: "Saved carts", area: "saved carts", kind: "feature", description: "Keep a cart for a week so people can come back to it." },
  { title: "Fix slow first load", area: "first load", kind: "bug", description: "The first page takes four seconds on phones." },
  { title: "Yearly plans", area: "yearly plans", kind: "feature", description: "Offer a yearly plan with two months free." },
  { title: "Team invites", area: "team invites", kind: "feature", description: "Invite teammates by email with a role." },
  { title: "Fix broken CSV export", area: "CSV export", kind: "bug", description: "Exports cut off after a thousand rows." },
  { title: "Two-factor sign-in", area: "two-factor sign-in", kind: "feature", description: "Optional codes from an authenticator app." },
  { title: "Update the brand colours", area: "brand colours", kind: "chore", description: "Use the new palette everywhere." },
  { title: "Usage dashboard", area: "the usage dashboard", kind: "new", description: "A page that shows usage per month and per teammate." },
  { title: "Refund flow", area: "refunds", kind: "feature", description: "Let support refund an order in two clicks." },
  { title: "Fix timezone bug in reports", area: "reports", kind: "bug", description: "Reports use UTC instead of the account's timezone." },
  { title: "Dark mode", area: "dark mode", kind: "feature", description: "A dark theme everywhere." },
  { title: "Webhook retries", area: "webhooks", kind: "bug", description: "Retry failed webhooks with backoff." },
];

type Target =
  | "queued" | "held" | "design-running" | "build-running" | "review-running" | "question" | "permission" | "screen"
  | "plan-gate" | "design-gate" | "delivery-gate" | "pr-open" | "done";

/** What each task in the portfolio is doing when the app opens. At most eight hold a slot. */
const PORTFOLIO_TARGETS: readonly Target[] = [
  "build-running", "review-running", "design-running", "question", "build-running", "permission", "review-running",
  "plan-gate", "design-gate", "delivery-gate", "delivery-gate", "design-gate", "plan-gate", "delivery-gate",
  "pr-open", "pr-open", "pr-open", "done", "done", "done", "done", "done", "done",
  "queued", "queued", "queued", "queued", "queued", "held", "queued", "queued", "queued", "queued", "queued", "held", "queued", "queued",
  "screen",
];

const reach: Record<Exclude<Target, "queued" | "held">, (task: Task, inbox: readonly InboxItem[]) => boolean> = {
  // Running agents are caught after an action under a to-do item.
  "design-running": (task) => task.column === "designing" && task.state === "running" && (task.agent?.step ?? 0) >= 2,
  "build-running": (task) => task.column === "building" && task.state === "running" && (task.agent?.step ?? 0) >= 2,
  "review-running": (task) => task.column === "reviewing" && task.state === "running" && (task.agent?.step ?? 0) >= 2,
  question: (_task, inbox) => inbox.some((item) => item.kind === "question"),
  permission: (_task, inbox) => inbox.some((item) => item.kind === "permission"),
  screen: (_task, inbox) => inbox.some((item) => item.kind === "screen"),
  "plan-gate": (_task, inbox) => inbox.some((item) => item.kind === "plan"),
  "design-gate": (_task, inbox) => inbox.some((item) => item.kind === "design"),
  "delivery-gate": (_task, inbox) => inbox.some((item) => item.kind === "delivery"),
  "pr-open": (task) => task.state === "pr-open",
  done: (task) => task.state === "done",
};

/** Twenty made-up products with work spread across them. Products 16 to 19 are quiet. */
export function createPortfolioDemo(now: number): Demo {
  return remembered(`portfolio:${now}`, () => buildPortfolioDemo(now));
}

function buildPortfolioDemo(now: number): Demo {
  const products: Product[] = PORTFOLIO_NAMES.map((name, index) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    repo: `acme/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    tone: TONES[index % TONES.length]!,
    delivery: index % 3 === 0 ? "pull-request" : index % 3 === 1 ? "release" : "local",
    approveDelivery: index % 3 !== 2,
  }));
  const triggers: Record<string, Trigger> = {};
  const since = trackingStart(now);
  const builder = new DemoBuilder(now, since);
  const quirks: Record<string, SimQuirk> = {
    "p0|builder": { toolId: "codex", helpers: 1 },
    "p1|code-reviewer": { toolId: "codex", ran: { model: "gpt-6.1", name: "gpt-6.1", effort: "medium" } },
    "p4|builder": { toolId: "claude-code", extraModel: "claude-haiku-5-5" },
  };
  const tasks = builder.tasks;
  let queuePosition = 0;
  addHistory(builder, products.slice(0, 16), quirks);

  PORTFOLIO_TARGETS.forEach((target, index) => {
    const product = products[(index * 7) % 16]!;
    const work = PORTFOLIO_WORK[index % PORTFOLIO_WORK.length]!;
    const id = `p${index}`;
    const kind: TaskKind = target === "design-running" || target === "design-gate" || target === "question" ? "feature" : work.kind;
    const spec: Spec = {
      id, productId: product.id, title: work.title, description: work.description, area: work.area, kind,
      approvePlan: target === "plan-gate" || (target === "done" && kind === "new"),
      // A full journey: plan and design checks, a send-back, and release notes before Petrina publishes.
      ...(target === "done" && kind === "new" ? { delivery: "release" as const } : {}),
      // New products that already shipped went through every check, so their journeys run long.
      ...(target === "delivery-gate" || (target === "done" && kind === "new") ? { approveDelivery: true } : {}),
      ...(target === "pr-open" ? { delivery: "pull-request" as const } : {}),
    };

    if (target === "question") {
      triggers[`${id}|architect|1|1`] = {
        kind: "question",
        title: `Should ${work.area} be on for everyone, or opt-in first?`,
        options: [
        "Opt-in first, then everyone",
        "Everyone",
        "Opt-in only"
      ]
      };
    }
    if (target === "permission") {
      triggers[`${id}|builder|1|2`] = {
        kind: "permission",
        title: "Add a new package: date-fns",
        body: "Formatting dates in the user's timezone.",
        detail: "npm install date-fns"
      };
    }
    if (target === "screen") {
      triggers[`${id}|builder|1|2`] = { kind: "screen", title: "Open the app on screen and check the first page appears without a blank flash" };
    }

    if (target === "queued" || target === "held") {
      const task = queuedTask(spec, queuePosition, now - (90 - index) * MINUTE, products);
      queuePosition += 1;
      tasks.push(target === "held" ? { ...task, held: true, statusLine: "On hold" } : task);
      return;
    }

    const reached = fastForward(spec, reach[target], triggers, products, quirks);
    const ago = target === "done" ? Math.min(index + 2, 8) * 60 * MINUTE : target.endsWith("-running") ? (index % 2) * MINUTE : (index % 9) * 3 * MINUTE;
    builder.place(reached, now, ago, 100 + index);
  });

  recordProducts(builder.log, products, now);
  recordUsageHistory(builder.log, now);
  attachSampleFollowUps(tasks, products, now);
  return {
    state: {
      ...baseState(
      now,
      tasks,
      builder.inbox
    ),
      products,
      seq: 10_000,
      pool: {
      limit: 8,
      paused: false,
      toolCaps: {
      "claude-code": 5,
      codex: 4
    },
      usage: demoUsage(now)
    },
      work: {
      version: 1,
      since
    }
    },
    triggers, log: builder.log, open: builder.openWork(), quirks,
  };
}

/**
 * First run on the simulated squad (?demo=first-run): nothing added yet, Claude Code ready, Codex
 * not installed and the GitHub CLI not logged in. The demo products stand in for clones found on disk.
 */
export function createFirstRunDemo(now: number): Demo {
  const state = baseState(now);
  return {
    state: {
      ...state, products: [], pool: { ...state.pool, usage: [], limited: [] },
      setup: {
        done: false, platform: "darwin",
        checks: [
          { id: "claude-code", status: "ready", at: now },
          { id: "codex", status: "not-installed", at: now },
          { id: "gh", status: "logged-out", at: now },
          { id: "git", status: "ready", at: now },
          { id: "node", status: "ready", at: now },
        ],
      },
    },
    triggers: DEMO_TRIGGERS, log: new MemoryWorkLog(now),
    open: { turns: [], stages: [], runs: [], pullRequests: [] }, quirks: {},
  };
}
