// Keeping a task's work one commit on top of the latest default branch. Petrina folds the branch into one
// commit after every build, and right before the delivery check, and again right before shipping, puts it
// on top of the latest main itself, with git plumbing that never leaves a working copy halfway through a
// rebase. When main's changes and the task's overlap, the builder brings the work up to date.

import { JOURNEY_WORDS as W, lastIndexWhere, petrinaMoment } from "@petrina/core";
import * as git from "./git.js";
import type { Sources } from "./sources.js";
import type { Connections } from "./connection.js";
import type { Kernel, MTask } from "./kernel.js";

export class Updates {
  constructor(
    private readonly k: Kernel,
    private readonly connections: Connections,
    private readonly sources: Sources,
  ) {}

  /** The task's one commit message: the builder's title in the repository's style, what changed for users, who built it. */
  message(task: MTask): string {
    const builder = task.plan?.stages.find((stage) => stage.roleId === "builder");
    const by = task.builderSession?.profileId ?? builder?.profileIds[0];
    const changes = (task.report?.changes ?? []).map((change) => `- ${change}`).join("\n");
    return [task.report?.title ?? task.title, task.report?.summary ?? "", changes, `Built by Petrina${by ? `: ${this.k.describe("builder", by)}` : ""}`].filter(Boolean).join("\n\n");
  }

  /** The branch as one commit on top of where it forked, with the same code and the task's message. */
  async fold(task: MTask): Promise<void> {
    // While the builder brings the work up to date, the branch sits on main with the change not committed yet.
    if (!task.worktree || task.updating) return;
    const base = (await this.settleBase(task)) ?? task.base;
    if (!base) return;
    await git.squash(task.worktree, base, this.message(task));
  }

  /**
   * Where the task's work starts, checked before each fold. A builder that brings main into its branch itself
   * (told not to, but it happens) moves where the branch last met main past the base noted when the working
   * copy was made; left there, main's own changes would read as the task's in every review, and its merge
   * would be folded into the task's commit. The base follows the branch's latest meeting with main, read from
   * the product's own clone with no network. The same when the noted base is not in the branch at all.
   */
  private async settleBase(task: MTask): Promise<string | undefined> {
    const worktree = task.worktree!;
    const base = task.baseSha;
    const product = this.k.repositoryOf(task);
    if (!base || !product?.path) return base;
    const branch = task.source?.start.branch ?? product.defaultBranch ?? "main";
    const main = task.source?.start.kind === "pull-request"
      ? await git.revParse(product.path, `refs/petrina/sources/${task.id}`)
      : (task.delivery !== "local" || task.localUpdate?.pushed === false ? await git.revParse(product.path, `refs/remotes/origin/${branch}`) : undefined) ?? (await git.revParse(product.path, `refs/heads/${branch}`));
    if (!main) return base;
    const met = await git.mergeBase(worktree, "HEAD", main);
    if (!met || met === base) return base;
    const forward = await git.contains(worktree, met, base);
    const baseInBranch = await git.contains(worktree, await git.head(worktree), base);
    // The usual case: the branch forked at the base and main moved on since. Nothing to settle.
    if (!forward && baseInBranch) return base;
    task.baseSha = met;
    this.k.log(
      task,
      "warn",
      forward
        ? `The builder brought ${branch} into the branch itself, so the work now counts from ${met.slice(0, 7)} and reviews see only its own changes. Petrina brings work up to date; builders need not.`
        : `The work's noted base was not in the branch: it now counts from ${met.slice(0, 7)}, where the branch last met ${branch}`,
    );
    this.k.commit();
    return met;
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
    const sourceName = task.source?.start.kind === "pull-request" ? `PR #${task.source.start.number}` : task.source?.start.branch ?? "main";
    if (!worktree) return "current";
    await this.fold(task);
    const latest = await this.latestMain(task, signal, fresh);
    if (!latest) return "current";
    // Checked before treating an older tip as already current. A rewrite can keep the first starting commit
    // and still drop a source commit this task already brought in.
    if (task.baseSha && task.baseSha !== latest.sha && !(await git.contains(worktree, latest.sha, task.baseSha))) {
      throw new Error("The starting branch's history was replaced or diverged. The task's work is preserved; it cannot be published safely without a decision.");
    }
    const fork = await git.mergeBase(worktree, "HEAD", latest.sha);
    if (!fork) throw new Error(`The work and ${latest.ref} share no history, so Petrina could not bring the work up to date`);
    if (fork === latest.sha) return "current";
    if (!(await git.isClean(worktree))) throw new Error(`The working copy has changes Petrina did not commit, so it could not bring the work up to date with ${sourceName}`);
    const merged = await git.mergeTree(worktree, latest.sha);
    if (!merged) throw new Error(`Petrina could not bring the work up to date with ${sourceName}`);
    const gained = await git.commitsSince(worktree, fork, latest.sha);
    const commits = `${gained} new commit${gained === 1 ? "" : "s"}`;
    const reviewed = !!task.reviewedTree && task.reviewedTree === await git.treeOf(worktree);
    if (!merged.conflicts.length) {
      await git.moveTo(worktree, await git.commitTree(worktree, merged.tree, latest.sha, this.message(task)));
      if (reviewed) task.reviewedTree = merged.tree;
      task.baseSha = latest.sha;
      task.base = latest.ref;
      // The version the last round reviewed, carried onto the new base too, so the next round still sees only what changed since.
      if (task.reviewedSha) {
        const carried = await this.carry(task, task.reviewedSha);
        if (carried) task.reviewedSha = carried;
        else delete task.reviewedSha;
      }
      this.k.log(task, "done", `Brought up to date with ${sourceName} (${commits} there), with no conflicts`);
      this.k.commit();
      return "moved";
    }
    const builder = lastIndexWhere(task.plan?.stages ?? [], (stage) => stage.roleId === "builder" && stage.kind === "do");
    if (builder < 0) throw new Error(`${sourceName === "main" ? "Main" : sourceName} moved on and the work conflicts with it, but the plan has no builder to bring it up to date`);
    // On disk before the working copy moves: a restart in between finds the update and opens it again.
    // Only a completed review of this exact code permits the later review to cover the port alone.
    const head = reviewed ? await git.head(worktree) : undefined;
    task.updating = { from: fork, onto: latest.sha, ...(head ? { head } : {}), files: merged.conflicts, ...(merged.notes.length ? { notes: merged.notes } : {}) };
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
    // A moment of Petrina's own on the journey: why the builder gets the work back.
    petrinaMoment(task, "update", { outcome: W.mainMoved(merged.conflicts.length, sourceName), reason: W.conflicts(sourceName), tone: "back" }, Date.now());
    this.k.log(task, "warn", `${sourceName === "main" ? "Main" : sourceName} moved on (${commits}) and ${files} with this work, so the builder brings it up to date`);
    this.k.commit();
    return "conflict";
  }

