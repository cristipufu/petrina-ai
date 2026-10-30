import { SourceUpdates, type RepositoryContext } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { keptLearnings } from "./learnings.js";
import type { Sources } from "./sources.js";
import type { Connections } from "./connection.js";
import type { Kernel } from "./kernel.js";

export type { FoldedVersion } from "@petrina/orchestrator";

/** The native source-update adapter keeps credentialed fetches and product/worktree namespaces separate. */
export class Updates extends SourceUpdates {
  private readonly observedHeads: WeakMap<RepositoryContext["work"], string>;
  constructor(k: Kernel, connections: Connections, sources: Sources) {
    const observedHeads = new WeakMap<RepositoryContext["work"], string>();
    super({
      role: (id, task) => k.role(id, task), repositoryOf: scope => k.repositoryOf(scope),
      productName: scope => k.repositoryOf(scope)?.name, describe: (role, profile) => k.describe(role, profile),
      rememberVersion: async (scope, version) => {
        if (version?.head) observedHeads.set(scope.work, version.head);
        else observedHeads.delete(scope.work);
        await k.rememberVersion(scope, version);
      },
      fetchFailure: (scope, failure) => connections.why(scope, failure),
      checkpoint: () => k.commitNow(), changed: () => k.commit(),
      note: (scope, tone, text) => k.log(scope, tone, text), now: () => Date.now(),
    }, {
      repository: path => {
        return {
          observeFold: () => git.observeFold(path),
          mergeBase: (head, base, raw) => git.mergeBase(path, head, base, raw),
          contains: (head, base, raw) => git.contains(path, head, base, raw),
          isClean: () => git.isClean(path), mergeTree: (onto, ref) => git.mergeTree(path, onto, ref),
          commitsSince: (from, to) => git.commitsSince(path, from, to), treeOf: ref => git.treeOf(path, ref),
          moveTo: sha => git.moveTo(path, sha), commitTree: (tree, parent, message) => git.commitTree(path, tree, parent, message),
          head: () => git.head(path), openOn: (onto, tree) => git.openOn(path, onto, tree),
          patchId: (from, ref) => git.patchId(path, from, ref),
        };
      },
      sourceRef: (path, ref) => git.revParse(path, ref),
      sourceContains: (path, head, base) => head === base ? Promise.resolve(true) : git.contains(path, head, base),
      fetchDefault: (scope, signal) => connections.fetchDefault(scope, signal),
      fetchSource: (scope, signal) => sources.fetch(scope, signal),
      keptLearnings: (scope, fork, onto, merged, ref) => keptLearnings(k.productOf(scope), scope.task.id, scope.work.worktree!, fork, onto, merged, ref),
    });
    this.observedHeads = observedHeads;
  }

  clearObservedHead(scope: RepositoryContext): void {
    this.observedHeads.delete(scope.work);
  }

  consumeObservedHead(scope: RepositoryContext): string | undefined {
    const head = this.observedHeads.get(scope.work);
    this.observedHeads.delete(scope.work);
    return head;
  }
}
