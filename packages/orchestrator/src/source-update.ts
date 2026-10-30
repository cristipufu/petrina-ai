import { completeAll, JOURNEY_WORDS, petrinaMoment } from "@petrina/core";
import { keptLearningsMessage } from "./learning-merge.js";
import { SourceConflicts } from "./source-conflicts.js";
import type { RepositoryContext } from "./repository-context.js";
import type { SourceUpdateHost, SourceUpdateEffects, SourceFoldObservation, SourceMerge } from "./ports/source-update.js";

/** Owns source selection, fold/update decisions and canonical state; native observations stay behind bounded effects. */
export interface FoldedVersion {
  fork: string;
  version: { head: string; tree: string };
}

export class SourceUpdates {
  private readonly conflicts: SourceConflicts;
  private readonly knownForks = new WeakMap<RepositoryContext["work"], { head: string; base: string; fork: string }>();
  constructor(private readonly host: SourceUpdateHost, private readonly effects: SourceUpdateEffects) {
    this.conflicts = new SourceConflicts(host);
  }

  /** The task's one commit message: the builder's title in the repository's style, what changed for users, who built it. */
  message(scope: RepositoryContext): string {
    const { task, work: repository } = scope;
    const builder = task.plan?.stages.find((stage) => this.host.role(stage.roleId, task)?.result === "build");
    const by = repository.builderSession?.profileId ?? builder?.profileIds[0];
    const changes = (repository.report?.changes ?? []).map((change) => `- ${change}`).join("\n");
    return [
      repository.report?.title ?? task.title,
      repository.report?.summary ?? "",
      changes,
      `Built by Petrina${by ? `: ${this.host.describe(
      builder?.roleId ?? "builder",
      by
    )}` : ""}`
    ].filter(Boolean).join("\n\n");
  }

  /** The branch as one commit on top of where it forked, with the same code and the task's message. */
  async fold(scope: RepositoryContext, sourceRef: (path: string, ref: string) => Promise<string | undefined> = (
    path,
    ref
  ) => this.effects.sourceRef(
    path,
    ref
  )): Promise<FoldedVersion | undefined> {
    const { work: repository } = scope;
    // While the builder brings the work up to date, the branch sits on main with the change not committed yet.
    const worktree = repository.worktree;
    if (!worktree || repository.updating) return;
    // Source/commit reads below do not change HEAD. Keep this observation within this fold only.
    let pending: Promise<SourceFoldObservation> | undefined;
    const observe = () => pending ??= this.effects.repository(worktree).observeFold();
    const settled = await this.settleBase(scope, observe, sourceRef);
    const base = settled.base ?? repository.base;
    if (!base) return;
    const observed = await observe();
    const fork = settled.fork ?? await this.effects.repository(worktree).mergeBase(observed.kind === "observed" ? observed.head : "HEAD", base);
    if (!fork) return;
    const version = await observed.squash(fork, this.message(scope));
    const currentBase = repository.baseSha ?? repository.base;
    if (currentBase) this.knownForks.set(repository, { head: version.head, base: currentBase, fork });
    await this.host.rememberVersion(scope, version);
    return { fork, version };
  }

