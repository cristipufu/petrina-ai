// A finished task's working copy (a full copy of the product, with its packages and build output)
// is removed to free disk space. The branch and the task's history stay.
// The engine and the simulator share these rules and words so the demo cannot drift from the real thing.

import type { Task } from "./model.js";

export const CLEANUP_WORDS = {
  removed: "Removed the working copy to free disk space. The branch is kept",
  failed: (reason: string) => `Could not remove the working copy yet: ${reason}. Petrina will try again`,
  /** The usual reason a removal fails: a program still has a file open, or a file is read-only. */
  locked: "some files in it are in use or locked",
  unconfirmed: "GitHub could not confirm what went out before this task was cancelled",
  unconfirmedPr: "GitHub could not confirm whether this task still has an open pull request",
} as const;

/** Marking work done is not evidence that its pull request ended, including work saved by older versions. */
export function needsPullRequestCheck(task: Task): boolean {
  if (task.cleanup?.removedAt !== undefined) return false;
  return task.cleanup?.foreignPullRequest !== undefined || task.cleanup?.pullRequest === "unconfirmed" || (task.state === "done" && task.delivery === "pull-request" && !task.pr && task.cleanup?.pullRequest !== "none");
}

/**
 * Whether a task is finished with its working copy: done or cancelled. While a pull request of its is
 * open, review fixes may still need the copy, so it stays, even when cancelled.
 */
export function copyNoLongerNeeded(task: Task): boolean {
  return (task.state === "done" || task.state === "cancelled") && task.pr?.state !== "open" && !task.cleanup?.foreignPullRequest && !needsPullRequestCheck(task);
}
