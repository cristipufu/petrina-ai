// A task's journey: the steps it actually went through, in order, with every round, send-back and
// retry as a step of its own, then the steps its plan still has ahead. The engine and the simulator
// record it through these helpers and in these words, so the demo cannot drift from the real thing.
// The screen only draws what they recorded, and what the plan says comes next.

import { callOn, followingCall } from "./call.js";
import type { AgentProfile, Id, InboxItem, InboxKind, JourneyAcceptanceCheck, JourneyAsk, JourneyStep, JourneyTone, JourneyWait, JourneyWork, Role, Stage, Task } from "./model.js";
import { queueOf } from "./scheduler.js";
import { reviewerAt } from "./roles.js";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Task titles in quotes: “A”, “A” and “B”, “A”, “B” and “C”. */
export function quoteTitles(titles: readonly string[]): string {
  const quoted = titles.map((title) => `“${title}”`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : (quoted[0] ?? "");
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const JOURNEY_WORDS = {
  // What happened in a step, on its box.
  planned: (stages: number) => `Plan with ${plural(stages, "stage")}`,
  wroteBrief: "Wrote the brief",
  answeredAll: "Answered every objection",
  followed: "Brief follows your call",
  objections: (total: number, blocking: number) => (total === 0 ? "No objections" : `${plural(total, "objection")}, ${blocking} blocking`),
  wroteNotes: "Wrote notes",
  built: "Change ready",
  unchanged: "No changes to the code",
  fixed: (count: number) => (count ? `Fixed ${plural(count, "finding")}` : "Fixes ready"),
  checks: (failed: number, total: number) => (failed ? `${failed} of ${plural(total, "check")} failed` : total === 1 ? "The check passes" : total ? `All ${total} checks pass` : "Every check passes"),
  voted: (real: number, total: number) => `${total} checked: ${real} real`,
  foundChecks: (count: number) => (count ? `Found ${plural(count, "check")}` : "Found no checks"),
  couldNotFinish: "Could not finish",
  handedOn: "Work handed on",
  guidePoint: "Proposed a point for the review guide",
  noGuidePoint: "Nothing for the review guide",
  mainMoved: (files: number, source = "main") => `${plural(files, "file")} conflict${files === 1 ? "s" : ""} with ${source}`,
  broughtUpToDate: "Brought it up to date",
  askAgain: "Needs your OK again",
  mainMovedOn: "Main moved on",
  notReady: "Not ready to publish",
  notes: "Wrote the release notes",
  openedPr: (number: number) => `Opened pull request #${number}`,
  released: (tag: string) => `Published release ${tag}`,
  movedMain: (branch: string) => `Moved ${branch} forward`,
  stuck: "Stuck",
  stopped: "Stopped: you cancelled",
  interrupted: "Interrupted",
  alreadyOut: (what: string) => `Already out: ${what}`,
  approved: "Approved",
  changes: "Changes asked",
  madeCall: "Made the call",
  sided: "Sided with the architect",
  triedAgain: "Tried again",
  checkedAgain: "Checked again",
  shippedAgain: "Shipping again",
  markedDone: "Marked as done",
  cancelled: "Cancelled",
  // Why the work moved on, on the arrow out.
  planReady: "plan ready",
  briefReady: "brief ready",
  objectionsAnswered: "objections answered",
  followsCall: "brief follows your call",
  blocking: (count: number) => plural(count, "blocking objection"),
  noBlocking: "no blocking objections",
  notesReady: "notes ready",
  readyForReview: "ready for review",
  fixesReady: "fixes ready",
  checksFailed: (count: number) => `${plural(count, "check")} failed`,
  checksPassed: "checks passed",
  checksFound: "checks found",
  checksAsBefore: "the checks it had",
  toCheck: (count: number) => `${plural(count, "important finding")} to check`,
  sentBack: (count: number) => `sent back: ${count} important`,
  reviewPassed: "review passed",
  reviewAgain: "your changes get reviewed",
  stillOpen: (count: number) => `${count} important still open`,
  conflicts: (source = "main") => (source === "main" ? "main moved on" : `${source} moved on`),
  upToDate: "up to date with main",
  changedSinceApproval: "changed since you approved",
  releaseNotesReady: "release notes ready",
  readyAgain: "getting it ready again",
  backToBuilder: "back to the builder",
  agentChanged: "another agent took over",
  youApproved: "you approved",
  changesAsked: "changes asked",
  yourCall: "your call",
  youSided: "you sided with the architect",
  tryAgain: "you asked to try again",
  checkAgain: "you asked to check again",
  shipAgain: "you asked to ship it again",
  youMarkedDone: "you marked it as done",
  stuckReason: "stuck",
  shippingInterrupted: "shipping interrupted",
  landed: (titles: readonly string[]) => `${quoteTitles(titles)} landed`,
  // A prerequisite that finished without landing says so: it no longer holds the task back, but nothing landed.
  othersCancelled: (titles: readonly string[]) => `${quoteTitles(titles)} did not land: cancelled`,
  othersClosed: (titles: readonly string[]) => `${quoteTitles(titles)} did not land: closed without merging`,
  othersMarkedDone: (titles: readonly string[]) => `${quoteTitles(titles)} marked as done, delivery not confirmed`,
  noLongerWaits: "no longer waits",
} as const;

/**
 * How a task's work ended up, honestly. A pull request closed without merging did not land, and
 * "Mark as done" confirms no delivery. `open`: not finished yet.
 */
export type Landing = "landed" | "awaiting-merge" | "closed" | "marked-done" | "cancelled" | "open";

export function landingOf(task: Pick<Task, "state" | "pr" | "release" | "landed">): Landing {
  if (task.state === "cancelled") return "cancelled";
  if (task.release || task.landed || task.pr?.state === "merged") return "landed";
  // Recorded before "closed" was: a finished task whose pull request never merged.
  if (task.pr && (task.pr.state === "closed" || task.state === "done")) return "closed";
  if (task.pr && task.state === "pr-open") return "awaiting-merge";
  // A finished task with nothing delivered on record: the coordinator marked it as done.
  return task.state === "done" ? "marked-done" : "open";
}

/** Waiting for other tasks to land: the timeline's words and the task's status line. */
export const AFTER_WORDS = {
  starts: (titles: readonly string[]) => `It starts after ${quoteTitles(titles)} land${titles.length === 1 ? "s" : ""}`,
  none: "It no longer waits for other tasks",
  waiting: (titles: readonly string[]) => `Waiting for “${titles[0]}”${titles.length > 1 ? ` and ${titles.length - 1} more` : ""} to land`,
} as const;

/** The coordinator's steps, by what they wait for. */
export const YOU_STEP_NAMES: Readonly<Record<JourneyWait, string>> = {
  plan: "Your plan check",
  design: "Your design check",
  delivery: "Your delivery check",
  call: "Your call",
  stuck: "Stuck",
  shipping: "Shipping interrupted",
};

/** Petrina's own steps, by what it did. */
export const PETRINA_STEP_NAMES: Readonly<Record<JourneyWork, string>> = {
  checks: "Automated checks",
  update: "Update branch",
  delivery: "Publish delivery",
};

// ── Recording: the engine and the simulator call these as the task moves ───────────────────

/** What the recording helpers read and write: the engine's and the simulator's working copies of a task. */
export type JourneyTask = Pick<Task, "plan" | "stageIndex" | "rounds" | "sub" | "fixing" | "call" | "updating" | "portReview"> & Partial<Pick<Task, "findings">> & { journey?: JourneyStep[] };

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

type StepKey = Pick<JourneyStep, "stageId" | "round" | "sub" | "fixing" | "update" | "port" | "call" | "roleId" | "work">;

/**
 * Where the task is: its stage (none while planning) and round, and the design position. A review round's reviewers
 * share one step; a review of the builder's port is a round of its own.
 */
function placeOf(task: Omit<JourneyTask, "journey">): Pick<StepKey, "stageId" | "round" | "sub" | "port"> {
  if (task.stageIndex < 0) return { round: 1, sub: 0 };
  const stage = task.plan?.stages[task.stageIndex];
  const rounds = stage && (stage.kind === "converge" || stage.kind === "review-chain");
  return {
    ...(stage ? { stageId: stage.id } : {}),
    round: rounds ? (task.rounds[stage.id] ?? 1) : 1,
    sub: stage?.kind === "converge" ? task.sub : 0,
    ...(task.portReview && stage?.kind === "review-chain" ? { port: true } : {}),
  };
}

/**
 * The reviewer who looks at a port of an already reviewed change, by place in the stage's reviewers: the first on a
 * tool other than the latest builder's, or else the first. The engine then substitutes for unavailable tools.
 */
export function portReviewerIndex(task: Pick<Task, "plan" | "builderSession">, profileIds: readonly Id[], toolOf: (profileId: Id) => Id | undefined): number {
  const builder = task.builderSession?.toolId ?? toolOf(task.plan?.stages.find((stage) => stage.roleId === "builder")?.profileIds[0] ?? "");
  return Math.max(0, profileIds.findIndex((profileId) => toolOf(profileId) !== builder));
}

/** Which step the task is on for a role: where it is, and whether the builder fixes or brings the work up to date, or the architect follows the call. */
function agentKey(task: Omit<JourneyTask, "journey">, roleId: Id): StepKey {
  const stage = task.stageIndex < 0 ? undefined : task.plan?.stages[task.stageIndex];
  return {
    ...placeOf(task),
    ...(task.updating && stage?.kind === "do" ? { update: true } : task.fixing && stage?.kind === "do" ? { fixing: true } : {}),
    ...(task.sub === 0 && followingCall(task) ? { call: true } : {}),
    roleId,
  };
}

function sameStep(a: StepKey & Pick<JourneyStep, "kind">, b: StepKey & Pick<JourneyStep, "kind">): boolean {
  return (
    a.kind === b.kind &&
    a.roleId === b.roleId &&
    a.work === b.work &&
    a.stageId === b.stageId &&
    a.round === b.round &&
    a.sub === b.sub &&
    !!a.fixing === !!b.fixing &&
    !!a.update === !!b.update &&
    !!a.port === !!b.port &&
    !!a.call === !!b.call
  );
}

function push(task: JourneyTask, step: Omit<JourneyStep, "id">): JourneyStep {
  const recorded: JourneyStep = { id: `j${(task.journey?.length ?? 0) + 1}`, ...step };
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
  if (step.asks?.some((ask) => ask.endedAt === undefined)) step.asks = step.asks.map((ask) => (ask.endedAt === undefined ? { ...ask, endedAt: step.endedAt!, how: "withdrawn" } : ask));
}

function stopStepChecks(step: JourneyStep, at: number): void {
  for (const check of step.productChecks ?? []) if (check.result === "running" || check.result === "pending") {
    check.result = "stopped";
    check.endedAt = Math.max(at, check.startedAt ?? step.startedAt);
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
export function beginAgentStep(task: JourneyTask, roleId: Id, profileId: Id, at: number, team?: readonly Id[]): JourneyStep {
  const key = agentKey(task, roleId);
  const many = team ? { team: [...team] } : {};
  const open = openStep(task);
  if (open && sameStep(open, { kind: "agent", ...key })) {
    if (!open.team) open.profileId = profileId;
    if (many.team) Object.assign(open, many);
    return open;
  }
  if (open) close(open, at);
  const fixingFindings = task.fixing && roleId === "builder"
    ? { findingIds: (task.findings ?? []).filter((finding) => finding.status === "open" && finding.severity !== "pre-existing").map((finding) => finding.id) }
    : {};
  return push(task, { kind: "agent", ...key, ...fixingFindings, profileId: team?.[0] ?? profileId, ...many, startedAt: at });
}

/** Keep a step's actual handoff independent of later replies and fixes. */
export function recordStepResult(task: Pick<JourneyTask, "journey">, result: NonNullable<JourneyStep["result"]>): void {
  const step = openStep(task);
  if (step?.kind === "agent") step.result = JSON.parse(JSON.stringify({ ...step.result, ...result })) as NonNullable<JourneyStep["result"]>;
}

/** Petrina starts on work of its own, with no agent: running the product's checks, or publishing the delivery. */
export function beginPetrinaStep(task: JourneyTask, work: JourneyWork, at: number): JourneyStep {
  const key: StepKey = { ...placeOf(task), work };
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

/** The task waits for the coordinator: a check, the call on a disagreement, a stuck task, interrupted shipping. */
export function beginYouStep(task: JourneyTask, waitsFor: JourneyWait, at: number): JourneyStep {
  const open = openStep(task);
  if (open?.kind === "you" && open.waitsFor === waitsFor) return open;
  if (open) close(open, at);
  const stage = task.stageIndex >= 0 ? task.plan?.stages[task.stageIndex] : undefined;
  return push(task, { kind: "you", waitsFor, ...(stage ? { stageId: stage.id } : {}), round: stage ? (task.rounds[stage.id] ?? 1) : 1, sub: task.sub, startedAt: at });
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
    step.asks = step.asks.map((ask) => (ask.id === itemId && ask.endedAt === undefined ? { ...ask, endedAt: Math.max(at, ask.at), how, ...(answer ? { answer } : {}) } : ask));
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
export function syncWait(task: JourneyTask & Pick<Task, "after">, blockers: readonly Pick<Task, "id" | "title">[], find: (id: Id) => Pick<Task, "state" | "title" | "pr" | "release" | "landed"> | undefined, at: number): void {
  const open = openStep(task);
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
      return other && landingOf(other) === landing ? [other.title] : [];
    });
  const parts = [
    ...(ended("landed").length ? [JOURNEY_WORDS.landed(ended("landed"))] : []),
    ...(ended("closed").length ? [JOURNEY_WORDS.othersClosed(ended("closed"))] : []),
    ...(ended("marked-done").length ? [JOURNEY_WORDS.othersMarkedDone(ended("marked-done"))] : []),
    ...(ended("cancelled").length ? [JOURNEY_WORDS.othersCancelled(ended("cancelled"))] : []),
  ];
  const reason = parts.length ? parts.join("; ") : JOURNEY_WORDS.noLongerWaits;
  close(open, at, { outcome: capitalize(reason), reason });
}

const LEGACY_WAITS: Partial<Record<InboxKind, JourneyWait>> = { plan: "plan", design: "design", delivery: "delivery", disagreement: "call", stuck: "stuck", shipping: "shipping" };

/**
 * For a task that ran before journeys were recorded: one step per finished plan stage, without times
 * or rounds, then the step under way now: the agent at work or waiting on its question (with the
 * question under it), or the coordinator's step it waits at. New steps are recorded after these, and
 * picking up after a restart or an answer continues the step under way.
 */
export function legacyJourney(task: Task, inbox: readonly InboxItem[]): JourneyStep[] {
  if (task.startedAt === undefined) return [];
  const at = task.startedAt;
  const steps: JourneyStep[] = [];
  const add = (step: Omit<JourneyStep, "id" | "round" | "sub" | "startedAt">) => steps.push({ id: `j${steps.length + 1}`, round: 1, sub: 0, startedAt: at, ...step });
  const stages = task.plan?.stages ?? [];
  const finished = task.state === "pr-open" || task.state === "done";
  const ended = { endedAt: at, end: "done", legacy: true } as const;
  if (task.plan) add({ kind: "agent", roleId: "planner", profileId: task.plan.plannerProfileId, ...ended });
  for (const stage of stages.slice(0, Math.max(0, finished ? stages.length : task.stageIndex))) {
    const agent = { kind: "agent", stageId: stage.id, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}), ...ended } as const;
    if (stage.kind === "gate") add({ kind: "you", stageId: stage.id, waitsFor: stage.gate ?? "delivery", ...ended });
    else if (isDelivery(stage)) {
      // Petrina publishes; only a release has the Release Manager's notes first.
      if (task.delivery === "release") add(agent);
      add({ kind: "petrina", stageId: stage.id, work: "delivery", ...ended });
    } else add({ ...agent, ...(stage.kind === "review-chain" && stage.profileIds.length > 1 ? { team: [...stage.profileIds] } : {}) });
  }
  const live = !finished && task.state !== "cancelled";
  const asked = live ? inbox.filter((entry) => entry.taskId === task.id && entry.blocking && (entry.kind === "question" || entry.kind === "permission")) : [];
  const roleId = task.agent?.roleId ?? asked[0]?.roleId;
  const item = live ? inbox.find((entry) => entry.taskId === task.id && !entry.blocking) : undefined;
  const waits = item && LEGACY_WAITS[item.kind];
  const stage = task.stageIndex >= 0 ? stages[task.stageIndex] : undefined;
  // Delivering before the update, with no agent of its own now: Petrina's delivery was under way.
  if (roleId && stage && isDelivery(stage) && task.delivery !== "release") steps.push({ id: `j${steps.length + 1}`, kind: "petrina", work: "delivery", ...placeOf(task), startedAt: task.agent?.since ?? asked[0]?.at ?? at });
  else if (roleId) {
    const profileId = task.agent?.profileId ?? asked[0]?.profileId;
    const asks = asked.map(({ id, kind, title, at: askedAt }): JourneyAsk => ({ id, kind: kind === "question" ? "question" : "permission", title, at: askedAt }));
    // A review round's reviewers look at once: one step for all of them.
    const team = stage?.kind === "review-chain" && roleId === stage.roleId && stage.profileIds.length > 1 ? { profileId: stage.profileIds[0]!, team: [...stage.profileIds] } : profileId ? { profileId } : {};
    steps.push({ id: `j${steps.length + 1}`, kind: "agent", ...agentKey(task, roleId), ...team, startedAt: task.agent?.since ?? asked[0]!.at, ...(asks.length ? { asks } : {}) });
  } else if (item && waits) steps.push({ id: `j${steps.length + 1}`, kind: "you", waitsFor: waits, ...(stage ? { stageId: stage.id } : {}), round: stage ? (task.rounds[stage.id] ?? 1) : 1, sub: task.sub, startedAt: item.at });
  return steps;
}

// ── Reading: what the screen draws ──────────────────────────────────────────────────────────

/** The fields a step's name comes from, for recorded and planned steps alike. */
type Named = Pick<JourneyStep, "kind" | "stageId" | "round" | "sub" | "fixing" | "update" | "port" | "call" | "roleId" | "team" | "work" | "waitsFor" | "end" | "endedAt">;

/**
 * A step's name. Repeats say so: "Architect (round 2)", "Builder (fixes)", "Builder (fixes 2)",
 * "Builder (update)", "Architect (your call)", "Code reviewers (round 2)" for reviewers looking at once,
 * "Code reviewer (port)" for a review of the builder's port, "Petrina's checks (round 2)", and "(again)" for a
 * retry after getting stuck. Main moving on is not a round of anything.
 */
export function stepName(step: Named, earlier: readonly Named[], roles: readonly Pick<Role, "id" | "name">[]): string {
  if (step.kind === "you") return YOU_STEP_NAMES[step.waitsFor ?? "delivery"];
  if (step.kind === "wait") return "Waiting for others";
  const same = earlier.filter((entry) => sameStep(entry, step));
  if (step.kind === "petrina") {
    const place = step.work === "update" ? [] : step.port ? ["port"] : step.round > 1 ? [`round ${step.round}`] : [];
    const parts = [...place, ...(same.length ? ["again"] : [])];
    const name = PETRINA_STEP_NAMES[step.work ?? "delivery"];
    return parts.length ? `${name} (${parts.join(", ")})` : name;
  }
  const one = roles.find((entry) => entry.id === step.roleId)?.name ?? "Agent";
  const role = (step.team?.length ?? 0) > 1 ? `${one}s` : one;
  const parts: string[] = [];
  if (step.call) parts.push("your call");
  else if (step.update) parts.push("update");
  else if (step.fixing) {
    const fixes = earlier.filter((entry) => entry.kind === "agent" && entry.fixing && entry.roleId === step.roleId && entry.stageId === step.stageId && entry.endedAt !== undefined && (entry.end ?? "done") === "done").length;
    parts.push(fixes ? `fixes ${fixes + 1}` : "fixes");
  } else if (step.port) parts.push("port");
  else if (step.round > 1) parts.push(`round ${step.round}`);
  const last = same.at(-1);
  if (last && (!step.fixing || (last.end !== undefined && last.end !== "done"))) parts.push("again");
  return parts.length ? `${role} (${parts.join(", ")})` : role;
}

function flowStepMarks(step: Named, name: string, earlier: readonly Named[]) {
  const flowName = name.replace(/\s+\([^)]*\)$/, "");
  const roundMark = step.round > 1 && !step.update && !step.fixing && !step.call && !step.port ? step.round : undefined;
  const updateMark = !!step.update || (step.kind === "petrina" && step.work === "update");
  const repeatMark = name.endsWith("again)") || earlier.some((entry) => sameStep(entry, step));
  const fixMark = step.fixing ? Number(name.match(/\(fixes(?: (\d+))?/)?.[1] ?? 1) : undefined;
  const portMark = !!step.port;
  const callMark = !!step.call;
  return {
    flowName,
    ...(roundMark ? { roundMark } : {}),
    ...(updateMark ? { updateMark: true } : {}),
    ...(repeatMark ? { repeatMark: true } : {}),
    ...(fixMark ? { fixMark } : {}),
    ...(portMark ? { portMark: true } : {}),
    ...(callMark ? { callMark: true } : {}),
  };
}

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
  builderConversation?: JourneyStep["builderConversation"];
  /** `petrina`: what Petrina did. */
  work?: JourneyWork;
  stageId?: Id;
  waitsFor?: JourneyWait;
  waitsOn?: readonly { id: Id; title: string }[];
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
  start: { kind: "started"; at: number } | { kind: "queued"; position: number } | { kind: "held" } | { kind: "backlog" };
  nodes: JourneyNode[];
  /** Where it ended: delivered, awaiting merge, cancelled, or finished without a confirmed delivery. */
  end?: { text: string; state: "done" | "pending" | "cancelled" | "unconfirmed" };
  /** After the faint steps, while the plan is not written yet. */
  rest?: string;
  /** A quiet note, for tasks that ran before journeys were recorded. */
  note?: string;
}

export interface JourneyContext {
  roles: readonly Pick<Role, "id" | "name">[];
  profiles: readonly AgentProfile[];
  tasks: readonly Task[];
  inbox: readonly InboxItem[];
  /** The profile the planner runs on. */
  planner?: Id;
}

type Planned = Omit<Named, "end" | "endedAt"> & { profileId?: Id };

/** The plan's last stage: Petrina publishes the work, after the Release Manager's notes for a release. */
function isDelivery(stage: Pick<Stage, "kind" | "roleId">): boolean {
  return stage.kind === "do" && stage.roleId === "release-manager";
}

/** Whether the review stage at `index` looks only at the builder's port: the first review stage from here, after a port. */
function portAt(task: Task, index: number): boolean {
  if (!task.reviewedTree || (!task.portReview && !task.updating?.head)) return false;
  return index === (task.plan?.stages ?? []).findIndex((stage, at) => at >= task.stageIndex && stage.kind === "review-chain");
}

/** One stage's steps, as the plan has them, from a position on: the design position, or a place in the stage's steps. */
function stageSteps(task: Task, stage: Stage, index: number, ctx: Pick<JourneyContext, "profiles">, from = 0): Planned[] {
  const round = task.rounds[stage.id] ?? 1;
  const base = { stageId: stage.id, round: 1, sub: 0 };
  switch (stage.kind) {
    case "gate":
      return from === 0 ? [{ ...base, kind: "you", waitsFor: stage.gate ?? "delivery" }] : [];
    case "do": {
      // After its first pass, the tester runs again only when the engine schedules the final-code pass.
      if (stage.roleId === "tester" && task.testedPatch !== undefined && !task.retest) return [];
      const agent: Planned = { ...base, kind: "agent", roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) };
      if (!isDelivery(stage)) return from === 0 ? [{ ...agent, ...(task.updating && index === task.stageIndex ? { update: true } : task.fixing && index === task.stageIndex ? { fixing: true } : {}) }] : [];
      // The release notes are written once: an interrupted delivery only publishes again.
      const notes = task.delivery === "release" && !(index === task.stageIndex && task.shipping?.prepared);
      return [...(notes ? [agent] : []), { ...base, kind: "petrina" as const, work: "delivery" as const }].slice(from);
    }
    case "converge": {
      const author: Planned = { ...base, kind: "agent", round, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) };
      // Following the coordinator's call, the architect alone works on the brief.
      if (index === task.stageIndex && followingCall(task)) return from === 0 ? [{ ...author, call: true }] : [];
      if (callOn(task, index) && index < task.stageIndex) return [];
      const reviewer: Planned = { ...base, kind: "agent", round, sub: 1, roleId: stage.reviewerRoleId ?? "design-reviewer", ...(stage.reviewerProfileIds?.[0] ? { profileId: stage.reviewerProfileIds[0] } : {}) };
      return [author, reviewer].slice(from);
    }
    case "review-chain": {
      if (from > 0) return [];
      // A port of an already reviewed change gets one reviewer, as the engine picks it.
      if (portAt(task, index)) {
        const reviewer = portReviewerIndex(task, stage.profileIds, (id) => ctx.profiles.find((profile) => profile.id === id)?.toolId);
        const profileId = stage.profileIds[reviewer];
        return [{ ...base, kind: "agent", round, port: true, roleId: reviewerAt(stage, reviewer), ...(profileId ? { profileId } : {}) }];
      }
      // Every reviewer looks at the change at once: one step for the round.
      return [{ ...base, kind: "agent", round, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}), ...(stage.profileIds.length > 1 ? { team: [...stage.profileIds] } : {}) }];
    }
  }
}

