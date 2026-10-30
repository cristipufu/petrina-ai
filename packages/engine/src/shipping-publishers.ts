import {
  checkOutcome, checkOutcomeLabel, completeAll, endAgentStep, JOURNEY_WORDS, proofDecision, refreshProofs,
  reviewerAt, sameProofDecision, undecidedAcceptanceGap, type DeliveryMode, type Product, type ShippingStep, type TaskSource,
} from "@petrina/core";
import {
  DeliveryRecovery, DeliveryWorkflow, needsReleaseManager as deliveryNeedsReleaseManager, scopesFor,
  type RepositoryContext, type RepositoryWork,
} from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { realPath } from "@petrina/repositories/paths";
import { Unreachable, type Connections } from "./connection.js";
import { Aborted, RELEASE_MANAGER_PROFILE, type Kernel, type MutableStage, type RuntimeTask } from "./kernel.js";
import type { ProductChecks } from "./product-checks.js";
import type { ReleasePrep } from "./release-prep.js";
import { ReleaseNotesResult, TEXT_LIMITS } from "./roles.js";
import type { ShippingVerifier } from "./shipping-verifier.js";
import type { Turns } from "./turn.js";

/** Publishing found new source commits, after ruling out an already completed push. */
export class SourceMoved extends Error {}
/** Local placement recovery may still owe a push; a changed or missing decision publishes nothing further. */
export class DecisionNeeded extends Error {}
/** A released prerequisite wait still owes the ordinary driver's source/evidence refresh. */
export class PrerequisiteRefresh extends Error {}

/** Where a delivery goes. Approval is for this destination only. */
export function destination(
  task: { delivery: DeliveryMode; source?: TaskSource },
  product: Pick<Product, "path" | "repo" | "defaultBranch"> | undefined,
): string {
  if (task.source) {
    const target = task.source.destination;
    return target.kind === "update-pr" && task.source.start.kind === "pull-request"
      ? `${task.source.product.repo}#pr/${task.source.start.number}:${target.repo}#${target.branch}`
      : task.delivery === "local"
        ? `${task.source.product.path ?? ""}#${target.branch}`
        : `${target.repo}#${target.branch}`;
  }
  const branch = product?.defaultBranch ?? "main";
  return task.delivery === "local" ? `${product?.path ?? ""}#${branch}` : `${product?.repo ?? ""}#${branch}`;
}

/** Whether the delivery step needs an agent now: only a release, for its notes, until they are written. */
export function needsReleaseManager(task: RepositoryWork): boolean {
  return deliveryNeedsReleaseManager(task);
}

