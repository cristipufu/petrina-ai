import {
  completeAll,
  effectiveDestinationKind,
  proofDecision,
  refreshProofs,
  sameProofDecision,
  type DeliveryDestinationKind,
  type DeliveryMode,
  type Product,
  type TaskSource,
} from "@petrina/core";
import { scopesFor, type RepositoryContext } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { Kernel, MutableStage, RuntimeTask } from "./kernel.js";
import type { ReleasePrep } from "./release-prep.js";
import {
  prepareBranchOrPrUpdateCandidate,
  prepareNewPullRequestCandidate,
  prepareReleaseCandidate,
  publishPrUpdateDelivery,
  publishPullRequestDelivery,
  publishReleaseDelivery,
  type ShippingPublishHooks,
} from "./shipping-publishers.js";
import type { ShippingVerifier } from "./shipping-verifier.js";

export interface ProofScopeContext {
  readonly k: Kernel;
  readonly releases: ReleasePrep;
  readonly verifier: ShippingVerifier;
  readonly task: RuntimeTask;
  readonly scope: RepositoryContext;
  readonly head: string | undefined;
  readonly versions: Record<string, string>;
  readonly delivered: boolean;
  readonly prepared: boolean;
  readonly signal: AbortSignal;
}

export interface DeliveryDestinationStrategy {
  readonly kind: DeliveryDestinationKind;
  readonly checkBranchSourceBeforePublish: boolean;
  readonly requiresProofRecheckWhenDelivered: boolean;
  destinationKey(
    task: { readonly delivery: DeliveryMode; readonly source?: TaskSource },
    product: Pick<Product, "path" | "repo" | "defaultBranch"> | undefined,
  ): string;
  prepare(
    hooks: ShippingPublishHooks,
    scope: RepositoryContext,
    stage: MutableStage,
    signal: AbortSignal,
  ): Promise<"ready" | "continue" | "stop">;
  publish(
    hooks: ShippingPublishHooks,
    scope: RepositoryContext,
    signal: AbortSignal,
  ): Promise<"done" | "again" | "continue" | "stop">;
  validateProofScope(ctx: ProofScopeContext): Promise<boolean>;
}

function remoteRepoBranchKey(
  task: { readonly source?: TaskSource },
  product: Pick<Product, "repo" | "defaultBranch"> | undefined,
): string {
  if (task.source) {
    return `${task.source.destination.repo}#${task.source.destination.branch}`;
  }
  return `${product?.repo ?? ""}#${product?.defaultBranch ?? "main"}`;
}

export const DELIVERY_STRATEGIES = {
  "update-pr": {
    kind: "update-pr",
    checkBranchSourceBeforePublish: false,
    requiresProofRecheckWhenDelivered: false,
    destinationKey: (task, product) => {
      if (task.source && task.source.destination.kind === "update-pr" && task.source.start.kind === "pull-request") {
        const target = task.source.destination;
        return `${task.source.product.repo}#pr/${task.source.start.number}:${target.repo}#${target.branch}`;
      }
      return remoteRepoBranchKey(task, product);
    },
    prepare: prepareBranchOrPrUpdateCandidate,
    publish: publishPrUpdateDelivery,
    validateProofScope: async () => true,
  },
  "new-pr": {
    kind: "new-pr",
    checkBranchSourceBeforePublish: true,
    requiresProofRecheckWhenDelivered: false,
    destinationKey: (task, product) => remoteRepoBranchKey(task, product),
    prepare: (hooks, scope) => prepareNewPullRequestCandidate(hooks, scope),
    publish: publishPullRequestDelivery,
    validateProofScope: async ({ verifier, scope, delivered, prepared, signal }) => {
      const shipping = scope.work.shipping;
      if (!delivered && prepared && shipping?.base && !shipping.pushed) {
        return verifier.sourceCurrent(scope, signal);
      }
      return true;
    },
  },
  release: {
    kind: "release",
    checkBranchSourceBeforePublish: false,
    requiresProofRecheckWhenDelivered: true,
    destinationKey: (task, product) => remoteRepoBranchKey(task, product),
    prepare: prepareReleaseCandidate,
    publish: publishReleaseDelivery,
    validateProofScope: async ({ releases, verifier, task, scope, head, versions, delivered, prepared, signal }) => {
      const { work } = scope;
      if (work.approvedFor?.by !== "coordinator") return false;
      const version = work.proofRelease;
      if (version && head !== version.start) {
        if (head !== version.tested || !(await releases.isVersionCommit(work.worktree!, head, version.start))) {
          return false;
        }
        if (versions[work.productId] !== task.approvedProofDecision?.versions[work.productId]) {
          versions[work.productId] = (await git.treeOf(work.worktree!, version.start)) ?? "unavailable";
        }
      }
      const shipping = work.shipping;
      if (!delivered && prepared && shipping?.base && !shipping.pushed) {
        return verifier.sourceCurrent(scope, signal);
      }
      return true;
    },
  },
  branch: {
    kind: "branch",
    checkBranchSourceBeforePublish: true,
    requiresProofRecheckWhenDelivered: false,
    destinationKey: (task, product) => {
      if (task.source) {
        return `${task.source.product.path ?? ""}#${task.source.destination.branch}`;
      }
      return `${product?.path ?? ""}#${product?.defaultBranch ?? "main"}`;
    },
    prepare: prepareBranchOrPrUpdateCandidate,
    publish: (hooks, scope, signal) => hooks.publishLocal(scope, signal),
    validateProofScope: async ({ k, scope, delivered, prepared }) => {
      const { work } = scope;
      const shipping = work.shipping;
      if (!delivered && prepared && shipping?.base && !shipping.pushed) {
        const product = k.repositoryOf(scope)!;
        const branch = work.source?.start.branch ?? product.defaultBranch ?? "main";
        const current = await git.revParse(product.path!, `refs/heads/${branch}`);
        const ownUpdate = current === shipping.localUpdated && current === shipping.prepared?.tested;
        if (current && !ownUpdate && current !== shipping.base && !(await git.contains(product.path!, shipping.base, current))) {
          return false;
        }
      }
      return true;
    },
  },
} as const satisfies Readonly<Record<DeliveryDestinationKind, DeliveryDestinationStrategy>>;

