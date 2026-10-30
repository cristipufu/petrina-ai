import { BUILT_IN_ROLES, roleForTask, type DeepMutable, type Product } from "@petrina/core";
import { SourceUpdates } from "../../src/source-update.js";
import type { SourceFetch, SourceFoldObservation, SourceMerge, SourceUpdateRepository, SourceVersion } from "../../src/ports/source-update.js";
import type { LearningMergeResult } from "../../src/ports/learning-merge.js";
import { sourceConflictFixture } from "./source-conflicts.js";

function operation<Args extends unknown[], Value>(name: string, calls: { name: string; args: unknown[] }[]) {
  const pending: { args: Args; answer: () => Promise<Value> }[] = [];
  return {
    expect(args: Args, value: Value) { pending.push({ args, answer: async () => value }); },
    effect(args: Args, answer: () => Promise<Value>) { pending.push({ args, answer }); },
    async read(...args: Args): Promise<Value> {
      calls.push({ name, args });
      const next = pending.shift();
      if (!next || JSON.stringify(args) !== JSON.stringify(next.args))
        throw new Error(`Unexpected ${name} observation: ${JSON.stringify(args)}; expected ${JSON.stringify(next?.args)}`);
      return next.answer();
    },
    remaining: () => pending.length,
  };
}

/** Actual update/conflict owners, supplied observations and explicitly consumed effect requests; no simulated Git graph. */
export function sourceUpdateFixture(kind: "default" | "branch" | "pull-request" = "default", shared = false) {
  const f = sourceConflictFixture(shared), { task, scope } = f;
  const product: DeepMutable<Product> = { id: scope.work.productId, name: "Product", repo: "acme/product", path: "native-product-observation",
    remote: "https://github.com/acme/product.git", defaultBranch: "main", tone: "blue" };
  const branch = kind === "default" ? "main" : kind === "branch" ? "release-2.x" : "review-work";
  scope.work.source = { product: { ...product }, start: kind === "pull-request"
    ? { kind, number: 7, url: "https://github.com/acme/product/pull/7", branch, headRepo: "acme/product" }
    : { kind, branch }, destination: { mode: "local", kind: "branch", repo: product.repo, branch }, confirmed: true, initialSha: "initial-source" };
  scope.work.baseSha = "base"; scope.work.base = branch;
  const calls: { name: string; args: unknown[] }[] = [];
  const reads = {
    observeFold: operation<[], SourceFoldObservation>("observeFold", calls),
    squash: operation<[string, string], { head: string; tree: string }>("squash", calls),
    mergeBase: operation<[string, string, boolean?], string | undefined>("mergeBase", calls),
    contains: operation<[string, string, boolean?], boolean>("contains", calls),
    isClean: operation<[], boolean>("isClean", calls),
    mergeTree: operation<[string, string?], SourceMerge | undefined>("mergeTree", calls),
    commitsSince: operation<[string, string], number>("commitsSince", calls),
    treeOf: operation<[string?], string | undefined>("treeOf", calls),
    moveTo: operation<[string], void>("moveTo", calls),
    commitTree: operation<[string, string, string], string>("commitTree", calls),
    head: operation<[], string>("head", calls),
    openOn: operation<[string, string], void>("openOn", calls),
    patchId: operation<[string, string], string | undefined>("patchId", calls),
    sourceRef: operation<[string], string | undefined>("sourceRef", calls),
    sourceContains: operation<[string, string], boolean>("sourceContains", calls),
    fetchDefault: operation<[], SourceFetch>("fetchDefault", calls),
    fetchSource: operation<[], SourceVersion>("fetchSource", calls),
    keptLearnings: operation<[string, string, { tree: string; conflicts: readonly string[] }, string], LearningMergeResult | undefined>("keptLearnings", calls),
    rememberVersion: operation<[{ head: string; tree: string }?], void>("rememberVersion", calls),
  };
  const repository: SourceUpdateRepository = {
    observeFold: reads.observeFold.read, mergeBase: reads.mergeBase.read, contains: reads.contains.read,
    isClean: reads.isClean.read, mergeTree: reads.mergeTree.read, commitsSince: reads.commitsSince.read,
    treeOf: reads.treeOf.read, moveTo: reads.moveTo.read, commitTree: reads.commitTree.read,
    head: reads.head.read, openOn: reads.openOn.read, patchId: reads.patchId.read,
  };
  const ownScope = (bound: typeof scope) => { if (bound !== scope) throw new Error("Unexpected repository execution"); };
  const ownProduct = (path: string) => { if (path !== product.path) throw new Error("Unexpected product repository namespace"); };
  const notes: string[] = [], versions: ({ head: string; tree: string } | undefined)[] = [];
  const controller = new SourceUpdates({
    ...f.host, role: (id, current) => roleForTask(BUILT_IN_ROLES, id, current), repositoryOf: bound => { ownScope(bound); return product; },
    describe: () => "the actual selected builder", fetchFailure: (_scope, failure) => failure.error,
    note: (_scope, _tone, text) => { notes.push(text); },
    rememberVersion: async (bound, version) => { ownScope(bound); await reads.rememberVersion.read(version); versions.push(version); },
  }, {
    repository: worktree => {
      if (worktree !== scope.work.worktree) throw new Error("Unexpected repository execution");
      return repository;
    },
    sourceRef: (path, ref) => { ownProduct(path); return reads.sourceRef.read(ref); },
    sourceContains: (path, head, base) => { ownProduct(path); return reads.sourceContains.read(head, base); },
    fetchDefault: bound => { ownScope(bound); return reads.fetchDefault.read(); },
    fetchSource: bound => { ownScope(bound); return reads.fetchSource.read(); },
    keptLearnings: (bound, fork, onto, merged, ref) => { ownScope(bound); return reads.keptLearnings.read(fork, onto, merged, ref); },
  });
  const folded = { head: "folded", tree: "own-tree" };
  const fold = (main = "base", head = "own-head", parents = ["base"]) => {
    const ref = kind === "pull-request" ? `refs/petrina/sources/${task.id}`
      : scope.work.delivery !== "local" || scope.work.localUpdate?.pushed === false ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`;
    reads.sourceRef.expect([ref], main);
    reads.observeFold.expect([], { kind: "observed", head, tree: "own-tree", parents, squash: reads.squash.read });
    reads.squash.expect(["base", controller.message(scope)], folded);
    reads.rememberVersion.expect([folded], undefined);
  };
  const fetched = (sha = "latest") => {
    if (kind === "default") reads.fetchDefault.expect([], { ok: true, sha });
    else reads.fetchSource.expect([], { ref: `origin/${branch}`, sha });
    if (scope.work.delivery === "local" && kind !== "pull-request") {
      reads.sourceRef.expect([`refs/heads/${branch}`], sha);
      reads.sourceContains.expect([sha, sha], true);
    }
  };
  const incoming = (merge: SourceMerge | null = { tree: "combined-tree", conflicts: [], notes: [] }, clean = true) => {
    reads.contains.expect(["latest", "base"], true);
    reads.mergeBase.expect(["HEAD", "latest"], "base");
    reads.isClean.expect([], clean); reads.mergeTree.expect(["latest"], merge ?? undefined); reads.commitsSince.expect(["base", "latest"], 1);
  };
  return { ...f, product, branch, controller, calls, reads, notes, versions, fold, fetched, incoming,
    update: (fresh = false, required = false) => controller.upToDate(scope, f.signal, fresh, required),
    consumed() { for (const [name, observation] of Object.entries(reads)) if (observation.remaining()) throw new Error(`Unconsumed ${name}: ${observation.remaining()}`); },
  };
}
