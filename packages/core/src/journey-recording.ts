import { exhaustedAcceptanceFailure, owedAcceptanceTest } from "./acceptance.js";
import { followingCall } from "./call.js";
import { evidenceFor, reusedCheckWords } from "./check-evidence.js";
import {
  dependencyLanding,
  JOURNEY_WORDS,
  quoteTitles,
  sameStep,
  type Landing,
  type StepKey,
} from "./journey-words.js";
import type {
  Id,
  InboxItem,
  InboxKind,
  JourneyAsk,
  JourneyStep,
  JourneyTone,
  JourneyWait,
  JourneyWork,
  RepositoryState,
  Role,
  Stage,
  Task,
} from "./model.js";
import { roleForTask } from "./roles.js";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type RoleSummary = readonly Pick<Role, "id" | "name" | "result">[];

/** What the recording helpers read and write: the engine's and the simulator's working copies of a task. */
export type JourneyTask = Pick<Task, "plan" | "stageIndex" | "rounds" | "sub" | "fixing" | "call" | "updating" | "portReview"> &
  Partial<Pick<Task, "findings" | "maintenance" | "repositories" | "acceptanceBlocked">> & { journey?: JourneyStep[] };

/** How a step ended, in a few words, and why the work moved on. */
export interface StepEnd {
  outcome?: string;
  reason?: string;
  tone?: JourneyTone;
  end?: JourneyStep["end"];
}

/** The step under way: the last one, while it has not ended. */
export function openStep(task: { journey?: readonly JourneyStep[] }): JourneyStep | undefined {
  const last = task.journey?.at(-1);
  return last && last.endedAt === undefined ? last : undefined;
}

/** The step a new timeline or session line belongs to: the latest one, ended or not. */
export function stepTag(task: { journey?: readonly JourneyStep[] }): Id | undefined {
  return task.journey?.at(-1)?.id;
}

type JourneyExecution = Pick<RepositoryState, "portReview" | "updating">;

/**
 * Where the task is: its stage (none while planning) and round, and the design position. A review round's reviewers
 * share one step; a review of the builder's port is a round of its own.
 */
export function placeOf(task: Omit<JourneyTask, "journey">, execution: JourneyExecution = task): Pick<StepKey, "stageId" | "round" | "sub" | "port"> {
  if (task.stageIndex < 0) return { round: 1, sub: 0 };
  const stage = task.plan?.stages[task.stageIndex];
  const rounds = stage && (stage.kind === "converge" || stage.kind === "review-chain");
  return {
    ...(stage ? { stageId: stage.id } : {}),
    round: rounds ? (task.rounds[stage.id] ?? 1) : 1,
    sub: stage?.kind === "converge" ? task.sub : 0,
    ...(execution.portReview && stage?.kind === "review-chain" ? { port: true } : {}),
  };
}

/**
 * The reviewer who looks at a port of an already reviewed change, by place in the stage's reviewers: the first on a
 * tool other than the latest builder's, or else the first. The engine then substitutes for unavailable tools.
 */
export function portReviewerIndex(
  task: Pick<Task, "plan" | "builderSession" | "maintenance">,
  profileIds: readonly Id[],
  toolOf: (profileId: Id) => Id | undefined,
  roles: RoleSummary,
): number {
  const builder =
    task.builderSession?.toolId ??
    toolOf(task.plan?.stages.find((stage) => roleForTask(roles, stage.roleId, task)?.result === "build")?.profileIds[0] ?? "");
  return Math.max(0, profileIds.findIndex((profileId) => toolOf(profileId) !== builder));
}

/** Which step the task is on for a role: where it is, and whether the builder fixes or brings the work up to date, or the architect follows the call. */
export function agentKey(task: Omit<JourneyTask, "journey">, roleId: Id, execution: JourneyExecution = task): StepKey {
  const stage = task.stageIndex < 0 ? undefined : task.plan?.stages[task.stageIndex];
  return {
    ...placeOf(task, execution),
    ...(execution.updating && stage?.kind === "do" ? { update: true } : task.fixing && stage?.kind === "do" ? { fixing: true } : {}),
    ...(task.sub === 0 && followingCall(task) ? { call: true } : {}),
    roleId,
  };
}

