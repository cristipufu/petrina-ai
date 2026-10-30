// Shared demo fixtures, fast-forward simulation, and thirty-day work-log synthesis.

import { AFTER_WORDS, syncWait } from "./journey.js";
import {
  attachSampleFollowUps,
  baseState,
  byId,
  DEMO_DISAGREE,
  DEMO_LOCKED,
  DEMO_PRODUCTS,
  DEMO_TRIGGERS,
  demoClones,
  demoUsage,
  MINUTE,
  queuedTask,
  type Spec,
} from "./demo-specs.js";
import type {
  CheckRun,
  CheckSetupAttempt,
  Id,
  InboxItem,
  JourneyProductCheck,
  JourneyStep,
  Product,
  State,
  Task,
  TaskKind,
  UsageReport,
} from "./model.js";
import { Simulator, type SimOpenWork, type SimQuirk, type Trigger, type Triggers } from "./sim.js";
import { askMomentId, MemoryWorkLog } from "./worklog.js";

export {
  attachSampleFollowUps,
  baseState,
  byId,
  DEMO_PRODUCTS,
  DEMO_TRIGGERS,
  demoClones,
  demoUsage,
  MINUTE,
  queuedTask,
  type Spec,
};

const TICK = 40_000;

export interface Placed {
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
export function fastForward(
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
  const sim = new Simulator(
    {
    ...baseState(
    start,
    [queuedTask(
    spec,
    0,
    start,
    products
  )]
  ),
    products
  },
    {
    triggers,
    prMergeAfter: 3,
    tickMs,
    log,
    quirks,
    disagree: DEMO_DISAGREE,
    lockedCopies: DEMO_LOCKED
  }
  );
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
  const shiftRun = (run: CheckRun): CheckRun => ({
    ...run,
    ...(run.startedAt !== undefined ? { startedAt: at(run.startedAt) } : {}),
    ...(run.endedAt !== undefined ? { endedAt: at(run.endedAt) } : {})
  });
  const shiftSetup = (attempt: CheckSetupAttempt): CheckSetupAttempt => ({ ...attempt, queuedAt: at(attempt.queuedAt),
    ...(attempt.startedAt !== undefined ? { startedAt: at(attempt.startedAt) } : {}), ...(attempt.endedAt !== undefined ? { endedAt: at(attempt.endedAt) } : {}),
    results: attempt.results.map(result => ({ ...result, run: shiftRun(result.run) })) });
  const shiftEvidence = (check: JourneyProductCheck): JourneyProductCheck => ({
    ...check,
    ...(check.queuedAt !== undefined ? { queuedAt: at(check.queuedAt) } : {}),
    ...(check.startedAt !== undefined ? { startedAt: at(check.startedAt) } : {}),
    ...(check.endedAt !== undefined ? { endedAt: at(check.endedAt) } : {}),
    ...(check.reusedAt !== undefined ? { reusedAt: at(check.reusedAt) } : {}),
    ...(check.run ? { run: shiftRun(check.run) } : {})
  });
  // Each fast-forward has its own id counter. Rename pending requests in both the inbox and log.
  const shiftedInbox = inbox.map((item) => ({ ...item, id: `${task.id}:${item.id}`, at: at(item.at) }));
  const requestIds = new Map(inbox.map((item, index) => [askMomentId(task.id, item.id), askMomentId(task.id, shiftedInbox[index]!.id)]));
  placed.log.shift(task.id, delta, requestIds);
  return {
    task: {
      ...task, priority, createdAt: at(task.createdAt) - 5 * MINUTE,
      ...(task.startedAt !== undefined ? { startedAt: at(task.startedAt) } : {}),
      ...(task.finishedAt !== undefined ? { finishedAt: at(task.finishedAt) } : {}),
      ...(task.agent ? { agent: { ...task.agent, since: at(task.agent.since) } } : {}),
      ...(task.stepClock?.since !== undefined ? { stepClock: { ...task.stepClock, since: at(task.stepClock.since) } } : {}),
      ...(task.steps ? { steps: task.steps.map((record) => ({ ...record, at: at(record.at) })) } : {}),
      ...(task.pr ? { pr: { ...task.pr, openedAt: at(task.pr.openedAt) } } : {}),
      ...(task.cleanup?.removedAt !== undefined ? { cleanup: { ...task.cleanup, removedAt: at(task.cleanup.removedAt) } } : {}),
      ...(task.checks ? { checks: { ...task.checks, at: at(task.checks.at), results: task.checks.results.map(shiftRun) } } : {}),
      ...(task.checkSetup ? { checkSetup: shiftSetup(task.checkSetup) } : {}),
      ...(task.checkSetupInvalidated ? { checkSetupInvalidated: { ...task.checkSetupInvalidated, at: at(task.checkSetupInvalidated.at) } } : {}),
      ...(task.screen ? { screen: { ...task.screen, at: at(task.screen.at) } } : {}),
      timeline: task.timeline.map((entry) => ({ ...entry, at: at(entry.at) })),
      session: task.session.map((line) => ({ ...line, at: at(line.at) })),
      ...(task.journey
        ? {
            journey: task.journey.map((step) => ({
              ...step, startedAt: at(step.startedAt),
              ...(step.endedAt !== undefined ? { endedAt: at(step.endedAt) } : {}),
              ...(step.productChecks ? { productChecks: step.productChecks.map(shiftEvidence) } : {}),
              ...(step.checkSetups ? { checkSetups: step.checkSetups.map(shiftSetup) } : {}),
              // A question or request is its inbox item, renamed below like the item.
              ...(step.asks ? { asks: step.asks.map((ask) => ({
                ...ask,
                id: `${task.id}:${ask.id}`,
                at: at(ask.at),
                ...(ask.endedAt !== undefined ? { endedAt: at(ask.endedAt) } : {})
              })) } : {}),
            })),
          }
        : {}),
    },
    inbox: shiftedInbox, log: placed.log, open: shiftOpen(placed.open, delta),
  };
}

function shiftOpen(open: SimOpenWork, delta: number): SimOpenWork {
  return {
    turns: open.turns.map(([taskId, turn]) => [
      taskId,
      {
      ...turn,
      startedAt: turn.startedAt + delta,
      ...(turn.waitingSince !== undefined ? { waitingSince: turn.waitingSince + delta } : {})
    }
    ]),
    stages: open.stages.map(([taskId, stage]) => [taskId, { ...stage, startedAt: stage.startedAt + delta }]),
    runs: open.runs, pullRequests: open.pullRequests,
  };
}

/** A queued task that starts after `on` lands: it says so, and its journey starts with the wait. */
export function waitingFor(task: Task, on: Task, at: number): Task {
  const draft: Task & { journey: JourneyStep[] } = { ...task, after: [on.id], journey: [] };
  syncWait(draft, [on], (id) => (id === on.id ? on : undefined), at);
  const said = { id: `${task.id}-after`, at, text: AFTER_WORDS.starts([on.title]), tone: "you" as const, step: draft.journey[0]!.id };
  return { ...draft, statusLine: AFTER_WORDS.waiting([on.title]), timeline: [...task.timeline, said] };
}

// ── History: thirty days of work, so every number in the app has something to show ──────

const DAY = 24 * 60 * MINUTE;

/** Collects the board, the inbox and the work log while a demo is put together. */
export class DemoBuilder {
  readonly tasks: Task[] = [];
  readonly inbox: InboxItem[] = [];
  readonly log: MemoryWorkLog;
  private open: SimOpenWork = { turns: [], stages: [], runs: [], pullRequests: [] };

