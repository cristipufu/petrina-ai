// A synthetic demo squad: three made-up products and a board with work in every state.
// Tasks are fast-forwarded through the real simulator, so their histories are consistent.

import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "./library.js";
import type { DeliveryMode, InboxItem, Product, State, Task, TaskKind } from "./model.js";
import { Simulator, type Trigger, type Triggers } from "./sim.js";

export const DEMO_PRODUCTS: readonly Product[] = [
  {
    id: "shop",
    name: "Shop",
    repo: "acme/shop",
    tone: "blue",
    delivery: "pull-request",
    approveDelivery: true,
    checks: [
      { name: "Type check", argv: ["bun", "run", "typecheck"], why: "CI runs it on every pull request" },
      { name: "Tests", argv: ["bun", "run", "test"], why: "CI runs it on every pull request" },
      { name: "Build", argv: ["bun", "run", "build"], why: "The release workflow builds before it ships" },
    ],
    checksBy: "finder",
  },
  { id: "notes", name: "Notes", repo: "acme/notes", tone: "green", delivery: "release", approveDelivery: true },
  { id: "site", name: "Site", repo: "acme/site", tone: "orange", delivery: "local", approveDelivery: false },
];

// Question choices list the agent's own recommendation first, as real agents are told to.
export const DEMO_TRIGGERS: Triggers = {
  "guest-checkout|builder|1|2": {
    kind: "permission",
    title: "Add a new package: Stripe.js",
    body: "Card payments for guests need Stripe's official browser library.",
    detail: "npm install @stripe/stripe-js",
  },
  "dark-mode|architect|1|1": {
    kind: "question",
    title: "Should dark mode follow the system setting, or be a manual toggle?",
    body: "Following the system is what most apps do. A toggle gives people control.",
    options: ["Both, starting from the system setting", "Follow the system", "Manual toggle"],
  },
  "export-pdf|builder|1|1": {
    kind: "permission",
    title: "Add a new package: pdf-lib",
    body: "Creates PDF files in the app without a server.",
    detail: "npm install pdf-lib",
  },
  "export-pdf|builder|1|3": {
    kind: "question",
    title: "Should exported PDFs include images?",
    options: ["Yes, compressed", "Yes, full size", "No images"],
  },
  "onboarding|architect|1|2": {
    kind: "question",
    title: "Can people skip the onboarding checklist?",
    body: "Skipping lowers friction, but fewer people finish setup.",
    options: ["Yes, after the first step", "Yes, any time", "No"],
  },
  "tag-search|builder|1|2": {
    kind: "permission",
    title: "Change the database: add a tags index",
    body: "Search by tag needs an index to stay fast with many notes.",
    detail: "bun run db:migrate add-tags-index",
  },
};

/** Demo tasks whose architects end up disagreeing, so the coordinator can make the call. */
const DEMO_DISAGREE: readonly string[] = ["gift-cards"];

interface Spec {
  id: string;
  productId: string;
  title: string;
  description: string;
  area: string;
  kind: TaskKind;
  approvePlan?: boolean;
  delivery?: DeliveryMode;
  approveDelivery?: boolean;
}