  /**
   * Where the task's work starts, checked before each fold. A builder that brings main into its branch itself
   * (told not to, but it happens) moves where the branch last met main past the base noted when the working
   * copy was made; left there, main's own changes would read as the task's in every review, and its merge
   * would be folded into the task's commit. The base follows the branch's latest meeting with main, read from
   * the product's own clone with no network. The same when the noted base is not in the branch at all.
   */
  private async settleBase(
    scope: RepositoryContext,
    observe: () => Promise<SourceFoldObservation>,
    sourceRef: (path: string, ref: string) => Promise<string | undefined>,
  ): Promise<{ base?: string; fork?: string }> {
    const { task, work: repository } = scope;
    const worktree = repository.worktree!;
    const base = repository.baseSha;
    const product = this.host.repositoryOf(scope);
    if (!base || !product?.path) return { base };
    const branch = repository.source?.start.branch ?? product.defaultBranch ?? "main";
    const main = repository.source?.start.kind === "pull-request"
      ? await sourceRef(product.path, `refs/petrina/sources/${task.id}`)
      : (repository.delivery !== "local" || repository.localUpdate?.pushed === false ? await sourceRef(
        product.path,
        `refs/remotes/origin/${branch}`
      ) : undefined) ?? (await sourceRef(
        product.path,
        `refs/heads/${branch}`
      ));
    if (!main) return { base };
    const observed = await observe();
    const head = observed.kind === "observed" ? observed.head : "HEAD";
    // Direct recorded ancestry proves the ordinary unchanged source without walking history again.
    if (main === base && observed.kind === "observed" && (observed.head === base || observed.parents.length === 1 && observed.parents[0] === base)) return {
      base,
      fork: base
    };
    if ((await this.effects.repository(worktree).mergeBase(head, main)) === base) return { base, fork: base };
    // Moving where the work starts rests on the commits themselves, not on Git's commit index: an edited one could
    // move it past a lesson main removed, which the learnings kept on an update would then bring back.
    const met = await this.effects.repository(worktree).mergeBase(head, main, true);
    if (!met) return { base };
    if (met === base) return { base, fork: base };
    const [forward, baseInBranch] = await completeAll([
      this.effects.repository(worktree).contains(
      met,
      base,
      true
    ),
      this.effects.repository(worktree).contains(
      head,
      base,
      true
    )
    ]);
    // The usual case: the branch forked at the base and main moved on since. Nothing to settle.
    if (!forward && baseInBranch) return { base, fork: base };
    repository.baseSha = met;
    await this.carryReviewed(scope);
    this.host.note(
      scope,
      "warn",
      forward
        ? `The builder brought ${branch} into the branch itself, so the work now counts from ${met.slice(
          0,
          7
        )} and reviews see only its own changes. Petrina brings work up to date; builders need not.`
        : `The work's noted base was not in the branch: it now counts from ${met.slice(0, 7)}, where the branch last met ${branch}`,
    );
    this.host.changed();
    return { base: met, fork: met };
  }

  /** The change itself (git's patch-id), from where the branch forked to `ref`. */
  async patch(scope: RepositoryContext, ref = "HEAD"): Promise<string | undefined> {
    const { work: repository } = scope;
    const base = repository.baseSha ?? repository.base;
    const worktree = repository.worktree;
    if (!worktree || !base) return undefined;
    const known = ref !== "HEAD" ? this.knownForks.get(repository) : undefined;
    const fork = (known && known.head === ref && known.base === base ? known.fork : await this.effects.repository(worktree).mergeBase(ref, base)) ?? base;
    return this.effects.repository(worktree).patchId(fork, ref);
  }

