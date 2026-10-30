import { findingCount } from "./findings.js";
import { followUpDescription, followUpTitle } from "./follow-ups.js";
import { DEFAULT_PROFILES, KNOWN_TOOLS } from "./library.js";
import type {
  DeliveryMode,
  Finding,
  InboxItem,
  Product,
  State,
  Task,
  TaskKind,
} from "./model.js";
import { libraryRoles, NO_ROLE_CHANGES } from "./roles.js";
import type { Clone } from "./setup.js";
import type { Triggers } from "./sim-types.js";

export const MINUTE = 60_000;

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
  // A builder checking a Mac app window: everything else is done offscreen, this needs the real screen.
  "quick-note|builder|1|3": {
    kind: "screen",
    title: "Click the menu bar icon and check the quick note window opens in front, takes focus and closes with Esc",
  },
};

/** Demo tasks whose architects end up disagreeing, so the coordinator can make the call. */
export const DEMO_DISAGREE: readonly string[] = ["gift-cards"];

/** Demo tasks whose working copy could not be removed at the first try, so the board shows Petrina trying again. */
export const DEMO_LOCKED: readonly string[] = ["sentry"];

export interface Spec {
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
  {
    id: "guest-checkout",
    productId: "shop",
    title: "Guest checkout",
    description: "Let people buy without creating an account. Ask for an email so they get the receipt.",
    area: "guest checkout",
    kind: "feature",
  },
  {
    id: "login-loop",
    productId: "shop",
    title: "Fix login loop on Safari",
    description: "Some Safari users get sent back to the login page after signing in.",
    area: "login",
    kind: "bug",
  },
  {
    id: "dark-mode",
    productId: "notes",
    title: "Dark mode",
    description: "A dark theme for the whole app.",
    area: "dark mode",
    kind: "feature",
  },
  {
    id: "weekly-digest",
    productId: "notes",
    title: "Weekly email digest",
    description: "Every Monday, email people a summary of the notes they changed last week.",
    area: "the digest",
    kind: "feature",
    approvePlan: true,
  },
  {
    id: "pricing-refresh",
    productId: "shop",
    title: "Refresh the pricing page",
    description: "New plan names and the yearly discount.",
    area: "pricing",
    kind: "chore",
  },
  {
    id: "sentry",
    productId: "shop",
    title: "Report errors to Sentry",
    description: "Send crashes and slow pages to Sentry.",
    area: "error reporting",
    kind: "chore",
  },
  {
    id: "footer-typo",
    productId: "site",
    title: "Fix the footer links",
    description: "Two footer links go to old pages.",
    area: "footer",
    kind: "bug",
  },
  {
    id: "export-pdf",
    productId: "notes",
    title: "Export notes to PDF",
    description: "A button that exports a note, or a whole folder, as a PDF.",
    area: "PDF export",
    kind: "feature",
  },
  {
    id: "onboarding",
    productId: "shop",
    title: "Onboarding checklist",
    description: "A short checklist for new store owners: add a product, set up payments, share the store.",
    area: "onboarding",
    kind: "new",
  },
  {
    id: "tag-search",
    productId: "notes",
    title: "Search by tag",
    description: "Type #tag in search to see every note with that tag.",
    area: "tag search",
    kind: "feature",
  },
  {
    id: "stripe-retries",
    productId: "shop",
    title: "Retry failed Stripe webhooks",
    description: "When a webhook fails, retry it a few times before giving up.",
    area: "webhooks",
    kind: "bug",
  },
  {
    id: "gift-cards",
    productId: "shop",
    title: "Gift cards",
    description: "Sell gift cards people can send by email and spend at checkout.",
    area: "gift cards",
    kind: "feature",
  },
  {
    id: "quick-note",
    productId: "notes",
    title: "Quick note window opens behind others",
    description: "On the Mac app, the quick note window from the menu bar sometimes opens behind other windows.",
    area: "the quick note window",
    kind: "bug",
  },
];

/** Codex is close to its weekly limit, so Petrina starts fewer agents on it, and Claude Code has room: the usage the demo shows. */
export function demoUsage(now: number): NonNullable<State["pool"]["usage"]> {
  return [
    {
      toolId: "claude-code",
      kind: "seven_day",
      status: "allowed",
      utilization: 0.62,
      resetsAt: now + 3 * 24 * 60 * MINUTE,
      at: now,
    },
    {
      toolId: "claude-code",
      kind: "five_hour",
      status: "allowed",
      utilization: 0.35,
      resetsAt: now + 90 * MINUTE,
      at: now,
    },
    {
      toolId: "codex",
      kind: "codex:primary",
      status: "allowed",
      utilization: 0.84,
      windowMinutes: 10_080,
      resetsAt: now + 2 * 24 * 60 * MINUTE,
      at: now,
    },
  ];
}

