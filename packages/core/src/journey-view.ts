import { owedAcceptanceTest } from "./acceptance.js";
import { callOn, followingCall } from "./call.js";
import { decisionEvidence, incompleteCheckOutcome, latestCheckResults } from "./check-evidence.js";
import { DELIVERY_MODE_CATALOG } from "./delivery-modes.js";
import { isDelivery, legacyJourney, openStep, portReviewerIndex } from "./journey-recording.js";
import { flowStepMarks, landingOf, stepName, type Named } from "./journey-words.js";
import type {
  AgentProfile,
  Id,
  InboxItem,
  JourneyAcceptanceCheck,
  JourneyAsk,
  JourneyStep,
  JourneyTone,
  JourneyWait,
  JourneyWork,
  Role,
  Stage,
  Task,
} from "./model.js";
import { reviewerAt } from "./roles.js";
import { queueOf } from "./scheduler.js";

/**
 * A box on the journey.
 * - `done`, `failed` (stuck) and `cancelled`: it ended.
 * - `now`: the live step; `run` says whether its agent works, is paused, or waits for a slot or for other tasks.
 * - `you`: it waits for the coordinator (a check, a call, a question or permission under it).
 * - `next` and `ahead`: still in the plan, faint. The first says Next.
 */
export type JourneyNodeState = "done" | "failed" | "cancelled" | "now" | "you" | "next" | "ahead";

export interface JourneyNode {
  id: string;
  kind: JourneyStep["kind"];
  name: string;
  /** Short title for the flow node; round, update and repeat details use visual marks. */
  flowName?: string;
  roundMark?: number;
  updateMark?: boolean;
  repeatMark?: boolean;
  fixMark?: number;
  portMark?: boolean;
  callMark?: boolean;
  state: JourneyNodeState;
  run?: "working" | "paused" | "waiting";
  /** The task's live status line, on the live step, or on the next one while nothing is under way. */
  live?: string;
  roleId?: Id;
  profileId?: Id;
  /** Every agent on the step when several worked at once, `profileId` first. */
  team?: readonly Id[];
  fixing?: boolean;
  findingIds?: readonly Id[];
  result?: JourneyStep["result"];
  agentInputs?: JourneyStep["agentInputs"];
  productChecks?: JourneyStep["productChecks"];
  /** Why each fresh check run on this step was needed, as recorded then. */
  checkReasons?: JourneyStep["checkReasons"];
  builderConversation?: JourneyStep["builderConversation"];
  builderReturn?: JourneyStep["builderReturn"];
  /** `petrina`: what Petrina did. */
  work?: JourneyWork;
  stageId?: Id;
  waitsFor?: JourneyWait;
  waitsOn?: readonly { id: Id; title: string }[];
  waitReason?: string;
  waitStates?: JourneyStep["waitStates"];
  startedAt?: number;
  endedAt?: number;
  outcome?: string;
  acceptanceChecks?: readonly JourneyAcceptanceCheck[];
  /** Why the work moved on: the words on the arrow out. */
  reason?: string;
  tone: JourneyTone;
  asks: readonly JourneyAsk[];
  /** Recorded before journeys were: no times. */
  legacy?: boolean;
}

export interface JourneyView {
  start:
    | { kind: "started" | "created"; at: number }
    | { kind: "queued"; position: number }
    | { kind: "held" }
    | { kind: "backlog" };
  nodes: JourneyNode[];
  /** Where it ended: delivered, awaiting merge, cancelled, or finished without a confirmed delivery. */
  end?: { text: string; state: "done" | "pending" | "cancelled" | "unconfirmed" };
  /** After the faint steps, while the plan is not written yet. */
  rest?: string;
  /** A quiet note, for tasks that ran before journeys were recorded. */
  note?: string;
}

export interface JourneyContext {
  roles: readonly Pick<Role, "id" | "name" | "result">[];
  profiles: readonly AgentProfile[];
  tasks: readonly Task[];
  inbox: readonly InboxItem[];
  /** The profile the planner runs on. */
  planner?: Id;
}

type Planned = Omit<Named, "end" | "endedAt"> & { profileId?: Id };

/** Whether the review stage at `index` looks only at the builder's port: the first review stage from here, after a port. */
function portAt(task: Task, index: number): boolean {
  if (!task.reviewedTree || (!task.portReview && !task.updating?.head)) return false;
  return index === (task.plan?.stages ?? []).findIndex((stage, at) => at >= task.stageIndex && stage.kind === "review-chain");
}