export function deliveryStrategyFor(work: {
  readonly delivery: DeliveryMode;
  readonly source?: Pick<TaskSource, "start"> | undefined;
}): DeliveryDestinationStrategy {
  return DELIVERY_STRATEGIES[effectiveDestinationKind(work)];
}

/** Where a delivery goes. Approval is for this destination only. */
export function destination(
  task: { readonly delivery: DeliveryMode; readonly source?: TaskSource },
  product: Pick<Product, "path" | "repo" | "defaultBranch"> | undefined,
): string {
  return deliveryStrategyFor(task).destinationKey(task, product);
}

export function prepareDelivery(
  hooks: ShippingPublishHooks,
  scope: RepositoryContext,
  stage: MutableStage,
  signal: AbortSignal,
): Promise<"ready" | "continue" | "stop"> {
  return deliveryStrategyFor(scope.work).prepare(hooks, scope, stage, signal);
}

export async function publishDelivery(
  hooks: ShippingPublishHooks,
  scope: RepositoryContext,
  signal: AbortSignal,
): Promise<"done" | "again" | "continue" | "stop"> {
  const { work: repository } = scope;
  const strategy = deliveryStrategyFor(repository);
  if (
    strategy.checkBranchSourceBeforePublish &&
    repository.source?.start.kind === "branch" &&
    !(await hooks.verifier.sourceCurrent(scope, signal))
  ) {
    return hooks.prepareAgain(scope, "The approved starting branch moved on GitHub");
  }
  return strategy.publish(hooks, scope, signal);
}

export async function isProofApprovalCurrent(
  k: Kernel,
  releases: ReleasePrep,
  verifier: ShippingVerifier,
  task: RuntimeTask,
  signal: AbortSignal,
  prepared = false,
): Promise<boolean> {
  const observed = Object.fromEntries(
    await completeAll(
      scopesFor(task).map(async ({ work }) => {
        if (!work.worktree) return [work.productId, { head: undefined, tree: "unavailable" }] as const;
        const version = await git.commitVersion(work.worktree);
        return [work.productId, { head: version.head, tree: version.tree ?? "unavailable" }] as const;
      }),
    ),
  );
  const versions: Record<string, string> = Object.fromEntries(
    Object.entries(observed).map(([id, entry]) => [id, entry.tree]),
  );
  for (const scope of scopesFor(task)) {
    const { work } = scope;
    const strategy = deliveryStrategyFor(work);
    const delivered = Boolean(work.pr || work.release || work.landed);
    if (delivered && !strategy.requiresProofRecheckWhenDelivered) continue;
    if (!work.worktree) return false;
    const head = observed[work.productId]?.head ?? (await git.head(work.worktree));
    if (!(await git.isClean(work.worktree))) return false;
    const shipping = work.shipping;
    if (prepared && shipping?.prepared && head !== shipping.prepared.tested) return false;
    const ok = await strategy.validateProofScope({
      k,
      releases,
      verifier,
      task,
      scope,
      head,
      versions,
      delivered,
      prepared,
      signal,
    });
    if (!ok) return false;
  }
  refreshProofs(task, versions);
  return sameProofDecision(task.approvedProofDecision, proofDecision(task, versions));
}
