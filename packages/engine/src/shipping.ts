import { CompanionLinks } from "./companion-links.js";
import { DeliveryAdmission, DeliveryWorkflow, DeliveryRecovery, needsReleaseManager as deliveryNeedsReleaseManager } from "@petrina/orchestrator";
import { ShippingVerifier, type DeliveryEvidence } from "./shipping-verifier.js";
import { realPath } from "@petrina/repositories/paths";
import { ReleasePrep } from "./release-prep.js";
import { PrMonitor } from "./pr-monitor.js";
import { scopesFor, type RepositoryContext, type RepositoryWork } from "@petrina/orchestrator";
import { checkOutcome, checkOutcomeLabel, completeAll, proofDecision, refreshProofs, sameProofDecision, undecidedAcceptanceGap } from "@petrina/core";
// Delivering finished work, by Petrina itself, with no agent. Before anything goes out the work is one commit on
// top of the latest main, approved for this delivery and destination, with the checks passing on it. Petrina
// publishes the exact commit it checked, with what the builder wrote to go out with it: it pushes the branch and
// opens the pull request (the builder's description, then Petrina's own part), sets a release's version in the
// product's version files, pushes main and the new tag together and creates the release with the builder's
// notes, or moves the approved local branch forward and pushes it. A pull request the task started from gets the tested commit on its working branch. It has no merge, force-push or delete. Every publishing step is saved
// before it starts, and an interrupted delivery is looked up before anything goes out again: never twice.

import {
  type Id,
  endAgentStep,
  JOURNEY_WORDS,
  reviewerAt,
  type DeliveryMode,
  type Product,
  type ShippingStep,
  type TaskSource,
} from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { ReleaseNotesResult, TEXT_LIMITS } from "./roles.js";
import { WaitingForUsage } from "./usage.js";
import { Aborted, type Kernel, type MutableStage, type RuntimeTask, RELEASE_MANAGER_PROFILE } from "./kernel.js";
import { type Connections, Unreachable } from "./connection.js";
import type { ProductChecks } from "./product-checks.js";
import type { ToolChecks } from "./tool-checks.js";
import type { Turns } from "./turn.js";
import type { Updates } from "./update.js";

/** A delivery from before the update, which Petrina leaves to the coordinator. */
export { CARRIED_OVER } from "@petrina/orchestrator";

/** Publishing found new source commits, after ruling out an already completed push. */
class SourceMoved extends Error {}
/** Local placement recovery may still owe a push; a changed or missing decision publishes nothing further. */
class DecisionNeeded extends Error {}

/** A released prerequisite wait still owes the ordinary driver's source/evidence refresh. */
class PrerequisiteRefresh extends Error {}

/** Where a delivery goes. Approval is for this destination only. */
export function destination(task: { delivery: DeliveryMode; source?: TaskSource }, product: Pick<Product, "path" | "repo" | "defaultBranch"> | undefined): string {
  if (task.source) {
    const target = task.source.destination;
    return target.kind === "update-pr" && task.source.start.kind === "pull-request" ? `${task.source.product.repo}#pr/${task.source.start.number}:${target.repo}#${target.branch}` : task.delivery === "local" ? `${task.source.product.path ?? ""}#${target.branch}` : `${target.repo}#${target.branch}`;
  }
  const branch = product?.defaultBranch ?? "main";
  return task.delivery === "local" ? `${product?.path ?? ""}#${branch}` : `${product?.repo ?? ""}#${branch}`;
}

/** Whether the delivery step needs an agent now: only a release, for its notes, until they are written. */
export function needsReleaseManager(task: RepositoryWork): boolean {
  return deliveryNeedsReleaseManager(task);
}

/** Text cut to fit where GitHub puts it, marked when it was cut. */
function fit(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}


export class Shipping {
  readonly releases: ReleasePrep;
  readonly monitor: PrMonitor;
  readonly verifier: ShippingVerifier;
  private readonly companions: CompanionLinks;
  private readonly admission: DeliveryAdmission;
  private readonly workflow: DeliveryWorkflow;
  private readonly recovery: DeliveryRecovery;

