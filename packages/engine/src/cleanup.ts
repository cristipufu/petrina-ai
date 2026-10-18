// Removing finished tasks' working copies to free disk space. A task delivered, released, merged, closed or
// cancelled no longer needs its copy (a full copy of the product, with installed packages and build output);
// its branch and its history stay. A copy goes only once nothing uses it any more, never while a pull request
// of the task is open or what a cancelled delivery published is still being looked up. Removing never holds a
// slot or fails a task: a failure goes on the timeline once, and is tried again at the once-a-minute check and
// after a restart, when Petrina also catches up on tasks that finished before.

import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CLEANUP_WORDS, copyNoLongerNeeded, type Id, type Task } from "@petrina/core";
import * as git from "./git.js";
import type { Kernel, MTask } from "./kernel.js";

export class Cleanup {
  private readonly removing = new Set<Id>();
  private sweeping = false;

  constructor(private readonly k: Kernel) {}

  /** Every finished task's copy that is still there, one after another: at start to catch up, then once a minute. */
  async sweep(): Promise<void> {
    if (this.sweeping || this.k.stopped) return;
    this.sweeping = true;
    try {
      for (const task of [...this.k.s.tasks]) await this.removeCopy(task.id);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Remove the working copy of a task that no longer needs it, once no driver uses it. The outcome and history
   * are saved first. A copy removed before whose folder came back (a program wrote into it late) goes again,
   * quietly.
   */
  async removeCopy(taskId: Id): Promise<void> {
    const task = this.k.task(taskId);
    const path = task && this.copyOf(task);
    if (!task || !path || !this.finishedWith(task) || this.removing.has(taskId) || this.k.stopped) return;
    const again = task.cleanup?.removedAt !== undefined;
    const copies = join(this.k.dataDir, "worktrees", task.productId, `${task.id}.copies`);
    if (again && task.cleanup?.reviewCopiesRemovedAt !== undefined && !existsSync(path) && !existsSync(copies)) return;
    this.removing.add(taskId);
    let outcome: { removed: boolean } | { error: string };
    try {
      // On a full disk even this save fails; removing the copy is what frees the space, and the next change saves.
      try {
        this.k.commitNow();
      } catch {
        // Saved with the next change.
      }
      const root = this.k.productOf(task)?.path ?? (await git.mainClone(path));
      if (!root) throw new Error("the product's repository could not be found");
      const peersRemoved = await git.removeFinishedCopies(root, copies);
      outcome = { removed: await git.removeWorktree(root, path) || peersRemoved };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.removing.delete(taskId);
    }
    const current = this.k.task(taskId);
    if (!current) return;
    if ("error" in outcome) {
      // Said once: trying again every minute never crowds out the task's history.
      if (current.cleanup?.error === undefined) this.k.log(current, "warn", CLEANUP_WORDS.failed(outcome.error));
      current.cleanup = { ...current.cleanup, error: outcome.error };
      delete current.cleanup.removedAt;
      delete current.cleanup.reviewCopiesRemovedAt;
    } else {
      // Quiet when there was nothing (new) to remove, unless an earlier try said it failed.
      if ((outcome.removed && !again) || current.cleanup?.error !== undefined) this.k.log(current, "done", CLEANUP_WORDS.removed);
      current.cleanup = { ...current.cleanup, removedAt: Date.now(), reviewCopiesRemovedAt: Date.now() };
      delete current.cleanup.error;
    }
    this.k.commit();
  }

  /**
   * Done or cancelled, with no pull request open, nothing running on it and nobody driving it. A delivery
   * cancelled halfway keeps its copy until what it published is looked up (it may be an open pull request),
   * and one from before Petrina published deliveries itself keeps it for the coordinator to check.
   */
  private finishedWith(task: MTask): boolean {
    if (this.k.drivers.has(task.id) || this.k.settling.has(task.id) || task.driving || this.k.switching.has(task.id)) return false;
    if (task.shipping?.step !== undefined || task.shipping?.carriedOver) return false;
    return copyNoLongerNeeded(task as unknown as Task);
  }

  /** The task's working copy, when it is one Petrina made in its own folder. Nothing else is ever removed. */
  copyOf(task: MTask): string | undefined {
    // Checkout may finish after quitting saved the task, before its usable copy was recorded.
    // Its saved identity still names the same folder prepare() uses; never search other folders.
    const copy = task.worktree ?? (task.state === "cancelled" && task.startedAt !== undefined ? join(this.k.dataDir, "worktrees", task.productId, task.id) : undefined);
    if (!copy) return undefined;
    const path = resolve(copy);
    return path.startsWith(resolve(this.k.dataDir, "worktrees") + sep) ? path : undefined;
  }
}