/** One stage's steps, as the plan has them, from a position on: the design position, or a place in the stage's steps. */
function stageSteps(task: Task, stage: Stage, index: number, ctx: Pick<JourneyContext, "profiles" | "roles">, from = 0): Planned[] {
  const round = task.rounds[stage.id] ?? 1;
  const base = { stageId: stage.id, round: 1, sub: 0 };
  switch (stage.kind) {
    case "gate":
      return from === 0 ? [{ ...base, kind: "you", waitsFor: stage.gate ?? "delivery" }] : [];
    case "do": {
      // After its first pass, the tester runs again only for the testing it still owes: checking an acceptance repair, or
      // the final-code pass the engine schedules.
      if (ctx.roles.find((role) => role.id === stage.roleId)?.result === "checks" && task.testedPatch !== undefined && owedAcceptanceTest(task)?.stage !== index) {
        return [];
      }
      const agent: Planned = { ...base, kind: "agent", roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) };
      if (!isDelivery(stage, ctx.roles)) {
        return from === 0
          ? [{
            ...agent,
            ...(task.updating && index === task.stageIndex ? { update: true } : task.fixing && index === task.stageIndex ? { fixing: true } : {})
          }]
          : [];
      }
      // The release notes are written once: an interrupted delivery only publishes again.
      const notes = DELIVERY_MODE_CATALOG[task.delivery].requiresAgentPrepNotes && !(index === task.stageIndex && task.shipping?.prepared);
      return [...(notes ? [agent] : []), { ...base, kind: "petrina" as const, work: "delivery" as const }].slice(from);
    }
    case "converge": {
      const author: Planned = { ...base, kind: "agent", round, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) };
      // Following the coordinator's call, the architect alone works on the brief.
      if (index === task.stageIndex && followingCall(task)) return from === 0 ? [{ ...author, call: true }] : [];
      if (callOn(task, index) && index < task.stageIndex) return [];
      const reviewer: Planned = {
        ...base,
        kind: "agent",
        round,
        sub: 1,
        roleId: stage.reviewerRoleId ?? "design-reviewer",
        ...(stage.reviewerProfileIds?.[0] ? { profileId: stage.reviewerProfileIds[0] } : {}),
      };
      return [author, reviewer].slice(from);
    }
    case "review-chain": {
      if (from > 0) return [];
      // A port of an already reviewed change gets one reviewer, as the engine picks it.
      if (portAt(task, index)) {
        const reviewer = portReviewerIndex(task, stage.profileIds, (id) => ctx.profiles.find((profile) => profile.id === id)?.toolId, ctx.roles);
        const profileId = stage.profileIds[reviewer];
        return [{ ...base, kind: "agent", round, port: true, roleId: reviewerAt(stage, reviewer), ...(profileId ? { profileId } : {}) }];
      }
      // Every reviewer looks at the change at once: one step for the round.
      return [
        {
          ...base,
          kind: "agent",
          round,
          roleId: stage.roleId,
          ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}),
          ...(stage.profileIds.length > 1 ? { team: [...stage.profileIds] } : {}),
        },
      ];
    }
  }
}