  constructor(
    private readonly k: Kernel,
    private readonly turns: Turns,
    private readonly updates: Updates,
    private readonly checks: ProductChecks,
    private readonly connections: Connections,
    private readonly tools: ToolChecks,
  ) {
    this.admission = new DeliveryAdmission({
      task: id => k.task(id), roleResult: (id, task) => k.role(id, task)?.result,
      destination: scope => destination(scope.work, k.repositoryOf(scope)),
      branch: scope => scope.work.source?.destination.branch ?? k.repositoryOf(scope)?.defaultBranch ?? "main",
      reserveOrder: () => k.checkQueue.reserveOrder(),
      rememberOrder: (id, order) => checks.deliveryOrders.set(id, order),
      forgetOrder: id => { checks.deliveryOrders.delete(id); }, hasOrder: id => checks.deliveryOrders.has(id),
      hasDriver: id => k.drivers.has(id), hasSettling: id => k.settling.has(id),
      taskAdmissionsClosed: task => k.taskAdmissionsClosed(task), taskAdmissionWait: task => k.taskAdmissionWait(task),
      admissionsClosed: () => k.admissionsClosed, poolPaused: () => k.s.pool.paused,
      draining: () => k.draining, stopped: () => k.stopped, extraRecovery: () => k.extraRecovery,
    });
    this.releases = new ReleasePrep(k, turns, connections);
    this.companions = new CompanionLinks(k);
    this.verifier = new ShippingVerifier(k, connections);
    this.workflow = new DeliveryWorkflow(this.admission, {
      restoredChecks: (scope, signal) => this.checks.failing(scope, signal, undefined, "publishing"),
      closedPullRequest: ({ work }) => k.github.prState(work.source!.product.repo, work.pr!.number),
      needGitHub: task => this.tools.needGitHub(task),
      readyToShip: (scope, signal) => this.readyToShip(scope, signal),
      head: scope => {
        const observed = this.updates.consumeObservedHead(scope);
        return observed ? Promise.resolve(observed) : git.head(scope.work.worktree!);
      },
      patch: (scope, ref) => this.updates.patch(scope, ref),
      upToDate: (scope, signal) => {
        this.updates.clearObservedHead(scope);
        return this.updates.upToDate(scope, signal, true);
      },
      checkOrder: taskId => this.checks.deliveryOrders.get(taskId),
      checksBeforeShipping: async (scope, signal, preparation) => {
        this.updates.clearObservedHead(scope);
        try {
          return await this.checks.checksBeforeShipping(scope, signal, preparation);
        } finally {
          this.updates.clearObservedHead(scope);
        }
      },
      prepare: (scope, stage, signal) => this.prepare(scope, stage, signal),
      checkDelivery: (scope, signal) => this.checkDelivery(scope, signal),
      proofApprovalCurrent: (task, signal, prepared) => this.proofApprovalCurrent(task, signal, prepared),
      returnForDecision: (task, why) => this.returnForDecision(task, why),
      backToWork: scope => this.backToWork(scope),
      publish: (scope, signal) => this.publish(scope, signal),
      prepareAgain: (scope, why) => this.prepareAgain(scope, why),
      clearUnpublishedVersion: scope => this.clearUnpublishedVersion(scope),
      finishCompanions: task => this.companions.finish(task),
    }, {
      clearStep: scope => k.clearStep(scope), checksBlocked: task => this.checks.blocked(task),
      productName: scope => k.repositoryOf(scope)!.name, defaultBranch: scope => k.repositoryOf(scope)?.defaultBranch,
      findingId: task => k.id(task.id), gate: (task, problem) => k.gate(task, "delivery", problem), fail: (id, error) => k.fail(id, error),
      changed: () => k.commit(), noteScope: (scope, tone, text) => k.log(scope, tone, text),
      destination: scope => destination(scope.work, k.repositoryOf(scope)),
      sourceName: scope => scope.work.source?.start.kind === "pull-request" ? `PR #${scope.work.source.start.number}` : scope.work.source?.start.branch ?? k.repositoryOf(scope)?.defaultBranch ?? "main",
      stopped: () => k.stopped, now: () => Date.now(), taskDetails: id => k.taskDetails(id), role: (id, task) => k.role(id, task),
      hasDecision: (taskId, kinds) => k.s.inbox.some(item => item.taskId === taskId && kinds.includes(item.kind)),
      raise: (target, kind, title, details) => { k.raise(target, kind, title, false, details); },
      log: (task, tone, text) => k.log(task, tone, text), delivered: task => k.tracking.delivered(task),
      done: task => k.onTaskDone?.(task), checkpoint: () => k.commitNow(), schedule: () => k.schedule(),
    }, {
      aborted: () => new Aborted(), waiting: reason => new WaitingForUsage(reason), prerequisiteRefresh: () => new PrerequisiteRefresh(),
      classify: error => error instanceof DecisionNeeded ? { kind: "decision" } : error instanceof PrerequisiteRefresh ? { kind: "refresh" }
        : error instanceof SourceMoved ? { kind: "source-moved", message: error.message } : { kind: "other" },
    });
    this.recovery = new DeliveryRecovery({
      get state() { return k.s; }, get boot() { return k.boot; }, now: () => Date.now(),
      task: id => k.task(id), repository: scope => k.repositoryOf(scope), taskDetails: id => k.taskDetails(id),
      log: (target, tone, text) => k.log(target, tone, text), raise: (target, kind, title, blocking, extra) => { k.raise(target, kind, title, blocking, extra); },
      commit: () => k.commit(), commitNow: () => k.commitNow(), delivered: target => k.tracking.delivered(target),
      done: task => k.onTaskDone?.(task), takeItem: id => k.takeItem(id), toWaiting: task => k.toWaiting(task),
      clearStep: task => k.clearStep(task), schedule: () => k.schedule(), tidy: id => k.tidy(id),
    }, {
      lookForDelivery: scope => this.verifier.lookForDelivery(scope),
      noteCancelledLocal: scope => this.noteCancelledLocal(scope), landLocal: (scope, signal, tested, how) => this.landLocal(scope, signal, tested, how),
      rememberDelivery: (scope, sha, branch) => this.rememberDelivery(scope, sha, branch),
      clearApproval: scope => this.clearApproval(scope), finishMany: task => this.finishMany(task),
      checkUnrecordedPullRequest: scope => this.monitor.checkUnrecordedPullRequest(scope),
    }, { aborted: () => new Aborted(), unreachable: text => new Unreachable(text) });
    this.monitor = new PrMonitor(k, this.verifier, {
      recordDelivery: (scope, evidence, signal) => this.recordDelivery(scope, evidence, signal),
      finishMany: task => this.finishMany(task),
    });
  }

