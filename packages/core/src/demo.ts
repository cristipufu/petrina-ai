// A synthetic demo squad: three made-up products and a board with work in every state.
// Tasks are fast-forwarded through the real simulator, so their histories (and the work
// log behind every usage number) are consistent.

import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "./library.js";
import type { DeliveryMode, Id, InboxItem, Product, State, Task, TaskKind } from "./model.js";
import { Simulator, type SimOpenWork, type SimQuirk, type Trigger, type Triggers } from "./sim.js";
import { askMomentId, MemoryWorkLog } from "./worklog.js";

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

/** Claude Code is close to its weekly limit and Codex is fine: the usage the demo shows. */
function demoUsage(now: number): NonNullable<State["pool"]["usage"]> {
  return [
    { toolId: "claude-code", kind: "seven_day", status: "allowed_warning", utilization: 0.82, resetsAt: now + 3 * 24 * 60 * MINUTE, at: now },
    { toolId: "claude-code", kind: "five_hour", status: "allowed", utilization: 0.35, resetsAt: now + 90 * MINUTE, at: now },
    { toolId: "codex", kind: "codex:primary", status: "allowed", utilization: 0.16, windowMinutes: 10_080, resetsAt: now + 5 * 24 * 60 * MINUTE, at: now - 2 * MINUTE },
  ];
}

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
    pool: { limit: 5, paused: false, toolCaps: { "claude-code": 3, codex: 2 }, usage: demoUsage(now) },
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

interface Placed {
  task: Task;
  inbox: InboxItem[];
  log: MemoryWorkLog;
  open: SimOpenWork;
}