  constructor(readonly now: number, readonly since: number) {
    this.log = new MemoryWorkLog(since);
  }

  place(placed: Placed, now: number, ago: number, priority: number): Task {
    const shifted = shift(placed, now, ago, priority);
    this.tasks.push(shifted.task);
    this.inbox.push(...shifted.inbox);
    this.log.absorb(shifted.log);
    this.open = {
      turns: [
      ...this.open.turns,
      ...shifted.open.turns
    ],
      stages: [
      ...this.open.stages,
      ...shifted.open.stages
    ],
      runs: [
      ...this.open.runs,
      ...shifted.open.runs
    ],
      pullRequests: [
      ...this.open.pullRequests,
      ...shifted.open.pullRequests
    ]
    };
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
export function addHistory(builder: DemoBuilder, products: readonly Product[], quirks: Record<string, SimQuirk>): void {
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
      const spec: Spec = {
        id,
        productId: product.id,
        title: work.title,
        description: work.description,
        area: work.area,
        kind: work.kind,
        approveDelivery: product.approveDelivery ?? true,
        delivery: product.delivery ?? "pull-request"
      };
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
      if (index % 3 === 0) triggers[`${id}|architect|1|1`] = {
        kind: "question",
        title: `Should ${work.area} be on for everyone at once?`,
        options: [
        "Yes",
        "Opt-in first"
      ]
      };
      if (index % 3 === 1) triggers[`${id}|builder|1|2`] = { kind: "permission", title: "Add a new package", detail: "npm install date-fns" };
      if (index % 4 === 2) triggers[`${id}|code-reviewer|1|1`] = { kind: "question", title: "Is the old export still used?", options: ["Yes", "No"] };
      const cancelled = index % 10 === 7;
      const placed = fastForward(
        spec,
        cancelled ? (task) => task.column === "building" && (task.agent?.step ?? 0) >= 2 : (task) => task.state === "done",
        triggers,
        [
        ...products,
        REMOVED
      ],
        quirks,
        index % 8 === 3 ? 4 : undefined,
        150_000
      );
      if (cancelled) {
        // Cancelled mid-build: that turn ends without a token report.
        const sim = new Simulator(
          {
          ...baseState(
          placed.task.timeline.at(-1)?.at ?? 0,
          [placed.task]
        ),
          products: [
          ...products,
          REMOVED
        ]
        },
          {
          log: placed.log,
          open: placed.open,
          quirks
        }
        );
        sim.cancel(id);
        placed.task = sim.getState().tasks[0]!;
        placed.open = { turns: [], stages: [], runs: [], pullRequests: [] };
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
  const base = {
    taskId: task.id,
    productId: task.productId,
    stageId: build.stageId,
    stageTitle: build.stageTitle,
    stageKind: build.stageKind,
    round: build.round,
    roleId: build.roleId,
    toolId: build.toolId,
    profileId: build.profileId
  };
  const reasons = ["limit", "agent-stopped", "unusable"] as const;
  log.addMoment({ ...base, id: `${task.id}-fail`, at: build.startedAt + 30_000, kind: "failure", outcome: reasons[index % reasons.length]! });
  log.addMoment({ ...base, id: `${task.id}-retry`, at: build.startedAt + 60_000, kind: "retry" });
  log.addMoment({ ...base, id: `${task.id}-redo`, at: (build.endedAt ?? build.startedAt) - 20_000, kind: "redo" });
}

export function trackingStart(now: number): number {
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

/** The permanent product list: every demo product, plus the removed one. */
export function recordProducts(log: MemoryWorkLog, products: readonly Product[], now: number): void {
  for (const product of products) log.recordProduct({ id: product.id, name: product.name, repo: product.repo, addedAt: now - 40 * DAY });
  log.recordProduct({ id: REMOVED.id, name: REMOVED.name, repo: REMOVED.repo, addedAt: now - 60 * DAY, removedAt: now - 12 * DAY });
}

/**
 * Thirty days of readings of each tool's limits, ending on the pool's current reports: every
 * window fills up over its length and drops at each reset. Claude Code's weekly window climbs
 * high each week, its 5-hour window saws through the day, and Codex's weekly window stays low.
 */
export function recordUsageHistory(log: MemoryWorkLog, now: number): void {
  const peaks: Record<string, readonly number[]> = {
    seven_day: [
    0.93,
    0.78,
    0.88,
    0.71
  ],
    five_hour: [
    0.55,
    0.3,
    0.7,
    0.45,
    0.6,
    0.35,
    0.5,
    0.65,
    0.4,
    0.58
  ],
    "codex:primary": [
    0.41,
    0.27,
    0.35,
    0.22
  ]
  };
  const readings: UsageReport[] = [];
  for (const current of demoUsage(now)) {
    const length = current.kind === "five_hour" ? 5 * 60 * MINUTE : 7 * DAY;
    const every = current.kind === "five_hour" ? 30 * MINUTE : 6 * 60 * MINUTE;
    const from = current.kind === "five_hour" ? now - 2 * DAY : now - 30 * DAY;
    const resetsAt = current.resetsAt!;
    for (let at = from; at < now; at += every) {
      // Which window the time falls in, counted back from the current one, and how far into it.
      const back = Math.ceil((resetsAt - at) / length) - 1;
      const start = resetsAt - (back + 1) * length;
      const peak = back === 0 ? current.utilization! / ((now - start) / length) : peaks[current.kind]![back % peaks[current.kind]!.length]!;
      const used = Math.round(peak * Math.pow((at - start) / length, 0.9) * 100) / 100;
      // Keep the sample's provider status independent of how full its window is.
      readings.push({ ...current, utilization: used, resetsAt: start + length, at });
    }
  }
  for (const reading of readings.sort((a, b) => a.at - b.at)) log.recordUsage(reading);
}

/** Demos already built, by kind and time. Building one fast-forwards dozens of tasks, and tests ask for the same one again and again. */
const built = new Map<string, Demo>();

/** A demo built once per kind and time. Each caller gets its own copy, free to change. */
export function remembered(key: string, build: () => Demo): Demo {
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