/** The steps still ahead in the plan, from where the task is now. */
function plannedSteps(task: Task, open: JourneyStep | undefined, ctx: JourneyContext): Planned[] {
  const stages = task.plan?.stages ?? [];
  if (task.stageIndex < 0) {
    // At the plan check the whole plan is ahead; otherwise the planner has yet to write it.
    if (task.plan && open?.kind === "you" && open.waitsFor === "plan") return stages.flatMap((stage, index) => stageSteps(task, stage, index, ctx));
    if (open?.kind === "agent" && ctx.roles.find((role) => role.id === open.roleId)?.result === "plan") return [];
    const profileId = ctx.planner ?? task.plan?.plannerProfileId;
    const planner = ctx.roles.find((role) => role.result === "plan");
    return planner ? [{ kind: "agent", roleId: planner.id, round: 1, sub: 0, ...(profileId ? { profileId } : {}) }] : [];
  }
  const current = stages[task.stageIndex];
  if (!current) return [];
  // What the open step already covers in the current stage.
  const mine = open && open.stageId === current.id ? open : undefined;
  const all = stageSteps(task, current, task.stageIndex, ctx, current.kind === "converge" ? task.sub : 0);
  let here: Planned[];
  if (mine?.kind === "you" && current.kind !== "do") {
    here = (current.kind === "gate" && mine.waitsFor === (current.gate ?? "delivery")) || mine.waitsFor === "call" ? [] : all;
  } else if (mine?.kind === "you") {
    here = mine.waitsFor === "delivery" || mine.waitsFor === "stuck" || mine.waitsFor === "shipping" ? all : [];
  } else if (mine?.kind === "agent") {
    // After the architect, its reviewer; after the Release Manager, Petrina publishes. Voters are never planned.
    const coversStage = all.some((step) => step.kind === "agent" && step.roleId === mine.roleId);
    // Supporting roles run before the stage's own work; only its reviewers' fresh voters cover it too.
    if (current.kind === "review-chain" && ctx.roles.find((role) => role.id === mine.roleId)?.result === "votes") here = [];
    else if (!coversStage) here = all;
    else here = current.kind === "converge" ? stageSteps(task, current, task.stageIndex, ctx, task.sub + 1) : all.filter((step) => step.kind === "petrina");
  } else if (mine?.kind === "petrina") {
    // Petrina's checks come before the stage's own steps; once Petrina publishes, nothing else is left.
    here = mine.work === "delivery" ? [] : all;
  } else {
    here = all;
  }
  // A final-code tester pass, and a repair of what it found, return straight to the delivery check; they do not repeat the reviewers.
  // An earlier acceptance repair is tested, then the rest of the plan follows.
  const owed = owedAcceptanceTest(task);
  const finalTester = owed?.final ? owed.stage : -1;
  const deliveryCheck = finalTester >= 0 ? stages.findIndex((stage) => stage.kind === "gate" && stage.gate === "delivery") : -1;
  return [
    ...here,
    ...stages.flatMap((stage, index) =>
      index > task.stageIndex && (deliveryCheck < 0 || index <= finalTester || index >= deliveryCheck) ? stageSteps(task, stage, index, ctx) : [],
    ),
  ];
}

const FINISHED: readonly Task["state"][] = ["done", "pr-open", "cancelled"];

function endOf(task: Task): JourneyView["end"] {
  switch (landingOf(task)) {
    case "no-changes":
      return { text: "Completed · No product changes", state: "done" };
    case "cancelled":
      return { text: "Cancelled", state: "cancelled" };
    case "landed":
      if (task.release) return { text: `Released ${task.release.tag}`, state: "done" };
      if (task.landed) return { text: `Delivered locally to ${task.landed.branch}`, state: "done" };
      return { text: `Merged #${task.pr!.number}`, state: "done" };
    case "awaiting-merge":
      return { text: `Pull request #${task.pr!.number} · awaiting merge`, state: "pending" };
    case "closed":
      return { text: `Pull request #${task.pr!.number} closed without merging`, state: "unconfirmed" };
    case "marked-done":
      return { text: "Marked as done · delivery not confirmed", state: "unconfirmed" };
    case "open":
      return undefined;
  }
}

/**
 * The journey as the screen draws it: every recorded step in order, then the steps the plan still has
 * ahead, with a start point and, once it is over, an end point. Pure: the same task gives the same journey.
 */