  /**
   * A reviewed version of the change carried onto the current base unchanged: a commit of its merge with the
   * base, on no branch, kept only as a reference for "what changed since". Undefined when the two overlap.
   */
  private async carry(task: MTask, sha: string): Promise<string | undefined> {
    const worktree = task.worktree;
    const base = task.baseSha;
    if (!worktree || !base) return undefined;
    const merged = await git.mergeTree(worktree, base, sha);
    if (!merged || merged.conflicts.length) return undefined;
    return git.commitTree(worktree, merged.tree, base, "The version the last review round saw, carried onto the latest main (Petrina's reference, on no branch)");
  }

  /** Before the builder starts on an update: the working copy as `upToDate` left it, even after a restart in between. */
  async reopen(task: MTask): Promise<void> {
    const updating = task.updating;
    if (!updating || !task.worktree) return;
    if ((await git.head(task.worktree).catch(() => undefined)) === updating.onto) return;
    const merged = await git.mergeTree(task.worktree, updating.onto);
    const sourceName = task.source?.start.kind === "pull-request" ? `PR #${task.source.start.number}` : task.source?.start.branch ?? "main";
    if (!merged) throw new Error(`Petrina could not bring the work up to date with ${sourceName}`);
    await git.openOn(task.worktree, updating.onto, merged.tree);
  }

  /**
   * The latest approved source, fetched from its saved address. Commit delivery also accounts for newer
   * local destination commits. Explicit sources never fall back to an old copy. Ordinary default-branch
   * tasks keep their existing fallback before delivery; publishing always needs a fresh GitHub read.
   */
  private async latestMain(task: MTask, signal: AbortSignal, fresh: boolean): Promise<{ ref: string; sha: string } | undefined> {
    const product = this.k.repositoryOf(task);
    if (!product?.path) return undefined;
    const branch = task.source?.start.branch ?? product.defaultBranch ?? "main";
    let remote: { ref: string; sha: string } | undefined;
    if (task.source && task.source.start.kind !== "default") {
      remote = await this.sources.fetch(task, signal);
    } else if (!(task.delivery === "local" && !product.remote && product.remoteRefused)) {
      const fetched = await this.connections.fetchDefault(task, signal);
      if (fetched.ok) remote = { ref: `origin/${branch}`, sha: fetched.sha };
      else if (fresh && !fetched.missing) throw new Error(`Petrina could not get the latest ${branch} from GitHub (${this.connections.why(task, fetched)}), so it published nothing. Retry when that is sorted.`);
      else if (!fetched.missing) this.k.log(task, "warn", `Did not update from GitHub: ${this.connections.why(task, fetched)}, so Petrina compared the work with the local copy of ${branch}`);
    }
    if (task.delivery !== "local" || task.source?.start.kind === "pull-request") {
      if (remote) return remote;
      const sha = await git.revParse(product.path, `refs/remotes/origin/${branch}`) ?? await git.revParse(product.path, `refs/heads/${branch}`);
      return sha ? { ref: branch, sha } : undefined;
    }
    const local = await git.revParse(product.path, `refs/heads/${branch}`);
    if (!local) return remote;
    // Our own unpushed placement is work to carry forward, not an independent source commit.
    if (remote && task.localUpdate?.pushed === false && task.localUpdate.branch === branch && task.localUpdate.sha === local) return remote;
    if (!remote || await git.contains(product.path, local, remote.sha)) return { ref: branch, sha: local };
    if (await git.contains(product.path, remote.sha, local)) return remote;
    throw new Error(`${branch} in the local copy and on GitHub have divergent history. The task's work is preserved. Bring the destination copies into agreement before retrying.`);
  }
}