const SPECS: readonly Spec[] = [
  { id: "guest-checkout", productId: "shop", title: "Guest checkout", description: "Let people buy without creating an account. Ask for an email so they get the receipt.", area: "guest checkout", kind: "feature" },
  { id: "login-loop", productId: "shop", title: "Fix login loop on Safari", description: "Some Safari users get sent back to the login page after signing in.", area: "login", kind: "bug" },
  { id: "dark-mode", productId: "notes", title: "Dark mode", description: "A dark theme for the whole app.", area: "dark mode", kind: "feature" },
  { id: "weekly-digest", productId: "notes", title: "Weekly email digest", description: "Every Monday, email people a summary of the notes they changed last week.", area: "the digest", kind: "feature", approvePlan: true },
  { id: "pricing-refresh", productId: "shop", title: "Refresh the pricing page", description: "New plan names and the yearly discount.", area: "pricing", kind: "chore" },
  { id: "sentry", productId: "shop", title: "Report errors to Sentry", description: "Send crashes and slow pages to Sentry.", area: "error reporting", kind: "chore" },
  { id: "footer-typo", productId: "site", title: "Fix the footer links", description: "Two footer links go to old pages.", area: "footer", kind: "bug" },
  { id: "export-pdf", productId: "notes", title: "Export notes to PDF", description: "A button that exports a note, or a whole folder, as a PDF.", area: "PDF export", kind: "feature" },
  { id: "onboarding", productId: "shop", title: "Onboarding checklist", description: "A short checklist for new store owners: add a product, set up payments, share the store.", area: "onboarding", kind: "new" },
  { id: "tag-search", productId: "notes", title: "Search by tag", description: "Type #tag in search to see every note with that tag.", area: "tag search", kind: "feature" },
  { id: "stripe-retries", productId: "shop", title: "Retry failed Stripe webhooks", description: "When a webhook fails, retry it a few times before giving up.", area: "webhooks", kind: "bug" },
  { id: "gift-cards", productId: "shop", title: "Gift cards", description: "Sell gift cards people can send by email and spend at checkout.", area: "gift cards", kind: "feature" },
];

const MINUTE = 60_000;
const TICK = 40_000;

function baseState(now: number, tasks: Task[] = [], inbox: InboxItem[] = []): State {
  return {
    now,
    seq: 0,
    products: DEMO_PRODUCTS,
    roles: BUILT_IN_ROLES,
    tools: KNOWN_TOOLS,
    profiles: DEFAULT_PROFILES,
    tasks,
    inbox,
    pool: { limit: 4, paused: false, toolCaps: { "claude-code": 3, codex: 2 } },
  };
}

function queuedTask(spec: Spec, priority: number, now: number, products: readonly Product[] = DEMO_PRODUCTS): Task {
  const product = products.find((entry) => entry.id === spec.productId);
  return {
    ...spec,
    delivery: spec.delivery ?? product?.delivery ?? "pull-request",
    approveDelivery: spec.approveDelivery ?? product?.approveDelivery ?? true,
    priority,
    held: false,
    state: "queued",
    column: "queue",
    holdsSlot: false,
    approvePlan: spec.approvePlan ?? false,
    stageIndex: -1,
    rounds: {},
    sub: 0,
    fixing: false,
    statusLine: "In the queue",
    createdAt: now,
    timeline: [{ id: `${spec.id}-0`, at: now, text: "You added it to the queue", tone: "you" }],
    session: [],
    queued: [],
    objections: [],
    findings: [],
    prAge: 0,
  };
}

/**
 * Run one task alone through the simulator until `until` holds, settling everything that
 * needs the coordinator on the way (first option, allow once, approve).
 */
function fastForward(
  spec: Spec,
  until: (task: Task, inbox: readonly InboxItem[]) => boolean,
  triggers: Triggers = DEMO_TRIGGERS,
  products: readonly Product[] = DEMO_PRODUCTS,
): { task: Task; inbox: InboxItem[] } {
  const start = 0;
  const sim = new Simulator({ ...baseState(start, [queuedTask(spec, 0, start, products)]), products }, { triggers, prMergeAfter: 3, tickMs: TICK, disagree: DEMO_DISAGREE });
  for (let tick = 0; tick < 400; tick += 1) {
    sim.tick();
    const state = sim.getState();
    const task = state.tasks[0]!;
    if (until(task, state.inbox)) return { task, inbox: [...state.inbox] };
    for (const item of state.inbox) {
      if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") sim.allow(item.id, "once");
      else sim.approve(item.id);
    }
  }
  throw new Error(`demo task ${spec.id} never reached its target state`);
}