export function journeyView(task: Task, ctx: JourneyContext): JourneyView {
  if (task.maintenance) ctx = { ...ctx, roles: [...ctx.roles.filter((role) => role.id !== task.maintenance!.role.id), task.maintenance.role] };
  const recorded: readonly JourneyStep[] = task.journey ?? legacyJourney(task, ctx.inbox, ctx.roles);
  const open = openStep({ journey: recorded });
  const finished = FINISHED.includes(task.state);
  const run: JourneyNode["run"] = task.state === "running" ? "working" : task.state === "paused" ? "paused" : "waiting";
  // The live step's line. A native retry comes ahead of the latest action, as on the card (summary.ts mainLine).
  const nowText = task.state === "running" && task.retrying ? task.retrying : task.statusLine;

  const nodes: JourneyNode[] = recorded.map((step, index) => {
    let state: JourneyNodeState;
    if (step.endedAt !== undefined || finished) {
      state = step.end === "failed" ? "failed" : step.end === "cancelled" || (step.endedAt === undefined && task.state === "cancelled") ? "cancelled" : "done";
    } else if (step.kind === "you" || step.asks?.some((ask) => ask.endedAt === undefined)) {
      state = "you";
    } else {
      state = "now";
    }
    const live = state === "now" || state === "you";
    const earlier = recorded.slice(0, index);
    const supporting = live && step.kind === "you" && step.waitsFor === "delivery" && !step.productChecks ? decisionEvidence(task) : undefined;
    const name = stepName(supporting ? { ...step, productChecks: supporting } : step, earlier, ctx.roles);
    const latestChecks = latestCheckResults(step.productChecks ?? []);
    const interruptedOutcome = step.work === "checks" && latestChecks.some((check) => check.run?.interruption) ? incompleteCheckOutcome(latestChecks) : undefined;
    const outcome = interruptedOutcome ?? step.outcome;
    return {
      id: step.id,
      kind: step.kind,
      name,
      ...flowStepMarks(step, name, earlier),
      state,
      ...(state === "now" ? { run } : {}),
      ...(live && nowText ? { live: nowText } : {}),
      ...(step.roleId ? { roleId: step.roleId } : {}),
      ...(step.profileId ? { profileId: step.profileId } : {}),
      ...(step.team ? { team: step.team } : {}),
      ...(step.fixing ? { fixing: true } : {}),
      ...(step.findingIds ? { findingIds: step.findingIds } : {}),
      ...(step.result ? { result: step.result } : {}),
      ...(step.agentInputs ? { agentInputs: step.agentInputs } : {}),
      ...(step.productChecks ? { productChecks: step.productChecks } : {}),
      ...(step.checkReasons ? { checkReasons: step.checkReasons } : {}),
      ...(step.builderReturn ? { builderReturn: step.builderReturn } : {}),
      ...(step.builderConversation ? { builderConversation: step.builderConversation } : {}),
      ...(step.work ? { work: step.work } : {}),
      ...(step.stageId ? { stageId: step.stageId } : {}),
      ...(step.waitsFor ? { waitsFor: step.waitsFor } : {}),
      ...(step.waitsOn ? { waitsOn: step.waitsOn } : {}),
      ...(step.waitReason ? { waitReason: step.waitReason } : {}),
      ...(step.waitStates ? { waitStates: step.waitStates } : {}),
      ...(step.legacy ? { legacy: true } : { startedAt: step.startedAt, ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}) }),
      ...(outcome ? { outcome } : {}),
      ...(step.acceptanceChecks ? { acceptanceChecks: step.acceptanceChecks } : {}),
      ...(interruptedOutcome ? { reason: interruptedOutcome } : step.reason ? { reason: step.reason } : {}),
      tone: step.tone ?? "on",
      asks: step.asks ?? [],
    };
  });

  if (!finished) {
    const ahead = task.state === "backlog" ? [] : plannedSteps(task, open, ctx);
    const named: Named[] = [...recorded];
    ahead.forEach((step, index) => {
      // While nothing is under way, the next step says what it waits for ("Waiting for a free slot", "Paused by you").
      const live = index === 0 && !open && task.state !== "queued" && task.statusLine ? { live: task.statusLine } : {};
      const name = stepName(step, named, ctx.roles);
      nodes.push({
        id: `ahead:${step.stageId ?? "plan"}:${step.sub}${step.kind === "petrina" ? `:${step.work}` : ""}`,
        kind: step.kind,
        name,
        ...flowStepMarks(step, name, named),
        state: index === 0 ? "next" : "ahead",
        ...live,
        ...(step.roleId ? { roleId: step.roleId } : {}),
        ...(step.profileId ? { profileId: step.profileId } : {}),
        ...(step.team ? { team: step.team } : {}),
        ...(step.work ? { work: step.work } : {}),
        ...(step.stageId ? { stageId: step.stageId } : {}),
        ...(step.waitsFor ? { waitsFor: step.waitsFor } : {}),
        tone: "on",
        asks: [],
      });
      named.push(step);
    });
  }

  const queue = queueOf(ctx.tasks);
  const start: JourneyView["start"] =
    task.state === "backlog"
      ? { kind: "backlog" }
      : task.state === "queued"
        ? task.held
          ? { kind: "held" }
          : { kind: "queued", position: Math.max(0, queue.findIndex((entry) => entry.id === task.id)) + 1 }
        : task.startedAt !== undefined
          ? { kind: "started", at: task.startedAt }
          : { kind: "created", at: task.createdAt };
  const writing = !finished && task.state !== "backlog" && task.stageIndex < 0 && !(open?.kind === "you" && open.waitsFor === "plan");
  const end = endOf(task);
  return {
    start,
    nodes,
    ...(end ? { end } : {}),
    ...(writing ? { rest: "The planner will choose the rest" } : {}),
    ...(recorded.some((step) => step.legacy) ? { note: "Earlier rounds were not recorded: this task ran before Petrina kept its journey." } : {}),
  };
}