export function baseState(now: number, tasks: Task[] = [], inbox: InboxItem[] = []): State {
  return {
    now,
    seq: 0,
    products: DEMO_PRODUCTS,
    roles: libraryRoles(NO_ROLE_CHANGES),
    tools: [
      ...KNOWN_TOOLS,
      { id: "grok", name: "Grok", command: ["grok"], status: "not-installed", models: ["Grok 4.7"] },
      { id: "antigravity", name: "Antigravity", command: ["agy"], status: "not-installed", models: ["Gemini 4 Argon"] },
    ],
    profiles: DEFAULT_PROFILES,
    tasks,
    inbox,
    pool: { limit: 5, paused: false, toolCaps: { "claude-code": 3, codex: 2 }, usage: demoUsage(now) },
    planner: "sonnet-medium",
  };
}

export function queuedTask(
  spec: Spec,
  priority: number,
  now: number,
  products: readonly Product[] = DEMO_PRODUCTS,
): Task {
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
  };
}

/** One Backlog card for two differently worded older reports, and one report Petrina could not match. */
export function attachSampleFollowUps(tasks: Task[], products: readonly Product[], now: number): void {
  const source = tasks.find((task) => task.state === "done");
  if (!source || tasks.some((task) => task.id === "footer-follow-up")) return;
  const about = "The About link in the footer opens a retired page.";
  const other = "Choosing About in the footer still lands on the old about page.";
  const steps = "Open the site and choose About in the footer.";
  const evidence = "The same retired page opened on the previous version.";
  const finding = (
    id: string,
    text: string,
    raisedBy: string,
    roleId: string,
    tracking: NonNullable<Finding["tracking"]>,
  ): Finding => ({
    id,
    text,
    severity: "pre-existing",
    status: "open",
    raisedBy,
    roleId,
    confirmedBy: [],
    steps,
    evidence,
    productIds: [source.productId],
    tracking,
  });
  const first = finding(`${source.id}-about`, about, "opus-high", "code-reviewer", { taskId: "footer-follow-up" });
  first.votes = [
    { by: "grok-high", toolId: "grok", verdict: "real", reason: "The footer still opens a retired page." },
    { by: "opus-high", toolId: "claude-code", verdict: "pre-existing", reason: evidence },
    { by: "sol-xhigh", toolId: "codex", verdict: "pre-existing", reason: "Reproduced the same problem before this change." },
    {
      by: "argon-high",
      toolId: "antigravity",
      verdict: "pre-existing",
      reason: "The changed page and the earlier page both have this problem.",
    },
  ];
  first.verification = { by: "opus-high", verdict: "pre-existing", reason: evidence, at: now };
  const second = finding(`${source.id}-about-again`, other, "sol-xhigh", "security-reviewer", {
    taskId: "footer-follow-up",
  });
  const missed = finding(`${source.id}-year`, "The copyright line is a year behind.", "opus-high", "code-reviewer", {
    reason: "unmatched",
  });
  source.findings = [...source.findings, first, second, missed];
  const review = source.journey?.find((step) => step.result?.findingsSettled);
  if (review?.result) {
    review.result = {
      ...review.result,
      findings: [...(review.result.findings ?? []), JSON.parse(JSON.stringify(first)) as Finding],
      findingChanges: {
        raised: [...(review.result.findingChanges?.raised ?? []), first.id],
        fixed: review.result.findingChanges?.fixed ?? [],
        dismissed: review.result.findingChanges?.dismissed ?? [],
      },
    };
    review.outcome = findingCount(review.result.findings!.filter((entry) => entry.status === "open"));
  }
  const reports = [first, second].map((entry) => ({
    taskId: source.id,
    findingId: entry.id,
    sourceTitle: source.title,
    text: entry.text,
    steps: entry.steps!,
    evidence: entry.evidence!,
    raisedBy: entry.raisedBy,
    ...(entry.roleId ? { roleId: entry.roleId } : {}),
    productIds: [...(entry.productIds ?? [])],
    at: now,
  }));
  const names = [products.find((product) => product.id === source.productId)?.name ?? source.productId];
  const card = queuedTask(
    {
      id: "footer-follow-up",
      productId: source.productId,
      title: followUpTitle(about),
      description: followUpDescription(reports.map((report) => ({ ...report, images: [] })), names),
      area: "footer",
      kind: "bug",
    },
    tasks.length,
    now,
    products,
  );
  tasks.push({
    ...card,
    state: "backlog",
    column: "backlog",
    statusLine: "Review the request before queueing",
    timeline: [{ id: "footer-follow-up-kept", at: now, text: "Kept as future work", tone: "status" }],
    followUp: { reports },
  });
}

export const byId = (id: string): Spec => {
  const spec = SPECS.find((entry) => entry.id === id);
  if (!spec) throw new Error(`unknown demo task ${id}`);
  return spec;
};

/** The clones first run's demo "finds": the demo products, newest first. */
export function demoClones(now: number): Clone[] {
  return DEMO_PRODUCTS.map((product, index) => ({
    path: `~/code/${product.repo.split("/")[1]}`,
    repo: product.repo,
    changedAt: now - index * 3_600_000,
  }));
}