  waitingForTurn(task: RuntimeTask): string | undefined { return this.admission.waitingForTurn(task); }
  releaseDeliveryTurn(taskId: Id): void { this.admission.releaseDeliveryTurn(taskId); }
  yieldForDecision(task: RuntimeTask): boolean { return this.admission.yieldForDecision(task); }
  finishDeliveryTurn(taskId: Id): void { this.admission.finishDeliveryTurn(taskId); }
  syncDeliveryTurns(): void { this.admission.syncDeliveryTurns(); }

  /**
   * The delivery step. Interrupted while publishing: what went out is looked up first. Otherwise the work is
   * made ready to ship, then ready to publish, then Petrina publishes it. Only a release runs an agent here, for
   * its notes. "continue": the task went somewhere else first (back to the builder or the delivery check, or main
   * moved and it gets ready again).
   */
  async deliver(task: RuntimeTask, stage: MutableStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    return this.workflow.deliver(task, stage, signal);
  }

  /** Native composition keeps the established wait and source-refresh failures. */
  private beforePublishing(scope: RepositoryContext, queuedCheck = false): void {
    this.workflow.beforePublishing(scope, queuedCheck);
  }

  private clearUnpublishedPreparations(task: RuntimeTask): Promise<void> { return this.workflow.clearUnpublishedPreparations(task); }


  private finishMany(task: RuntimeTask): void { this.workflow.finishMany(task); }

  /** A known-unpublished version commit is preparation, so it never reaches an editing role. */
  clearUnpublishedVersion(scope: RepositoryContext, preserveAttempts = false): Promise<void> {
    return this.workflow.clearUnpublishedVersion(scope, preserveAttempts);
  }


  // ── Ready to ship ──────────────────────────────────────────────────────

  /**
   * What ships is the change the coordinator approved, for this delivery and destination, one commit on top of
   * the latest main (freshly fetched for a GitHub delivery), with the checks passing on it. "back": the task went
   * back to the builder or the delivery check first.
   */
  private readyToShip(scope: RepositoryContext, signal: AbortSignal): Promise<"ready" | "back"> {
    return this.workflow.readyToShip(scope, signal);
  }

  /** A decision covers the full prepared versions and every proof status the coordinator saw. */
  private async proofApprovalCurrent(task: RuntimeTask, signal: AbortSignal, prepared = false): Promise<boolean> {
    const observed = Object.fromEntries(await completeAll(scopesFor(task).map(async ({ work }) => {
      if (!work.worktree) return [work.productId, { head: undefined, tree: "unavailable" }] as const;
      const version = await git.commitVersion(work.worktree);
      return [work.productId, { head: version.head, tree: version.tree ?? "unavailable" }] as const;
    })));
    const versions: Record<string, string> = Object.fromEntries(Object.entries(observed).map(([id, entry]) => [id, entry.tree]));
    for (const scope of scopesFor(task)) {
      const { work } = scope;
      const delivered = !!(work.pr || work.release || work.landed);
      if (delivered && work.delivery !== "release") continue;
      if (!work.worktree) return false;
      const head = observed[work.productId]?.head ?? await git.head(work.worktree);
      if (!(await git.isClean(work.worktree))) return false;
      const shipping = work.shipping;
      if (prepared && shipping?.prepared && head !== shipping.prepared.tested) return false;
      // This exception is only for the exact version commit created and verified by ReleasePrep.
      if (work.delivery === "release") {
        if (work.approvedFor?.by !== "coordinator") return false;
        const version = work.proofRelease;
        if (version && head !== version.start) {
          if (head !== version.tested || !await this.releases.isVersionCommit(work.worktree, head, version.start)) return false;
          if (versions[work.productId] !== task.approvedProofDecision?.versions[work.productId]) versions[work.productId] = await git.treeOf(work.worktree, version.start) ?? "unavailable";
        }
      }
      if (!delivered && prepared && shipping?.base && !shipping.pushed) {
        if (work.delivery === "local") {
          const product = this.k.repositoryOf(scope)!;
          const branch = work.source?.start.branch ?? product.defaultBranch ?? "main";
          const current = await git.revParse(product.path!, `refs/heads/${branch}`);
          const ownUpdate = current === shipping.localUpdated && current === shipping.prepared?.tested;
          if (current && !ownUpdate && current !== shipping.base && !await git.contains(product.path!, shipping.base, current)) return false;
        } else if (work.source?.start.kind !== "pull-request" && !await this.verifier.sourceCurrent(scope, signal)) return false;
      }
    }
    refreshProofs(task, versions);
    return sameProofDecision(task.approvedProofDecision, proofDecision(task, versions));
  }

  /**
   * Back to the delivery check for the coordinator's decision, with nothing more published: the versions or requested
   * proof differ from it, or required acceptance that could not be verified has none. A plan without the check gains it.
   */
  private returnForDecision(task: RuntimeTask, why: "proof" | "acceptance"): Promise<void> {
    return this.workflow.returnForDecision(task, why);
  }

