import { markedDoneUnconfirmed } from "./cleanup.js";
import { hasNoProductChanges } from "./direct-tasks.js";
import type { HistoryItem } from "./history.js";
import type { Cleanup, JourneyStep, JourneyWait, JourneyWork, Role, Task } from "./model.js";
import { landingState } from "./repositories.js";
import { verificationSummary } from "./reviews.js";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Task titles in quotes: “A”, “A” and “B”, “A”, “B” and “C”. */
export function quoteTitles(titles: readonly string[]): string {
  const quoted = titles.map((title) => `“${title}”`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : (quoted[0] ?? "");
}

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
  fixed: (count: number) => (count ? `Builder claims ${plural(count, "fix")}` : "Changes returned"),
  checks: (
    failed: number,
    total: number
  ) => (failed ? `${failed} of ${plural(
    total,
    "check"
  )} failed` : total === 1 ? "The check passes" : total ? `All ${total} checks pass` : "No checks to run"),
  voted: verificationSummary,
  firstAnswers: (total: number, real: number, third: number) => `${total} checked: ${real} must be fixed in this change, ${third} awaiting a third answer`,
  foundChecks: (count: number) => (count ? `Found ${plural(count, "check")}` : "Found no checks"),
  couldNotFinish: "Could not finish",
  handedOn: "Work handed on",
  guidePoint: "Proposed a point for the review guide",
  noGuidePoint: "Nothing for the review guide",
  mainMoved: (files: number, source = "main") => `${plural(files, "file")} conflict${files === 1 ? "s" : ""} with ${source}`,
  broughtUpToDate: "Brought it up to date",
  keptLearnings: "Kept both sets of approved learnings",
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
  readyForDelivery: "ready for checks and delivery",
  fixesReady: "fixes ready",
  checksFailed: (count: number) => `${plural(count, "check")} failed`,
  checksPassed: "checks passed",
  noChecks: "no checks or commit hooks to run",
  checksFound: "checks found",
  checksAsBefore: "the checks it had",
  toCheck: (count: number) => `${plural(count, "important finding")} to check`,
  thirdAnswer: (count: number) => `${plural(count, "finding")} to check on a third tool`,
  sentBack: (count: number) => `sent back: ${count} important`,
  reviewPassed: "review passed",
  reviewAgain: "your changes get reviewed",
  stillOpen: (count: number) => `${count} important still open`,
  coveredOpen: (count: number) => `${count} earlier important still open under your decision to continue`,
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
 * How the displayed product's work ended up. A pull request closed without merging did not land, and
 * "Mark as done" confirms no delivery, even once a later lookup finds its pull request. `open`: not finished yet.
 */
export type Landing = "landed" | "awaiting-merge" | "closed" | "marked-done" | "no-changes" | "cancelled" | "open";

export function landingOf(
  task: Pick<Task, "state" | "pr" | "release" | "landed"> & {
    noProductChanges?: boolean;
    maintenance?: Pick<NonNullable<Task["maintenance"]>, "noProductChanges">;
    cleanup?: Pick<Cleanup, "markedDone" | "pullRequest">;
  },
): Landing {
  if (task.state === "cancelled") return "cancelled";
  if (task.state === "done" && hasNoProductChanges(task)) return "no-changes";
  // A pull request found after you marked the work done is not its delivery.
  const pr = markedDoneUnconfirmed(task, task) ? undefined : task.pr;
  if (task.release || task.landed || pr?.state === "merged") return "landed";
  // Recorded before "closed" was: a finished task whose pull request never merged.
  if (pr && (pr.state === "closed" || task.state === "done")) return "closed";
  if (pr && task.state === "pr-open") return "awaiting-merge";
  // A finished task with nothing delivered on record: the coordinator marked it as done.
  return task.state === "done" ? "marked-done" : "open";
}

/** A prerequisite is the whole task. Keep aggregation out of displayed-product outcomes. */
export function dependencyLanding(
  task: Parameters<typeof landingOf>[0] & Pick<Task, "repository" | "repositories"> & Pick<HistoryItem, "deliveries">,
): Landing {
  if (task.state === "cancelled") return "cancelled";
  if (task.state === "done" && hasNoProductChanges(task)) return "no-changes";
  // Engine records keep delivery on its repository owner; public task views flatten one owner.
  // Read every shared delivery so a successful lead cannot hide an unsuccessful companion.
  const deliveryLanding = (
    work: Pick<Task, "pr" | "release" | "landed"> & { cleanup?: Pick<Cleanup, "markedDone" | "pullRequest">; nothingToPublish?: boolean },
  ): Landing =>
    work.nothingToPublish
      ? "no-changes"
      : work.pr?.state === "open" && !markedDoneUnconfirmed(task, work)
        ? "awaiting-merge"
        : landingOf({ state: task.state, pr: work.pr, release: work.release, landed: work.landed, cleanup: work.cleanup });
  const deliveries = task.repositories ?? task.deliveries;
  if (deliveries?.length) {
    // Like blocksDependents, an unfinished push keeps a shared delivery open, even on a task marked as done.
    const outcomes = deliveries.map((work) =>
      !work.nothingToPublish && work.pr?.state !== "open" && work.localUpdate?.pushed === false ? "open" : deliveryLanding(work),
    );
    for (const outcome of ["closed", "marked-done", "awaiting-merge", "open"] as const) if (outcomes.includes(outcome)) return outcome;
    return outcomes.every((outcome) => outcome === "no-changes") ? "no-changes" : "landed";
  }
  return deliveryLanding(task.repository ?? task);
}

/**
 * The whole task's delivery, for coordinator summaries and waits. One product's work keeps its own outcome. Shared
 * work reads every product like a prerequisite, and awaits merge or lands only once the shared delivery has
 * finished everywhere: a published lead cannot stand in for a companion still publishing, interrupted or unlinked.
 */
export function taskLanding(task: Parameters<typeof dependencyLanding>[0]): Landing {
  if (!(task.repositories ?? task.deliveries)?.length) {
    const work = task.repository ?? task;
    return landingOf({
      state: task.state,
      noProductChanges: task.noProductChanges,
      maintenance: task.maintenance,
      pr: work.pr,
      release: work.release,
      landed: work.landed,
      cleanup: work.cleanup,
    });
  }
  const landing = dependencyLanding(task);
  return (landing === "landed" || landing === "awaiting-merge") && task.repositories && landingState(task.repositories) === "unfinished"
    ? "open"
    : landing;
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
  "review-decision": "Your review decision",
  "check-reuse": "Previous checks reused",
  checks: "Automated checks",
  update: "Update branch",
  delivery: "Publish delivery",
};

export type StepKey = Pick<JourneyStep, "stageId" | "round" | "sub" | "fixing" | "update" | "port" | "call" | "roleId" | "work">;

export function sameStep(a: StepKey & Pick<JourneyStep, "kind">, b: StepKey & Pick<JourneyStep, "kind">): boolean {
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

/** The fields a step's name comes from, for recorded and planned steps alike. */
export type Named = Pick<
  JourneyStep,
  "kind" | "stageId" | "round" | "sub" | "fixing" | "update" | "port" | "call" | "roleId" | "team" | "work" | "waitsFor" | "end" | "endedAt" | "productChecks"
>;

/**
 * A step's name. Repeats say so: "Architect (round 2)", "Builder (fixes)", "Builder (fixes 2)",
 * "Builder (update)", "Architect (your call)", "Code reviewers (round 2)" for reviewers looking at once,
 * "Code reviewer (port)" for a review of the builder's port, "Petrina's checks (round 2)", and "(again)" for a
 * retry after getting stuck. Main moving on is not a round of anything.
 */
export function stepName(step: Named, earlier: readonly Named[], roles: readonly Pick<Role, "id" | "name">[]): string {
  if (step.kind === "you") {
    if (step.work === "review-decision") return "Your review decision";
    if (step.waitsFor === "delivery" && step.productChecks?.some((check) => check.result === "fail" || check.result === "did-not-finish")) {
      return "Your call: checks still failing";
    }
    if (step.waitsFor === "delivery" && step.productChecks?.some((check) => check.result === "stopped" || check.result === "pending" || check.result === "running")) {
      return "Your call: checks unverified";
    }
    return YOU_STEP_NAMES[step.waitsFor ?? "delivery"];
  }
  if (step.kind === "wait") return "Waiting for others";
  const same = earlier.filter((entry) => sameStep(entry, step));
  if (step.kind === "petrina") {
    if (step.work === "check-reuse") return PETRINA_STEP_NAMES[step.work];
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
    const fixes = earlier.filter(
      (entry) =>
        entry.kind === "agent" &&
        entry.fixing &&
        entry.roleId === step.roleId &&
        entry.stageId === step.stageId &&
        entry.endedAt !== undefined &&
        (entry.end ?? "done") === "done",
    ).length;
    parts.push(fixes ? `fixes ${fixes + 1}` : "fixes");
  } else if (step.port) parts.push("port");
  else if (step.round > 1) parts.push(`round ${step.round}`);
  const last = same.at(-1);
  if (last && (!step.fixing || (last.end !== undefined && last.end !== "done"))) parts.push("again");
  return parts.length ? `${role} (${parts.join(", ")})` : role;
}

export function flowStepMarks(step: Named, name: string, earlier: readonly Named[]) {
  const flowName = name.replace(/\s+\([^)]*\)$/, "");
  const roundMark = step.round > 1 && step.work !== "check-reuse" && !step.update && !step.fixing && !step.call && !step.port ? step.round : undefined;
  const updateMark = !!step.update || (step.kind === "petrina" && step.work === "update");
  const repeatMark = step.work !== "check-reuse" && (name.endsWith("again)") || earlier.some((entry) => sameStep(entry, step)));
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