/** The steps still ahead in the plan, from where the task is now. */
function plannedSteps(task: Task, open: JourneyStep | undefined, ctx: JourneyContext): Planned[] {
  const stages = task.plan?.stages ?? [];
  if (task.stageIndex < 0) {
    // At the plan check the whole plan is ahead; otherwise the planner has yet to write it.
    if (task.plan && open?.kind === "you" && open.waitsFor === "plan") return stages.flatMap((stage, index) => stageSteps(task, stage, index, ctx));
    if (open?.kind === "agent" && open.roleId === "planner") return [];
    const profileId = ctx.planner ?? task.plan?.plannerProfileId;
    return [{ kind: "agent", roleId: "planner", round: 1, sub: 0, ...(profileId ? { profileId } : {}) }];
  }
  const current = stages[task.stageIndex];
  if (!current) return [];
  // What the open step already covers in the current stage.
  const mine = open && open.stageId === current.id ? open : undefined;
  const all = stageSteps(task, current, task.stageIndex, ctx, current.kind === "converge" ? task.sub : 0);
  let here: Planned[];
  if (mine?.kind === "you" && current.kind !== "do") here = (current.kind === "gate" && mine.waitsFor === (current.gate ?? "delivery")) || mine.waitsFor === "call" ? [] : all;
  else if (mine?.kind === "you") here = mine.waitsFor === "delivery" || mine.waitsFor === "stuck" || mine.waitsFor === "shipping" ? all : [];
  // After the architect, its reviewer; after the Release Manager, Petrina publishes. Voters are never planned.
  else if (mine?.kind === "agent") {
    const coversStage = all.some((step) => step.kind === "agent" && step.roleId === mine.roleId);
    // Supporting roles run before the stage's own work; only its reviewers' fresh voters cover it too.
    if (current.kind === "review-chain" && mine.roleId === "verifier") here = [];
    else if (!coversStage) here = all;
    else here = current.kind === "converge" ? stageSteps(task, current, task.stageIndex, ctx, task.sub + 1) : all.filter((step) => step.kind === "petrina");
  }
  // Petrina's checks come before the stage's own steps; once Petrina publishes, nothing else is left.
  else if (mine?.kind === "petrina") here = mine.work === "delivery" ? [] : all;
  else here = all;
  // A final-code tester pass returns straight to the delivery check; it does not repeat the reviewers.
  const deliveryCheck = task.retest && current.kind === "do" && current.roleId === "tester"
    ? stages.findIndex((stage) => stage.kind === "gate" && stage.gate === "delivery")
    : -1;
  const next = deliveryCheck >= 0 ? deliveryCheck : task.stageIndex + 1;
  return [...here, ...stages.slice(next).flatMap((stage, offset) => stageSteps(task, stage, next + offset, ctx))];
}

