// A task's current automated-check activity: one small fact the engine writes only from its shared check
// line and its own check progress. The Board card, the progress strip, task details, Next and the
// coordinator's reads all say what this fact says, in these words. It never decides admission or order.

import type { CheckActivity, CheckLineHold, CheckLineOwner, CheckPhase, CheckRunReason } from "./check-model.js";
import type { Id, Role, Task } from "./model.js";
import { roleForTask } from "./roles.js";

export type { CheckActivity, CheckLineHold, CheckLineOwner, CheckPhase, CheckRunReason };

export const CHECK_WORDS = {
  heading: "Automated checks",
  waiting: "Waiting for checks",
  preparing: "Preparing automated checks",
  starting: "Starting the checks",
  finishing: "Finishing the check run",
  paused: "Waiting for the pool to resume",
  held: "Waiting for checks · held for cleanup",
  /** After a restart, before Petrina confirms an earlier extra validation stopped: new work waits, the pool is not paused. */
  recovery: "Waiting while Petrina confirms an earlier validation stopped",
  ownLine: "Checks have their own line, separate from agent slots.",
} as const;

/** Waiting, held or paused: in the line, not yet admitted. */
export const inCheckLine = (activity: CheckActivity | undefined): boolean =>
  activity?.phase === "waiting" || activity?.phase === "held" || activity?.phase === "paused";

/** "next in line", "1 run ahead", "2 runs ahead". */
export function runsAhead(ahead: number): string {
  return ahead <= 0 ? "next in line" : `${ahead} ${ahead === 1 ? "run" : "runs"} ahead`;
}

/** The task's one main line while its checks are the current work. */
export function checkActivityLine(activity: CheckActivity): string {
  switch (activity.phase) {
    case "preparing":
      return CHECK_WORDS.preparing;
    case "starting":
      return CHECK_WORDS.starting;
    case "running":
      return activity.running?.length ? `Running checks: ${activity.running.join(", ")}` : CHECK_WORDS.starting;
    case "finishing":
      return CHECK_WORDS.finishing;
    case "paused":
      return CHECK_WORDS.paused;
    case "held":
      return CHECK_WORDS.held;
    case "waiting":
      return activity.ahead === undefined ? CHECK_WORDS.waiting : `${CHECK_WORDS.waiting} · ${runsAhead(activity.ahead)}`;
  }
}

type Tasks = readonly Pick<Task, "id" | "checkActivity">[];

