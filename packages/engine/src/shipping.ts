import { CompanionLinks } from "./companion-links.js";
import { DeliveryAdmission, DeliveryWorkflow } from "@petrina/orchestrator";
import { ShippingVerifier, type DeliveryEvidence } from "./shipping-verifier.js";
import { realPath } from "@petrina/repositories/paths";
import { ReleasePrep } from "./release-prep.js";
import { PrMonitor } from "./pr-monitor.js";
import { clearDeliveryPreparation, executionFor, scopesFor, type RepositoryContext, type RepositoryWork } from "@petrina/orchestrator";
import { checkOutcome, checkOutcomeLabel, proofDecision, refreshProofs, sameProofDecision, undecidedAcceptanceGap } from "@petrina/core";
import { versionsOf } from "./repositories.js";
import { landingState, syncRuntimeWait } from "@petrina/core";
// Delivering finished work, by Petrina itself, with no agent. Before anything goes out the work is one commit on
// top of the latest main, approved for this delivery and destination, with the checks passing on it. Petrina
// publishes the exact commit it checked, with what the builder wrote to go out with it: it pushes the branch and
// opens the pull request (the builder's description, then Petrina's own part), sets a release's version in the
// product's version files, pushes main and the new tag together and creates the release with the builder's
// notes, or moves the approved local branch forward and pushes it. A pull request the task started from gets the tested commit on its working branch. It has no merge, force-push or delete. Every publishing step is saved
// before it starts, and an interrupted delivery is looked up before anything goes out again: never twice.

import {
  CLEANUP_WORDS,
  type Id,
  beginYouStep,
  endAgentStep,
  endOpenStep,
  endPetrinaStep,
  endYouStep,
  JOURNEY_WORDS as W,
  lastIndexWhere,
  reviewerAt,
  openStep,
  petrinaMoment,
  type DeliveryMode,
  type Product,
  type ShippingStep,
  type TaskSource,
} from "@petrina/core";
import * as github from "@petrina/repositories/github";
import * as git from "@petrina/repositories/git";
import { ReleaseNotesResult, TEXT_LIMITS } from "./roles.js";
import { WaitingForUsage } from "./usage.js";
import { Aborted, type Kernel, type MStage, type MTask, RELEASE_MANAGER_PROFILE } from "./kernel.js";
import { type Connections, Unreachable } from "./connection.js";
import type { ProductChecks } from "./product-checks.js";
import type { ToolChecks } from "./tool-checks.js";
import type { Turns } from "./turn.js";
import type { Updates } from "./update.js";