function push(task: JourneyTask, step: Omit<JourneyStep, "id">): JourneyStep {
  const previous = task.journey?.at(-1);
  const trigger = previous ? { after: previous.id, reason: previous.reason ?? previous.outcome ?? "Previous step ended" } : { reason: "Task started" };
  const recorded: JourneyStep = { id: `j${(task.journey?.length ?? 0) + 1}`, trigger, ...step };
  task.journey = [...(task.journey ?? []), recorded];
  return recorded;
}

function close(step: JourneyStep, at: number, how: StepEnd = {}): void {
  step.endedAt = Math.max(at, step.startedAt);
  step.end = how.end ?? "done";
  stopStepChecks(step, step.endedAt);
  if (how.outcome) step.outcome = how.outcome;
  if (how.reason) step.reason = how.reason;
  if (how.tone && how.tone !== "on") step.tone = how.tone;
  // Nothing asked in a step outlives it.
  if (step.asks?.some((ask) => ask.endedAt === undefined)) {
    step.asks = step.asks.map((ask) => (ask.endedAt === undefined ? { ...ask, endedAt: step.endedAt!, how: "withdrawn" } : ask));
  }
}

function stopStepChecks(step: JourneyStep, at: number): void {
  for (const check of step.productChecks ?? []) {
    if (check.result === "running" || check.result === "pending") {
      check.result = "stopped";
      check.endedAt = Math.max(at, check.startedAt ?? step.startedAt);
    }
  }
}

/** A stopped process leaves completed results intact; unfinished programs no longer claim to run. */
export function stopCheckProgress(task: Pick<JourneyTask, "journey">, at: number): void {
  for (const step of task.journey ?? []) stopStepChecks(step, at);
}

/**
 * An agent starts on the task's current step. Picking up after a restart, or resuming after a pause,
 * continues the same step; a new round, a send-back or a retry after getting stuck is a new one.
 * `team`: every agent on the step when several work at once (a review round's reviewers, its voters).
 */
export function beginAgentStep(
  task: JourneyTask,
  roleId: Id,
  profileId: Id,
  at: number,
  roles: RoleSummary,
  team?: readonly Id[],
  execution: JourneyExecution = task,
): JourneyStep {
  const key = agentKey(task, roleId, execution);
  const many = team ? { team: [...team] } : {};
  const open = openStep(task);
  if (open && sameStep(open, { kind: "agent", ...key })) {
    if (!open.team) open.profileId = profileId;
    if (many.team) Object.assign(open, many);
    return open;
  }
  if (open) close(open, at);
  const fixingFindings =
    task.fixing && (task.maintenance?.role.id === roleId ? task.maintenance.role : roles.find((role) => role.id === roleId))?.result === "build"
      ? {
          findingIds: (task.findings ?? [])
            .filter((finding) => finding.status === "open" && finding.severity !== "pre-existing" && !exhaustedAcceptanceFailure(task, finding))
            .map((finding) => finding.id),
        }
      : {};
  return push(task, { kind: "agent", usageTracked: true, ...key, ...fixingFindings, profileId: team?.[0] ?? profileId, ...many, startedAt: at });
}

/** Keep a step's saved evidence independent of later replies and fixes. */
export function recordStepResult(task: Pick<JourneyTask, "journey">, result: NonNullable<JourneyStep["result"]>): void {
  const step = openStep(task);
  if (step?.kind === "agent") step.result = JSON.parse(JSON.stringify({ ...step.result, ...result })) as NonNullable<JourneyStep["result"]>;
}

/** Record an accepted participant response; its caller owns parsing and any native attachments. */
export function recordAgentResult(step: JourneyStep | undefined, result: NonNullable<JourneyStep["agentResults"]>[number]): void {
  if (step) step.agentResults = [...(step.agentResults ?? []), result];
}