/** What a place's owner is doing, as "Tests" for ordinary checks (from the owner's own activity) or an extra validation's name. */
export function checkOwnerParts(owner: CheckLineOwner, tasks: Tasks): { what: string; title: string; product?: string; plural: boolean } {
  const live = tasks.find((task) => task.id === owner.taskId)?.checkActivity;
  const names = owner.kind === "checks" && live?.phase === "running" ? (live.running ?? []) : [];
  const what = owner.kind === "extra" ? `extra validation “${owner.name ?? "extra validation"}”` : names.length ? names.join(", ") : "checks";
  return { what, title: owner.title, ...(owner.productName ? { product: owner.productName } : {}), plural: owner.kind === "checks" && names.length !== 1 };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Tests for “Fix login retry”", with the product for a task with several. */
export function checkOwnerText(owner: CheckLineOwner, tasks: Tasks): string {
  const parts = checkOwnerParts(owner, tasks);
  return `${parts.what} for “${parts.title}”${parts.product ? ` (${parts.product})` : ""}`;
}

/** "Tests for “A” is running", or "Running now: Tests for “A”; Lint for “B”" when several runs hold a place. */
export function checkOwnersLine(owners: readonly CheckLineOwner[], tasks: Tasks): string | undefined {
  if (!owners.length) return undefined;
  if (owners.length > 1) return `Running now: ${owners.map((owner) => checkOwnerText(owner, tasks)).join("; ")}`;
  const parts = checkOwnerParts(owners[0]!, tasks);
  return `${capital(checkOwnerText(owners[0]!, tasks))} ${parts.plural ? "are" : "is"} running`;
}

/** A hold in words, followed by its recorded explanation. Programs are called Petrina's only when its explanation verified them. */
export function checkHoldLine(hold: CheckLineHold, tasks: Tasks): string {
  const what = checkOwnerText(hold.owner, tasks);
  const lead =
    hold.kind === "recovery"
      ? `Checks are held while Petrina confirms an earlier validation stopped: ${what}.`
      : `Checks are held until Petrina confirms ${what} has stopped.`;
  return hold.detail ? `${lead} ${hold.detail}` : lead;
}

/** Checks have their own line, and how many runs it allows at once when that is more than one. */
export function checkLineNote(activity: Pick<CheckActivity, "slots">): string {
  return activity.slots > 1 ? `${CHECK_WORDS.ownLine} Petrina runs up to ${activity.slots} check runs at once.` : CHECK_WORDS.ownLine;
}

/**
 * The quieter lines under the main one in task details and the coordinator's reads: holds with their recorded
 * explanation, who holds each running place, and the separate line. Nothing while preparing or running.
 */
export function checkActivityDetails(activity: CheckActivity, tasks: Tasks): string[] {
  if (!inCheckLine(activity)) return [];
  const holds = (activity.holds ?? []).map((hold) => checkHoldLine(hold, tasks));
  const owners = checkOwnersLine(activity.owners ?? [], tasks);
  const kept = activity.phase === "paused" && activity.ahead !== undefined ? [`Keeps its place · ${runsAhead(activity.ahead)}`] : [];
  return [...kept, ...holds, ...(owners ? [owners] : []), checkLineNote(activity)];
}

/**
 * Whether Petrina's checks are the task's real current work: a check fact is current and no agent works on the
 * step, other than the Check finder, which only works out the checks. Without `roles`, any agent counts as work.
 */
export function checksCurrent(
  task: Pick<Task, "checkActivity" | "agent" | "state" | "maintenance" | "direct">
    & Partial<Pick<Task, "plan" | "stageIndex">>,
  roles?: readonly Pick<Role, "id" | "result">[],
): boolean {
  if (!task.checkActivity || !["running", "waiting"].includes(task.state)) return false;
  if (!task.agent) return true;
  const stage =
    task.stageIndex !== undefined && task.stageIndex >= 0 ? task.plan?.stages[task.stageIndex] : undefined;
  if (stage?.kind === "do" && stage.roleId === task.agent.roleId) return false;
  return !!roles && roleForTask(roles, task.agent.roleId, task)?.result === "check-discovery";
}

const PURPOSE: Readonly<Record<CheckRunReason["purpose"], string>> = {
  review: "Before review",
  acceptance: "Before acceptance testing",
  "delivery-check": "Before your delivery check",
  publishing: "Before publishing",
};

/** "step 28" for journey node j28. */
const stepName = (nodeId: Id | undefined) => (nodeId && /^j\d+$/.test(nodeId) ? `step ${nodeId.slice(1)}` : undefined);

/**
 * Why a fresh run is needed, from what was recorded then: "Before your delivery check: the code changed since the
 * passing run in step 28 (main moved on)". Never from stage order: an empty review is no reason to check again.
 */
export function checkReasonWords(reason: CheckRunReason): string {
  const purpose = PURPOSE[reason.purpose];
  const earlier = reason.earlier;
  if (!earlier) return `${purpose}: no earlier run of these checks`;
  const where = stepName(earlier.nodeId);
  const changed = new Set(reason.changed);
  const run = `the ${earlier.passed ? "passing" : changed.has("incomplete") ? "earlier" : "failed"} run${where ? ` in ${where}` : ""}`;
  if (changed.has("incomplete")) return `${purpose}: ${run} did not finish`;
  if (changed.has("requested")) return `${purpose}: you asked for a fresh run after ${run}`;
  if (changed.has("edits")) return `${purpose}: the working copy has changes that ${run} did not cover`;
  if (changed.has("code")) return `${purpose}: the code changed since ${run}${changed.has("start") ? " (main moved on)" : ""}`;
  if (changed.has("definitions")) return `${purpose}: the check commands or hook inputs changed since ${run}`;
  if (changed.has("hooks")) return `${purpose}: the code is unchanged since ${run}, but the repository's commit hooks must be checked again`;
  return `${purpose}: ${run} does not cover the current code`;
}