/** Preparations started again because the default branch moved, before Petrina stops and asks. */
const MAX_MOVES = 3;
/** Failed preparations (the checks failing on the version commit) before Petrina stops and asks. */
const MAX_FAILURES = 2;
/** A delivery from before the update, which Petrina leaves to the coordinator. */
export const CARRIED_OVER = "This delivery was interrupted before Petrina was updated";

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
  return task.delivery === "release" && !task.shipping?.prepared && !task.shipping?.step && !task.shipping?.carriedOver;
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
      closedPullRequest: ({ work }) => github.prState(work.source!.product.repo, work.pr!.number, k.options.gh),
      needGitHub: task => this.tools.needGitHub(task),
      readyToShip: (scope, signal) => this.readyToShip(scope, signal),
      head: scope => git.head(scope.work.worktree!),
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
    this.monitor = new PrMonitor(k, this.verifier, {
      recordDelivery: (scope, evidence, signal) => this.recordDelivery(scope, evidence, signal),
      finishMany: task => this.finishMany(task),
    });
  }

  waitingForTurn(task: MTask): string | undefined { return this.admission.waitingForTurn(task); }
  releaseDeliveryTurn(taskId: Id): void { this.admission.releaseDeliveryTurn(taskId); }
  yieldForDecision(task: MTask): boolean { return this.admission.yieldForDecision(task); }
  finishDeliveryTurn(taskId: Id): void { this.admission.finishDeliveryTurn(taskId); }
  syncDeliveryTurns(): void { this.admission.syncDeliveryTurns(); }

  /**
   * The delivery step. Interrupted while publishing: what went out is looked up first. Otherwise the work is
   * made ready to ship, then ready to publish, then Petrina publishes it. Only a release runs an agent here, for
   * its notes. "continue": the task went somewhere else first (back to the builder or the delivery check, or main
   * moved and it gets ready again).
   */
  async deliver(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    return this.workflow.deliver(task, stage, signal);
  }

  /** Native composition keeps the established wait and source-refresh failures. */
  private beforePublishing(scope: RepositoryContext, queuedCheck = false): void {
    this.workflow.beforePublishing(scope, queuedCheck);
  }

  private clearUnpublishedPreparations(task: MTask): Promise<void> { return this.workflow.clearUnpublishedPreparations(task); }


  private finishMany(task: MTask): void { this.workflow.finishMany(task); }

  /** A known-unpublished version commit is preparation, so it never reaches an editing role. */
  async clearUnpublishedVersion(scope: RepositoryContext, preserveAttempts = false): Promise<void> {
    const { work: repository } = scope;
    if (!repository.shipping?.step && !repository.shipping?.pushed && repository.shipping?.start) {
      const { moves, failures } = repository.shipping;
      await this.backToWork(scope);
      // Waiting invalidates the candidate, not the delivery attempts that actually happened.
      if (preserveAttempts) repository.shipping = { moves, failures };
      else delete repository.shipping;
      this.k.commitNow();
    }
  }


  // ── Ready to ship ──────────────────────────────────────────────────────

  /**
   * What ships is the change the coordinator approved, for this delivery and destination, one commit on top of
   * the latest main (freshly fetched for a GitHub delivery), with the checks passing on it. "back": the task went
   * back to the builder or the delivery check first.
   */
  private async readyToShip(scope: RepositoryContext, signal: AbortSignal): Promise<"ready" | "back"> {
    if (await this.readyCandidate(scope, signal) === "back") return "back";
    let order = this.checks.deliveryOrders.get(scope.task.id);
    const preparation = Object.assign(async () => await this.readyCandidate(scope, signal) === "ready", {
      beforeQueue: () => {
        this.beforePublishing(scope, true);
        const current = this.checks.deliveryOrders.get(scope.task.id);
        // A first turn follows the source preparation above. Only losing an existing turn
        // can make that preparation obsolete without a wait in the check line.
        const changed = order !== undefined && current !== order;
        order = current;
        return changed;
      },
    });
    if (await this.checks.checksBeforeShipping(scope, signal, preparation) !== "passed") return "back";
    const { task } = scope;
    if (task.proofRequests?.length && !await this.proofApprovalCurrent(task, signal)) {
      await this.returnForDecision(task, "proof");
      return "back";
    }
    if (undecidedAcceptanceGap(task)) {
      await this.returnForDecision(task, "acceptance");
      return "back";
    }
    return "ready";
  }

  /** The same source and approval rule applies before queuing and again after a check-line wait. */
  private async readyCandidate(scope: RepositoryContext, signal: AbortSignal): Promise<"ready" | "back"> {
    const { task, work: repository } = scope;
    // A version change from an earlier preparation is the delivery's, never the work's: it goes first.
    await this.backToWork(scope);
    const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
    const backToCheck = (line: string): "back" => {
      delete task.approvedProofDecision;
      delete task.approvedAcceptanceGap;
      this.clearApproval(scope);
      clearDeliveryPreparation(scope);
      task.stageIndex = check;
      task.sub = 0;
      petrinaMoment(task, "delivery", { outcome: W.askAgain, reason: W.changedSinceApproval, tone: "back" }, Date.now());
      this.k.log(scope, "warn", line);
      this.k.commit();
      return "back";
    };
    const allowed = repository.approvedFor;
    if (allowed && (allowed.mode !== repository.delivery || allowed.destination !== destination(repository, this.k.repositoryOf(scope)))) {
      if (check >= 0) return backToCheck("Where it goes changed after it was approved, so it needs your OK again");
      this.clearApproval(scope);
    }
    // Before anything moves (an approval from before patch-ids were kept goes by its commit).
    const sourceName = repository.source?.start.kind === "pull-request" ? `PR #${repository.source.start.number}` : repository.source?.start.branch ?? this.k.repositoryOf(scope)?.defaultBranch ?? "main";
    const approved = repository.approvedPatch ?? (repository.approvedSha ? await this.updates.patch(scope, repository.approvedSha) : undefined);
    const update = await this.updates.upToDate(scope, signal, true);
    if (update === "conflict") return "back";
    const sameCommit = approved && check >= 0 && update === "current" && repository.approvedSha
      && await git.head(repository.worktree!).catch(() => undefined) === repository.approvedSha;
    if (approved && check >= 0 && !sameCommit && (await this.updates.patch(scope)) !== approved) {
      return backToCheck(update === "moved" ? `${sourceName === "main" ? "Main" : sourceName} moved on, and on top of it this change reads differently from what you approved, so Petrina asks you again` : "The work changed after you approved the delivery, so Petrina asks you again");
    }
    return "ready";
  }

  /** A decision covers the full prepared versions and every proof status the coordinator saw. */
  private async proofApprovalCurrent(task: MTask, signal: AbortSignal, prepared = false): Promise<boolean> {
    const versions = await versionsOf(task);
    for (const scope of scopesFor(task)) {
      const { work } = scope;
      const delivered = !!(work.pr || work.release || work.landed);
      if (delivered && work.delivery !== "release") continue;
      if (!work.worktree) return false;
      const head = await git.head(work.worktree);
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
  private returnForDecision(task: MTask, why: "proof" | "acceptance"): Promise<void> {
    return this.workflow.returnForDecision(task, why);
  }

  /**
   * The delivery gets ready. A pull request takes the builder's title and description, followed by Petrina's own
   * part. A release gets its version worked out now and set by Petrina in the product's version files, as one
   * version commit it checks, the product's checks again on it, and notes from the Release Manager, who reads every commit
   * since the previous release: a release ships all of them, not only this task. Local delivery needs nothing more.
   */
  private async prepare(scope: RepositoryContext, stage: MStage, signal: AbortSignal): Promise<"ready" | "continue" | "stop"> {
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
    if (task.repositories && preview && (preview.start !== start || preview.version !== shipping.version || preview.tag !== shipping.tag || preview.after !== shipping.after)) {
      await this.backToWork(scope);
      delete repository.releasePreview;
      this.clearApproval(scope);
      delete repository.shipping;
      // The delivery gate can pause before it runs again. Restore every unpublished product
      // now, while the previous approval still describes the original work.
      await this.clearUnpublishedPreparations(task);
      const gate = task.plan!.stages.findIndex((entry) => entry.gate === "delivery");
      task.stageIndex = gate;
      this.k.log(scope, "warn", "The release preview changed, so shared delivery approval is needed again.");
      this.k.commitNow();
      return "continue";
    }
    const log = await this.releases.sincePreviousRelease(scope, signal);
    this.beforePublishing(scope);
    const profileId = stage.profileIds[0] ?? RELEASE_MANAGER_PROFILE;
    let by = profileId;
    const result = preview ?? await this.turns.turn(scope, "release-manager", profileId, () => [log], ReleaseNotesResult, signal, {
      used: (id) => (by = id),
      check: (value) => (!value.notes.trim() ? `"notes" is empty: write the release notes.` : value.notes.length > TEXT_LIMITS.notes ? `the release notes are longer than GitHub allows (${TEXT_LIMITS.notes} characters). Shorten them.` : undefined),
    });
    shipping.prepared = { tested, summary: result.summary, notes: result.notes.trim() };
    endAgentStep(task, { outcome: W.notes, reason: W.releaseNotesReady }, Date.now());
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
  private async preparationFailed(scope: RepositoryContext, summary: string, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task, work: repository } = scope;
    const shipping = repository.shipping!;
    await this.backToWork(scope);
    const failures = shipping.failures + 1;
    const reason = /[.!?]$/.test(summary.trim()) ? summary.trim() : `${summary.trim()}.`;
    if (task.repositories) {
      // Only delivery preparation changed. Keep the reviewed work and its approval; no builder owns this failure.
      delete repository.shipping;
      this.k.clearStep(scope);

      await this.clearUnpublishedPreparations(task);
      // Check the restored work, so failures belonging only to the removed version do not reach a builder.
      const restoredChecks = await this.checks.failing(scope, signal, undefined, "publishing");
      if (restoredChecks.kind === "blocked") { this.checks.blocked(task); return "stop"; }

      const delivery = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.kind === "gate" && entry.gate === "delivery");
      if (delivery < 0) throw new Error("The plan has no delivery check before release preparation");
      task.stageIndex = delivery;
      task.sub = 0;
      const problem = `${this.k.repositoryOf(scope)!.name}: getting the release ready failed. ${reason} Nothing was published. Your approved work is saved; try delivery again or send it back with a note.`;
      this.k.log(scope, "warn", problem);
      this.k.gate(task, "delivery", problem);
      return "stop";
    }
    task.findings.push({ id: this.k.id(task.id), text: `Getting the delivery ready failed, so nothing was published: ${reason}`, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
    repository.shipping = { moves: 0, failures };
    this.clearApproval(scope);
    delete task.agent;
    // Nothing was handed back, so no record for estimates.
    this.k.clearStep(scope);
    const builder = lastIndexWhere(task.plan?.stages ?? [], (entry) => this.k.role(entry.roleId)?.result === "build" && entry.kind === "do");
    if (builder >= 0) {
      task.stageIndex = builder;
      task.sub = 0;
      task.fixing = true;
    }
    this.k.log(scope, "warn", `Not ready to publish: ${reason} Nothing was published; it goes back to the builder.`);
    this.k.commitNow();
    if (failures < MAX_FAILURES && builder >= 0) return "continue";
    this.k.fail(task.id, new Error(`Getting the delivery ready failed ${failures} times, so Petrina stopped and published nothing. The last reason: ${reason} Try again to send it back to the builder, or cancel it.`));
    return "stop";
  }

  /** The default branch moved before a release or local delivery went out: Petrina gets it ready again. */
  private async prepareAgain(scope: RepositoryContext, why: string): Promise<"again"> {
    const { task, work: repository } = scope;
    if (task.proofRequests?.length) {
      await this.returnForDecision(task, "proof");
      return "again";
    }
    const shipping = repository.shipping!;
    const branch = repository.source?.start.branch ?? this.k.repositoryOf(scope)?.defaultBranch ?? "main";
    if (shipping.moves >= MAX_MOVES) {
      // A Retry gets a fresh set of attempts.
      shipping.moves = 0;
      this.k.commitNow();
      throw new Error(`${why} again: ${branch} kept moving while Petrina was delivering, so it stopped after ${MAX_MOVES} new preparations and published nothing. Retry when it is quiet.`);
    }
    // The version change goes: the work is brought up to date again, and gets a fresh version.
    await this.backToWork(scope);
    repository.shipping = { ...(shipping.start ? { start: shipping.start } : {}), moves: shipping.moves + 1, failures: shipping.failures };
    const place = repository.source?.start.kind === "pull-request" ? `PR #${repository.source.start.number}` : branch;
    endPetrinaStep(task, { outcome: place === "main" ? W.mainMovedOn : `${place} moved on`, reason: W.readyAgain }, Date.now());
    this.k.log(scope, "warn", `${why}, so Petrina gets it ready again (${shipping.moves + 1} of ${MAX_MOVES})`);
    this.k.commitNow();
    return "again";
  }

  /**
   * The working copy on the task branch, with nothing half done, and the work itself at its tip: a release's
   * version commit from an earlier preparation goes.
   */
  private async backToWork(scope: RepositoryContext): Promise<void> {
    const { work: repository } = scope;
    const worktree = repository.worktree!;
    await git.discardChanges(worktree);
    if ((await git.currentBranch(worktree)) !== repository.branch) {
      const switched = await git.switchTo(worktree, repository.branch!);
      if (!switched.ok) throw new Error(`Petrina could not put the working copy back on ${repository.branch} (${switched.error}), so it published nothing.`);
    }
    const start = repository.shipping?.start;
    const tip = await this.branchTip(scope);
    if (start && tip && tip !== start && (await this.releases.isVersionCommit(worktree, tip, start))) await git.resetTo(worktree, start);
    await this.k.rememberVersion(scope);
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
    const opened = await this.publishStep(scope, signal, "open", "Publishing: opening the pull request", () =>
      github.openPullRequest(product.repo, { head: branch, base: repository.source?.destination.branch ?? product.defaultBranch ?? "main", title: prepared.title!.trim(), body: prepared.body! }, this.k.options.gh),
    );
    this.stopIfAsked(signal);
    if (!opened.ok && !opened.exists) throw new Error(`GitHub did not open the pull request (${opened.error}). Retry: Petrina looks for it on GitHub before opening another.`);
    // Checked on GitHub itself: from this branch, into the default branch, at the tested commit.
    const pr = await this.verifier.findPullRequest(scope);
    if (!pr) {
      throw new Error(
        opened.ok
          ? "GitHub said it opened the pull request, but Petrina cannot find it for this branch and commit. Retry to check again."
          : `GitHub says a pull request already exists for this branch, but none matches this work (${opened.error}). Look at it on GitHub, then retry or cancel.`,
      );
    }
    return this.recordPr(scope, pr, "opened");
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
        const latest = await this.connections.serial(product.id, () => github.latestRelease(product.repo, this.k.options.gh));
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
    const created = await this.publishStep(scope, signal, "release", `Publishing: creating the release ${tag}`, () => github.createRelease(product.repo, tag, notes!, this.k.options.gh));
    this.stopIfAsked(signal);
    if (!created.ok && !created.exists) throw new Error(`GitHub did not create the release ${tag} (${created.error}). Retry: Petrina looks for it on GitHub before creating another.`);
    const release = await this.verifier.findRelease(scope);
    if (!release) throw new Error(`GitHub ${created.ok ? "said it created" : "says it already has"} the release ${tag}, but Petrina cannot find it. Retry to check again.`);
    // Checked on GitHub itself: the tag is at the tested commit.
    const verified = await this.verifier.releaseRefs(scope, remote);
    if (verified.tag !== tested) throw new Error(`The release ${tag} is on GitHub, but its tag is not at the tested commit ${tested.slice(0, 7)}. Look at it on GitHub.`);
    return this.recordRelease(scope, release, "published");
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
  private async checkDelivery(scope: RepositoryContext, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task, work: repository } = scope;
    const shipping = repository.shipping!;
    const interrupted = shipping.step !== undefined;
    const when = interrupted && shipping.boot !== this.k.boot ? " after a restart" : "";
    if (interrupted) {
      task.statusLine = "Checking whether it already went out";
      this.k.commit();
    }
    const delivery = await this.verifier.lookForDelivery(scope);
    if (signal.aborted) throw new Aborted();
    if (delivery.found === true) {
      this.k.log(scope, "done", `Found${when} that it had already gone out: ${delivery.text}`);
      await this.recordDelivery(scope, delivery.evidence, signal);
      return "stop";
    }
    if (delivery.found === false) {
      if (interrupted) this.k.log(scope, "status", `Checked${when}: ${delivery.text} Petrina carries on publishing.`);
      return "continue";
    }
    if (!interrupted) throw delivery.found === "unknown" ? new Unreachable(delivery.text) : new Error(delivery.text);
    delete task.agent;
    task.holdsSlot = false;
    task.statusLine = "Shipping was interrupted. Your call";
    endPetrinaStep(task, { outcome: W.interrupted, reason: W.shippingInterrupted, tone: "back" }, Date.now());
    beginYouStep(task, "shipping", Date.now());
    this.k.raise(scope, "shipping", `Shipping “${task.title}” was interrupted`, false, {
      body: `${delivery.text} Petrina will not publish it again on its own: check again, ship it again (it gets ready again, and Petrina checks GitHub before publishing), or mark it as done if it went out another way.`,
    });
    this.k.log(scope, "warn", `Shipping was interrupted${when}. ${delivery.text}`);
    this.k.commitNow();
    return "stop";
  }


  /** Observations alone never complete publishing. The state machine owns recording and local recovery. */
  private async recordDelivery(scope: RepositoryContext, evidence: DeliveryEvidence, signal: AbortSignal): Promise<"done" | "unknown"> {
    if (evidence.kind === "pr") return this.recordPr(scope, evidence.pr, evidence.updated ? "updated" : undefined);
    if (evidence.kind === "release") return this.recordRelease(scope, evidence.release);
    if (scope.task.state === "cancelled") return await this.noteCancelledLocal(scope) === "unknown" ? "unknown" : "done";
    return this.landLocal(scope, signal, evidence.tested, "found");
  }

  private recordPr(scope: RepositoryContext, pr: { number: number; url: string; state: "open" | "merged" | "closed" }, how?: "opened" | "updated"): "done" {
    const { task, work: repository } = scope;
    repository.pr = { number: pr.number, url: pr.url, state: pr.state, openedAt: repository.pr?.openedAt ?? Date.now() };
    // GitHub answered: an open pull request now explains why the copy stays. Its earlier warning stays in history.
    if (pr.state === "open" && repository.cleanup?.error === CLEANUP_WORDS.unconfirmed) delete repository.cleanup;
    delete repository.shipping;
    if (task.state === "cancelled") {
      this.k.log(scope, "status", `Pull request #${pr.number} went out while you cancelled it: ${pr.url}`);
    } else {
      if (how) this.k.log(scope, "done", how === "updated" ? `Updated PR #${pr.number}: ${repository.report?.summary ?? "The checked work was added"}. Delivered to ${repository.source!.destination.repo} · ${repository.source!.destination.branch}` : `Petrina opened pull request #${pr.number}, and checked it on GitHub`);
      if (!task.repositories) this.k.tracking.delivered(scope);
      endPetrinaStep(task, { outcome: how === "updated" ? `Updated pull request #${pr.number}` : how ? W.openedPr(pr.number) : W.alreadyOut(`pull request #${pr.number}`) }, Date.now());
      if (task.repositories) {  this.saveOutcome(); return "done"; }
      if (pr.state === "open") {
        delete task.agent;
        task.holdsSlot = false;
        task.state = "pr-open";
        task.column = "ready";
        task.statusLine = how === "updated" ? `Updated PR #${pr.number}. Merge it on GitHub when you are happy` : `Pull request #${pr.number} is open. Merge it on GitHub when you are happy`;
        syncRuntimeWait(task, id => this.k.taskDetails(id), Date.now());
      } else {
        this.finished(scope, pr.state === "merged" ? `Merged #${pr.number} on GitHub` : `Closed #${pr.number} without merging`);
      }
    }
    this.saveOutcome();
    return "done";
  }

  private async recordRelease(scope: RepositoryContext, release: { tag: string; url: string }, how?: "published"): Promise<"done"> {
    const { task, work: repository } = scope;
    const sha = repository.shipping?.prepared?.tested;
    if (sha) await this.rememberDelivery(scope, sha, repository.source?.destination.branch ?? this.k.repositoryOf(scope)?.defaultBranch ?? "main");
    repository.release = release;
    delete repository.shipping;
    if (task.state === "cancelled") this.k.log(scope, "status", `Release ${release.tag} went out while you cancelled it: ${release.url}`);
    else {
      if (how) this.k.log(scope, "done", `Petrina published release ${release.tag}, and checked it on GitHub`);
      if (!task.repositories) this.k.tracking.delivered(scope);
      endPetrinaStep(task, { outcome: how ? W.released(release.tag) : W.alreadyOut(`release ${release.tag}`) }, Date.now());
      this.finished(scope, `Released ${release.tag}`);
    }
    this.saveOutcome();
    return "done";
  }


  /**
   * A cancelled local move is recorded only after GitHub is asked. Seeing the commit on this computer
   * is not a completed push. An uncertain answer keeps the copy and does not claim the work was delivered.
   */
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

  private async recordLanded(scope: RepositoryContext, branch: string, sha: string, how?: "found" | "moved"): Promise<"done"> {
    const { task, work: repository } = scope;
    if (!repository.localUpdate || repository.localUpdate.pushed) await this.rememberDelivery(scope, sha, branch);
    repository.landed = { branch, sha: sha.slice(0, 7) };
    // A local move is not a push. `localUpdate.pushed` is set only after GitHub is shown to have the commit.
    delete repository.shipping;
    if (task.state === "cancelled") {
      this.k.log(scope, "status", repository.localUpdate && !repository.localUpdate.pushed
        ? `${branch} moved forward in the local copy while you cancelled it (${sha.slice(0, 7)}). Its push to GitHub did not finish.`
        : `${branch} moved forward to it while you cancelled it (${sha.slice(0, 7)})`);
    }
    else {
      if (!task.repositories) this.k.tracking.delivered(scope);
      if (how) this.k.log(scope, "done", how === "found" ? `Checked: ${branch} already has it (${sha.slice(0, 7)})` : `Petrina moved ${branch} forward to it (${sha.slice(0, 7)}), and checked the main copy`);
      endPetrinaStep(task, { outcome: how === "moved" ? W.movedMain(branch) : W.alreadyOut(`${branch} has it`) }, Date.now());
      this.finished(scope, `Committed to ${branch}`);
    }
    this.saveOutcome();
    return "done";
  }

  /** Preserve complete confirmed contents before shipping's preparation and working copy are removed. */
  private async rememberDelivery(scope: RepositoryContext, sha: string, branch: string): Promise<void> {
    const product = this.k.repositoryOf(scope);
    const path = scope.work.worktree ?? product?.path;
    if (!path || !product || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return;
    const tree = await git.run(["git", "rev-parse", "--verify", `${sha}^{tree}`], path, undefined, { timeoutMs: 1000 }).catch(() => undefined);
    if (tree?.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree.stdout)) scope.work.confirmedDelivery = { sha, tree: tree.stdout, branch, repo: product.repo, at: Date.now() };
  }

  /** The verified delivery stays completed even when saving fails: removing its copy may free the disk. */
  private saveOutcome(): void {
    try {
      this.k.commitNow();
    } catch {
      this.k.commit();
    }
  }

  private finished(scope: RepositoryContext, statusLine: string): void {
    const { task } = scope;
    if (task.repositories) { task.statusLine = statusLine;  return; }
    delete task.agent;
    task.holdsSlot = false;
    task.state = "done";
    task.column = "done";
    task.finishedAt = Date.now();
    task.statusLine = statusLine;
    syncRuntimeWait(task, id => this.k.taskDetails(id), Date.now());
    this.k.onTaskDone?.(task);
  }

  // ── From before this version ───────────────────────────────────────────

  /**
   * Deliveries a Petrina from before it published deliveries saved while its delivery agent published them with a GitHub login:
   * Petrina cannot tell what went out, so it never acts on one by itself, and asks the coordinator instead.
   */
  carryOverShipping(): void {
    for (const task of this.k.s.tasks) {
      const saved = executionFor(task).work.shipping as unknown as Record<string, unknown> | undefined;
      if (!saved || (typeof saved.moves === "number" && typeof saved.failures === "number")) continue;
      // Delivered already: nothing is left to decide.
      if (task.state === "done" || task.state === "pr-open") {
        delete executionFor(task).work.shipping;
        continue;
      }
      executionFor(task).work.shipping = { moves: 0, failures: 0, carriedOver: true };
      if (task.state === "cancelled") task.statusLine = `Cancelled. ${CARRIED_OVER}: check GitHub for what went out`;
      if (!["running", "waiting", "needs-you"].includes(task.state)) continue;
      // What the old version asked about this delivery goes: the coordinator's choice replaces it.
      this.k.s.inbox = this.k.s.inbox.filter((item) => item.taskId !== task.id);
      this.askCarriedOver(task);
    }
  }

  /**
   * A delivery from before the update: nothing happens, not even an update from GitHub, until the coordinator
   * checks GitHub and chooses: it went out (mark as done), or ship it again.
   */
  askCarriedOver(task: MTask): void {
    const scope = executionFor(task);
    delete task.agent;
    delete scope.work.conversation;
    task.holdsSlot = false;
    task.statusLine = `${CARRIED_OVER}: check GitHub, then choose`;
    if (!this.k.s.inbox.some((item) => item.taskId === task.id && item.kind === "shipping")) {
      // The step that was delivering ends as interrupted, and the task waits for the coordinator's choice.
      if (openStep(task)?.kind !== "you") endOpenStep(task, { outcome: W.interrupted, reason: W.shippingInterrupted, tone: "back" }, Date.now());
      beginYouStep(task, "shipping", Date.now());
      this.k.raise(task, "shipping", `Shipping “${task.title}” was interrupted`, false, {
        body: `${CARRIED_OVER}: check GitHub, then choose. Its delivery agent published deliveries itself then, so Petrina cannot tell what went out, and does nothing with it until you choose.`,
      });
      this.k.log(task, "warn", `${CARRIED_OVER}: check GitHub, then choose`);
    }
    task.state = "needs-you";
    this.k.commitNow();
  }

  // ── The coordinator's choices ──────────────────────────────────────────

  private takeShippingItem(itemId: Id): MTask | undefined {
    if (this.k.s.inbox.find((entry) => entry.id === itemId)?.kind !== "shipping") return undefined;
    const item = this.k.takeItem(itemId);
    return item && this.k.task(item.taskId);
  }

  /** "Check again": look for the interrupted delivery once more. */
  checkShipping(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    this.k.log(task, "you", "You asked Petrina to check again");
    endYouStep(task, { outcome: W.checkedAgain, reason: W.checkAgain }, Date.now());
    this.k.toWaiting(task);
    this.k.commit();
    this.k.schedule();
  }

  /**
   * "Ship it again": the delivery gets ready again, and Petrina publishes it after the same check as always. A
   * release whose push already went out keeps its version and commit. A delivery from before the update, which
   * the coordinator checked on GitHub, starts afresh from the delivery check, as the task sets it.
   */
  shipAgain(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    const scope = task ? executionFor(task) : undefined;
    if (!task) return;
    const shipping = scope!.work.shipping;
    if (shipping?.carriedOver) {
      delete scope!.work.shipping;
      this.clearApproval(scope!);
      const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
      if (check >= 0 && task.approveDelivery) {
        task.stageIndex = check;
        task.sub = 0;
      }
    } else if (shipping?.prepared && (shipping.localUpdated || scope!.work.source?.start.kind === "pull-request")) {
      // Keep the original tested commit until its publishing evidence is resolved.
    } else if (shipping && !shipping.pushed) {
      // What the work was stays, so an earlier version change can go before it gets ready again.
      scope!.work.shipping = { ...(shipping.start ? { start: shipping.start } : {}), moves: 0, failures: shipping.failures };
    }
    this.k.log(task, "you", "You asked to ship it again");
    endYouStep(task, { outcome: W.shippedAgain, reason: W.shipAgain }, Date.now());
    this.k.toWaiting(task);
    this.k.commitNow();
    this.k.schedule();
  }

  /** "Mark as done": it went out another way. */
  markDone(itemId: Id): void {
    const pending = this.k.s.inbox.find((item) => item.id === itemId);
    const shared = pending && this.k.task(pending.taskId);
    if (shared?.repositories && !shared.repositories.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) throw new Error("Check each unfinished delivery before marking this shared task as landed.");
    const task = this.takeShippingItem(itemId);
    const scope = task ? executionFor(task) : undefined;
    if (!task) return;
    if (task.repositories) {
      for (const work of task.repositories) if (work.pr?.state === "closed" && !work.landingAccepted) work.landingAccepted = { at: Date.now() };
      this.k.log(task, "you", "You resolved the closed pull requests. Open companion pull requests still need to land.");
      if (landingState(task.repositories) === "unfinished") { this.k.toWaiting(task); this.k.commitNow(); this.k.schedule(); }
      else this.finishMany(task);
      return;
    }
    if (!scope!.work.pr && (scope!.work.delivery === "pull-request" || scope!.work.shipping?.carriedOver)) {
      // An update's destination is the PR's working branch, not its base. Its existing approved-PR
      // path keeps the earlier cleanup rules; this extra attribution proof is for newly opened PRs.
      const tested = scope!.work.source?.start.kind === "pull-request" ? undefined : scope!.work.shipping?.prepared?.tested;
      const base = scope!.work.source?.destination.branch ?? this.k.repositoryOf(task)?.defaultBranch ?? "main";
      scope!.work.cleanup = { ...scope!.work.cleanup, pullRequest: "unconfirmed", ...(tested ? { checkedDelivery: { tested, base } } : {}) };
      if (!tested) delete scope!.work.cleanup.checkedDelivery;
    }
    if (!scope!.work.pr && !scope!.work.release && (!scope!.work.landed || scope!.work.localUpdate?.pushed === false)) scope!.work.cleanup = { ...scope!.work.cleanup, markedDone: true };
    delete scope!.work.shipping;
    this.k.clearStep(task);
    this.k.tracking.delivered(task);
    task.state = "done";
    task.column = "done";
    task.finishedAt = Date.now();
    task.statusLine = "Marked as done by you";
    this.k.log(task, "you", "You marked it as done");
    endYouStep(task, { outcome: W.markedDone, reason: W.youMarkedDone }, Date.now());
    this.k.onTaskDone?.(task);
    this.k.commitNow();
    this.k.schedule();
    void this.monitor.checkUnrecordedPullRequest(scope!);
    this.k.tidy(task.id);
  }
}
