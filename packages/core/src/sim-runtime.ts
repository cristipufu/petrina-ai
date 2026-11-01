// Internal runtime state, work-log accounting, screen requests, and check runs for the deterministic Simulator.

import { followingCall } from "./call.js";
import { CLEANUP_WORDS, copyNoLongerNeeded } from "./cleanup.js";
import { columnOf, type DeepMutable } from "./flow.js";
import { beginPetrinaStep, endPetrinaStep, JOURNEY_WORDS, openStep, stepTag } from "./journey.js";
import { INBOX_CATALOG, INBOX_KINDS } from "./inbox-catalog.js";
import type { Column, DesignCall, Id, InboxItem, InboxKind, Stage, State, Task } from "./model.js";
import { DEMO_PLANNER_PROFILE } from "./profiles.js";
import { getProviderDescriptor } from "./providers.js";
import { repositoryPublished } from "./repositories.js";
import * as library from "./roles.js";
import { SCREEN_WORDS, screenMode, screenWait } from "./screen.js";
import { DEMO_CHECKS, simCheckSetup, simReport, simVersions } from "./sim-script.js";
import type { SimQuirk, Triggers } from "./sim-types.js";
import { resumeClock } from "./summary.js";
import {
  askMomentId,
  continuingAgentTurn,
  type AskAnswer,
  type MemoryWorkLog,
  type MomentOutcome,
  type TurnEnd,
  type TurnReason,
  turnTokens,
  type WorkMoment,
  type WorkStageKind
} from "./worklog.js";

export type Draft = DeepMutable<State>;
export type DraftTask = DeepMutable<Task>;

export const PLANNER_PROFILE = DEMO_PLANNER_PROFILE;
/** Requests are logged when raised and completed by an answer, as the engine does. */
export const ASKS: ReadonlySet<string> = new Set(
  INBOX_KINDS.filter((kind) => INBOX_CATALOG[kind].worklogAsk !== undefined),
);

export interface SimRuntime {
  readonly triggers: Triggers;
  readonly prMergeAfter: number;
  readonly tickMs: number;
  readonly work: MemoryWorkLog;
  readonly quirks: Readonly<Record<string, SimQuirk>>;
  readonly openTurns: Map<Id, { id: Id; startedAt: number; waitedMs: number; waitingSince?: number; first: boolean }>;
  readonly openStages: Map<Id, { stageId: Id; title: string; kind: WorkStageKind; roleId: Id; round: number; startedAt: number }>;
  readonly stageRuns: Map<Id, number>;
  serial: number;
  readonly pullRequestAges: Map<Id, number>;
  readonly disagree: ReadonlySet<Id>;
  readonly lockedCopies: ReadonlySet<Id>;
}

export function simId(d: Draft, prefix: string): Id {
  d.seq += 1;
  return `${prefix}-${d.seq}`;
}