  /**
   * The task's work as one commit on top of the latest main. "current": it already was. "moved": Petrina put
   * it on top, and says so, keeping both sides' approved learnings when only they overlap. "conflict": main's
   * changes and this one overlap, so the task is back on its builder step, with the working copy on main and the
   * change applied, conflict markers and all.
   * `fresh`: right before shipping, where only main freshly fetched from GitHub counts for a GitHub delivery.
   * `requiredSource`: release from a prerequisite wait also refuses a missing approved GitHub connection.
   */
  async upToDate(scope: RepositoryContext, signal: AbortSignal, fresh = false, requiredSource = false): Promise<"current" | "moved" | "conflict"> {
    const { task, work: repository } = scope;
    if (task.repositories && (repository.pr || repository.release || repository.landed)) return "current";
    const worktree = repository.worktree;
    const sourceName = repository.source?.start.kind === "pull-request" ? `PR #${repository.source.start.number}` : repository.source?.start.branch ?? "main";
    if (!worktree) return "current";
    const sourceRefs = new Map<string, Promise<string | undefined>>();
    const readSourceRef = (path: string, ref: string) => {
      const key = `${path}\0${ref}`;
      let hit = sourceRefs.get(key);
      if (!hit) {
        hit = this.effects.sourceRef(path, ref);
        sourceRefs.set(key, hit);
      }
      return hit;
    };
    const folded = await this.fold(scope, readSourceRef);
    const foldedFork = folded?.fork;
    const latest = await this.latestMain(scope, signal, fresh, requiredSource, sourceRefs, readSourceRef);
    if (!latest) return "current";
    // Checked before treating an older tip as already current. A rewrite can keep the first starting commit
    // and still drop a source commit this task already brought in.
    if (repository.baseSha && repository.baseSha !== latest.sha && !(await this.effects.repository(worktree).contains(latest.sha, repository.baseSha))) {
      throw new Error("The starting branch's history was replaced or diverged. The task's work is preserved; it cannot be published safely without a decision.");
    }
    const fork = foldedFork === latest.sha ? foldedFork : await this.effects.repository(worktree).mergeBase("HEAD", latest.sha);
    if (!fork) throw new Error(`The work and ${latest.ref} share no history, so Petrina could not bring the work up to date`);
    if (fork === latest.sha) return "current";
    const observation = this.effects.repository(worktree);
    let clean!: boolean;
    let merged: SourceMerge | undefined;
    let gained!: number;
    let tree: string | undefined;
    await completeAll([
      observation.isClean().then(value => { clean = value; }),
      observation.mergeTree(latest.sha).then(value => { merged = value; }),
      observation.commitsSince(fork, latest.sha).then(value => { gained = value; }),
      repository.reviewedTree ? (folded?.version.tree ? Promise.resolve(folded.version.tree) : observation.treeOf()).then(value => { tree = value; }) : Promise.resolve(),
    ]);
    if (!clean) throw new Error(`The working copy has changes Petrina did not commit, so it could not bring the work up to date with ${sourceName}`);
    if (!merged) throw new Error(`Petrina could not bring the work up to date with ${sourceName}`);
    const commits = `${gained} new commit${gained === 1 ? "" : "s"}`;
    const reviewed = !!repository.reviewedTree && repository.reviewedTree === tree;
    const kept = merged.conflicts.length ? await this.keptLearnings(scope, fork, latest.sha, merged) : undefined;
    if (!merged.conflicts.length || kept) {
      const result = kept?.tree ?? merged.tree;
      const head = await this.effects.repository(worktree).commitTree(result, latest.sha, this.message(scope));
      await this.effects.repository(worktree).moveTo(head);
      if (reviewed) repository.reviewedTree = result;
      if (repository.checks) repository.checks.current = repository.checks.tree === result;
      this.knownForks.set(repository, { head, base: latest.sha, fork: latest.sha });
      await this.host.rememberVersion(scope, { head, tree: result });
      repository.baseSha = latest.sha;
      repository.base = latest.ref;
      // The version the last round reviewed, carried onto the new base too, so the next round still sees only what changed since.
      await this.carryReviewed(scope);
      if (kept) {
        // Not a send-back: told apart from a conflict on the journey, with the lines it kept in the log.
        petrinaMoment(
          task,
          "update",
          {
          outcome: JOURNEY_WORDS.keptLearnings,
          reason: sourceName === "main" ? JOURNEY_WORDS.upToDate : `up to date with ${sourceName}`
        },
          this.host.now()
        );
        this.host.note(scope, "done", keptLearningsMessage(kept, sourceName, commits));
      } else this.host.note(scope, "done", `Brought up to date with ${sourceName} (${commits} there), with no conflicts`);
      this.host.changed();
      return "moved";
    }
    const conflicted = merged;
    return this.conflicts.begin(scope, {
      sourceName, from: fork, onto: latest.sha, ontoRef: latest.ref,
      files: merged.conflicts, notes: merged.notes, gained, reviewed,
    }, {
      head: () => folded?.version.head ? Promise.resolve(folded.version.head) : this.effects.repository(worktree).head(),
      open: () => this.effects.repository(worktree).openOn(
      latest.sha,
      conflicted.tree
    )
    });
  }

  /** Both sides' approved learnings kept, when `ref` and main overlap in nothing else. Only onto the product's own main. */
  private async keptLearnings(scope: RepositoryContext, fork: string, onto: string, merged: { tree: string; conflicts: readonly string[] }, ref = "HEAD") {
    const { work: repository } = scope;
    // A starting branch or pull request is not where approved learnings land.
    if (!repository.worktree || (repository.source?.start.kind ?? "default") !== "default") return undefined;
    return this.effects.keptLearnings(scope, fork, onto, merged, ref);
  }

  /**
   * A reviewed version of the change carried onto the current base unchanged, or with both sides' approved learnings
   * kept as an update keeps them: a commit of its merge with the base, on no branch, kept only as a reference for
   * "what changed since". Undefined when the two overlap otherwise.
   */
  private async carry(scope: RepositoryContext, sha: string): Promise<string | undefined> {
    const { work: repository } = scope;
    const worktree = repository.worktree;
    const base = repository.baseSha;
    if (!worktree || !base) return undefined;
    const merged = await this.effects.repository(worktree).mergeTree(base, sha);
    if (!merged) return undefined;
    const fork = merged.conflicts.length ? await this.effects.repository(worktree).mergeBase(sha, base) : undefined;
    const tree = merged.conflicts.length ? fork && (await this.keptLearnings(scope, fork, base, merged, sha))?.tree : merged.tree;
    if (!tree) return undefined;
    return this.effects.repository(worktree).commitTree(
      tree,
      base,
      "The version the last review round saw, carried onto the latest main (Petrina's reference, on no branch)"
    );
  }

