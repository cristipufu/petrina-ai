// A synthetic demo squad: three made-up products and a board with work in every state.
// Tasks are fast-forwarded through the real simulator, so their histories are consistent.

import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "./library.js";
import type { InboxItem, Product, State, Task, TaskKind } from "./model.js";
import { Simulator, type Triggers } from "./sim.js";

export const DEMO_PRODUCTS: readonly Product[] = [
  { id: "shop", name: "Shop", repo: "acme/shop", tone: "blue" },
  { id: "notes", name: "Notes", repo: "acme/notes", tone: "green" },
  { id: "site", name: "Site", repo: "acme/site", tone: "orange" },
];

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

interface Spec {
  id: string;
  productId: string;
  title: string;
  description: string;
  area: string;
  kind: TaskKind;
  approvePlan?: boolean;
}

const SPECS: readonly Spec[] = [
  { id: "guest-checkout", productId: "shop", title: "Guest checkout", description: "Let people buy without creating an account. Ask for an email so they get the receipt.", area: "guest checkout", kind: "feature" },
  { id: "login-loop", productId: "shop", title: "Fix login loop on Safari", description: "Some Safari users get sent back to the login page after signing in.", area: "login", kind: "bug" },
  { id: "dark-mode", productId: "notes", title: "Dark mode", description: "A dark theme for the whole app.", area: "dark mode", kind: "feature" },
  { id: "weekly-digest", productId: "notes", title: "Weekly email digest", description: "Every Monday, email people a summary of the notes they changed last week.", area: "the digest", kind: "feature", approvePlan: true },
  { id: "pricing-refresh", productId: "site", title: "Refresh the pricing page", description: "New plan names and the yearly discount.", area: "pricing", kind: "chore" },
  { id: "sentry", productId: "shop", title: "Report errors to Sentry", description: "Send crashes and slow pages to Sentry.", area: "error reporting", kind: "chore" },
  { id: "footer-typo", productId: "site", title: "Fix the footer links", description: "Two footer links go to old pages.", area: "footer", kind: "bug" },
  { id: "export-pdf", productId: "notes", title: "Export notes to PDF", description: "A button that exports a note, or a whole folder, as a PDF.", area: "PDF export", kind: "feature" },
  { id: "onboarding", productId: "shop", title: "Onboarding checklist", description: "A short checklist for new store owners: add a product, set up payments, share the store.", area: "onboarding", kind: "new" },
  { id: "tag-search", productId: "notes", title: "Search by tag", description: "Type #tag in search to see every note with that tag.", area: "tag search", kind: "feature" },
  { id: "stripe-retries", productId: "shop", title: "Retry failed Stripe webhooks", description: "When a webhook fails, retry it a few times before giving up.", area: "webhooks", kind: "bug" },
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

function queuedTask(spec: Spec, priority: number, now: number): Task {
  return {
    ...spec,
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
function fastForward(spec: Spec, until: (task: Task, inbox: readonly InboxItem[]) => boolean): { task: Task; inbox: InboxItem[] } {
  const start = 0;
  const sim = new Simulator(baseState(start, [queuedTask(spec, 0, start)]), { triggers: DEMO_TRIGGERS, prMergeAfter: 3, tickMs: TICK });
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
