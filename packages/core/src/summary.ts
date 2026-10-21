// What a task says at a glance: what its agent is working on (the current item of its own to-do
// list), what comes next in the plan and who does it, and, once Petrina has seen enough steps like
// it, roughly how long the current step has left. The engine and the simulator keep the data;
// these read it, so the demo and the real squad say the same things.

import { CALL_WORDS, followingCall } from "./call.js";
import { allowsReviewFix, reviewRoundEnd } from "./flow.js";
import { portReviewerIndex } from "./journey.js";
import { reviewerAt, roleForTask } from "./roles.js";
import type { DeliveryMode, GateKind, Id, Stage, State, StepClock, StepRecord, Task } from "./model.js";

/** How long a to-do item may be on the board, in characters. */
export const TODO_MAX = 100;

/**
 * An agent's to-do item as plain text: one line, formatting marks removed (emphasis, code marks,
 * headings, list markers, check boxes, links keep their words), at most about 100 characters.
 */
export function plainTodo(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((part) =>
      part
        .replace(/^\s*(?:>\s*)+/, "")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/^\s*\[[ xX]\]\s*/, ""),
    )
    .join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/`+/g, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\*\*|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return undefined;
  if (line.length <= TODO_MAX) return line;
  const cut = line.slice(0, TODO_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TODO_MAX - 25 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A card's one main line: while the agent works, the to-do item it is on; otherwise, or for a tool
 * that shares no to-do list, the status line (its latest action, or what the task waits for).
 */
export function mainLine(task: Pick<Task, "state" | "todo" | "statusLine"> & Partial<Pick<Task, "plan" | "stageIndex" | "sub" | "call">>): string {
  if (task.state !== "running") return task.statusLine;
  if (task.todo) return task.todo;
  if (task.stageIndex !== undefined && task.sub === 0 && followingCall({ ...task, stageIndex: task.stageIndex })) return CALL_WORDS.following;
  return task.statusLine;
}

/** A restart or stopped step cannot leave a tool looking live. No outcome is inferred. */
export function clearRunningTools(task: Pick<Task, "toolActivity" | "hunt" | "journey" | "state" | "statusLine">): void {
  if (task.state === "running" && task.toolActivity?.runningTool?.description === task.statusLine) task.statusLine = "Continuing work";
  if (task.toolActivity) delete task.toolActivity.runningTool;
  for (const work of Object.values(task.hunt?.work ?? {})) if (work.toolActivity) {
    if (work.activity === work.toolActivity.runningTool?.description) work.activity = "Continuing work";
    delete work.toolActivity.runningTool;
  }
  for (const step of task.journey ?? []) for (const activity of Object.values(step.toolActivity ?? {})) delete activity.runningTool;
}

// ── How long ─────────────────────────────────────────────────────────────

/** Steps of the same kind Petrina needs to have seen before it says how long one takes. */
export const MIN_HISTORY = 3;
/** How many of the latest steps of a kind the estimate reads. */
export const HISTORY = 10;

/** Whether the task's current step repeats earlier work: a later design or review round, fixing findings, or following the coordinator's call. */
export function isRepeat(task: Pick<Task, "plan" | "stageIndex" | "rounds" | "sub" | "fixing" | "call" | "retest">): boolean {
  const stage = task.stageIndex < 0 ? undefined : task.plan?.stages[task.stageIndex];
  if (!stage) return false;
  return task.retest === true || task.fixing || (task.rounds[stage.id] ?? 1) > 1 || (stage.kind === "converge" && task.sub === 0 && followingCall(task) !== undefined);
}

/** A new clock for a step that starts fresh. */
export function startClock(task: Parameters<typeof isRepeat>[0], roleId: Id, now: number): StepClock {
  return { roleId, repeat: isRepeat(task), worked: 0, since: now };
}

/** The agent stops to wait for the coordinator, or Petrina stops: the time until then counts, the wait does not. */
export function pauseClock(clock: StepClock, now: number): StepClock {
  const { since: _since, ...rest } = clock;
  return { ...rest, worked: workedSoFar(clock, now) };
}

/** The agent works again. */
export function resumeClock(clock: StepClock, now: number): StepClock {
  return clock.since === undefined ? { ...clock, since: now } : clock;
}

/** How long the agent has worked on the step so far, in milliseconds. */
export function workedSoFar(clock: StepClock, now: number): number {
  return clock.worked + (clock.since === undefined ? 0 : Math.max(0, now - clock.since));
}

/** The record a finished step leaves. */
export function stepRecord(clock: StepClock, now: number): StepRecord {
  return { roleId: clock.roleId, repeat: clock.repeat, worked: workedSoFar(clock, now), at: now };
}

/** The most records one task keeps. */
export const MAX_STEP_RECORDS = 60;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Time left, in rough words. Past the usual time it says so instead. */
export function leftWords(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes <= 0) return "Taking longer than usual";
  if (minutes < 7.5) return "A few minutes left";
  if (minutes < 45) return `About ${Math.round(minutes / 5) * 5} minutes left`;
  if (minutes < 90) return "About an hour left";
  return `About ${Math.round(minutes / 60)} hours left`;
}

/**
 * Roughly how long the current step has left: the typical time of the last ten finished steps of the
 * same kind (role and pass) anywhere in Petrina, minus the time worked so far. Only while the agent
 * works, and only with at least three such steps; otherwise nothing, never a guess.
 */
export function timeLeft(state: Pick<State, "tasks" | "now" | "history">, task: Task): string | undefined {
  const clock = task.stepClock;
  if (task.state !== "running" || !clock || clock.since === undefined) return undefined;
  const same = [...state.tasks.flatMap((entry) => entry.steps ?? []), ...(state.history?.steps ?? [])]
    .filter((record) => record.roleId === clock.roleId && record.repeat === clock.repeat)
    .sort((a, b) => a.at - b.at)
    .slice(-HISTORY);
  if (same.length < MIN_HISTORY) return undefined;
  return leftWords(median(same.map((record) => record.worked)) - workedSoFar(clock, state.now));
}

// ── What's next ──────────────────────────────────────────────────────────

const WORK: Readonly<Record<string, string>> = {
  planner: "planning",
  researcher: "research",
  architect: "design",
  "design-reviewer": "design review",
  "ux-designer": "screens",
  builder: "build",
  tester: "testing",
  "code-reviewer": "code review",
  "security-reviewer": "security review",
  "release-manager": "release notes",
};

/** Petrina publishes by itself; only a release has an agent first, for its notes. */
const PUBLISH: Readonly<Record<DeliveryMode, string>> = {
  "pull-request": "Petrina opens the pull request",
  local: "Petrina commits to main",
  release: "Petrina publishes the release",
};

/** The coordinator's checks are named as theirs. */
const CHECKS: Readonly<Record<GateKind, string>> = {
  plan: "your plan check",
  design: "your design check",
  delivery: "your OK to ship",
};

type People = Pick<State, "profiles" | "tools" | "roles">;

/** "tool · model" for a profile, or nothing when it is unknown. */
function who(state: People, profileId: Id | undefined): string | undefined {
  const profile = state.profiles.find((entry) => entry.id === profileId);
  if (!profile) return undefined;
  return `${state.tools.find((tool) => tool.id === profile.toolId)?.name ?? profile.toolId} · ${profile.model}`;
}

/** Who does a step, as " (tool · model)", or " (tool · model and tool · model)" for agents working at once. */
function by(state: People, ...profileIds: readonly (Id | undefined)[]): string {
  const names = [...new Set(profileIds.map((profileId) => who(state, profileId)).filter((name): name is string => !!name))];
  return names.length ? ` (${names.join(" and ")})` : "";
}

/** Whether a review round may still send the work back to the builder (a later round keeps doing so while it converges). */
function canFixReview(state: People, task: Task, stage: Stage, index: number): boolean {
  if (!task.plan!.stages.some((entry, at) => at < index && roleForTask(state.roles, entry.roleId, task)?.result === "build")) return false;
  return allowsReviewFix(task, stage, task.rounds[stage.id] ?? 1);
}

/** The engine requires the coordinator's check when a review would end with blocking findings open, even if shipping normally needs no approval. */
function needsReviewCheck(state: People, task: Task, index: number): boolean {
  const stage = task.plan?.stages[index];
  return index === task.stageIndex && stage?.kind === "review-chain" && reviewRoundEnd(task, stage, task.rounds[stage.id] ?? 1, state.roles).kind === "used up";
}

/**
 * Who reviews in a review stage: every reviewer still to look, all at once. A port of a change already
 * reviewed gets one, on a tool other than the builder's where the stage has one, as the engine picks it.
 */
function reviewersOf(task: Task, state: People, stage: Stage, at: number, from: number): readonly { roleId: Id; profileId: Id }[] {
  const stages = task.plan?.stages ?? [];
  const port = task.portReview && stages.findIndex((entry, index) => index >= task.stageIndex && entry.kind === "review-chain") === at;
  const reported = at === task.stageIndex && task.hunt?.stageId === stage.id && task.hunt.round === (task.rounds[stage.id] ?? 1) ? task.hunt.reported : {};
  const reviewers = stage.profileIds.map((profileId, index) => ({ roleId: reviewerAt(stage, index), profileId }));
  if (!port) return reviewers.filter((_, index) => index >= from && !reported[String(index)]);
  if (Object.keys(reported).length) return [];
  const index = portReviewerIndex(task, stage.profileIds, (id) => state.profiles.find((profile) => profile.id === id)?.toolId, state.roles);
  const one = reviewers[index];
  return one ? [one] : [];
}

/** Final preparation resolves single-product patch equivalence; until then name the conditional test. */
function finalTesting(state: People, task: Task): string | undefined {
  if (task.retest || task.testedPatch === undefined || task.acceptanceUnverified || (task.acceptancePassed === false && task.acceptanceBlocked)) return undefined;
  const tester = task.plan?.stages.find((stage) => stage.kind === "do" && roleForTask(state.roles, stage.roleId, task)?.result === "checks");
  if (!tester) return undefined;
  const versions = task.repositories?.every((work) => work.checks?.current && work.checks.tree && task.testedVersions?.[work.productId])
    ? task.repositories.map((work) => work.checks!.tree === task.testedVersions![work.productId]) : undefined;
  const failed = task.acceptancePassed === false;
  if (!failed && versions?.every(Boolean)) return undefined;
  const knownChange = versions?.some((same) => !same);
  return `final acceptance testing${by(state, tester.profileIds[0])}${failed || knownChange ? "" : " if the code changed"}`;
}

/**
 * The steps of the plan from stage `index`, position `sub` (converge: 0 the author, 1 the reviewer;
 * review chain: the first reviewer still to look), along the likely path: reviews pass, nobody objects.
 */
function upcoming(state: People, task: Task, index: number, sub: number, limit = 2): string[] {
  const stages: readonly Stage[] = task.plan?.stages ?? [];
  const steps: string[] = [];
  for (let at = index, from = sub; at < stages.length && steps.length < limit; at += 1, from = 0) {
    const stage = stages[at]!;
    const again = (task.rounds[stage.id] ?? 1) > 1 ? " again" : "";
    switch (stage.kind) {
      case "gate":
        // On the way back to the check where the coordinator asked for changes, the engine goes past earlier design checks.
        if (stage.gate === "design" && task.returnToCheck !== undefined && at < task.returnToCheck) break;
        if (stage.gate === "delivery" && (at !== task.stageIndex || task.state === "running")) {
          const testing = finalTesting(state, task);
          if (testing) steps.push(testing);
        }
        steps.push(CHECKS[stage.gate ?? "delivery"]);
        break;
      case "converge": {
        // A design the coordinator's call settled is only updated to follow it: no review round.
        const following = followingCall({ ...task, stageIndex: at }) !== undefined;
        if (from === 0) steps.push(following ? `design following your call${by(state, stage.profileIds[0])}` : `design${again}${by(state, stage.profileIds[0])}`);
        if (!following) steps.push(`design review${again}${by(state, stage.reviewerProfileIds?.[0])}`);
        break;
      }
      case "review-chain": {
        // The reviewers look at the change at once: one step, naming each of them.
        const reviewers = reviewersOf(task, state, stage, at, from);
        const port = reviewers.length === 1 && task.portReview !== undefined && stage.profileIds.length > 1;
        const roles = [...new Set(reviewers.map((reviewer) => reviewer.roleId))];
        const roleId = roles[0];
        const name = roles.length > 1 ? "review" : roleId && (WORK[roleId] ?? roleForTask(state.roles, roleId, task)?.name.toLowerCase());
        if (reviewers.length) steps.push(`${port ? "a review of the port" : `${name || stage.title.toLowerCase()}${again}`}${by(state, ...reviewers.map((reviewer) => reviewer.profileId))}`);
        if (needsReviewCheck(state, task, at)) steps.push("your call");
        break;
      }
      case "do": {
        // After the first acceptance pass, the engine skips this stage in fix rounds and decides on
        // a final pass at the delivery check. A tester already on that final pass goes straight to the check.
        if (roleForTask(state.roles, stage.roleId, task)?.result === "checks" && task.testedPatch !== undefined && !(task.retest && at === task.stageIndex)) break;
        if (roleForTask(state.roles, stage.roleId, task)?.result === "delivery") {
          // Petrina publishes by itself: a release's notes come from the Release Manager first.
          if (task.delivery === "release") steps.push(`${WORK[stage.roleId]}${by(state, stage.profileIds[0])}`);
          steps.push(PUBLISH[task.delivery]);
          break;
        }
        const fixing = at === task.stageIndex && task.fixing && roleForTask(state.roles, stage.roleId, task)?.result === "build";
        steps.push(`${fixing ? "fixes by the builder" : (WORK[stage.roleId] ?? stage.title.toLowerCase())}${by(state, stage.profileIds[0])}`);
        break;
      }
    }
  }
  return steps.slice(0, limit);
}

/** The plan's steps from stage `index` on, along the likely path, for a decision that says what is still to come. */
export function stepsFrom(state: People, task: Task, index: number, limit = 6): string[] {
  return upcoming(state, task, index, 0, limit);
}

export interface NextSteps {
  /** Up to two steps, each with who does it; one when it comes with an "or". */
  steps: readonly string[];
  /** What happens instead if the agent working now objects or finds blocking issues. */
  or?: string;
}

function shaped(steps: readonly string[], or?: string): NextSteps | undefined {
  if (steps.length === 0) return undefined;
  return or ? { steps: steps.slice(0, 1), or } : { steps: steps.slice(0, 2) };
}

/**
 * What comes next for a task, worked out from its plan each time: it follows design and review
 * rounds, the coordinator's checks and plan edits. Only for tasks that are working, need the
 * coordinator, wait for a slot or are paused, and only when there is a next step.
 */
export function nextSteps(state: People & Pick<State, "inbox">, task: Task): NextSteps | undefined {
  if (task.state !== "running" && task.state !== "needs-you" && task.state !== "waiting" && task.state !== "paused") return undefined;
  const items = state.inbox.filter((item) => item.taskId === task.id);
  const stages = task.plan?.stages ?? [];

  // Planning: what comes after is not known yet, only whether the coordinator checks the plan.
  if (task.stageIndex < 0) {
    if (!items.some((item) => item.kind === "plan")) return task.approvePlan ? { steps: [CHECKS.plan] } : undefined;
    const after = upcoming(state, task, 0, 0);
    return shaped(task.state === "paused" ? [CHECKS.plan, ...after] : after);
  }
  const stage = stages[task.stageIndex];
  if (!stage) return undefined;

  // Pausing a checkpoint does not send its finished agent back through another review.
  const check = items.find((item) => !item.blocking && (item.kind === "design" || item.kind === "delivery" || item.kind === "disagreement"));
  if (task.state === "paused" && check) {
    const name = check.kind === "disagreement" ? "your call" : check.kind === "design" ? CHECKS.design : CHECKS.delivery;
    const after = stage.kind === "gate" || check.kind === "disagreement" ? task.stageIndex + 1 : task.stageIndex;
    return shaped([name, ...upcoming(state, task, after, 0)]);
  }

  // No agent on the step: waiting for a slot or paused, the step it starts (again) comes first. At a
  // checkpoint or a disagreement, what follows it. The Check finder and the Guide keeper only prepare
  // a step: the card is already running, but the review, the test or the build they are getting ready
  // has not started, so that work is still what comes next.
  const result = roleForTask(state.roles, task.agent?.roleId ?? "", task)?.result;
  const preparing = result === "check-discovery" || result === "guide";
  const onStep = !preparing && (task.state === "running" || items.some((item) => item.blocking));
  if (!onStep) {
    const past = task.state === "needs-you" && (stage.kind === "gate" || stage.kind === "converge");
    return shaped(past ? upcoming(state, task, task.stageIndex + 1, 0) : upcoming(state, task, task.stageIndex, task.sub));
  }

  const round = task.rounds[stage.id] ?? 1;
  switch (stage.kind) {
    case "gate":
      return shaped(upcoming(state, task, task.stageIndex, 0));
    case "converge":
      if (task.sub === 0) return shaped(followingCall(task) ? upcoming(state, task, task.stageIndex + 1, 0) : upcoming(state, task, task.stageIndex, 1));
      return shaped(upcoming(state, task, task.stageIndex + 1, 0), round >= (stage.maxRounds ?? 3) ? "your call if they still disagree" : "another design round if the reviewer objects");
    case "review-chain": {
      // Every reviewer looks at once, then voters settle what only one tool raised: what follows is the next stage.
      const after = upcoming(state, task, task.stageIndex + 1, 0);
      if (needsReviewCheck(state, task, task.stageIndex)) return shaped(["your call", ...(after[0] === CHECKS.delivery ? after.slice(1) : after)]);
      return shaped(after, canFixReview(state, task, stage, task.stageIndex) ? "fixes by the builder if blocking issues are found" : "your call if blocking issues are found");
    }
    default:
      if (task.retest && roleForTask(state.roles, stage.roleId, task)?.result === "checks") {
        const gate = stages.findIndex((entry) => entry.kind === "gate" && entry.gate === "delivery");
        return shaped(upcoming(state, task, gate >= 0 ? gate : task.stageIndex + 1, 0), "fixes by the builder if acceptance checks fail");
      }
      // The Release Manager writing a release's notes: Petrina publishes it next.
      if (roleForTask(state.roles, stage.roleId, task)?.result === "delivery") return task.delivery === "release" ? { steps: [PUBLISH.release] } : undefined;
      return shaped(upcoming(state, task, task.stageIndex + 1, 0));
  }
}

/** "Next: design review (Codex · sol), then your design check", or nothing when no step follows. */
export function nextLine(state: People & Pick<State, "inbox">, task: Task): string | undefined {
  const next = nextSteps(state, task);
  return next && `Next: ${next.steps.join(", then ")}${next.or ? `, or ${next.or}` : ""}`;
}