  /** Keep the incremental comparison task-only, whoever advanced the execution base. */
  private async carryReviewed(scope: RepositoryContext): Promise<void> {
    if (!scope.work.reviewedSha) return;
    const carried = await this.carry(scope, scope.work.reviewedSha);
    if (carried) scope.work.reviewedSha = carried;
    else delete scope.work.reviewedSha;
  }

  /** Before the builder starts on an update: the working copy as `upToDate` left it, even after a restart in between. */
  async reopen(scope: RepositoryContext): Promise<void> {
    const { work: repository } = scope;
    const updating = repository.updating;
    const worktree = repository.worktree;
    if (!updating || !worktree) return;
    if ((await this.effects.repository(worktree).head().catch(() => undefined)) === updating.onto) return;
    const merged = await this.effects.repository(worktree).mergeTree(updating.onto);
    const sourceName = repository.source?.start.kind === "pull-request" ? `PR #${repository.source.start.number}` : repository.source?.start.branch ?? "main";
    if (!merged) throw new Error(`Petrina could not bring the work up to date with ${sourceName}`);
    await this.effects.repository(worktree).openOn(updating.onto, merged.tree);
  }

  /**
   * The latest approved source, fetched from its saved address. Commit delivery also accounts for newer
   * local destination commits. Explicit sources never fall back to an old copy. Ordinary default-branch
   * tasks keep their existing fallback before delivery; publishing always needs a fresh GitHub read.
   */
  private async latestMain(
    scope: RepositoryContext,
    signal: AbortSignal,
    fresh: boolean,
    requiredSource: boolean,
    sourceRefs: Map<string, Promise<string | undefined>>,
    sourceRef: (path: string, ref: string) => Promise<string | undefined>,
  ): Promise<{ ref: string; sha: string } | undefined> {
    const { work: repository } = scope;
    const product = this.host.repositoryOf(scope);
    if (!product?.path) return undefined;
    const branch = repository.source?.start.branch ?? product.defaultBranch ?? "main";
    let remote: { ref: string; sha: string } | undefined;
    if (repository.source && repository.source.start.kind !== "default") {
      sourceRefs.clear();
      remote = await this.effects.fetchSource(scope, signal);
    } else if (!(repository.delivery === "local" && !product.remote && product.remoteRefused)) {
      const fetched = await this.effects.fetchDefault(scope, signal);
      if (fetched.ok || !fetched.missing) sourceRefs.clear();
      if (fetched.ok) remote = { ref: `origin/${branch}`, sha: fetched.sha };
      else if (requiredSource && (repository.delivery !== "local" || !!product.remote && !product.remoteRefused && !product.repo.startsWith("local/"))) throw new Error(`Petrina could not get the latest starting code from GitHub (${this.host.fetchFailure(
        scope,
        fetched
      )}). Your work is preserved. Try again when the connection is available.`);
      else if (fresh && !fetched.missing) throw new Error(`Petrina could not get the latest ${branch} from GitHub (${this.host.fetchFailure(
        scope,
        fetched
      )}), so it published nothing. Retry when that is sorted.`);
      else if (!fetched.missing) this.host.note(
        scope,
        "warn",
        `Did not update from GitHub: ${this.host.fetchFailure(
        scope,
        fetched
      )}, so Petrina compared the work with the local copy of ${branch}`
      );
    }
    if (repository.delivery !== "local" || repository.source?.start.kind === "pull-request") {
      if (remote) return remote;
      const sha = await sourceRef(product.path, `refs/remotes/origin/${branch}`) ?? await sourceRef(product.path, `refs/heads/${branch}`);
      return sha ? { ref: branch, sha } : undefined;
    }
    const local = await sourceRef(product.path, `refs/heads/${branch}`);
    if (!local) return remote;
    // Our own unpushed placement is work to carry forward, not an independent source commit.
    if (remote && repository.localUpdate?.pushed === false && repository.localUpdate.branch === branch && repository.localUpdate.sha === local) return remote;
    if (!remote || await this.effects.sourceContains(product.path, local, remote.sha)) return { ref: branch, sha: local };
    if (await this.effects.sourceContains(product.path, remote.sha, local)) return remote;
    throw new Error(`${branch} in the local copy and on GitHub have divergent history. The task's work is preserved. Bring the destination copies into agreement before retrying.`);
  }
}