/** How long the simulated coordinator takes to answer, in ticks: a few minutes for questions, longer for checkpoints. */
function patience(item: InboxItem): number {
  const seed = [...item.id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  return item.kind === "question" || item.kind === "permission" ? 1 + (seed % 7) : 3 + (seed % 22);
}

/**
 * Run one task alone through the simulator until `until` holds, settling everything that
 * needs the coordinator on the way (first option, allow once, approve), after a believable pause.
 */
function fastForward(
  spec: Spec,
  until: (task: Task, inbox: readonly InboxItem[]) => boolean,
  triggers: Triggers = DEMO_TRIGGERS,
  products: readonly Product[] = DEMO_PRODUCTS,
  quirks: Readonly<Record<string, SimQuirk>> = {},
  interruptAt?: number,
  tickMs: number = TICK,
): Placed {
  const start = 0;
  const log = new MemoryWorkLog(start);
  const sim = new Simulator({ ...baseState(start, [queuedTask(spec, 0, start, products)]), products }, { triggers, prMergeAfter: 3, tickMs, log, quirks, disagree: DEMO_DISAGREE });
  const seen = new Map<string, number>();
  for (let tick = 0; tick < 600; tick += 1) {
    sim.tick();
    const state = sim.getState();
    const task = state.tasks[0]!;
    if (until(task, state.inbox)) return { task, inbox: [...state.inbox], log, open: sim.openWork() };
    if (tick === interruptAt && task.state === "running") sim.sendMessage(task.id, "Keep the change small, please.", "interrupt");
    for (const item of state.inbox) {
      const first = seen.get(item.id) ?? tick;
      seen.set(item.id, first);
      if (tick - first < patience(item)) continue;
      if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") sim.allow(item.id, "once");
      else sim.approve(item.id);
    }
    // A task waiting for the coordinator only moves the clock, so the wait is one jump to the next answer
    // instead of a step per tick. Every time in the result is the same; building the demos is much faster.
    const after = sim.getState();
    if (after.tasks[0]!.state !== "needs-you" || after.inbox.length === 0) continue;
    const due = Math.min(...after.inbox.map((item) => (seen.get(item.id) ?? tick + 1) + patience(item)));
    if (due - 1 > tick) {
      sim.tick(after.now + (due - 1 - tick) * tickMs);
      tick = due - 1;
    }
  }
  throw new Error(`demo task ${spec.id} never reached its target state`);
}

/** Move a fast-forwarded task in time so it ends `ago` milliseconds before `now`. */
function shift(placed: Placed, now: number, ago: number, priority: number): Placed {
  const { task, inbox } = placed;
  const endedAt = Math.max(task.timeline.at(-1)?.at ?? 0, ...inbox.map((item) => item.at));
  const delta = now - ago - endedAt;
  const at = (value: number) => value + delta;
  // Each fast-forward has its own id counter. Rename pending requests in both the inbox and log.
  const shiftedInbox = inbox.map((item) => ({ ...item, id: `${task.id}:${item.id}`, at: at(item.at) }));
  const requestIds = new Map(inbox.map((item, index) => [askMomentId(task.id, item.id), askMomentId(task.id, shiftedInbox[index]!.id)]));
  placed.log.shift(task.id, delta, requestIds);
  return {
    task: {
      ...task,
      priority,
      createdAt: at(task.createdAt) - 5 * MINUTE,
      ...(task.startedAt !== undefined ? { startedAt: at(task.startedAt) } : {}),
      ...(task.finishedAt !== undefined ? { finishedAt: at(task.finishedAt) } : {}),
      ...(task.agent ? { agent: { ...task.agent, since: at(task.agent.since) } } : {}),
      ...(task.pr ? { pr: { ...task.pr, openedAt: at(task.pr.openedAt) } } : {}),
      ...(task.checks ? { checks: { ...task.checks, at: at(task.checks.at) } } : {}),
      timeline: task.timeline.map((entry) => ({ ...entry, at: at(entry.at) })),
      session: task.session.map((line) => ({ ...line, at: at(line.at) })),
    },
    inbox: shiftedInbox,
    log: placed.log,
    open: shiftOpen(placed.open, delta),
  };
}

function shiftOpen(open: SimOpenWork, delta: number): SimOpenWork {
  return {
    turns: open.turns.map(([taskId, turn]) => [taskId, { ...turn, startedAt: turn.startedAt + delta, ...(turn.waitingSince !== undefined ? { waitingSince: turn.waitingSince + delta } : {}) }]),
    stages: open.stages.map(([taskId, stage]) => [taskId, { ...stage, startedAt: stage.startedAt + delta }]),
    runs: open.runs,
  };
}

const byId = (id: string): Spec => {
  const spec = SPECS.find((entry) => entry.id === id);
  if (!spec) throw new Error(`unknown demo task ${id}`);
  return spec;
};

// ── History: thirty days of work, so every number in the app has something to show ──────

const DAY = 24 * 60 * MINUTE;

/** Collects the board, the inbox and the work log while a demo is put together. */
class DemoBuilder {
  readonly tasks: Task[] = [];
  readonly inbox: InboxItem[] = [];
  readonly log: MemoryWorkLog;
  private open: SimOpenWork = { turns: [], stages: [], runs: [] };

  constructor(readonly now: number, readonly since: number) {
    this.log = new MemoryWorkLog(since);
  }

  place(placed: Placed, now: number, ago: number, priority: number): Task {
    const shifted = shift(placed, now, ago, priority);
    this.tasks.push(shifted.task);
    this.inbox.push(...shifted.inbox);
    this.log.absorb(shifted.log);
    this.open = { turns: [...this.open.turns, ...shifted.open.turns], stages: [...this.open.stages, ...shifted.open.stages], runs: [...this.open.runs, ...shifted.open.runs] };
    return shifted.task;
  }

  openWork(): SimOpenWork {
    return this.open;
  }

  /** Take a placed task off the board, keeping its entries in the log. */
  drop(taskId: Id): void {
    this.tasks.splice(this.tasks.findIndex((task) => task.id === taskId), 1);
    for (let index = this.inbox.length - 1; index >= 0; index -= 1) if (this.inbox[index]!.taskId === taskId) this.inbox.splice(index, 1);
  }
}

const HISTORY_WORK: readonly { title: string; area: string; kind: TaskKind; description: string }[] = [
  { title: "Saved carts", area: "saved carts", kind: "feature", description: "Keep a cart for a week so people can come back to it." },
  { title: "Fix slow first load", area: "first load", kind: "bug", description: "The first page takes four seconds on phones." },
  { title: "Yearly plans", area: "yearly plans", kind: "feature", description: "Offer a yearly plan with two months free." },
  { title: "Update the brand colours", area: "brand colours", kind: "chore", description: "Use the new palette everywhere." },
  { title: "Fix broken CSV export", area: "CSV export", kind: "bug", description: "Exports cut off after a thousand rows." },
  { title: "Team invites", area: "team invites", kind: "feature", description: "Invite teammates by email with a role." },
  { title: "Tidy the settings page", area: "settings", kind: "chore", description: "Group the settings and drop the ones nobody uses." },
  { title: "Fix timezone bug in reports", area: "reports", kind: "bug", description: "Reports use UTC instead of the account's timezone." },
  { title: "Welcome email", area: "the welcome email", kind: "new", description: "A friendly first email with three tips." },
  { title: "Refund flow", area: "refunds", kind: "feature", description: "Let support refund an order in two clicks." },
  { title: "Fix the broken avatar upload", area: "avatars", kind: "bug", description: "Large photos fail without a message." },
  { title: "Faster search results", area: "search", kind: "chore", description: "Cache the most common searches." },
];

/** What the removed demo product was called, so its history still has a name. */
const REMOVED: Product = { id: "legacy", name: "Legacy app", repo: "acme/legacy-app", tone: "slate", delivery: "pull-request", approveDelivery: true };

/**
 * Fill the log with history: one to three finished tasks a day for the 29 days before today,
 * across both tools. Tracking "began" 24 days ago, so the oldest tasks ran before Petrina
 * kept track and one straddles the start. A few tasks are cancelled, a few agents ran on
 * other settings, and a removed product still has its share.
 */
function addHistory(builder: DemoBuilder, products: readonly Product[], quirks: Record<string, SimQuirk>): void {
  const today = new Date(builder.now);
  today.setHours(0, 0, 0, 0);
  let index = 0;
  for (let daysAgo = 29; daysAgo >= 1; daysAgo -= 1) {
    const perDay = 1 + ((daysAgo * 7) % 3);
    for (let k = 0; k < perDay; k += 1) {
      index += 1;
      const work = HISTORY_WORK[(daysAgo * 5 + k * 3) % HISTORY_WORK.length]!;
      const removedEra = daysAgo >= 14 && (daysAgo + k) % 4 === 0;
      const product = removedEra ? REMOVED : products[(daysAgo * 3 + k) % products.length]!;
      const id = `h${index}`;
      const spec: Spec = { id, productId: product.id, title: work.title, description: work.description, area: work.area, kind: work.kind, approveDelivery: product.approveDelivery ?? true, delivery: product.delivery ?? "pull-request" };
      // The quirks that make every caveat in the app show up somewhere.
      const quirk = (role: string, value: SimQuirk) => (quirks[`${id}|${role}`] = { ...quirks[`${id}|${role}`], ...value });
      if (index % 6 === 0) quirk("builder", { toolId: "codex", helpers: 1 + (index % 2) });
      if (index % 5 === 0) quirk("code-reviewer", { toolId: "codex", helpers: 1 });
      if (index % 9 === 0) quirk("code-reviewer", { toolId: "codex", ran: { model: "gpt-6.1", name: "gpt-6.1", effort: "medium" } });
      if (index % 11 === 5) quirk("code-reviewer", { toolId: "codex", changedTo: { model: "gpt-6.1-mini" } });
      if (index % 13 === 0) quirk("planner", { toolId: "claude-code", noBreakdown: true });
      if (index % 17 === 0) quirk("architect", { notConfirmed: true });
      if (index % 19 === 0) quirk("release-manager", { toolId: "claude-code", changedTo: { model: "Sonnet 5.5" } });
      if (index % 4 === 1) quirk("builder", { toolId: "claude-code", extraModel: "claude-haiku-5-5" });
      // Agents stop to ask now and then, so not all of a stage's time is agent work.
      const triggers: Record<string, Trigger> = { ...DEMO_TRIGGERS };
      if (index % 3 === 0) triggers[`${id}|architect|1|1`] = { kind: "question", title: `Should ${work.area} be on for everyone at once?`, options: ["Yes", "Opt-in first"] };
      if (index % 3 === 1) triggers[`${id}|builder|1|2`] = { kind: "permission", title: "Add a new package", detail: "npm install date-fns" };
      if (index % 4 === 2) triggers[`${id}|code-reviewer|1|1`] = { kind: "question", title: "Is the old export still used?", options: ["Yes", "No"] };
      const cancelled = index % 10 === 7;
      const placed = fastForward(spec, cancelled ? (task) => task.column === "building" && (task.agent?.step ?? 0) >= 2 : (task) => task.state === "done", triggers, [...products, REMOVED], quirks, index % 8 === 3 ? 4 : undefined, 150_000);
      if (cancelled) {
        // Cancelled mid-build: that turn ends without a token report.
        const sim = new Simulator({ ...baseState(placed.task.timeline.at(-1)?.at ?? 0, [placed.task]), products: [...products, REMOVED] }, { log: placed.log, open: placed.open, quirks });
        sim.cancel(id);
        placed.task = sim.getState().tasks[0]!;
        placed.open = { turns: [], stages: [], runs: [] };
      }
      const endAt = today.getTime() - daysAgo * DAY + (10 + k * 3) * 60 * MINUTE + ((index * 37) % 50) * MINUTE;
      // One task straddles the moment tracking began.
      const straddle = index === 9;
      const end = straddle ? builder.since + 25 * MINUTE : endAt;
      const task = builder.place(placed, builder.now, builder.now - end, 1000 + index);
      if ((task.startedAt ?? task.createdAt) < builder.since) {
        builder.log.forget(task.id, builder.since);
        builder.log.markUntracked(task.id, task.productId);
      }
      if (index % 7 === 0 && !cancelled) sprinkleTrouble(builder.log, task, index);
      // Removing a product took its tasks off the board; only its history stays, in the work log.
      if (removedEra) builder.drop(task.id);
    }
  }
}

/** A failure and a retry, or a result an agent had to redo, inside a finished task's build. */
function sprinkleTrouble(log: MemoryWorkLog, task: Task, index: number): void {
  const build = log.turns({ taskId: task.id }).find((turn) => turn.roleId === "builder");
  if (!build) return;
  const base = { taskId: task.id, productId: task.productId, stageId: build.stageId, stageTitle: build.stageTitle, stageKind: build.stageKind, round: build.round, roleId: build.roleId, toolId: build.toolId, profileId: build.profileId };
  const reasons = ["limit", "agent-stopped", "unusable"] as const;
  log.addMoment({ ...base, id: `${task.id}-fail`, at: build.startedAt + 30_000, kind: "failure", outcome: reasons[index % reasons.length]! });
  log.addMoment({ ...base, id: `${task.id}-retry`, at: build.startedAt + 60_000, kind: "retry" });
  log.addMoment({ ...base, id: `${task.id}-redo`, at: (build.endedAt ?? build.startedAt) - 20_000, kind: "redo" });
}

function trackingStart(now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime() - 24 * DAY;
}

export interface Demo {
  state: State;
  triggers: Triggers;
  /** The work log the demo starts with, and the work still open in it. */
  log: MemoryWorkLog;
  open: SimOpenWork;
  quirks: Readonly<Record<string, SimQuirk>>;
}

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
  const place = (id: string, ago: number, until: (task: Task, inbox: readonly InboxItem[]) => boolean, priority: number) => builder.place(fastForward(byId(id), until, DEMO_TRIGGERS, DEMO_PRODUCTS, quirks), now, ago, priority);

  addHistory(builder, DEMO_PRODUCTS, quirks);
  place("guest-checkout", 2 * MINUTE, (_task, items) => items.some((item) => item.kind === "permission"), 100);
  place("login-loop", 0, (task) => task.column === "reviewing" && task.sub === 0 && (task.agent?.step ?? 0) === 2, 101);
  place("dark-mode", 4 * MINUTE, (_task, items) => items.some((item) => item.kind === "question"), 102);
  place("gift-cards", 6 * MINUTE, (_task, items) => items.some((item) => item.kind === "disagreement"), 107);
  place("weekly-digest", 9 * MINUTE, (_task, items) => items.some((item) => item.kind === "plan"), 103);
  place("pricing-refresh", 26 * MINUTE, (_task, items) => items.some((item) => item.kind === "delivery"), 104);
  place("sentry", 3 * 60 * MINUTE, (task) => task.state === "done", 105);
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
    builder.tasks.push(id === "stripe-retries" ? { ...task, held: true, statusLine: "On hold" } : task);
  });

  recordProducts(builder.log, DEMO_PRODUCTS, now);
  const state: State = { ...baseState(now, builder.tasks, builder.inbox), seq: 10_000, work: { version: 1, since } };
  return { state, triggers: DEMO_TRIGGERS, log: builder.log, open: builder.openWork(), quirks };
}