/** Move a fast-forwarded task in time so it ends `ago` milliseconds before `now`. */
function shift(task: Task, inbox: readonly InboxItem[], endedAt: number, now: number, ago: number): { task: Task; inbox: InboxItem[] } {
  const delta = now - ago - endedAt;
  const at = (value: number) => value + delta;
  return {
    task: {
      ...task,
      createdAt: at(task.createdAt) - 5 * MINUTE,
      ...(task.startedAt !== undefined ? { startedAt: at(task.startedAt) } : {}),
      ...(task.finishedAt !== undefined ? { finishedAt: at(task.finishedAt) } : {}),
      ...(task.agent ? { agent: { ...task.agent, since: at(task.agent.since) } } : {}),
      ...(task.pr ? { pr: { ...task.pr, openedAt: at(task.pr.openedAt) } } : {}),
      timeline: task.timeline.map((entry) => ({ ...entry, at: at(entry.at) })),
      session: task.session.map((line) => ({ ...line, at: at(line.at) })),
    },
    // Each fast-forward has its own id counter, so inbox ids are made unique per task.
    inbox: inbox.map((item) => ({ ...item, id: `${task.id}:${item.id}`, at: at(item.at) })),
  };
}

const byId = (id: string): Spec => {
  const spec = SPECS.find((entry) => entry.id === id);
  if (!spec) throw new Error(`unknown demo task ${id}`);
  return spec;
};

