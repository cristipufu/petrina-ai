import { type RepositoryContext } from "./repository-context.js";
// Keeping a task's work one commit on top of the latest default branch. Petrina folds the branch into one
// commit after every build, and right before the delivery check, and again right before shipping, puts it
// on top of the latest main itself, with git plumbing that never leaves a working copy halfway through a
// rebase. When main's changes and the task's overlap, the builder brings the work up to date.

import { JOURNEY_WORDS as W, lastIndexWhere, petrinaMoment } from "@petrina/core";
import * as git from "./git.js";
import type { Sources } from "./sources.js";
import type { Connections } from "./connection.js";
import type { Kernel } from "./kernel.js";

export class Updates {
  constructor(
    private readonly k: Kernel,
    private readonly connections: Connections,
    private readonly sources: Sources,
  ) {}

  /** The task's one commit message: the builder's title in the repository's style, what changed for users, who built it. */
  message(scope: RepositoryContext): string {
    const { task, work: repository } = scope;
    const builder = task.plan?.stages.find((stage) => stage.roleId === "builder");
    const by = repository.builderSession?.profileId ?? builder?.profileIds[0];
    const changes = (repository.report?.changes ?? []).map((change) => `- ${change}`).join("\n");
    return [repository.report?.title ?? task.title, repository.report?.summary ?? "", changes, `Built by Petrina${by ? `: ${this.k.describe("builder", by)}` : ""}`].filter(Boolean).join("\n\n");
  }

  /** The branch as one commit on top of where it forked, with the same code and the task's message. */
  async fold(scope: RepositoryContext): Promise<string | undefined> {
    const { work: repository } = scope;
    // While the builder brings the work up to date, the branch sits on main with the change not committed yet.
    if (!repository.worktree || repository.updating) return;
    const settled = await this.settleBase(scope);
    const base = settled.base ?? repository.base;
    if (!base) return;
    const fork = settled.fork ?? await git.mergeBase(repository.worktree, "HEAD", base);
    if (!fork) return;
    await git.squash(repository.worktree, base, this.message(scope), fork);
    return fork;
  }

  /**
   * Where the task's work starts, checked before each fold. A builder that brings main into its branch itself
   * (told not to, but it happens) moves where the branch last met main past the base noted when the working
   * copy was made; left there, main's own changes would read as the task's in every review, and its merge
   * would be folded into the task's commit. The base follows the branch's latest meeting with main, read from
   * the product's own clone with no network. The same when the noted base is not in the branch at all.
   */
  private async settleBase(scope: RepositoryContext): Promise<{ base?: string; fork?: string }> {
    const { task, work: repository } = scope;
    const worktree = repository.worktree!;
    const base = repository.baseSha;
    const product = this.k.repositoryOf(scope);
    if (!base || !product?.path) return { base };
    const branch = repository.source?.start.branch ?? product.defaultBranch ?? "main";
    const main = repository.source?.start.kind === "pull-request"
      ? await git.revParse(product.path, `refs/petrina/sources/${task.id}`)
      : (repository.delivery !== "local" || repository.localUpdate?.pushed === false ? await git.revParse(product.path, `refs/remotes/origin/${branch}`) : undefined) ?? (await git.revParse(product.path, `refs/heads/${branch}`));
    if (!main) return { base };
    const met = await git.mergeBase(worktree, "HEAD", main);
    if (!met) return { base };
    if (met === base) return { base, fork: base };
    const [forward, baseInBranch] = await Promise.all([git.contains(worktree, met, base), git.contains(worktree, "HEAD", base)]);
    // The usual case: the branch forked at the base and main moved on since. Nothing to settle.
    if (!forward && baseInBranch) return { base, fork: base };
    repository.baseSha = met;
    this.k.log(
      scope,
      "warn",
      forward
        ? `The builder brought ${branch} into the branch itself, so the work now counts from ${met.slice(0, 7)} and reviews see only its own changes. Petrina brings work up to date; builders need not.`
        : `The work's noted base was not in the branch: it now counts from ${met.slice(0, 7)}, where the branch last met ${branch}`,
    );
    this.k.commit();
    return { base: met, fork: met };
  }

  /** The change itself (git's patch-id), from where the branch forked to `ref`. */
  async patch(scope: RepositoryContext, ref = "HEAD"): Promise<string | undefined> {
    const { work: repository } = scope;
    const base = repository.baseSha ?? repository.base;
    if (!repository.worktree || !base) return undefined;
    const fork = (await git.mergeBase(repository.worktree, ref, base)) ?? base;
    return git.patchId(repository.worktree, fork, ref);
  }

