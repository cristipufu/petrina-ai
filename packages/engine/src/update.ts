// Keeping a task's work one commit on top of the latest default branch. Petrina folds the branch into one
// commit after every build, and right before the delivery check, and again right before shipping, puts it
// on top of the latest main itself, with git plumbing that never leaves a working copy halfway through a
// rebase. When main's changes and the task's overlap, the builder brings the work up to date.

import { lastIndexWhere } from "@petrina/core";
import * as git from "./git.js";
import type { Connections } from "./connection.js";
import type { Kernel, MTask } from "./kernel.js";

export class Updates {
  constructor(
    private readonly k: Kernel,
    private readonly connections: Connections,
  ) {}

  /** The task's one commit message: the builder's title in the repository's style, what changed for users, who built it. */
  message(task: MTask): string {
    const builder = task.plan?.stages.find((stage) => stage.roleId === "builder");
    const changes = (task.report?.changes ?? []).map((change) => `- ${change}`).join("\n");
    return [task.report?.title ?? task.title, task.report?.summary ?? "", changes, `Built by Petrina${builder?.profileIds[0] ? `: ${this.k.describe("builder", builder.profileIds[0])}` : ""}`].filter(Boolean).join("\n\n");
  }

  /** The branch as one commit on top of where it forked, with the same code and the task's message. */
  async fold(task: MTask): Promise<void> {
    const base = task.baseSha ?? task.base;
    // While the builder brings the work up to date, the branch sits on main with the change not committed yet.
    if (!task.worktree || !base || task.updating) return;
    await git.squash(task.worktree, base, this.message(task));
  }

  /** The change itself (git's patch-id), from where the branch forked to `ref`. */
  async patch(task: MTask, ref = "HEAD"): Promise<string | undefined> {
    const base = task.baseSha ?? task.base;
    if (!task.worktree || !base) return undefined;
    const fork = (await git.mergeBase(task.worktree, ref, base)) ?? base;
    return git.patchId(task.worktree, fork, ref);
  }

  /**
   * The task's work as one commit on top of the latest main. "current": it already was. "moved": Petrina put
   * it on top, and says so. "conflict": main's changes and this one overlap, so the task is back on its
   * builder step, with the working copy on main and the change applied, conflict markers and all.
   * `fresh`: right before shipping, where only main freshly fetched from GitHub counts for a GitHub delivery.
   */
  async upToDate(task: MTask, signal: AbortSignal, fresh = false): Promise<"current" | "moved" | "conflict"> {
    const worktree = task.worktree;
    if (!worktree) return "current";
    await this.fold(task);
    const latest = await this.latestMain(task, signal, fresh);
    if (!latest) return "current";
    const fork = await git.mergeBase(worktree, "HEAD", latest.sha);
    if (!fork) throw new Error(`The work and ${latest.ref} share no history, so Petrina could not bring the work up to date`);
    if (fork === latest.sha) return "current";
    if (!(await git.isClean(worktree))) throw new Error("The working copy has changes Petrina did not commit, so it could not bring the work up to date with main");
    const merged = await git.mergeTree(worktree, latest.sha);
    if (!merged) throw new Error("Petrina could not bring the work up to date with main");
    const gained = await git.commitsSince(worktree, fork, latest.sha);
    const commits = `${gained} new commit${gained === 1 ? "" : "s"}`;
    if (!merged.conflicts.length) {
      await git.moveTo(worktree, await git.commitTree(worktree, merged.tree, latest.sha, this.message(task)));
      task.baseSha = latest.sha;
      task.base = latest.ref;
      this.k.log(task, "done", `Brought up to date with main (${commits} there), with no conflicts`);
      this.k.commit();
      return "moved";
    }
    const builder = lastIndexWhere(task.plan?.stages ?? [], (stage) => stage.roleId === "builder" && stage.kind === "do");
    if (builder < 0) throw new Error("Main moved on and the work conflicts with it, but the plan has no builder to bring it up to date");
    // On disk before the working copy moves: a restart in between finds the update and opens it again.
    task.updating = { from: fork, onto: latest.sha, files: merged.conflicts, ...(merged.notes.length ? { notes: merged.notes } : {}) };
    // The builder ports the change by hand: whatever was approved before, the coordinator checks it again.
    delete task.approvedSha;
    delete task.approvedPatch;
    delete task.approvedFor;
    task.baseSha = latest.sha;
    task.base = latest.ref;
    task.stageIndex = builder;
    task.sub = 0;
    task.fixing = false;
    this.k.commitNow();
    await git.openOn(worktree, latest.sha, merged.tree);
    const files = merged.conflicts.length === 1 ? "1 file conflicts" : `${merged.conflicts.length} files conflict`;
    this.k.log(task, "warn", `Main moved on (${commits}) and ${files} with this work, so the builder brings it up to date`);
    this.k.commit();
    return "conflict";
  }

  /** Before the builder starts on an update: the working copy as `upToDate` left it, even after a restart in between. */
  async reopen(task: MTask): Promise<void> {
    const updating = task.updating;
    if (!updating || !task.worktree) return;
    if ((await git.head(task.worktree).catch(() => undefined)) === updating.onto) return;
    const merged = await git.mergeTree(task.worktree, updating.onto);
    if (!merged) throw new Error("Petrina could not bring the work up to date with main");
    await git.openOn(task.worktree, updating.onto, merged.tree);
  }

  /**
   * Where the work lands, as of now: the local default branch for "Commit to main", with no network; else the
   * default branch on GitHub, fetched now from the product's saved address. A fetch that did not happen falls
   * back to the last copy fetched, except right before shipping (`fresh`): an old copy is never published on.
   */
  private async latestMain(task: MTask, signal: AbortSignal, fresh: boolean): Promise<{ ref: string; sha: string } | undefined> {
    const product = this.k.productOf(task);
    if (!product?.path) return undefined;
    const branch = product.defaultBranch ?? "main";
    if (task.delivery !== "local") {
      const fetched = await this.connections.fetchDefault(task, signal);
      if (fetched.ok) return { ref: `origin/${branch}`, sha: fetched.sha };
      if (fresh && !fetched.missing) throw new Error(`Petrina could not get the latest ${branch} from GitHub (${this.connections.why(task, fetched)}), so it published nothing. Retry when that is sorted.`);
      if (!fetched.missing) this.k.log(task, "warn", `${fetched.timedOut ? "GitHub did not answer in time" : `Did not update from GitHub: ${this.connections.why(task, fetched)}`}, so Petrina compared the work with the local copy of ${branch}`);
      const remote = await git.revParse(product.path, `refs/remotes/origin/${branch}`);
      if (remote) return { ref: `origin/${branch}`, sha: remote };
    }
    const sha = await git.revParse(product.path, `refs/heads/${branch}`);
    return sha ? { ref: branch, sha } : undefined;
  }
}