/** The demo board as it looks when the app opens at `now`. */
export function createDemoState(now: number): State {
  const tasks: Task[] = [];
  const inbox: InboxItem[] = [];

  const place = (id: string, ago: number, until: (task: Task, inbox: readonly InboxItem[]) => boolean, priority: number) => {
    const reached = fastForward(byId(id), until);
    const endedAt = Math.max(reached.task.timeline.at(-1)?.at ?? 0, ...reached.inbox.map((item) => item.at));
    const shifted = shift({ ...reached.task, priority }, reached.inbox, endedAt, now, ago);
    tasks.push(shifted.task);
    inbox.push(...shifted.inbox);
  };

  place("guest-checkout", 2 * MINUTE, (_task, items) => items.some((item) => item.kind === "permission"), 100);
  place("login-loop", 0, (task) => task.column === "reviewing" && task.sub === 0 && (task.agent?.step ?? 0) === 2, 101);
  place("dark-mode", 4 * MINUTE, (_task, items) => items.some((item) => item.kind === "question"), 102);
  place("gift-cards", 6 * MINUTE, (_task, items) => items.some((item) => item.kind === "disagreement"), 107);
  place("weekly-digest", 9 * MINUTE, (_task, items) => items.some((item) => item.kind === "plan"), 103);
  place("pricing-refresh", 26 * MINUTE, (_task, items) => items.some((item) => item.kind === "delivery"), 104);
  place("sentry", 3 * 60 * MINUTE, (task) => task.state === "done", 105);
  place("footer-typo", 26 * 60 * MINUTE, (task) => task.state === "done", 106);

  ["export-pdf", "onboarding", "tag-search", "stripe-retries"].forEach((id, priority) => {
    const task = queuedTask(byId(id), priority, now - (40 - priority * 7) * MINUTE);
    tasks.push(id === "stripe-retries" ? { ...task, held: true, statusLine: "On hold" } : task);
  });

  return { ...baseState(now, tasks, inbox), seq: 10_000 };
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
  | "queued" | "held" | "design-running" | "build-running" | "review-running" | "question" | "permission"
  | "plan-gate" | "design-gate" | "delivery-gate" | "pr-open" | "done";

/** What each task in the portfolio is doing when the app opens. At most eight hold a slot. */
const PORTFOLIO_TARGETS: readonly Target[] = [
  "build-running", "review-running", "design-running", "question", "build-running", "permission", "review-running",
  "plan-gate", "design-gate", "delivery-gate", "delivery-gate", "design-gate", "plan-gate", "delivery-gate",
  "pr-open", "pr-open", "pr-open", "done", "done", "done", "done", "done", "done",
  "queued", "queued", "queued", "queued", "queued", "held", "queued", "queued", "queued", "queued", "queued", "held", "queued", "queued",
];

const reach: Record<Exclude<Target, "queued" | "held">, (task: Task, inbox: readonly InboxItem[]) => boolean> = {
  "design-running": (task) => task.column === "designing" && task.state === "running" && (task.agent?.step ?? 0) >= 1,
  "build-running": (task) => task.column === "building" && task.state === "running" && (task.agent?.step ?? 0) >= 2,
  "review-running": (task) => task.column === "reviewing" && task.state === "running" && (task.agent?.step ?? 0) >= 1,
  question: (_task, inbox) => inbox.some((item) => item.kind === "question"),
  permission: (_task, inbox) => inbox.some((item) => item.kind === "permission"),
  "plan-gate": (_task, inbox) => inbox.some((item) => item.kind === "plan"),
  "design-gate": (_task, inbox) => inbox.some((item) => item.kind === "design"),
  "delivery-gate": (_task, inbox) => inbox.some((item) => item.kind === "delivery"),
  "pr-open": (task) => task.state === "pr-open",
  done: (task) => task.state === "done",
};

export interface Demo {
  state: State;
  triggers: Triggers;
}

/** Twenty made-up products with work spread across them. Products 16 to 19 are quiet. */
export function createPortfolioDemo(now: number): Demo {
  const products: Product[] = PORTFOLIO_NAMES.map((name, index) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    repo: `acme/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    tone: TONES[index % TONES.length]!,
    delivery: index % 3 === 0 ? "pull-request" : index % 3 === 1 ? "release" : "local",
    approveDelivery: index % 3 !== 2,
  }));
  const triggers: Record<string, Trigger> = {};
  const tasks: Task[] = [];
  const inbox: InboxItem[] = [];
  let queuePosition = 0;

  PORTFOLIO_TARGETS.forEach((target, index) => {
    const product = products[(index * 7) % 16]!;
    const work = PORTFOLIO_WORK[index % PORTFOLIO_WORK.length]!;
    const id = `p${index}`;
    const kind: TaskKind = target === "design-running" || target === "design-gate" || target === "question" ? "feature" : work.kind;
    const spec: Spec = {
      id,
      productId: product.id,
      title: work.title,
      description: work.description,
      area: work.area,
      kind,
      approvePlan: target === "plan-gate",
      ...(target === "delivery-gate" ? { approveDelivery: true } : {}),
      ...(target === "pr-open" ? { delivery: "pull-request" as const } : {}),
    };

    if (target === "question") {
      triggers[`${id}|architect|1|1`] = { kind: "question", title: `Should ${work.area} be on for everyone, or opt-in first?`, options: ["Opt-in first, then everyone", "Everyone", "Opt-in only"] };
    }
    if (target === "permission") {
      triggers[`${id}|builder|1|2`] = { kind: "permission", title: "Add a new package: date-fns", body: "Formatting dates in the user's timezone.", detail: "npm install date-fns" };
    }

    if (target === "queued" || target === "held") {
      const task = queuedTask(spec, queuePosition, now - (90 - index) * MINUTE, products);
      queuePosition += 1;
      tasks.push(target === "held" ? { ...task, held: true, statusLine: "On hold" } : task);
      return;
    }

    const reached = fastForward(spec, reach[target], triggers, products);
    const endedAt = Math.max(reached.task.timeline.at(-1)?.at ?? 0, ...reached.inbox.map((item) => item.at));
    const ago = target === "done" ? (index + 2) * 60 * MINUTE : (index % 9) * 3 * MINUTE;
    const shifted = shift({ ...reached.task, priority: 100 + index }, reached.inbox, endedAt, now, ago);
    tasks.push(shifted.task);
    inbox.push(...shifted.inbox);
  });

  return {
    state: { ...baseState(now, tasks, inbox), products, seq: 10_000, pool: { limit: 8, paused: false, toolCaps: { "claude-code": 5, codex: 4 } } },
    triggers,
  };
}