/** The permanent product list: every demo product, plus the removed one. */
function recordProducts(log: MemoryWorkLog, products: readonly Product[], now: number): void {
  for (const product of products) log.recordProduct({ id: product.id, name: product.name, repo: product.repo, addedAt: now - 40 * DAY });
  log.recordProduct({ id: REMOVED.id, name: REMOVED.name, repo: REMOVED.repo, addedAt: now - 60 * DAY, removedAt: now - 12 * DAY });
}

// ── Built once ────────────────────────────────────────────────────────────────────────

/** Demos already built, by kind and time. Building one fast-forwards dozens of tasks, and tests ask for the same one again and again. */
const built = new Map<string, Demo>();

/** A demo built once per kind and time. Each caller gets its own copy, free to change. */
function remembered(key: string, build: () => Demo): Demo {
  let demo = built.get(key);
  if (!demo) {
    demo = build();
    if (built.size >= 4) built.clear();
    built.set(key, demo);
  }
  return { state: plain(demo.state), triggers: plain(demo.triggers), log: demo.log.copy(), open: plain(demo.open), quirks: plain(demo.quirks) };
}

/** A full copy of plain data. A JSON round trip, as the simulator copies its state: it works the same everywhere. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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

    const reached = fastForward(spec, reach[target], triggers, products, quirks);
    const ago = target === "done" ? Math.min(index + 2, 8) * 60 * MINUTE : (index % 9) * 3 * MINUTE;
    builder.place(reached, now, ago, 100 + index);
  });

  recordProducts(builder.log, products, now);
  return {
    state: { ...baseState(now, tasks, builder.inbox), products, seq: 10_000, pool: { limit: 8, paused: false, toolCaps: { "claude-code": 5, codex: 4 }, usage: demoUsage(now) }, work: { version: 1, since } },
    triggers,
    log: builder.log,
    open: builder.openWork(),
    quirks,
  };
}