/** Bind an actual acceptance start to its prepared run and its place in the repair route. */
export function recordAcceptanceStart(
  task: Parameters<typeof owedAcceptanceTest>[0] & Pick<Task, "acceptanceRun" | "proofRetestReason">,
  step: JourneyStep,
  result: Role["result"],
  clone: <T>(value: T) => T,
): void {
  if (result !== "checks") return;
  if (task.acceptanceRun) step.proofRun = clone(task.acceptanceRun);
  const owed = !step.agentInputs?.length ? owedAcceptanceTest(task) : undefined;
  if (owed?.final) {
    step.trigger = {
      ...step.trigger,
      reason:
        task.proofRetestReason === "requested"
          ? "A reviewer asked for proof on the final code"
          : task.proofRetestReason === "main-moved"
            ? "Main moved since the proof was recorded"
            : task.proofRetestReason === "code-changed"
              ? "The task's code changed since acceptance testing"
              : "Final acceptance testing after review: the final code needs current acceptance evidence",
    };
  } else if (owed) {
    step.trigger = { ...step.trigger, reason: "Checking the builder's repair of the failed acceptance checks; the planned reviews follow" };
  }
}

/** Petrina starts on work of its own, with no agent: running the product's checks, or publishing the delivery. */
export function beginPetrinaStep(task: JourneyTask, work: JourneyWork, at: number, execution: JourneyExecution = task): JourneyStep {
  const key: StepKey = { ...placeOf(task, execution), work };
  const open = openStep(task);
  if (open && sameStep(open, { kind: "petrina", ...key })) return open;
  if (open) close(open, at);
  return push(task, { kind: "petrina", ...key, startedAt: at });
}

/** Petrina's own work ended: what happened, and why the work moved on. */
export function endPetrinaStep(task: JourneyTask, how: StepEnd, at: number): void {
  const open = openStep(task);
  if (open?.kind === "petrina") close(open, at, how);
}

/** Something Petrina found that moves the work, in a moment: a step of its own that begins and ends at once. */
export function petrinaMoment(task: JourneyTask, work: JourneyWork, how: StepEnd, at: number): void {
  const open = openStep(task);
  if (open?.kind === "petrina" && open.work === work) close(open, at, how);
  else {
    beginPetrinaStep(task, work, at);
    endPetrinaStep(task, how, at);
  }
}

/** The agent's step ended: what happened, and why the work moved on. */
export function endAgentStep(task: JourneyTask, how: StepEnd, at: number): void {
  const open = openStep(task);
  if (open?.kind === "agent") close(open, at, how);
}

/** An evidence handoff, never a check execution. Keep the original run and attempt intact. */
export function recordCheckReuse(task: JourneyTask, work: RepositoryState, at: number): void {
  if (!work.checks) return;
  const journey = task.journey ?? [];
  // Shared repairs finish several Builders before checks are read. Match this product's return,
  // then stop once its evidence has been handed on or fresh checks have followed that return.
  const returned = journey.findLastIndex((step) => step.builderReturn?.productId === work.productId && step.endedAt !== undefined);
  if (returned < 0) return;
  const following = journey.slice(returned + 1);
  if (following.some((step) => step.kind !== "you" && step.productChecks?.some((check) => check.productId === work.productId))) return;
  const evidence = evidenceFor(task, work);
  if (!evidence.length) return;
  const checks = evidence.map((check) => ({ ...check, reusedAt: at }));
  const outcome = reusedCheckWords(checks);
  petrinaMoment(
    task,
    "check-reuse",
    { outcome, reason: outcome, ...(checks.some((check) => check.result !== "pass" && check.result !== "skipped") ? { tone: "back" as const } : {}) },
    at,
  );
  const step = task.journey!.at(-1)!;
  step.productChecks = checks;
}