  /**
   * The task's work as one commit on top of the latest main. "current": it already was. "moved": Petrina put
   * it on top, and says so. "conflict": main's changes and this one overlap, so the task is back on its
   * builder step, with the working copy on main and the change applied, conflict markers and all.
   * `fresh`: right before shipping, where only main freshly fetched from GitHub counts for a GitHub delivery.
   */
  async upToDate(scope: RepositoryContext, signal: AbortSignal, fresh = false): Promise<"current" | "moved" | "conflict"> {
    const { task, work: repository } = scope;
    if (task.repositories && (repository.pr || repository.release || repository.landed)) return "current";
    const worktree = repository.worktree;
    const sourceName = repository.source?.start.kind === "pull-request" ? `PR #${repository.source.start.number}` : repository.source?.start.branch ?? "main";
    if (!worktree) return "current";
    const foldedFork = await this.fold(scope);
    const latest = await this.latestMain(scope, signal, fresh);
    if (!latest) return "current";
    // Checked before treating an older tip as already current. A rewrite can keep the first starting commit
    // and still drop a source commit this task already brought in.
    if (repository.baseSha && repository.baseSha !== latest.sha && !(await git.contains(worktree, latest.sha, repository.baseSha))) {
      throw new Error("The starting branch's history was replaced or diverged. The task's work is preserved; it cannot be published safely without a decision.");
    }
    const fork = foldedFork === latest.sha ? foldedFork : await git.mergeBase(worktree, "HEAD", latest.sha);
    if (!fork) throw new Error(`The work and ${latest.ref} share no history, so Petrina could not bring the work up to date`);
    if (fork === latest.sha) return "current";
    const [clean, merged, gained, tree] = await Promise.all([
      git.isClean(worktree), git.mergeTree(worktree, latest.sha), git.commitsSince(worktree, fork, latest.sha),
      repository.reviewedTree ? git.treeOf(worktree) : undefined,
    ]);
    if (!clean) throw new Error(`The working copy has changes Petrina did not commit, so it could not bring the work up to date with ${sourceName}`);
    if (!merged) throw new Error(`Petrina could not bring the work up to date with ${sourceName}`);
    const commits = `${gained} new commit${gained === 1 ? "" : "s"}`;
    const reviewed = !!repository.reviewedTree && repository.reviewedTree === tree;
    if (!merged.conflicts.length) {
      await git.moveTo(worktree, await git.commitTree(worktree, merged.tree, latest.sha, this.message(scope)));
      if (reviewed) repository.reviewedTree = merged.tree;
      if (repository.checks) repository.checks.current = repository.checks.tree === merged.tree;
      repository.baseSha = latest.sha;
      repository.base = latest.ref;
      // The version the last round reviewed, carried onto the new base too, so the next round still sees only what changed since.
      if (repository.reviewedSha) {
        const carried = await this.carry(scope, repository.reviewedSha);
        if (carried) repository.reviewedSha = carried;
        else delete repository.reviewedSha;
      }
      this.k.log(scope, "done", `Brought up to date with ${sourceName} (${commits} there), with no conflicts`);
      this.k.commit();
      return "moved";
    }
    const builder = lastIndexWhere(task.plan?.stages ?? [], (stage) => stage.roleId === "builder" && stage.kind === "do");
    if (builder < 0) throw new Error(`${sourceName === "main" ? "Main" : sourceName} moved on and the work conflicts with it, but the plan has no builder to bring it up to date`);
    // On disk before the working copy moves: a restart in between finds the update and opens it again.
    // Only a completed review of this exact code permits the later review to cover the port alone.
    const head = reviewed ? await git.head(worktree) : undefined;
    repository.updating = { from: fork, onto: latest.sha, ...(head ? { head } : {}), files: merged.conflicts, ...(merged.notes.length ? { notes: merged.notes } : {}) };
    // The builder ports the change by hand: whatever was approved before, the coordinator checks it again.
    delete repository.approvedSha;
    delete repository.approvedPatch;
    delete repository.approvedFor;
    repository.baseSha = latest.sha;
    repository.base = latest.ref;
    if (task.repositories) task.repair = { products: [repository.productId], index: 0, returnStage: task.stageIndex, kind: "review" };
    task.stageIndex = builder;
    task.sub = 0;
    task.fixing = false;
    this.k.commitNow();
    await git.openOn(worktree, latest.sha, merged.tree);
    const files = merged.conflicts.length === 1 ? "1 file conflicts" : `${merged.conflicts.length} files conflict`;
    // A moment of Petrina's own on the journey: why the builder gets the work back.
    petrinaMoment(task, "update", { outcome: W.mainMoved(merged.conflicts.length, sourceName), reason: W.conflicts(sourceName), tone: "back" }, Date.now());
    this.k.log(scope, "warn", `${sourceName === "main" ? "Main" : sourceName} moved on (${commits}) and ${files} with this work, so the builder brings it up to date`);
    this.k.commit();
    return "conflict";
  }