/**
 * A small key for the parts of a task that affect its journey. Conversation lines, findings and check
 * output can change often or be large, but they do not change this view. The desktop uses this to
 * keep the diagram's nodes stable while unrelated session activity arrives.
 */
export function journeyViewKey(task: Task, ctx: JourneyContext): string {
  const taskView = {
    id: task.id,
    state: task.state,
    held: task.held,
    priority: task.priority,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    stageIndex: task.stageIndex,
    plan: task.plan,
    rounds: task.rounds,
    sub: task.sub,
    fixing: task.fixing,
    call: task.call,
    updating: task.updating ? [true, task.updating.head] : undefined,
    builderTool: task.builderSession?.toolId,
    portReview: task.portReview,
    reviewedTree: task.reviewedTree,
    testedPatch: task.testedPatch,
    retest: task.retest,
    repairCheck: task.repairCheck,
    repair: task.repair,
    proofDeliveryGate: task.proofDeliveryGate,
    delivery: task.delivery,
    shippingPrepared: task.shipping?.prepared,
    agent: task.agent && [task.agent.roleId, task.agent.profileId, task.agent.since],
    journey: task.journey,
    statusLine: task.statusLine,
    pr: task.pr,
    release: task.release,
    landed: task.landed,
  };
  const queued = ctx.tasks.filter((entry) => entry.state === "queued").map(({ id, priority }) => [id, priority]);
  const legacyInbox = task.journey
    ? undefined
    : ctx.inbox
        .filter((entry) => entry.taskId === task.id)
        .map(({ id, kind, blocking, roleId, profileId, at, title }) => [id, kind, blocking, roleId, profileId, at, title]);
  return JSON.stringify([
    taskView,
    ctx.roles.map(({ id, name, result }) => [id, name, result]),
    ctx.profiles.map(({ id, toolId }) => [id, toolId]),
    queued,
    legacyInbox,
    ctx.planner,
  ]);
}

/**
 * What is wrong with a recorded journey, if anything. The engine's and the simulator's tests run the
 * same checks, so the two cannot record journeys differently without a test saying so.
 */
export function journeyProblems(task: Task): string[] {
  const problems: string[] = [];
  const steps = task.journey ?? [];
  const ids = new Set<Id>();
  steps.forEach((step, index) => {
    if (ids.has(step.id)) problems.push(`${step.id} is recorded twice`);
    ids.add(step.id);
    const last = index === steps.length - 1;
    if (!last && step.endedAt === undefined) problems.push(`${step.id} was left open`);
    if (step.legacy) return;
    if (step.endedAt !== undefined && step.endedAt < step.startedAt) problems.push(`${step.id} ends before it starts`);
    const before = steps[index - 1];
    if (before && !before.legacy && step.startedAt < (before.endedAt ?? before.startedAt)) problems.push(`${step.id} starts before ${before.id} ends`);
    if (step.endedAt !== undefined && !step.outcome) problems.push(`${step.id} (${step.kind} ${step.roleId ?? step.waitsFor ?? ""}) does not say how it ended`);
    if (!last && step.endedAt !== undefined && step.end === "done" && !step.reason) {
      problems.push(`${step.id} (${step.kind} ${step.roleId ?? step.waitsFor ?? ""}) does not say why the work moved on`);
    }
    if (step.kind === "agent" && (!step.roleId || !step.profileId)) problems.push(`${step.id} does not name its role, tool and model`);
    for (const ask of step.asks ?? []) if (step.endedAt !== undefined && ask.endedAt === undefined) problems.push(`${step.id} ended with “${ask.title}” still open`);
  });
  for (const line of [...task.timeline, ...task.session]) {
    if (line.step && !ids.has(line.step)) problems.push(`“${line.text}” belongs to a step that was never recorded`);
  }
  if (FINISHED.includes(task.state) && openStep(task)) problems.push(`${task.state} with a step still open`);
  return problems;
}