export function simLog(d: Draft, task: DraftTask, tone: Task["timeline"][number]["tone"], text: string, roleId?: Id, profileId?: Id): void {
  const step = stepTag(task);
  task.timeline.push({
    id: simId(
    d,
    task.id
  ),
    at: d.now,
    text,
    tone,
    ...(roleId ? { roleId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(step ? { step } : {})
  });
}

export function simSay(d: Draft, task: DraftTask, from: Task["session"][number]["from"], text: string, roleId?: Id, profileId?: Id): void {
  const step = stepTag(task);
  task.session.push({
    id: simId(d, task.id),
    at: d.now,
    from,
    text,
    ...(from === "agent"
      ? {
          recording: {
            recordedLength: text.length,
            originalLength: text.length,
            complete: true,
            state: "finished" as const,
            revision: 1,
          },
        }
      : {}),
    ...(roleId ? { roleId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(step ? { step } : {}),
  });
}

export function simStage(task: DraftTask): DeepMutable<Stage> | undefined {
  return task.stageIndex < 0 ? undefined : task.plan?.stages[task.stageIndex];
}

export function simRound(task: DraftTask): number {
  const stage = simStage(task);
  return stage ? (task.rounds[stage.id] ?? 1) : 1;
}

/** The call the architect is following, while it works on the design stage the call settled. */
export function simFollowing(task: DraftTask): DesignCall | undefined {
  return task.sub === 0 ? followingCall(task) : undefined;
}

export function simColumnFor(d: Draft, task: DraftTask): Column {
  return columnOf(task, d.roles);
}

/** The profile the planner runs on, kept in the state so a queued task's journey can name it. */
export function simPlanner(d: Draft): Id {
  const id = d.planner ?? PLANNER_PROFILE;
  return d.profiles.find(profile => profile.id === id && !profile.standby)?.id ?? d.profiles.find(profile => !profile.standby)?.id ?? id;
}

/** Who should be working right now, given the stage and the sub-step. */
export function simNextAgent(d: Draft, task: DraftTask): { roleId: Id; profileId: Id } | undefined {
  if (task.stageIndex < 0) return { roleId: "planner", profileId: task.plan?.plannerProfileId ?? d.planner ?? PLANNER_PROFILE };
  const stage = simStage(task);
  if (!stage) return undefined;
  switch (stage.kind) {
    case "do":
      return stage.profileIds[0] ? { roleId: stage.roleId, profileId: stage.profileIds[0] } : undefined;
    case "converge":
      if (task.sub === 0) return stage.profileIds[0] ? { roleId: stage.roleId, profileId: stage.profileIds[0] } : undefined;
      return stage.reviewerRoleId && stage.reviewerProfileIds?.[0]
        ? { roleId: stage.reviewerRoleId, profileId: stage.reviewerProfileIds[0] }
        : undefined;
    case "review-chain": {
      const profileId = stage.profileIds[task.sub];
      return profileId ? { roleId: library.reviewerAt(stage, task.sub), profileId } : undefined;
    }
    case "gate":
      return undefined;
  }
}

/** Screen requests and their quiet inbox items follow the active request. */
export function simSyncScreen(d: Draft): void {
  if (d.pool.screen && d.pool.screen.mode !== screenMode(d.pool, d.now)) d.pool.screen = { mode: "off" };
  for (const task of d.tasks) {
    const wait = screenWait(task as Task, d as State, d.now);
    const item = d.inbox.find((entry) => entry.taskId === task.id && entry.kind === "screen");
    if (wait === "ask" && !item) {
      const request = task.screen!;
      d.inbox.push({
        id: simId(
        d,
        "inbox"
      ),
        taskId: task.id,
        kind: "screen",
        title: SCREEN_WORDS.needs(request.reason),
        body: SCREEN_WORDS.body,
        at: request.at,
        blocking: false,
        roleId: request.roleId,
        profileId: request.profileId
      });
    } else if (wait !== "ask" && item) d.inbox = d.inbox.filter((entry) => entry !== item);
    if (wait === "ask") task.statusLine = SCREEN_WORDS.needs(task.screen!.reason);
    else if (wait === "turn") task.statusLine = SCREEN_WORDS.turn;
    else if (task.state === "waiting" && task.screen && !task.screen.granted) task.statusLine = "Waiting for a free slot";
  }
}

/** The step ended, was paused or cancelled: free the screen. */
export function simReleaseScreen(d: Draft, task: DraftTask): void {
  delete task.screen;
  d.inbox = d.inbox.filter((item) => !(item.taskId === task.id && item.kind === "screen"));
}

/** Petrina's own run of the product's checks, before a review round's reviewers. In the demo they pass. */
export function simRunChecks(d: Draft, task: DraftTask): void {
  beginPetrinaStep(task, "checks", d.now);
  const step = openStep(task)!;
  for (const work of (task.repositories ?? [task]).filter((work) => !repositoryPublished(work))) {
    const tree = simVersions(task)[work.productId]!;
    const modeled = simCheckSetup(d.products.find(product => product.id === work.productId)!, tree, d.now,
      { before: simId(d, "demo-setup"), after: simId(d, "demo-setup") }, work.checkSetupInvalidated?.id);
    step.checkSetups = [...(step.checkSetups ?? []), modeled.before, modeled.after];
    work.checkSetup = modeled.after;
    delete work.checkSetupInvalidated;
    const results = DEMO_CHECKS.map((
      run,
      index
    ) => ({
      ...run,
      executor: modeled.executor,
      startedAt: d.now,
      endedAt: d.now,
      source: {
      stepId: step.id,
      attemptId: "run-0",
      checkId: `${task.repositories ? `${work.productId}:` : ""}check-${index}`
    }
    }));
    step.productChecks = [
      ...(step.productChecks ?? []),
      ...results.map((run) => ({
      id: run.source.checkId,
      attemptId: "run-0",
      productId: work.productId,
      name: run.name,
      result: "pass" as const,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      run
    }))
    ];
    work.checks = { at: d.now, tree, definition: modeled.input.definition, environment: modeled.environment, current: true, results };
  }
  simLog(d, task, "done", `Checks passed: ${DEMO_CHECKS.map((run) => run.name).join(", ")}`);
  endPetrinaStep(task, { outcome: JOURNEY_WORDS.checks(0, DEMO_CHECKS.length), reason: JOURNEY_WORDS.checksPassed }, d.now);
}

export function simRaise(
  rt: SimRuntime,
  d: Draft,
  task: DraftTask,
  kind: InboxKind,
  title: string,
  blocking: boolean,
  extra: { body?: string; options?: readonly string[]; detail?: string } = {},
): Id {
  task.state = "needs-you";
  const agent = task.agent;
  const id = simId(d, "inbox");
  d.inbox.push({
    id, taskId: task.id, kind, title, at: d.now, blocking,
    ...(agent ? { roleId: agent.roleId, profileId: agent.profileId } : {}),
    ...(extra.body ? { body: extra.body } : {}),
    ...(extra.options ? { options: [...extra.options] } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  });
  if (ASKS.has(kind)) simAskMoment(rt, d, task, d.inbox.at(-1)!);
  return id;
}

export function simUnblock(d: Draft, task: DraftTask): void {
  if (task.state !== "needs-you") return;
  task.state = task.holdsSlot ? "running" : "waiting";
  task.statusLine = task.holdsSlot ? "Back to work" : "Waiting for a free slot";
  if (task.holdsSlot && task.stepClock) task.stepClock = resumeClock(task.stepClock, d.now);
}

/** A finished task's working copy goes, to free disk space. One with an open pull request stays. */
export function simRemoveCopy(rt: SimRuntime, d: Draft, task: DraftTask): void {
  if (!copyNoLongerNeeded(task) || task.cleanup?.removedAt !== undefined) return;
  if (rt.lockedCopies.has(task.id) && !task.cleanup?.error) {
    task.cleanup = { error: CLEANUP_WORDS.locked };
    simLog(d, task, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.locked));
    return;
  }
  task.cleanup = { removedAt: d.now };
  simLog(d, task, "done", CLEANUP_WORDS.removed);
}

// ── The work log ─────────────────────────────────────────────────────────

export function simWrote(rt: SimRuntime, d: Draft): void {
  d.work = { version: (d.work?.version ?? 0) + 1, since: d.work?.since ?? rt.work.since() };
}

function simEntryId(rt: SimRuntime, prefix: string): Id {
  rt.serial += 1;
  return `${prefix}-${rt.serial}`;
}

function simStageContext(task: DraftTask): { stageId: Id; title: string; kind: WorkStageKind; roleId: Id } {
  const stage = simStage(task);
  if (!stage) return { stageId: `${task.id}:plan`, title: "Planning", kind: "plan", roleId: "planner" };
  return { stageId: stage.id, title: stage.title, kind: stage.kind, roleId: stage.roleId };
}

export function simMoment(rt: SimRuntime, d: Draft, task: DraftTask, moment: Omit<WorkMoment, "id" | "at" | "taskId" | "productId">, when: {
  id?: Id;
  at?: number
} = {}): void {
  const open = rt.openStages.get(task.id);
  const context = open ?? simStageContext(task);
  rt.work.addMoment({
    id: when.id ?? simEntryId(rt, `${task.id}-m`),
    at: when.at ?? d.now,
    taskId: task.id,
    productId: task.productId,
    ...(moment.kind === "task-end" ? {} : {
      stageId: context.stageId,
      stageTitle: context.title,
      stageKind: context.kind,
      round: context.kind === "converge" || context.kind === "review-chain" ? simRound(task) : (open?.round ?? simRound(task))
    }),
    ...moment,
  });
  simWrote(rt, d);
}

export function simBeginStage(rt: SimRuntime, d: Draft, task: DraftTask): void {
  const context = simStageContext(task);
  const open = rt.openStages.get(task.id);
  if (open?.stageId === context.stageId) return;
  if (open) simEndStage(rt, d, task, "done");
  const runs = (rt.stageRuns.get(context.stageId) ?? 0) + 1;
  rt.stageRuns.set(context.stageId, runs);
  const stage = simStage(task);
  const round = stage && (stage.kind === "converge" || stage.kind === "review-chain") ? (task.rounds[stage.id] ?? 1) : runs;
  rt.openStages.set(task.id, { ...context, round, startedAt: d.now });
  simMoment(rt, d, task, { kind: "stage-start", roleId: context.roleId });
}

export function simEndStage(rt: SimRuntime, d: Draft, task: DraftTask, outcome: MomentOutcome, stageId?: Id): void {
  const open = rt.openStages.get(task.id);
  if (!open || (stageId && open.stageId !== stageId)) return;
  const workMs = rt.work
    .turns({ taskId: task.id })
    .filter((turn) => turn.stageId === open.stageId && turn.startedAt >= open.startedAt)
    .reduce((sum, turn) => sum + (turn.workMs ?? 0), 0);
  simMoment(rt, d, task, { kind: "stage-end", outcome, roleId: open.roleId, durationMs: d.now - open.startedAt, workMs });
  rt.openStages.delete(task.id);
}

export function simDesignRound(rt: SimRuntime, d: Draft, task: DraftTask, stage: DeepMutable<Stage>, round: number, objections: number, blocking: number): void {
  simMoment(rt, d, task, {
    kind: "design-round",
    roleId: stage.roleId,
    ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}),
    ...(stage.reviewerRoleId ? { peerRoleId: stage.reviewerRoleId } : {}),
    ...(stage.reviewerProfileIds?.[0] ? { peerProfileId: stage.reviewerProfileIds[0] } : {}),
    round, count: objections, blocking,
  });
}

/** The coordinator answered something: how long it took and what it was. */
export function simAnswered(rt: SimRuntime, d: Draft, task: DraftTask, item: DeepMutable<InboxItem>, answer: AskAnswer): void {
  simAskMoment(rt, d, task, item, answer);
  if (item.kind === "question" && task.agent) simOpenTurn(rt, d, task, "answer");
  const open = rt.openTurns.get(task.id);
  if (item.kind === "permission" && open?.waitingSince !== undefined) {
    open.waitedMs += d.now - open.waitingSince;
    delete open.waitingSince;
  }
}

export function simAskMoment(rt: SimRuntime, d: Draft, task: DraftTask, item: DeepMutable<InboxItem>, answer?: AskAnswer): void {
  const ask = INBOX_CATALOG[item.kind].worklogAsk ?? "checkpoint";
  simMoment(
    rt,
    d,
    task,
    {
    kind: "ask",
    ask,
    ...(answer ? {
    answer,
    durationMs: Math.max(
    0,
    d.now - item.at
  )
  } : {}),
    ...(item.roleId ? { roleId: item.roleId } : {}),
    ...(item.profileId ? { profileId: item.profileId } : {})
  },
    {
    id: askMomentId(
    task.id,
    item.id
  ),
    at: item.at
  }
  );
}

export function simOpenTurn(rt: SimRuntime, d: Draft, task: DraftTask, reason: TurnReason): void {
  const agent = task.agent;
  if (!agent) return;
  simEndTurn(rt, d, task, "finished");
  const profile = d.profiles.find((entry) => entry.id === agent.profileId);
  const toolId = profile?.toolId ?? "unknown";
  const quirk = simQuirkFor(rt, task.id, agent.roleId, toolId);
  const open = rt.openStages.get(task.id);
  const context = open ?? { ...simStageContext(task), round: simRound(task) };
  // Design and review rounds come from the stage; a do stage's round is which run of it this is.
  const round = context.kind === "converge" || context.kind === "review-chain" ? simRound(task) : context.round;
  const asked = profile?.modelId ?? profile?.model;
  const ran = quirk.notConfirmed ? undefined : (quirk.ran ?? (asked ? {
    model: asked,
    name: getProviderDescriptor(toolId)?.simTokenProfile === "reasoning-single" ? asked : (profile?.model ?? asked),
    effort: profile?.effort ?? "high"
  } : undefined));
  const id = simEntryId(rt, `${task.id}-turn`);
  const first = !rt.work.turns({ taskId: task.id }).some((turn) => turn.roleId === agent.roleId);
  const journeyId = openStep(task)?.id;
  const agentSeat = simStage(task)?.kind === "review-chain" ? String(task.sub) : agent.roleId;
  // Demo clocks can move; saved identities stay stable when the same work continues.
  const previous = reason !== "first" ? continuingAgentTurn(rt.work.turns({ taskId: task.id }), {
    taskId: task.id, journeyId, agentSeat, roleId: agent.roleId, toolId, profileId: agent.profileId,
  }) : undefined;
  rt.work.addTurn({
    id, taskId: task.id, productId: task.productId, stageId: context.stageId, stageTitle: context.title, stageKind: context.kind,
    round, fixing: task.fixing, roleId: agent.roleId, toolId, profileId: agent.profileId,
    ...(asked ? { modelAsked: asked } : {}),
    ...(profile?.model ? { modelAskedName: profile.model } : {}),
    ...(profile?.effort ? { effortAsked: profile.effort } : {}),
    ...(ran ? { modelRan: ran.model, modelRanName: ran.name, effortRan: ran.effort } : {}),
    ...(first && quirk.changedTo?.model ? { modelChangedTo: quirk.changedTo.model } : {}),
    ...(first && quirk.changedTo?.effort ? { effortChangedTo: quirk.changedTo.effort } : {}),
    sessionId: previous?.sessionId ?? `${task.id}-agent-${agent.since}`,
    ...(journeyId ? { journeyId } : {}),
    agentRunId: previous?.agentRunId ?? id,
    agentSeat, reason, startedAt: d.now, mainOnly: false, helpers: 0,
  });
  rt.openTurns.set(task.id, { id, startedAt: d.now, waitedMs: 0, first });
  simWrote(rt, d);
}

function simQuirkFor(rt: SimRuntime, taskId: Id, roleId: Id, toolId: Id): SimQuirk {
  const quirk = rt.quirks[`${taskId}|${roleId}`];
  return quirk && (!quirk.toolId || quirk.toolId === toolId) ? quirk : {};
}

/** The practice turn finished, so guidance the tool had accepted now counts as heard. */
function simHearLive(task: DraftTask): void {
  let heard = false;
  for (const message of task.queued) {
    const receipt = message.deliveries?.main;
    if (receipt?.state !== "accepted") continue;
    receipt.state = "applied";
    (message.recipients ??= {}).main = true;
    for (const step of task.journey ?? []) for (const input of step.agentInputs ?? []) for (const update of input.updates ?? []) {
      if (update.messageId === message.id) update.delivery = "applied";
    }
    heard = true;
  }
  if (heard) task.queued = task.queued.filter(message => !message.recipients || !Object.values(message.recipients).every(Boolean));
}

export function simEndTurn(rt: SimRuntime, d: Draft, task: DraftTask, end: TurnEnd): void {
  const open = rt.openTurns.get(task.id);
  if ((end === "finished" || end === "interrupted") && open) simHearLive(task);
  if (!open) return;
  rt.openTurns.delete(task.id);
  const turn = rt.work.turn(open.id);
  if (!turn) return;
  const waited = open.waitedMs + (open.waitingSince !== undefined ? d.now - open.waitingSince : 0);
  const workMs = Math.max(0, d.now - open.startedAt - waited);
  const quirk = simQuirkFor(rt, task.id, turn.roleId, turn.toolId);
  const reported = end === "finished" || end === "interrupted";
  const silent = !reported || (open.first && quirk.noTokens);
  const helpers = open.first ? (quirk.helpers ?? 0) : 0;
  const roleResult = d.roles.find((role) => role.id === turn.roleId)?.result;
  const report = silent ? undefined : simReport(
    `${open.id}|${turn.profileId}`,
    turn.toolId,
    turn.modelChangedTo ?? turn.modelRan ?? turn.modelAsked ?? "",
    turn.roleId,
    workMs,
    open.first ? quirk : {},
    roleResult,
  );
  const counted = turnTokens({
    toolId: turn.toolId,
    ...(report ? { report } : {}),
    ...(turn.modelRanName ? { model: turn.modelRanName } : {}),
    rerouted: getProviderDescriptor(turn.toolId)?.simTokenProfile === "reasoning-single" && turn.modelChangedTo !== undefined,
    helpers
  });
  rt.work.endTurn(
    open.id,
    {
    end,
    endedAt: d.now,
    workMs,
    mainOnly: counted.mainOnly,
    helpers,
    ...(counted.tokens ? { tokens: counted.tokens } : {})
  },
    counted.lines
  );
  simWrote(rt, d);
}