function fit(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function formatPullRequestTitle(scope: RepositoryContext): string {
  const { task, work: repository } = scope;
  return fit((repository.report?.title ?? task.title).replace(/\s+/g, " ").trim(), TEXT_LIMITS.title);
}

function formatFromReport(scope: RepositoryContext): string {
  const { task, work: repository } = scope;
  const report = repository.report;
  const changes = report?.changes.length ? `## What changed for users\n${report.changes.map((c) => `- ${c}`).join("\n")}` : "";
  return [report?.summary ?? task.title, changes].filter(Boolean).join("\n\n");
}

export function formatPullRequestBody(k: Kernel, scope: RepositoryContext): string {
  const { task, work: repository } = scope;
  const builder = repository.report?.description?.trim() || formatFromReport(scope);
  const parts: string[] = ["## Checked by Petrina"];
  const acceptance = task.brief?.acceptance ?? [];
  if (acceptance.length) {
    parts.push(
      `### Acceptance\n${acceptance.map((item) => (item.verification === "blocked" ? `- [ ] ${item.text} (Could not verify)` : item.met === undefined ? `- ${item.text}` : `- [${item.met ? "x" : " "}] ${item.text}`)).join("\n")}`,
    );
  }
  const runs = repository.checks?.results ?? [];
  if (runs.length) {
    parts.push(`### Checks Petrina ran on this commit\n${runs.map((r) => `- ${r.name}: ${checkOutcomeLabel(checkOutcome(r))} (\`${r.command}\`)`).join("\n")}`);
  }
  const reviewers = [
    ...new Set(
      (task.plan?.stages ?? [])
        .filter((stage) => stage.kind === "review-chain")
        .flatMap((stage) => stage.profileIds.map((profileId, pos) => k.describe(reviewerAt(stage, pos), profileId))),
    ),
  ];
  if (reviewers.length) parts.push(`### Reviewed by\n${reviewers.map((r) => `- ${r}`).join("\n")}`);
  const followUps = task.findings.filter((f) => f.status === "open" && f.severity === "pre-existing");
  if (followUps.length) {
    parts.push(`### Follow-ups\n${followUps.length === 1 ? "One older problem was" : `${followUps.length} older problems were`} noted for a follow-up, in Petrina.`);
  }
  return fit(`${builder}\n\n${parts.join("\n\n")}`, TEXT_LIMITS.body);
}

export async function isProofApprovalCurrent(
  k: Kernel,
  releases: ReleasePrep,
  verifier: ShippingVerifier,
  task: RuntimeTask,
  signal: AbortSignal,
  prepared = false,
): Promise<boolean> {
  const observed = Object.fromEntries(await completeAll(scopesFor(task).map(async ({ work }) => {
    if (!work.worktree) return [work.productId, { head: undefined, tree: "unavailable" }] as const;
    const version = await git.commitVersion(work.worktree);
    return [work.productId, { head: version.head, tree: version.tree ?? "unavailable" }] as const;
  })));
  const versions: Record<string, string> = Object.fromEntries(Object.entries(observed).map(([id, entry]) => [id, entry.tree]));
  for (const scope of scopesFor(task)) {
    const { work } = scope;
    const delivered = Boolean(work.pr || work.release || work.landed);
    if (delivered && work.delivery !== "release") continue;
    if (!work.worktree) return false;
    const head = observed[work.productId]?.head ?? (await git.head(work.worktree));
    if (!(await git.isClean(work.worktree))) return false;
    const shipping = work.shipping;
    if (prepared && shipping?.prepared && head !== shipping.prepared.tested) return false;
    if (work.delivery === "release") {
      if (work.approvedFor?.by !== "coordinator") return false;
      const version = work.proofRelease;
      if (version && head !== version.start) {
        if (head !== version.tested || !(await releases.isVersionCommit(work.worktree, head, version.start))) return false;
        if (versions[work.productId] !== task.approvedProofDecision?.versions[work.productId]) {
          versions[work.productId] = (await git.treeOf(work.worktree, version.start)) ?? "unavailable";
        }
      }
    }
    if (!delivered && prepared && shipping?.base && !shipping.pushed) {
      if (work.delivery === "local") {
        const product = k.repositoryOf(scope)!;
        const branch = work.source?.start.branch ?? product.defaultBranch ?? "main";
        const current = await git.revParse(product.path!, `refs/heads/${branch}`);
        const ownUpdate = current === shipping.localUpdated && current === shipping.prepared?.tested;
        if (current && !ownUpdate && current !== shipping.base && !(await git.contains(product.path!, shipping.base, current))) return false;
      } else if (work.source?.start.kind !== "pull-request" && !(await verifier.sourceCurrent(scope, signal))) return false;
    }
  }
  refreshProofs(task, versions);
  return sameProofDecision(task.approvedProofDecision, proofDecision(task, versions));
}

export async function resetBackToWork(
  k: Kernel,
  releases: ReleasePrep,
  branchTip: (scope: RepositoryContext) => Promise<string | undefined>,
  scope: RepositoryContext,
): Promise<void> {
  await k.agentCleanup.wait(scope.task.id);
  const { work: repository } = scope;
  const worktree = repository.worktree!;
  const status = await git.worktreeBranchStatus(worktree);
  if (!status.clean) await git.discardChanges(worktree);
  let moved = !status.clean;
  if ((status.clean ? status.branch : await git.currentBranch(worktree)) !== repository.branch) {
    const switched = await git.switchTo(worktree, repository.branch!);
    if (!switched.ok) throw new Error(`Petrina could not put the working copy back on ${repository.branch} (${switched.error}), so it published nothing.`);
    moved = true;
  }
  const start = repository.shipping?.start;
  const tip = start ? (!moved && status.branch === repository.branch && status.head ? status.head : await branchTip(scope)) : undefined;
  if (start && tip && tip !== start && (await releases.isVersionCommit(worktree, tip, start))) {
    await git.resetTo(worktree, start);
    moved = true;
  }
  if (moved || (start && tip && repository.savedVersion?.commit !== tip) || !repository.savedVersion?.commit || !repository.savedVersion?.tree) {
    await k.rememberVersion(scope);
  }
  if (!repository.release && !repository.shipping?.pushed) delete repository.proofRelease;
}

export async function rememberConfirmedDelivery(k: Kernel, scope: RepositoryContext, sha: string, branch: string): Promise<void> {
  const product = k.repositoryOf(scope);
  const path = scope.work.worktree ?? product?.path;
  if (!path || !product || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return;
  const savedTree = scope.work.savedVersion?.commit === sha ? scope.work.savedVersion.tree : undefined;
  if (savedTree && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(savedTree)) {
    scope.work.confirmedDelivery = { sha, tree: savedTree, branch, repo: product.repo, at: Date.now() };
    return;
  }
  const tree = await git.treeOf(path, sha).catch(() => undefined);
  if (tree && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) {
    scope.work.confirmedDelivery = { sha, tree, branch, repo: product.repo, at: Date.now() };
  }
}

export interface ShippingPublishHooks {
  k: Kernel;
  turns: Turns;
  checks: ProductChecks;
  connections: Connections;
  releases: ReleasePrep;
  verifier: ShippingVerifier;
  workflow: DeliveryWorkflow;
  recovery: DeliveryRecovery;
  beforePublishing(scope: RepositoryContext): void;
  branchTip(scope: RepositoryContext): Promise<string | undefined>;
  pullRequestBody(scope: RepositoryContext): string;
  preparationFailed(scope: RepositoryContext, summary: string, signal: AbortSignal): Promise<"continue" | "stop">;
  prepareAgain(scope: RepositoryContext, why: string): Promise<"again">;
  backToWork(scope: RepositoryContext): Promise<void>;
  proofApprovalCurrent(task: RuntimeTask, signal: AbortSignal, prepared?: boolean): Promise<boolean>;
  returnForDecision(task: RuntimeTask, why: "proof" | "acceptance"): Promise<void>;
  saveStep(scope: RepositoryContext, step: ShippingStep, status: string): void;
  publishStep<T>(scope: RepositoryContext, signal: AbortSignal, step: ShippingStep, status: string, run: () => Promise<T>): Promise<T>;
  recordPr(
    scope: RepositoryContext,
    pr: {
    number: number;
    url: string;
    state: "open" | "merged" | "closed"
  },
    how?: "opened" | "updated"
  ): "done" | Promise<"done">;
  recordLanded(scope: RepositoryContext, branch: string, sha: string, how?: "found" | "moved"): "done" | Promise<"done">;
  landLocal(scope: RepositoryContext, signal: AbortSignal, tested: string, how?: "found" | "moved"): Promise<"done">;
  pushMain(scope: RepositoryContext, signal: AbortSignal, branch: string, at: string): Promise<boolean>;
}

function stopIfAsked(signal: AbortSignal): void {
  if (signal.aborted) throw new Aborted();
}

function checking(k: Kernel, scope: RepositoryContext, status: string): void {
  if (scope.task.state === "cancelled") return;
  scope.task.statusLine = status;
  k.commit();
}

export async function prepareDelivery(
  hooks: ShippingPublishHooks,
  scope: RepositoryContext,
  stage: MutableStage,
  signal: AbortSignal,
): Promise<"ready" | "continue" | "stop"> {
  const { k, releases, checks, workflow, turns } = hooks;
  const { task, work: repository } = scope;
  hooks.beforePublishing(scope);
  const product = k.repositoryOf(scope)!;
  const defaultBranch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
  const shipping: NonNullable<RepositoryWork["shipping"]> = (repository.shipping = {
    moves: repository.shipping?.moves ?? 0,
    failures: repository.shipping?.failures ?? 0,
  });
  const start = await hooks.branchTip(scope);
  if (!start) throw new Error(`The task's branch ${repository.branch} is gone, so Petrina published nothing. Send it back to the builder, or cancel it.`);
  shipping.start = start;
  if (repository.baseSha) shipping.base = repository.baseSha;
  if (repository.delivery === "local" || repository.source?.start.kind === "pull-request") {
    shipping.prepared = { tested: start, summary: `Ready to go onto ${defaultBranch}` };
    k.log(scope, "status", `Ready to publish: ${start.slice(0, 7)}, on top of ${defaultBranch}`);
    k.commitNow();
    return "ready";
  }
  if (repository.delivery === "pull-request") {
    shipping.prepared = { tested: start, summary: "Ready to open a pull request", title: formatPullRequestTitle(scope), body: hooks.pullRequestBody(scope) };
    k.log(
      scope,
      "status",
      `Ready to publish: ${start.slice(
      0,
      7
    )}, with ${repository.report?.description ? "the builder's description" : "a description from the builder's report"}`
    );
    k.commitNow();
    return "ready";
  }
  const declared = await releases.chooseVersion(scope, signal);
  k.log(scope, "status", `Getting the release ready: Petrina sets the version to ${shipping.version}`);
  k.commitNow();
  const tested = await releases.setVersion(scope, declared);
  if (task.proofRequests?.length) repository.proofRelease = { start, tested };
  hooks.beforePublishing(scope);
  if (tested !== start) {
    const verified = await checks.failing(scope, signal, undefined, "publishing");
    if (verified.kind === "product-failed") return hooks.preparationFailed(
      scope,
      `The product's checks fail with the version set to ${shipping.version}`,
      signal
    );
    if (verified.kind === "blocked") {
      await hooks.backToWork(scope);
      delete repository.shipping;
      if (task.repositories) await workflow.clearUnpublishedPreparations(task);
      workflow.clearApproval(scope);
      checks.blocked(task);
      return "stop";
    }
  }
  const preview = repository.releasePreview;
  const changedPreview = workflow.rejectChangedReleasePreview(scope, start, shipping, preview);
  if (changedPreview) return changedPreview;
  const log = await releases.sincePreviousRelease(scope, signal);
  hooks.beforePublishing(scope);
  const profileId = stage.profileIds[0] ?? RELEASE_MANAGER_PROFILE;
  let by = profileId;
  const result = preview ?? (await turns.turn(scope, "release-manager", profileId, () => [log], ReleaseNotesResult, signal, {
    initialHead: tested,
    used: (id) => (by = id),
    check: (value) => (!value.notes.trim() ? `"notes" is empty: write the release notes.` : value.notes.length > TEXT_LIMITS.notes ? `the release notes are longer than GitHub allows (${TEXT_LIMITS.notes} characters). Shorten them.` : undefined),
  }));
  shipping.prepared = { tested, summary: result.summary, notes: result.notes.trim() };
  endAgentStep(task, { outcome: JOURNEY_WORDS.notes, reason: JOURNEY_WORDS.releaseNotesReady }, Date.now());
  delete task.agent;
  task.holdsSlot = false;
  k.finishStep(scope);
  k.participantSay(scope, "agent", `${result.summary}\n\n${k.describe("release-manager", by)}`, "release-manager", by, undefined);
  k.log(
    scope,
    "done",
    `Ready to publish: ${tested.slice(
    0,
    7
  )}, as ${shipping.tag}, with notes on everything since ${shipping.after || "the start"}`,
    "release-manager",
    by
  );
  k.commitNow();
  return "ready";
}

export async function publishPullRequestDelivery(hooks: ShippingPublishHooks, scope: RepositoryContext, signal: AbortSignal): Promise<"done"> {
  const { k, connections, recovery, verifier } = hooks;
  const { work: repository } = scope;
  const product = k.repositoryOf(scope)!;
  const prepared = repository.shipping!.prepared!;
  const branch = repository.branch!;
  const remote = await connections.requireConnection(scope, signal);
  const there = await connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/heads/${branch}`]));
  if (!there.ok) throw new Unreachable(`Petrina could not check this task's branch on GitHub (${there.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
  const at = there.value.get(`refs/heads/${branch}`);
  if (at && at !== prepared.tested && !(await git.contains(product.path!, prepared.tested, at))) {
    throw new Error(`GitHub has this task's branch at ${at.slice(
      0,
      7
    )}, which is not this work, so Petrina pushed nothing. Look at it on GitHub, then retry or cancel.`);
  }
  const pushed = await hooks.publishStep(scope, signal, "push", "Publishing: pushing the branch to GitHub", () =>
    git.push(product.path!, remote, [{ sha: prepared.tested, ref: `refs/heads/${branch}` }]),
  );
  stopIfAsked(signal);
  if (!pushed.ok) throw new Error(`GitHub refused the push of this task's branch, so no pull request was opened (${pushed.error}). Retry once that is sorted.`);
  k.log(scope, "status", `Petrina pushed the branch at ${prepared.tested.slice(0, 7)}`);
  return recovery.createPullRequest(scope, signal, {
    create: () => hooks.publishStep(scope, signal, "open", "Publishing: opening the pull request", () =>
      k.github.openPullRequest(product.repo, {
        head: branch,
        base: repository.source?.destination.branch ?? product.defaultBranch ?? "main",
        title: prepared.title!.trim(),
        body: prepared.body!,
      }),
    ),
    find: () => verifier.findPullRequest(scope),
  });
}

export async function publishReleaseDelivery(hooks: ShippingPublishHooks, scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
  const { k, connections, verifier, recovery } = hooks;
  const { work: repository } = scope;
  const product = k.repositoryOf(scope)!;
  const shipping = repository.shipping!;
  const { tested, notes } = shipping.prepared!;
  const tag = shipping.tag!;
  const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
  const root = product.path!;
  const remote = await connections.requireConnection(scope, signal);
  if (!shipping.pushed) {
    checking(k, scope, `Checking: looking at ${branch} and the tag ${tag} on GitHub`);
    const before = await verifier.releaseRefs(scope, remote);
    if (before.tag === tested && (await verifier.onGitHub(scope, remote, before.main, tested))) {
      k.log(scope, "status", `Checked: ${branch} and the tag ${tag} are already on GitHub at ${tested.slice(0, 7)}`);
    } else {
      if (before.tag === tested) throw new Error(`The tag ${tag} is on GitHub at the tested commit, but ${branch} there does not have it. Petrina published nothing more. Look at it on GitHub, then retry or cancel.`);
      if (before.main !== shipping.base && before.main !== tested) return hooks.prepareAgain(scope, `${branch} moved on GitHub`);
      const latest = await connections.serial(product.id, () => k.github.latestRelease(product.repo));
      if (!latest.ok) throw new Error(`Petrina could not read the latest release on GitHub (${latest.error}), so it published nothing. Retry when GitHub is reachable.`);
      if ((latest.value ?? "") !== shipping.after) return hooks.prepareAgain(
        scope,
        latest.value ? `${latest.value} came out meanwhile` : "The latest release changed meanwhile"
      );
      if (before.tag) throw new Error(`The tag ${tag} already exists on GitHub at another commit. Petrina will not move or reuse it, and published nothing more. Look at it on GitHub, then retry or cancel.`);
      const pushed = await hooks.publishStep(scope, signal, "push", `Publishing: pushing ${branch} and the tag ${tag} to GitHub`, () =>
        git.push(root, remote, [{ sha: tested, ref: `refs/heads/${branch}` }, { sha: tested, ref: `refs/tags/${tag}` }], true),
      );
      if (!pushed.ok) {
        const after = await verifier.releaseRefs(scope, remote);
        if (!(after.tag === tested && (await verifier.onGitHub(scope, remote, after.main, tested)))) {
          if (!after.tag && after.main !== shipping.base && after.main !== tested) return hooks.prepareAgain(scope, `${branch} moved on GitHub`);
          throw new Error(`GitHub refused the push of ${branch} and the tag ${tag}, so Petrina published nothing (${pushed.error}). Retry once that is sorted.`);
        }
      }
      k.log(scope, "status", `Petrina pushed ${branch} and the tag ${tag} at ${tested.slice(0, 7)}`);
    }
    shipping.pushed = true;
    k.commitNow();
    stopIfAsked(signal);
  }
  checking(k, scope, `Checking: looking at the tag ${tag} on GitHub`);
  const at = await verifier.releaseRefs(scope, remote);
  if (at.tag !== tested) {
    throw new Error(`The tag ${tag} on GitHub ${at.tag ? `is at ${at.tag.slice(
      0,
      7
    )}` : "is gone"}, not at the tested commit ${tested.slice(
      0,
      7
    )}, so Petrina created no release. Look at it on GitHub, then retry or cancel.`);
  }
  return recovery.createRelease(scope, signal, {
    create: () => hooks.publishStep(
      scope,
      signal,
      "release",
      `Publishing: creating the release ${tag}`,
      () => k.github.createRelease(
      product.repo,
      tag,
      notes!
    )
    ),
    find: () => verifier.findRelease(scope),
    tag: async () => (await verifier.releaseRefs(scope, remote)).tag,
  });
}

export async function publishLocalDelivery(hooks: ShippingPublishHooks, scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
  const { k, connections } = hooks;
  const { work: repository } = scope;
  const product = k.repositoryOf(scope)!;
  const shipping = repository.shipping!;
  const { tested } = shipping.prepared!;
  const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
  const root = product.path!;
  const outcome = await connections.serial(product.id, async (): Promise<"found" | "moved" | { again: string }> => {
    checking(k, scope, `Checking: looking at ${branch} in the main copy`);
    const current = await git.revParse(root, `refs/heads/${branch}`);
    if (current && (current === tested || (await git.contains(root, current, tested)))) return "found";
    const previous = repository.localUpdate?.pushed === false && repository.localUpdate.branch === branch && repository.localUpdate.sha === current;
    if (current && !previous && current !== shipping.base && !(shipping.base && (await git.contains(root, shipping.base, current)))) {
      return { again: `${branch} moved in the main copy` };
    }
    const places = current ? (await git.checkedOut(root, branch)).map((place) => realPath(place)) : [];
    const here = places.includes(realPath(root));
    const elsewhere = places.filter((place) => place !== realPath(root));
    if (elsewhere.length) throw new Error(`${branch} is checked out in another folder (${elsewhere[0]}), so Petrina did not move it. Switch that folder to another branch, then retry.`);
    if (here && (await git.changes(
      root,
      true
    )).length) throw new Error(`The main copy at ${root} has changes that are not committed, so Petrina did not move ${branch}. Commit them or put them aside, then retry.`);
    stopIfAsked(signal);
    hooks.saveStep(scope, "update", `Publishing: moving ${branch} forward to the tested work`);
    const moved = current
      ? previous ? await git.replaceLocalDelivery(root, branch, current, tested, here) : await git.fastForward(root, branch, current, tested, here)
      : await git.createBranchAt(root, branch, tested);
    if (!moved.ok) {
      const now = await git.revParse(root, `refs/heads/${branch}`);
      if (now !== current && now !== tested) return { again: `${branch} moved in the main copy` };
      throw new Error(`Git would not move ${branch} forward, so Petrina published nothing (${moved.error}). Retry once that is sorted.`);
    }
    stopIfAsked(signal);
    return "moved";
  });
  if (typeof outcome !== "string") return hooks.prepareAgain(scope, outcome.again);
  return hooks.landLocal(scope, signal, tested, outcome);
}

export async function landLocalDelivery(
  hooks: ShippingPublishHooks,
  scope: RepositoryContext,
  signal: AbortSignal,
  tested: string,
  how?: "found" | "moved",
): Promise<"done"> {
  const { k, verifier, connections } = hooks;
  const { work: repository } = scope;
  const product = k.repositoryOf(scope)!;
  const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
  await verifier.verifyLocal(product.path!, branch, tested);
  if (repository.shipping) repository.shipping.localUpdated = tested;
  const connection = await connections.connection(scope, signal);
  const github = connection.ok && Boolean(product.remote) && git.sameRepo(product.remote!, product.repo) && !product.repo.startsWith("local/");
  if (github || repository.localUpdate) {
    repository.localUpdate = { branch, sha: tested, pushed: false };
    k.commitNow();
  }
  if (repository.localUpdate) {
    const reached = await hooks.pushMain(scope, signal, branch, tested);
    if (!reached) throw new Error(`${branch} has the work in the main copy, but Petrina could not push it to GitHub. The checked work is preserved. Retry after access is restored.`);
    repository.localUpdate.pushed = true;
    k.commitNow();
  }
  return hooks.recordLanded(scope, branch, tested, how);
}

export async function pushMainBranch(hooks: ShippingPublishHooks, scope: RepositoryContext, signal: AbortSignal, branch: string, at: string): Promise<boolean> {
  const { k, connections, verifier } = hooks;
  const { work: repository } = scope;
  const product = k.repositoryOf(scope)!;
  const connection = await connections.connection(scope, signal);
  if (!connection.ok) {
    if (!connection.missing) k.log(scope, "warn", `${branch} was not pushed to GitHub: ${connection.reason}`);
    return false;
  }
  const ref = `refs/heads/${branch}`;
  const there = await connections.serial(product.id, () => git.remoteRefs(product.path!, connection.remote, [ref]));
  if (!there.ok) throw new Unreachable(`Petrina could not check ${branch} on GitHub (${there.error}). Retry before publishing anything more.`);
  if (await verifier.remoteContains(scope, connection.remote, branch, there.value.get(ref), at)) return true;
  const checkMovement = async (tip: string | undefined): Promise<void> => {
    const base = repository.shipping?.base;
    if (!tip && repository.source?.start.kind === "branch") throw new Error(`${branch} is no longer available on GitHub. The checked work is preserved; nothing more was published.`);
    if (tip && base && tip !== base && !(await git.contains(product.path!, base, tip))) {
      if (await git.contains(product.path!, tip, base)) throw new SourceMoved(`${branch} moved on GitHub`);
      throw new Error(`${branch} on GitHub has divergent history. The checked work is preserved; bring the destination copies into agreement before retrying.`);
    }
  };
  await checkMovement(there.value.get(ref));
  stopIfAsked(signal);
  if (scope.task.proofRequests?.length && !(await hooks.proofApprovalCurrent(scope.task, signal, true))) {
    await hooks.returnForDecision(scope.task, "proof");
    throw new DecisionNeeded();
  }
  if (undecidedAcceptanceGap(scope.task)) {
    await hooks.returnForDecision(scope.task, "acceptance");
    throw new DecisionNeeded();
  }
  const pushed = await hooks.publishStep(scope, signal, "push", `Publishing: pushing ${branch} to GitHub`, () =>
    git.push(product.path!, connection.remote, [{ sha: at, ref }]),
  );
  if (!pushed.ok) {
    const tip = await verifier.remoteTip(scope, connection.remote, branch);
    if (await verifier.remoteContains(scope, connection.remote, branch, tip, at)) return true;
    await checkMovement(tip);
    throw new Error(`${branch} has the work in the main copy, but Petrina could not push it to GitHub (${pushed.error}). The checked work is preserved. Retry after access is restored.`);
  }
  k.log(scope, "done", `Petrina pushed ${branch} to GitHub (${at.slice(0, 7)})`);
  return true;
}

export async function publishPrUpdateDelivery(hooks: ShippingPublishHooks, scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
  const { k, verifier } = hooks;
  const { work: repository } = scope;
  const pr = await verifier.approvedPr(scope);
  if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. No more commits will be published; the work is preserved.`);
  const remote = verifier.destinationRemote(scope);
  const { tested } = repository.shipping!.prepared!;
  const at = await verifier.remoteTip(scope, remote, pr.branch);
  if (!at) throw new Error(`The working branch for PR #${pr.number} is unavailable. The work is preserved.`);
  if (await verifier.remoteContains(scope, remote, pr.branch, at, tested)) return hooks.recordPr(scope, pr, "updated");
  if (at !== repository.shipping!.base) return hooks.prepareAgain(scope, `PR #${pr.number}'s working branch moved`);
  const pushed = await hooks.publishStep(scope, signal, "push", `Publishing: updating PR #${pr.number} in ${pr.headRepo} · ${pr.branch}`, () =>
    git.push(k.repositoryOf(scope)!.path!, remote, [{ sha: tested, ref: `refs/heads/${pr.branch}` }]),
  );
  stopIfAsked(signal);
  const after = await verifier.remoteTip(scope, remote, pr.branch);
  if (await verifier.remoteContains(scope, remote, pr.branch, after, tested)) return hooks.recordPr(scope, pr, "updated");
  if (after !== at) return hooks.prepareAgain(scope, `PR #${pr.number}'s branch moved during publishing`);
  throw new Error(`GitHub refused the update to PR #${pr.number} in ${pr.headRepo} · ${pr.branch} (${pushed.ok ? "the tested work could not be confirmed" : pushed.error}). The work is preserved. Retry after access is restored.`);
}

export async function noteCancelledLocalDelivery(hooks: ShippingPublishHooks, scope: RepositoryContext): Promise<boolean | "unknown"> {
  const { k, verifier } = hooks;
  const { work: repository } = scope;
  const product = k.repositoryOf(scope)!;
  const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
  const tested = repository.shipping!.prepared!.tested;
  const reached = await verifier.githubHas(scope, branch, tested);
  if (reached === "unknown") {
    if (repository.localUpdate) repository.localUpdate.pushed = false;
    k.commit();
    return "unknown";
  }
  const owes = Boolean(repository.localUpdate) || Boolean(product.remote && !product.repo.startsWith("local/") && git.sameRepo(product.remote, product.repo));
  if (owes) repository.localUpdate = { branch, sha: tested, pushed: reached };
  await hooks.recordLanded(scope, branch, tested, "found");
  return reached;
}
