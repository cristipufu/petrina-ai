// Removing finished tasks' working copies to free disk space. A task delivered, released, merged, closed or
// cancelled no longer needs its copy (a full copy of the product, with installed packages and build output);
// its branch and its history stay. A copy goes only once nothing uses it any more, never while a pull request
// of the task is open or what a cancelled delivery published is still being looked up. Removing never holds a
// slot or fails a task: a failure goes on the timeline once, and is tried again at the once-a-minute check and
// after a restart, when Petrina also catches up on tasks that finished before.

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { CLEANUP_WORDS, copyNoLongerNeeded, finishedTask, involvesProduct, type Id, type Task } from "@petrina/core";
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
      // Pictures belong only to unfinished tasks, independently of whether a working copy
      // must stay (an open pull request or interrupted delivery may still need its files).
      // Walk actual storage, without reading any archived conversations; missing tasks are orphans.
      for (const entry of await readdir(join(this.k.dataDir, "captures"), { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await this.removeCaptures(entry.name);
      }
      const ids = new Set(this.k.s.tasks.map((task) => task.id));
      // A late detached child can recreate a finished folder. Inspect folders and Git's actual
      // worktree records, then load only the tasks they name; never scan years of archived bodies.
      if (this.k.store.history.info().total > 0) {
        const root = resolve(this.k.dataDir, "worktrees");
        const remember = (path: string) => {
          const parts = relative(root, resolve(path)).split(sep);
          if (parts.length < 2 || parts[0] === ".." || !parts[1]) return;
          const id = parts[1].endsWith(".copies") ? parts[1].slice(0, -7) : parts[1];
          const task = this.k.task(id);
          if (task && involvesProduct(task, parts[0]!)) ids.add(id);
        };
        for (const product of await readdir(root, { withFileTypes: true }).catch(() => [])) {
          if (!product.isDirectory()) continue;
          for (const task of await readdir(join(root, product.name), { withFileTypes: true }).catch(() => [])) remember(join(root, product.name, task.name));
        }
        for (const product of this.k.s.products) if (product.path) {
          for (const path of await git.linkedWorktrees(product.path).catch(() => [])) remember(path);
        }
      }
      for (const id of ids) await this.removeCopy(id);
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
    await this.removeCaptures(taskId);
    const task = this.k.task(taskId);
    if (task?.repositories) return this.removeRepositoryCopies(task);
    const path = task && this.copyOf(task);
    if (!task || !path || !this.finishedWith(task) || this.removing.has(taskId) || this.k.stopped) return;
    const again = task.cleanup?.removedAt !== undefined;
    const copies = join(this.k.dataDir, "worktrees", task.productId, `${task.id}.copies`);
    if (again && task.cleanup?.reviewCopiesRemovedAt !== undefined && !existsSync(path) && !existsSync(copies)) return;
    this.removing.add(taskId);
    this.k.cleanupJobs.add(taskId);
    this.k.syncIdleSleep();
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
      this.k.cleanupJobs.delete(taskId);
      this.k.syncIdleSleep();
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
    this.k.saveArchivedTask(current);
    this.k.commit();
  }

  private async removeRepositoryCopies(task: MTask): Promise<void> {
    if (this.k.drivers.has(task.id) || this.k.settling.has(task.id) || task.driving || this.removing.has(task.id) || this.k.stopped || !this.finishedWith(task)) return;
    this.k.saveRepository(task);
    this.removing.add(task.id);
    this.k.cleanupJobs.add(task.id);
    this.k.syncIdleSleep();
    try {
      for (const work of [...task.repositories!, ...(task.excludedRepositories ?? [])]) {
        const copy = work.worktree ?? work.preparingCopy?.path;
        if (!copy || work.pr?.state === "open" || work.shipping?.step || work.localUpdate?.pushed === false) continue;
        const path = resolve(copy);
        if (!path.startsWith(resolve(this.k.dataDir, "worktrees") + sep)) continue;
        try {
          const root = work.source!.product.path!;
          for (const productId of new Set(task.repositories!.map((entry) => entry.productId))) await git.removeFinishedCopies(root, join(this.k.dataDir, "worktrees", productId, `${task.id}.copies`));
          await git.removeWorktree(root, path);
          work.cleanup = { removedAt: Date.now(), reviewCopiesRemovedAt: Date.now() };
        } catch (error) { work.cleanup = { error: String(error) }; }
        if (task.productId === work.productId) task.cleanup = work.cleanup;
        this.k.commitNow();
      }
      this.k.saveArchivedTask(task);
    } finally {
      this.removing.delete(task.id);
      this.k.cleanupJobs.delete(task.id);
      this.k.syncIdleSleep();
    }
  }

  async removeCaptures(taskId: Id): Promise<void> {
    if (this.k.stopped || !/^[a-zA-Z0-9_-]+$/.test(taskId)) return;
    const task = this.k.s.tasks.find((task) => task.id === taskId);
    if (task && !finishedTask(task as Task)) return;
    // A failed removal is tried again by the ordinary cleanup sweep.
    await rm(join(this.k.dataDir, "captures", taskId), { recursive: true, force: true }).catch(() => {});
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