  /**
   * The delivery gets ready. A pull request takes the builder's title and description, followed by Petrina's own
   * part. A release gets its version worked out now and set by Petrina in the product's version files, as one
   * version commit it checks, the product's checks again on it, and notes from the Release Manager, who reads every commit
   * since the previous release: a release ships all of them, not only this task. Local delivery needs nothing more.
   */
  private async prepare(scope: RepositoryContext, stage: MutableStage, signal: AbortSignal): Promise<"ready" | "continue" | "stop"> {
    const { task, work: repository } = scope;
    this.beforePublishing(scope);
    const product = this.k.repositoryOf(scope)!;
    const defaultBranch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
    const shipping: NonNullable<RepositoryWork["shipping"]> = (repository.shipping = { moves: repository.shipping?.moves ?? 0, failures: repository.shipping?.failures ?? 0 });
    const start = await this.branchTip(scope);
    if (!start) throw new Error(`The task's branch ${repository.branch} is gone, so Petrina published nothing. Send it back to the builder, or cancel it.`);
    shipping.start = start;
    if (repository.baseSha) shipping.base = repository.baseSha;
    if (repository.delivery === "local" || repository.source?.start.kind === "pull-request") {
      shipping.prepared = { tested: start, summary: `Ready to go onto ${defaultBranch}` };
      this.k.log(scope, "status", `Ready to publish: ${start.slice(0, 7)}, on top of ${defaultBranch}`);
      this.k.commitNow();
      return "ready";
    }
    if (repository.delivery === "pull-request") {
      shipping.prepared = { tested: start, summary: "Ready to open a pull request", title: this.pullRequestTitle(scope), body: this.pullRequestBody(scope) };
      this.k.log(scope, "status", `Ready to publish: ${start.slice(0, 7)}, with ${repository.report?.description ? "the builder's description" : "a description from the builder's report"}`);
      this.k.commitNow();
      return "ready";
    }
    const declared = await this.releases.chooseVersion(scope, signal);
    this.k.log(scope, "status", `Getting the release ready: Petrina sets the version to ${shipping.version}`);
    this.k.commitNow();
    const tested = await this.releases.setVersion(scope, declared);
    if (task.proofRequests?.length) repository.proofRelease = { start, tested };
    // A version commit changes what ships: the checks run on it too.
    this.beforePublishing(scope);
    if (tested !== start) {
      const verified = await this.checks.failing(scope, signal, undefined, "publishing");
      if (verified.kind === "product-failed") return this.preparationFailed(scope, `The product's checks fail with the version set to ${shipping.version}`, signal);
      if (verified.kind === "blocked") {
        await this.backToWork(scope);
        delete repository.shipping;
        if (task.repositories) await this.clearUnpublishedPreparations(task);
        this.clearApproval(scope);
        this.checks.blocked(task);
        return "stop";
      }
    }
    // The notes cover everything the release ships: every commit since the previous release, this task's included.
    const preview = repository.releasePreview;
    const changedPreview = this.workflow.rejectChangedReleasePreview(scope, start, shipping, preview);
    if (changedPreview) return changedPreview;
    const log = await this.releases.sincePreviousRelease(scope, signal);
    this.beforePublishing(scope);
    const profileId = stage.profileIds[0] ?? RELEASE_MANAGER_PROFILE;
    let by = profileId;
    const result = preview ?? await this.turns.turn(scope, "release-manager", profileId, () => [log], ReleaseNotesResult, signal, {
      initialHead: tested,
      used: (id) => (by = id),
      check: (value) => (!value.notes.trim() ? `"notes" is empty: write the release notes.` : value.notes.length > TEXT_LIMITS.notes ? `the release notes are longer than GitHub allows (${TEXT_LIMITS.notes} characters). Shorten them.` : undefined),
    });
    shipping.prepared = { tested, summary: result.summary, notes: result.notes.trim() };
    endAgentStep(task, { outcome: JOURNEY_WORDS.notes, reason: JOURNEY_WORDS.releaseNotesReady }, Date.now());
    // Petrina publishes from here.
    delete task.agent;
    task.holdsSlot = false;
    this.k.finishStep(scope);
    this.k.participantSay(scope, "agent", `${result.summary}\n\n${this.k.describe("release-manager", by)}`, "release-manager", by, undefined);
    this.k.log(scope, "done", `Ready to publish: ${tested.slice(0, 7)}, as ${shipping.tag}, with notes on everything since ${shipping.after || "the start"}`, "release-manager", by);
    this.k.commitNow();
    return "ready";
  }

  /** The pull request's title: the builder's one-line commit title, else the task's. */
  private pullRequestTitle(scope: RepositoryContext): string {
    const { task, work: repository } = scope;
    return fit((repository.report?.title ?? task.title).replace(/\s+/g, " ").trim(), TEXT_LIMITS.title);
  }

  /** The builder's words, or when it wrote none, its report: what it did, and what changed for users. */
  private fromReport(scope: RepositoryContext): string {
    const { task, work: repository } = scope;
    const report = repository.report;
    const changes = report?.changes.length ? `## What changed for users\n${report.changes.map((change) => `- ${change}`).join("\n")}` : "";
    return [report?.summary ?? task.title, changes].filter(Boolean).join("\n\n");
  }

  /** The pull request's description: the builder's, then Petrina's own part, which says only what Petrina saw. */
  private pullRequestBody(scope: RepositoryContext): string {
    const { task, work: repository } = scope;
    const builder = repository.report?.description?.trim() || this.fromReport(scope);
    const parts: string[] = ["## Checked by Petrina"];
    const acceptance = task.brief?.acceptance ?? [];
    // Ticked only where a tester checked it; an item that could not be verified says so, whatever the approval.
    if (acceptance.length) parts.push(`### Acceptance\n${acceptance.map((item) => (item.verification === "blocked" ? `- [ ] ${item.text} (Could not verify)` : item.met === undefined ? `- ${item.text}` : `- [${item.met ? "x" : " "}] ${item.text}`)).join("\n")}`);
    const runs = repository.checks?.results ?? [];
    if (runs.length) parts.push(`### Checks Petrina ran on this commit\n${runs.map((run) => `- ${run.name}: ${checkOutcomeLabel(checkOutcome(run))} (\`${run.command}\`)`).join("\n")}`);
    const reviewers = [...new Set((task.plan?.stages ?? []).filter((stage) => stage.kind === "review-chain").flatMap((stage) => stage.profileIds.map((profileId, position) => this.k.describe(reviewerAt(stage, position), profileId))))];
    if (reviewers.length) parts.push(`### Reviewed by\n${reviewers.map((reviewer) => `- ${reviewer}`).join("\n")}`);
    const followUps = task.findings.filter((finding) => finding.status === "open" && finding.severity === "pre-existing");
    // Only a count: an older problem a reviewer noted (a security one, say) is not for a public pull request.
    if (followUps.length) parts.push(`### Follow-ups\n${followUps.length === 1 ? "One older problem was" : `${followUps.length} older problems were`} noted for a follow-up, in Petrina.`);
    return fit(`${builder}\n\n${parts.join("\n\n")}`, TEXT_LIMITS.body);
  }