/** The task waits for the coordinator: a check, the call on a disagreement, a stuck task, interrupted shipping. */
export function beginYouStep(task: JourneyTask, waitsFor: JourneyWait, at: number): JourneyStep {
  const open = openStep(task);
  if (open?.kind === "you" && open.waitsFor === waitsFor) return open;
  if (open) close(open, at);
  const stage = task.stageIndex >= 0 ? task.plan?.stages[task.stageIndex] : undefined;
  return push(task, {
    kind: "you",
    waitsFor,
    ...(stage ? { stageId: stage.id } : {}),
    round: stage ? (task.rounds[stage.id] ?? 1) : 1,
    sub: task.sub,
    startedAt: at,
  });
}

/** The coordinator decided: what they decided, and the words on the arrow out. */
export function endYouStep(task: JourneyTask, how: StepEnd, at: number): void {
  const open = openStep(task);
  if (open?.kind === "you") close(open, at, how);
}

/** Whatever step is under way ends, for example because the task was cancelled. */
export function endOpenStep(task: JourneyTask, how: StepEnd, at: number): void {
  const open = openStep(task);
  if (open) close(open, at, how);
}

/** The agent asked the coordinator something: it hangs under the step that asked. */
export function addAsk(task: JourneyTask, ask: Pick<JourneyAsk, "id" | "kind" | "title" | "at">): void {
  const step = openStep(task) ?? task.journey?.at(-1);
  if (!step || step.asks?.some((entry) => entry.id === ask.id)) return;
  step.asks = [...(step.asks ?? []), { id: ask.id, kind: ask.kind, title: ask.title, at: ask.at }];
}

/** The coordinator answered, allowed, said no or let the agent decide; or the question went away. */
export function settleAsk(task: JourneyTask, itemId: Id, how: NonNullable<JourneyAsk["how"]>, at: number, answer?: string): void {
  for (const step of task.journey ?? []) {
    if (!step.asks?.some((ask) => ask.id === itemId && ask.endedAt === undefined)) continue;
    step.asks = step.asks.map((ask) =>
      ask.id === itemId && ask.endedAt === undefined ? { ...ask, endedAt: Math.max(at, ask.at), how, ...(answer ? { answer } : {}) } : ask,
    );
  }
}

/** Questions and requests that went away unanswered: a pause, a restart or cancelling dropped them. */
export function withdrawAsks(task: JourneyTask, itemIds: readonly Id[], at: number): void {
  for (const id of itemIds) settleAsk(task, id, "withdrawn", at);
}

/**
 * Keep the waiting-for-others step in line with what the task still waits for. It starts between
 * steps only (a step under way keeps its box), and ends saying which tasks landed.
 */
export function syncWait(
  task: JourneyTask & Pick<Task, "after">,
  blockers: readonly Pick<Task, "id" | "title">[],
  find: (id: Id) => Pick<Task, "state" | "title" | "pr" | "release" | "landed" | "repository" | "repositories"> | undefined,
  at: number,
): void {
  const open = openStep(task);
  if (open?.runtimeWait) return;
  if (blockers.length) {
    if (!open) push(task, { kind: "wait", round: 1, sub: 0, waitsOn: blockers.map(({ id, title }) => ({ id, title })), startedAt: at });
    else if (open.kind === "wait") {
      const added = blockers.filter((blocker) => !open.waitsOn?.some((entry) => entry.id === blocker.id));
      if (added.length) open.waitsOn = [...(open.waitsOn ?? []), ...added.map(({ id, title }) => ({ id, title }))];
    }
    return;
  }
  if (open?.kind !== "wait") return;
  const after = task.after ?? [];
  const still = (open.waitsOn ?? []).filter((entry) => after.includes(entry.id));
  const ended = (landing: Landing) =>
    still.flatMap((entry) => {
      const other = find(entry.id);
      return other && dependencyLanding(other) === landing ? [other.title] : [];
    });
  const parts = [
    ...(ended("landed").length ? [JOURNEY_WORDS.landed(ended("landed"))] : []),
    ...(ended("closed").length ? [JOURNEY_WORDS.othersClosed(ended("closed"))] : []),
    ...(ended("no-changes").length ? [`${quoteTitles(ended("no-changes"))} completed without product changes`] : []),
    ...(ended("marked-done").length ? [JOURNEY_WORDS.othersMarkedDone(ended("marked-done"))] : []),
    ...(ended("cancelled").length ? [JOURNEY_WORDS.othersCancelled(ended("cancelled"))] : []),
  ];
  const reason = parts.length ? parts.join("; ") : JOURNEY_WORDS.noLongerWaits;
  close(open, at, { outcome: capitalize(reason), reason });
}