const FINISHED: readonly Task["state"][] = ["done", "pr-open", "cancelled"];

function endOf(task: Task): JourneyView["end"] {
  switch (landingOf(task)) {
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
  const recorded: readonly JourneyStep[] = task.journey ?? legacyJourney(task, ctx.inbox);
  const open = openStep({ journey: recorded });
  const latestCompletedTester = recorded.reduce((latest, step, index) => ((step.kind === "agent" && step.roleId === "tester") || (step.kind === "petrina" && step.work === "checks")) && step.endedAt !== undefined ? index : latest, -1);
  const finished = FINISHED.includes(task.state);
  const run: JourneyNode["run"] = task.state === "running" ? "working" : task.state === "paused" ? "paused" : "waiting";

  const nodes: JourneyNode[] = recorded.map((step, index) => {
    let state: JourneyNodeState;
    if (step.endedAt !== undefined || finished) state = step.end === "failed" ? "failed" : step.end === "cancelled" || (step.endedAt === undefined && task.state === "cancelled") ? "cancelled" : "done";
    else if (step.kind === "you" || step.asks?.some((ask) => ask.endedAt === undefined)) state = "you";
    else state = "now";
    const live = state === "now" || state === "you";
    const earlier = recorded.slice(0, index);
    const name = stepName(step, earlier, ctx.roles);
    return {
      id: step.id,
      kind: step.kind,
      name,
      ...flowStepMarks(step, name, earlier),
      state,
      ...(state === "now" ? { run } : {}),
      ...(live && task.statusLine ? { live: task.statusLine } : {}),
      ...(step.roleId ? { roleId: step.roleId } : {}),
      ...(step.profileId ? { profileId: step.profileId } : {}),
      ...(step.team ? { team: step.team } : {}),
      ...(step.fixing ? { fixing: true } : {}),
      ...(step.findingIds ? { findingIds: step.findingIds } : {}),
      ...(step.result ? { result: step.result } : {}),
      ...(step.agentInputs ? { agentInputs: step.agentInputs } : {}),
      ...(step.productChecks ? { productChecks: step.productChecks } : {}),
      ...(step.builderConversation ? { builderConversation: step.builderConversation } : {}),
      ...(step.work ? { work: step.work } : {}),
      ...(step.stageId ? { stageId: step.stageId } : {}),
      ...(step.waitsFor ? { waitsFor: step.waitsFor } : {}),
      ...(step.waitsOn ? { waitsOn: step.waitsOn } : {}),
      ...(step.legacy ? { legacy: true } : { startedAt: step.startedAt, ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}) }),
      ...(step.outcome ? { outcome: step.outcome } : {}),
      ...(step.acceptanceChecks ? { acceptanceChecks: step.acceptanceChecks } : index === latestCompletedTester && !step.acceptanceChecks && task.brief?.acceptance.some((check) => check.verification)
        ? { acceptanceChecks: task.brief.acceptance.filter((check) => check.verification).map((check) => ({ text: check.text, result: check.verification === "passed" ? "pass" as const : check.verification === "failed" ? "fail" as const : "blocked" as const, ...(check.reason ? { reason: check.reason } : {}) })) }
        : {}),
      ...(step.reason ? { reason: step.reason } : {}),
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
    task.state === "backlog" ? { kind: "backlog" } : task.state === "queued" ? (task.held ? { kind: "held" } : { kind: "queued", position: Math.max(0, queue.findIndex((entry) => entry.id === task.id)) + 1 }) : { kind: "started", at: task.startedAt ?? task.createdAt };
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
  const legacyInbox = task.journey ? undefined : ctx.inbox
    .filter((entry) => entry.taskId === task.id)
    .map(({ id, kind, blocking, roleId, profileId, at, title }) => [id, kind, blocking, roleId, profileId, at, title]);
  return JSON.stringify([
    taskView,
    ctx.roles.map(({ id, name }) => [id, name]),
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
    if (!last && step.endedAt !== undefined && step.end === "done" && !step.reason) problems.push(`${step.id} (${step.kind} ${step.roleId ?? step.waitsFor ?? ""}) does not say why the work moved on`);
    if (step.kind === "agent" && (!step.roleId || !step.profileId)) problems.push(`${step.id} does not name its role, tool and model`);
    for (const ask of step.asks ?? []) if (step.endedAt !== undefined && ask.endedAt === undefined) problems.push(`${step.id} ended with “${ask.title}” still open`);
  });
  for (const line of [...task.timeline, ...task.session]) if (line.step && !ids.has(line.step)) problems.push(`“${line.text}” belongs to a step that was never recorded`);
  if (FINISHED.includes(task.state) && openStep(task)) problems.push(`${task.state} with a step still open`);
  return problems;
}