  /**
   * A reviewed version of the change carried onto the current base unchanged: a commit of its merge with the
   * base, on no branch, kept only as a reference for "what changed since". Undefined when the two overlap.
   */
  private async carry(scope: RepositoryContext, sha: string): Promise<string | undefined> {
    const { work: repository } = scope;
    const worktree = repository.worktree;
    const base = repository.baseSha;
    if (!worktree || !base) return undefined;
    const merged = await git.mergeTree(worktree, base, sha);
    if (!merged || merged.conflicts.length) return undefined;
    return git.commitTree(worktree, merged.tree, base, "The version the last review round saw, carried onto the latest main (Petrina's reference, on no branch)");
  }

  /** Before the builder starts on an update: the working copy as `upToDate` left it, even after a restart in between. */
  async reopen(scope: RepositoryContext): Promise<void> {
    const { work: repository } = scope;
    const updating = repository.updating;
    if (!updating || !repository.worktree) return;
    if ((await git.head(repository.worktree).catch(() => undefined)) === updating.onto) return;
    const merged = await git.mergeTree(repository.worktree, updating.onto);
    const sourceName = repository.source?.start.kind === "pull-request" ? `PR #${repository.source.start.number}` : repository.source?.start.branch ?? "main";
    if (!merged) throw new Error(`Petrina could not bring the work up to date with ${sourceName}`);
    await git.openOn(repository.worktree, updating.onto, merged.tree);
  }

  /**
   * The latest approved source, fetched from its saved address. Commit delivery also accounts for newer
   * local destination commits. Explicit sources never fall back to an old copy. Ordinary default-branch
   * tasks keep their existing fallback before delivery; publishing always needs a fresh GitHub read.
   */
  private async latestMain(scope: RepositoryContext, signal: AbortSignal, fresh: boolean): Promise<{ ref: string; sha: string } | undefined> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope);
    if (!product?.path) return undefined;
    const branch = repository.source?.start.branch ?? product.defaultBranch ?? "main";
    let remote: { ref: string; sha: string } | undefined;
    if (repository.source && repository.source.start.kind !== "default") {
      remote = await this.sources.fetch(scope, signal);
    } else if (!(repository.delivery === "local" && !product.remote && product.remoteRefused)) {
      const fetched = await this.connections.fetchDefault(scope, signal);
      if (fetched.ok) remote = { ref: `origin/${branch}`, sha: fetched.sha };
      else if (fresh && !fetched.missing) throw new Error(`Petrina could not get the latest ${branch} from GitHub (${this.connections.why(scope, fetched)}), so it published nothing. Retry when that is sorted.`);
      else if (!fetched.missing) this.k.log(scope, "warn", `Did not update from GitHub: ${this.connections.why(scope, fetched)}, so Petrina compared the work with the local copy of ${branch}`);
    }
    if (repository.delivery !== "local" || repository.source?.start.kind === "pull-request") {
      if (remote) return remote;
      const sha = await git.revParse(product.path, `refs/remotes/origin/${branch}`) ?? await git.revParse(product.path, `refs/heads/${branch}`);
      return sha ? { ref: branch, sha } : undefined;
    }
    const local = await git.revParse(product.path, `refs/heads/${branch}`);
    if (!local) return remote;
    // Our own unpushed placement is work to carry forward, not an independent source commit.
    if (remote && repository.localUpdate?.pushed === false && repository.localUpdate.branch === branch && repository.localUpdate.sha === local) return remote;
    if (!remote || await git.contains(product.path, local, remote.sha)) return { ref: branch, sha: local };
    if (await git.contains(product.path, remote.sha, local)) return remote;
    throw new Error(`${branch} in the local copy and on GitHub have divergent history. The task's work is preserved. Bring the destination copies into agreement before retrying.`);
  }
}