/** A runtime hold keeps a part-finished group honest instead of claiming a completed review. */
export function syncRuntimeWaitJourney(
  task: {
    journey?: JourneyStep[];
    stageIndex: number;
    plan?: Task["plan"];
    rounds: Task["rounds"];
    sub: number;
    fixing: boolean;
    call?: Task["call"];
  },
  view: {
    held: boolean;
    reason: string;
    phase: "active" | "after-current-work" | "released";
    prerequisites: readonly { id: Id; title: string; state: string; landed: boolean; decisionNeeded: boolean }[];
    releaseReason?: string;
  },
  at: number,
): boolean {
  let open = openStep(task);
  if (view.held) {
    let added = false;
    if (!open) {
      open = push(task, { kind: "wait", runtimeWait: true, round: 1, sub: 0, startedAt: at });
      added = true;
    }
    if (open.kind === "you" || view.phase === "after-current-work") return added;
    // Compare only this annotation, never a group's potentially large exact input history.
    const annotation = () => JSON.stringify([open!.runtimeWait, open!.waitReason, open!.waitsOn, open!.waitStates, open!.outcome]);
    const before = annotation();
    open.runtimeWait = true;
    open.waitReason = view.reason;
    open.waitsOn = view.prerequisites.map(({ id, title }) => ({ id, title }));
    open.waitStates = view.prerequisites.map(({ id, state, landed, decisionNeeded }) => ({ id, state, landed, decisionNeeded }));
    if (open.kind === "agent" && open.seats?.length) {
      open.waitOutcome ??= { previous: open.outcome };
      const reported = new Set(
        (open.agentResults ?? []).map((result) => {
          const input = result.inputIndex === undefined ? undefined : open!.agentInputs?.[result.inputIndex];
          return input?.reviewerKey ?? input?.place ?? result.profileId;
        }),
      ).size;
      open.outcome = `${reported} of ${open.seats.length} reported; waiting for prerequisites`;
    }
    return added || before !== annotation();
  }
  if (open?.kind === "wait" && open.runtimeWait) {
    if (view.prerequisites.length) {
      open.waitStates = view.prerequisites.map(({ id, state, landed, decisionNeeded }) => ({ id, state, landed, decisionNeeded }));
    }
    close(open, at, { outcome: view.releaseReason ?? "The wait ended", reason: view.releaseReason ?? "The wait ended" });
    return true;
  } else if (open && open.kind !== "you" && open.runtimeWait) {
    delete open.waitReason;
    delete open.waitsOn;
    delete open.waitStates;
    delete open.runtimeWait;
    if (open.waitOutcome) {
      if (open.waitOutcome.previous !== undefined) open.outcome = open.waitOutcome.previous;
      else delete open.outcome;
      delete open.waitOutcome;
    }
    return true;
  }
  return false;
}

/** The plan's last stage: Petrina publishes the work, after the Release Manager's notes for a release. */
export function isDelivery(stage: Pick<Stage, "kind" | "roleId">, roles: RoleSummary): boolean {
  return stage.kind === "do" && roles.find((role) => role.id === stage.roleId)?.result === "delivery";
}

const LEGACY_WAITS: Partial<Record<InboxKind, JourneyWait>> = {
  plan: "plan",
  design: "design",
  delivery: "delivery",
  disagreement: "call",
  stuck: "stuck",
  shipping: "shipping",
};