  /**
   * Not ready (the product's checks fail with the version set): nothing is published, and main and GitHub stay
   * as they were. The version change goes, and the task goes back to the builder, then review and the delivery
   * check again. After two failures Petrina stops and asks. Shared tasks keep their approval and return to
   * the delivery check instead; the coordinator can retry preparation or ask for changes.
   */
  private preparationFailed(scope: RepositoryContext, summary: string, signal: AbortSignal): Promise<"continue" | "stop"> {
    return this.workflow.preparationFailed(scope, summary, signal);
  }

  /** The default branch moved before a release or local delivery went out. */
  private prepareAgain(scope: RepositoryContext, why: string): Promise<"again"> {
    return this.workflow.prepareAgain(scope, why);
  }

  /**
   * The working copy on the task branch, with nothing half done, and the work itself at its tip: a release's
   * version commit from an earlier preparation goes.
   */
  private async backToWork(scope: RepositoryContext): Promise<void> {
    await this.k.agentCleanup.wait(scope.task.id);
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
    const tip = start ? (!moved && status.branch === repository.branch && status.head ? status.head : await this.branchTip(scope)) : undefined;
    if (start && tip && tip !== start && (await this.releases.isVersionCommit(worktree, tip, start))) {
      await git.resetTo(worktree, start);
      moved = true;
    }
    if (moved || (start && tip && repository.savedVersion?.commit !== tip) || !repository.savedVersion?.commit || !repository.savedVersion?.tree) {
      await this.k.rememberVersion(scope);
    }
    if (!repository.release && !repository.shipping?.pushed) delete repository.proofRelease;
  }

  /** Where the task branch itself points: never just what a working copy has open. */
  private branchTip(scope: RepositoryContext): Promise<string | undefined> {
    const { work: repository } = scope;
    return git.revParse(repository.worktree!, `refs/heads/${repository.branch!}`);
  }

  private clearApproval(scope: RepositoryContext): void {
    this.workflow.clearApproval(scope);
  }

  // ── Publishing ─────────────────────────────────────────────────────────

  private async publish(scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
    const { work: repository } = scope;
    if (repository.source?.start.kind === "pull-request") return this.publishPrUpdate(scope, signal);
    if (repository.source?.start.kind === "branch" && repository.delivery !== "release" && !(await this.verifier.sourceCurrent(scope, signal))) return this.prepareAgain(scope, "The approved starting branch moved on GitHub");
    if (repository.delivery === "pull-request") return this.publishPullRequest(scope, signal);
    if (repository.delivery === "release") return this.publishRelease(scope, signal);
    return this.publishLocal(scope, signal);
  }

  /** Saved before the step starts: a restart, pause or Retry looks its result up before doing anything. */
  private saveStep(scope: RepositoryContext, step: ShippingStep, status: string): void {
    const { task, work: repository } = scope;
    this.beforePublishing(scope);
    repository.shipping!.step = step;
    repository.shipping!.boot = this.k.boot;
    task.statusLine = status;
    this.k.commitNow();
  }

  /**
   * One publishing step, in line with the product's other git steps. Pause and cancel are checked when the step
   * actually starts, not when it joins the line, and it is saved right before it runs.
   */
  private publishStep<T>(scope: RepositoryContext, signal: AbortSignal, step: ShippingStep, status: string, run: () => Promise<T>): Promise<T> {
    return this.connections.serial(scope.work.productId, () => {
      if (signal.aborted) throw new Aborted();
      this.saveStep(scope, step, status);
      return run();
    });
  }

  /** Pause and cancel stop before the next step. What went out as a task was cancelled is looked up once its driver ends. */
  private stopIfAsked(signal: AbortSignal): void {
    if (signal.aborted) throw new Aborted();
  }

  private checking(scope: RepositoryContext, status: string): void {
    const { task } = scope;
    if (task.state === "cancelled") return;
    task.statusLine = status;
    this.k.commit();
  }

