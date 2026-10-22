// A finished task's working copy (a full copy of the product, with its packages and build output)
// is removed to free disk space. The branch and the task's history stay.
// The engine and the simulator share these rules and words so the demo cannot drift from the real thing.

import type { Cleanup, Task } from "./model.js";
import { displayTask } from "./repositories.js";

export const CLEANUP_WORDS = {
  removed: "Removed the working copy to free disk space. The branch is kept",
  failed: (reason: string) => `Could not remove the working copy yet: ${reason}. Petrina will try again`,
  /** The usual reason a removal fails: a program still has a file open, or a file is read-only. */
  locked: "some files in it are in use or locked",
  unconfirmed: "GitHub could not confirm what went out before this task was cancelled",
  unconfirmedPr: "GitHub could not confirm whether this task still has an open pull request",
} as const;

/**
 * You marked the work done without a confirmed delivery, here or in an older version. A pull request a later
 * lookup finds is recorded beside that decision and never confirms the delivery.
 */
export function markedDoneUnconfirmed(task: Pick<Task, "state">, work: { cleanup?: Pick<Cleanup, "markedDone" | "pullRequest"> }): boolean {
  return task.state === "done" && (!!work.cleanup?.markedDone || work.cleanup?.pullRequest !== undefined);
}

/** Marking work done is not evidence that its pull request ended, including work saved by older versions. */
export function needsPullRequestCheck(task: Task): boolean {
  task = displayTask(task);
  if (task.cleanup?.removedAt !== undefined) return false;
  return task.cleanup?.foreignPullRequest !== undefined || task.cleanup?.pullRequest === "unconfirmed" || (task.state === "done" && task.delivery === "pull-request" && !task.pr && task.cleanup?.pullRequest !== "none");
}

/**
 * Whether a task is finished with its working copy: done or cancelled. While a pull request of its is
 * open, review fixes may still need the copy, so it stays, even when cancelled.
 */
export function copyNoLongerNeeded(task: Task): boolean {
  task = displayTask(task);
  if (task.repositories) return (task.state === "done" || task.state === "cancelled") && task.repositories.every((work) =>
    work.nothingToPublish || work.pr?.state !== "open" && !(work.pr?.state === "closed" && !work.landingAccepted) && work.shipping?.step === undefined && !work.shipping?.carriedOver && work.localUpdate?.pushed !== false && !work.cleanup?.foreignPullRequest && !needsPullRequestCheck({ ...task, ...work, repositories: undefined }));
  return (task.state === "done" || task.state === "cancelled") && task.pr?.state !== "open" && !task.cleanup?.foreignPullRequest && !needsPullRequestCheck(task);
}