/**
 * For a task that ran before journeys were recorded: one step per finished plan stage, without times
 * or rounds, then the step under way now: the agent at work or waiting on its question (with the
 * question under it), or the coordinator's step it waits at. New steps are recorded after these, and
 * picking up after a restart or an answer continues the step under way.
 */
export function legacyJourney(task: Task, inbox: readonly InboxItem[], roles: RoleSummary): JourneyStep[] {
  if (task.startedAt === undefined) return [];
  const at = task.startedAt;
  const steps: JourneyStep[] = [];
  const add = (step: Omit<JourneyStep, "id" | "round" | "sub" | "startedAt">) =>
    steps.push({ id: `j${steps.length + 1}`, round: 1, sub: 0, startedAt: at, ...step });
  const stages = task.plan?.stages ?? [];
  const finished = task.state === "pr-open" || task.state === "done";
  const ended = { endedAt: at, end: "done", legacy: true } as const;
  const planner = roles.find((role) => role.result === "plan");
  if (task.plan && planner) add({ kind: "agent", roleId: planner.id, profileId: task.plan.plannerProfileId, ...ended });
  for (const stage of stages.slice(0, Math.max(0, finished ? stages.length : task.stageIndex))) {
    const agent = {
      kind: "agent",
      stageId: stage.id,
      roleId: stage.roleId,
      ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}),
      ...ended,
    } as const;
    if (stage.kind === "gate") add({ kind: "you", stageId: stage.id, waitsFor: stage.gate ?? "delivery", ...ended });
    else if (isDelivery(stage, roles)) {
      // Petrina publishes; only a release has the Release Manager's notes first.
      if (task.delivery === "release") add(agent);
      add({ kind: "petrina", stageId: stage.id, work: "delivery", ...ended });
    } else add({ ...agent, ...(stage.kind === "review-chain" && stage.profileIds.length > 1 ? { team: [...stage.profileIds] } : {}) });
  }
  const live = !finished && task.state !== "cancelled";
  const asked = live
    ? inbox.filter((entry) => entry.taskId === task.id && entry.blocking && (entry.kind === "question" || entry.kind === "permission"))
    : [];
  const roleId = task.agent?.roleId ?? asked[0]?.roleId;
  const item = live ? inbox.find((entry) => entry.taskId === task.id && !entry.blocking) : undefined;
  const waits = item && LEGACY_WAITS[item.kind];
  const stage = task.stageIndex >= 0 ? stages[task.stageIndex] : undefined;
  // Delivering before the update, with no agent of its own now: Petrina's delivery was under way.
  if (roleId && stage && isDelivery(stage, roles) && task.delivery !== "release") {
    steps.push({
      id: `j${steps.length + 1}`,
      kind: "petrina",
      work: "delivery",
      ...placeOf(task),
      startedAt: task.agent?.since ?? asked[0]?.at ?? at,
    });
  } else if (roleId) {
    const profileId = task.agent?.profileId ?? asked[0]?.profileId;
    const asks = asked.map(({ id, kind, title, at: askedAt }): JourneyAsk => ({
      id,
      kind: kind === "question" ? "question" : "permission",
      title,
      at: askedAt,
    }));
    // A review round's reviewers look at once: one step for all of them.
    const team =
      stage?.kind === "review-chain" && roleId === stage.roleId && stage.profileIds.length > 1
        ? { profileId: stage.profileIds[0]!, team: [...stage.profileIds] }
        : profileId
          ? { profileId }
          : {};
    steps.push({
      id: `j${steps.length + 1}`,
      kind: "agent",
      ...agentKey(task, roleId),
      ...team,
      startedAt: task.agent?.since ?? asked[0]!.at,
      ...(asks.length ? { asks } : {}),
    });
  } else if (item && waits) {
    steps.push({
      id: `j${steps.length + 1}`,
      kind: "you",
      waitsFor: waits,
      ...(stage ? { stageId: stage.id } : {}),
      round: stage ? (task.rounds[stage.id] ?? 1) : 1,
      sub: task.sub,
      startedAt: item.at,
    });
  }
  return steps;
}