  private async publishPullRequest(scope: RepositoryContext, signal: AbortSignal): Promise<"done"> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const prepared = repository.shipping!.prepared!;
    const branch = repository.branch!;
    const remote = await this.connections.requireConnection(scope, signal);
    // The branch on GitHub holds the tested commit already, or nothing Petrina would overwrite.
    const there = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, remote, [`refs/heads/${branch}`]));
    if (!there.ok) throw new Unreachable(`Petrina could not check this task's branch on GitHub (${there.error}), so it publishes nothing more until it can. Retry when GitHub is reachable.`);
    const at = there.value.get(`refs/heads/${branch}`);
    if (at && at !== prepared.tested && !(await git.contains(product.path!, prepared.tested, at))) {
      throw new Error(`GitHub has this task's branch at ${at.slice(0, 7)}, which is not this work, so Petrina pushed nothing. Look at it on GitHub, then retry or cancel.`);
    }
    // GitHub's listing showed no pull request for this work. The same push again overwrites nothing.
    const pushed = await this.publishStep(scope, signal, "push", "Publishing: pushing the branch to GitHub", () => git.push(product.path!, remote, [{ sha: prepared.tested, ref: `refs/heads/${branch}` }]));
    this.stopIfAsked(signal);
    if (!pushed.ok) throw new Error(`GitHub refused the push of this task's branch, so no pull request was opened (${pushed.error}). Retry once that is sorted.`);
    this.k.log(scope, "status", `Petrina pushed the branch at ${prepared.tested.slice(0, 7)}`);
    return this.recovery.createPullRequest(scope, signal, {
      create: () => this.publishStep(scope, signal, "open", "Publishing: opening the pull request", () =>
        this.k.github.openPullRequest(product.repo, { head: branch, base: repository.source?.destination.branch ?? product.defaultBranch ?? "main", title: prepared.title!.trim(), body: prepared.body! })),
      find: () => this.verifier.findPullRequest(scope),
    });
  }



  private async publishRelease(scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const shipping = repository.shipping!;
    const { tested, notes } = shipping.prepared!;
    const tag = shipping.tag!;
    const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
    const root = product.path!;
    const remote = await this.connections.requireConnection(scope, signal);
    if (!shipping.pushed) {
      this.checking(scope, `Checking: looking at ${branch} and the tag ${tag} on GitHub`);
      const before = await this.verifier.releaseRefs(scope, remote);
      if (before.tag === tested && (await this.verifier.onGitHub(scope, remote, before.main, tested))) {
        this.k.log(scope, "status", `Checked: ${branch} and the tag ${tag} are already on GitHub at ${tested.slice(0, 7)}`);
      } else {
        if (before.tag === tested) throw new Error(`The tag ${tag} is on GitHub at the tested commit, but ${branch} there does not have it. Petrina published nothing more. Look at it on GitHub, then retry or cancel.`);
        // A moved default branch or a newer release make this preparation and its version stale.
        if (before.main !== shipping.base && before.main !== tested) return this.prepareAgain(scope, `${branch} moved on GitHub`);
        const latest = await this.connections.serial(product.id, () => this.k.github.latestRelease(product.repo));
        if (!latest.ok) throw new Error(`Petrina could not read the latest release on GitHub (${latest.error}), so it published nothing. Retry when GitHub is reachable.`);
        if ((latest.value ?? "") !== shipping.after) return this.prepareAgain(scope, latest.value ? `${latest.value} came out meanwhile` : "The latest release changed meanwhile");
        if (before.tag) throw new Error(`The tag ${tag} already exists on GitHub at another commit. Petrina will not move or reuse it, and published nothing more. Look at it on GitHub, then retry or cancel.`);
        // One push, all or nothing, never forced: it only moves the branch forward and refuses an existing tag.
        const pushed = await this.publishStep(scope, signal, "push", `Publishing: pushing ${branch} and the tag ${tag} to GitHub`, () =>
          git.push(
            root,
            remote,
            [
              { sha: tested, ref: `refs/heads/${branch}` },
              { sha: tested, ref: `refs/tags/${tag}` },
            ],
            true,
          ),
        );
        if (!pushed.ok) {
          const after = await this.verifier.releaseRefs(scope, remote);
          if (!(after.tag === tested && (await this.verifier.onGitHub(scope, remote, after.main, tested)))) {
            if (!after.tag && after.main !== shipping.base && after.main !== tested) return this.prepareAgain(scope, `${branch} moved on GitHub`);
            throw new Error(`GitHub refused the push of ${branch} and the tag ${tag}, so Petrina published nothing (${pushed.error}). Retry once that is sorted.`);
          }
        }
        this.k.log(scope, "status", `Petrina pushed ${branch} and the tag ${tag} at ${tested.slice(0, 7)}`);
      }
      // From here the version and commit stay, even if the default branch moves on.
      shipping.pushed = true;
      this.k.commitNow();
      this.stopIfAsked(signal);
    }
    // Retry and Ship it again come straight here: the release goes only on a tag still at the tested commit.
    this.checking(scope, `Checking: looking at the tag ${tag} on GitHub`);
    const at = await this.verifier.releaseRefs(scope, remote);
    if (at.tag !== tested) {
      throw new Error(`The tag ${tag} on GitHub ${at.tag ? `is at ${at.tag.slice(0, 7)}` : "is gone"}, not at the tested commit ${tested.slice(0, 7)}, so Petrina created no release. Look at it on GitHub, then retry or cancel.`);
    }
    // GitHub showed no release for this tag. Release creation only uses the tag already on GitHub.
    return this.recovery.createRelease(scope, signal, {
      create: () => this.publishStep(scope, signal, "release", `Publishing: creating the release ${tag}`, () => this.k.github.createRelease(product.repo, tag, notes!)),
      find: () => this.verifier.findRelease(scope),
      tag: async () => (await this.verifier.releaseRefs(scope, remote)).tag,
    });
  }




  /** Local update and its push have separate saved evidence. */
  private async publishLocal(scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const shipping = repository.shipping!;
    const { tested } = shipping.prepared!;
    const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
    const root = product.path!;
    // Coordinated with the product's other git steps: nothing else moves its branches meanwhile.
    const outcome = await this.connections.serial(product.id, async (): Promise<"found" | "moved" | { again: string }> => {
      this.checking(scope, `Checking: looking at ${branch} in the main copy`);
      const current = await git.revParse(root, `refs/heads/${branch}`);
      if (current && (current === tested || (await git.contains(root, current, tested)))) return "found";
      const previous = repository.localUpdate?.pushed === false && repository.localUpdate.branch === branch && repository.localUpdate.sha === current;
      if (current && !previous && current !== shipping.base && !(shipping.base && await git.contains(root, shipping.base, current))) return { again: `${branch} moved in the main copy` };
      const places = current ? (await git.checkedOut(root, branch)).map((place) => realPath(place)) : [];
      const here = places.includes(realPath(root));
      const elsewhere = places.filter((place) => place !== realPath(root));
      if (elsewhere.length) throw new Error(`${branch} is checked out in another folder (${elsewhere[0]}), so Petrina did not move it. Switch that folder to another branch, then retry.`);
      if (here && (await git.changes(root, true)).length) throw new Error(`The main copy at ${root} has changes that are not committed, so Petrina did not move ${branch}. Commit them or put them aside, then retry.`);
      this.stopIfAsked(signal);
      this.saveStep(scope, "update", `Publishing: moving ${branch} forward to the tested work`);
      const moved = current ? previous ? await git.replaceLocalDelivery(root, branch, current, tested, here) : await git.fastForward(root, branch, current, tested, here) : await git.createBranchAt(root, branch, tested);
      if (!moved.ok) {
        const now = await git.revParse(root, `refs/heads/${branch}`);
        if (now !== current && now !== tested) return { again: `${branch} moved in the main copy` };
        throw new Error(`Git would not move ${branch} forward, so Petrina published nothing (${moved.error}). Retry once that is sorted.`);
      }
      this.stopIfAsked(signal);
      return "moved";
    });
    if (typeof outcome !== "string") return this.prepareAgain(scope, outcome.again);
    return this.landLocal(scope, signal, tested, outcome);
  }

  /**
   * The approved local branch has the tested work: checked in the main copy itself, then pushed to the saved
   * GitHub address when the product has one, and only then recorded as landed. A product with no GitHub
   * repository, or whose address the coordinator refused, lands locally and that is all.
   */
  private async landLocal(scope: RepositoryContext, signal: AbortSignal, tested: string, how?: "found" | "moved"): Promise<"done"> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
    await this.verifier.verifyLocal(product.path!, branch, tested);
    if (repository.shipping) repository.shipping.localUpdated = tested;
    const connection = await this.connections.connection(scope, signal);
    const github = connection.ok && !!product.remote && git.sameRepo(product.remote, product.repo) && !product.repo.startsWith("local/");
    // Saved before the push, so a cancelled or refused send stays unfinished instead of looking delivered.
    if (github || repository.localUpdate) {
      repository.localUpdate = { branch, sha: tested, pushed: false };
      this.k.commitNow();
    }
    if (repository.localUpdate) {
      const reached = await this.pushMain(scope, signal, branch, tested);
      if (!reached) throw new Error(`${branch} has the work in the main copy, but Petrina could not push it to GitHub. The checked work is preserved. Retry after access is restored.`);
      repository.localUpdate.pushed = true;
      this.k.commitNow();
    }
    return this.recordLanded(scope, branch, tested, how);
  }


  /**
   * Only the saved tested commit is pushed. Newer local commits stay local until checked in their own right.
   * A destination already containing this commit needs no push; divergent history is never overwritten.
   * True only when GitHub has this commit. A check that cannot send is false, never a completed push.
   */
  private async pushMain(scope: RepositoryContext, signal: AbortSignal, branch: string, at: string): Promise<boolean> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const connection = await this.connections.connection(scope, signal);
    if (!connection.ok) {
      if (!connection.missing) this.k.log(scope, "warn", `${branch} was not pushed to GitHub: ${connection.reason}`);
      return false;
    }
    const ref = `refs/heads/${branch}`;
    const there = await this.connections.serial(product.id, () => git.remoteRefs(product.path!, connection.remote, [ref]));
    if (!there.ok) throw new Unreachable(`Petrina could not check ${branch} on GitHub (${there.error}). Retry before publishing anything more.`);
    if (await this.verifier.remoteContains(scope, connection.remote, branch, there.value.get(ref), at)) return true;
    const checkMovement = async (tip: string | undefined): Promise<void> => {
      const base = repository.shipping?.base;
      if (!tip && repository.source?.start.kind === "branch") throw new Error(`${branch} is no longer available on GitHub. The checked work is preserved; nothing more was published.`);
      if (tip && base && tip !== base && !(await git.contains(product.path!, base, tip))) {
        if (await git.contains(product.path!, tip, base)) throw new SourceMoved(`${branch} moved on GitHub`);
        throw new Error(`${branch} on GitHub has divergent history. The checked work is preserved; bring the destination copies into agreement before retrying.`);
      }
    };
    await checkMovement(there.value.get(ref));
    this.stopIfAsked(signal);
    if (scope.task.proofRequests?.length && !await this.proofApprovalCurrent(scope.task, signal, true)) {
      await this.returnForDecision(scope.task, "proof");
      throw new DecisionNeeded();
    }
    // Recovery can reach this push straight from a finished local update: the completed update stays, the push waits.
    if (undecidedAcceptanceGap(scope.task)) {
      await this.returnForDecision(scope.task, "acceptance");
      throw new DecisionNeeded();
    }
    const pushed = await this.publishStep(scope, signal, "push", `Publishing: pushing ${branch} to GitHub`, () => git.push(product.path!, connection.remote, [{ sha: at, ref }]));
    if (!pushed.ok) {
      const tip = await this.verifier.remoteTip(scope, connection.remote, branch);
      if (await this.verifier.remoteContains(scope, connection.remote, branch, tip, at)) return true;
      await checkMovement(tip);
      throw new Error(`${branch} has the work in the main copy, but Petrina could not push it to GitHub (${pushed.error}). The checked work is preserved. Retry after access is restored.`);
    }
    this.k.log(scope, "done", `Petrina pushed ${branch} to GitHub (${at.slice(0, 7)})`);
    return true;
  }







  private async publishPrUpdate(scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
    const { work: repository } = scope;
    const pr = await this.verifier.approvedPr(scope);
    if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. No more commits will be published; the work is preserved.`);
    const remote = this.verifier.destinationRemote(scope);
    const { tested } = repository.shipping!.prepared!;
    const at = await this.verifier.remoteTip(scope, remote, pr.branch);
    if (!at) throw new Error(`The working branch for PR #${pr.number} is unavailable. The work is preserved.`);
    if (await this.verifier.remoteContains(scope, remote, pr.branch, at, tested)) return this.recordPr(scope, pr, "updated");
    if (at !== repository.shipping!.base) return this.prepareAgain(scope, `PR #${pr.number}'s working branch moved`);
    const pushed = await this.publishStep(scope, signal, "push", `Publishing: updating PR #${pr.number} in ${pr.headRepo} · ${pr.branch}`, () => git.push(this.k.repositoryOf(scope)!.path!, remote, [{ sha: tested, ref: `refs/heads/${pr.branch}` }]));
    this.stopIfAsked(signal);
    const after = await this.verifier.remoteTip(scope, remote, pr.branch);
    if (await this.verifier.remoteContains(scope, remote, pr.branch, after, tested)) return this.recordPr(scope, pr, "updated");
    if (after !== at) return this.prepareAgain(scope, `PR #${pr.number}'s branch moved during publishing`);
    throw new Error(`GitHub refused the update to PR #${pr.number} in ${pr.headRepo} · ${pr.branch} (${pushed.ok ? "the tested work could not be confirmed" : pushed.error}). The work is preserved. Retry after access is restored.`);
  }

  // ── What went out ──────────────────────────────────────────────────────

  /**
   * The one check before Petrina publishes, and after any interruption: record the delivery if it already
   * went out, carry on when GitHub clearly has nothing, and otherwise publish nothing more on its own. An
   * interrupted delivery asks the coordinator; a new one waits for Retry.
   */
  private checkDelivery(scope: RepositoryContext, signal: AbortSignal) { return this.recovery.checkDelivery(scope, signal); }
  private recordDelivery(scope: RepositoryContext, evidence: DeliveryEvidence, signal: AbortSignal) { return this.recovery.recordDelivery(scope, evidence, signal); }
  private recordPr(scope: RepositoryContext, pr: { number: number; url: string; state: "open" | "merged" | "closed" }, how?: "opened" | "updated") { return this.recovery.recordPr(scope, pr, how); }
  private recordLanded(scope: RepositoryContext, branch: string, sha: string, how?: "found" | "moved") { return this.recovery.recordLanded(scope, branch, sha, how); }
  carryOverShipping(): void { this.recovery.carryOverShipping(); }
  askCarriedOver(task: RuntimeTask): void { this.recovery.askCarriedOver(task); }
  checkShipping(itemId: Id): void { this.recovery.checkShipping(itemId); }
  shipAgain(itemId: Id): void { this.recovery.shipAgain(itemId); }
  markDone(itemId: Id): void { this.recovery.markDone(itemId); }

  /** Record a cancelled local move only after asking GitHub about its push. */
  private async noteCancelledLocal(scope: RepositoryContext): Promise<boolean | "unknown"> {
    const { work: repository } = scope;
    const product = this.k.repositoryOf(scope)!;
    const branch = repository.source?.destination.branch ?? product.defaultBranch ?? "main";
    const tested = repository.shipping!.prepared!.tested;
    const reached = await this.verifier.githubHas(scope, branch, tested);
    if (reached === "unknown") {
      if (repository.localUpdate) repository.localUpdate.pushed = false;
      this.k.commit();
      return "unknown";
    }
    const owes = Boolean(repository.localUpdate) || Boolean(product.remote && !product.repo.startsWith("local/") && git.sameRepo(product.remote, product.repo));
    if (owes) repository.localUpdate = { branch, sha: tested, pushed: reached };
    await this.recordLanded(scope, branch, tested, "found");
    return reached;
  }
  /** Preserve complete confirmed contents before preparation and the working copy are removed. */
  private async rememberDelivery(scope: RepositoryContext, sha: string, branch: string): Promise<void> {
    const product = this.k.repositoryOf(scope);
    const path = scope.work.worktree ?? product?.path;
    if (!path || !product || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return;
    const savedTree = scope.work.savedVersion?.commit === sha ? scope.work.savedVersion.tree : undefined;
    if (savedTree && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(savedTree)) {
      scope.work.confirmedDelivery = { sha, tree: savedTree, branch, repo: product.repo, at: Date.now() };
      return;
    }
    const tree = await git.treeOf(path, sha).catch(() => undefined);
    if (tree && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) scope.work.confirmedDelivery = { sha, tree, branch, repo: product.repo, at: Date.now() };
  }

}
