import { openProofs, proofDecision, proofTestNeeded, refreshProofs, requiredUnverified, sameVersions } from "@petrina/core";
import { scopesFor, type RepositoryContext } from "./repository-context.js";
import type { DeliveryCheckpointPreparation } from "./ports/agent-workflow.js";
import type { DeliveryCheckpointHost, DeliveryCheckpointEffects } from "./ports/delivery-checkpoint.js";

/** Actual final verification/retest/decision orchestration; native observations remain host effects. */
export class DeliveryCheckpoint {
  constructor(private readonly host: DeliveryCheckpointHost, private readonly effects: DeliveryCheckpointEffects) {}

  async run(scope: RepositoryContext, signal: AbortSignal): Promise<DeliveryCheckpointPreparation> {
    const current = scope.task;
    if (this.host.admissionsClosed(current)) {
      current.state = "waiting";
      current.holdsSlot = false;
      delete current.agent;
      current.column = this.host.column(current);
      current.statusLine = this.host.admissionWait(current);
      this.host.checkpoint();
      return { kind: "stop" };
    }
    const checking = scopesFor(current);
    let sentBack = false;
    for (const scope of checking) {
      const work = scope.work;
      if (current.repositories) {
        current.activeProductId = work.productId;
        if (work.pr || work.release || work.landed) continue;
      }
      await this.effects.writeGuide(scope);
      await this.effects.writeLearnings(scope);
      // What the coordinator checks is the work as it would land: one commit on top of the latest main.
      if ((await this.effects.upToDate(scope, signal)) === "conflict") {
        sentBack = true;
        break;
      }
      // Right before the coordinator is asked to ship, the checks run again on what would ship.
      const checkResult = await this.effects.checksBeforeDelivery(scope, signal, async () => await this.effects.upToDate(scope, signal) !== "conflict");
      if (checkResult === "returned") {
        sentBack = true;
        break;
      }
      if (checkResult === "exhausted" || checkResult === "blocked") {
        this.host.blocked(current);
        return { kind: "stop" };
      }
      await this.effects.offerLearnings(scope);
      if (scope.work.delivery === "release" && current.repositories) {
        const releaseStage = current.plan!.stages.find((entry) => entry.kind === "do" && this.host.role(entry.roleId, current)?.result === "delivery")!;
        await this.effects.previewRelease(scope, releaseStage, signal);
      }
      const checkedHead = await this.effects.head(scope).catch(() => undefined);
      if (checkedHead) scope.work.checkedSha = checkedHead;
      else delete scope.work.checkedSha;
      if (current.repositories) work.nothingToPublish = scope.work.delivery !== "release" && checkedHead === scope.work.baseSha;
      const checkedPatch = checkedHead && checkedHead === scope.work.baseSha ? "empty" : await this.effects.patch(scope, checkedHead);
      if (checkedPatch) scope.work.checkedPatch = checkedPatch;
      else delete scope.work.checkedPatch;

    }
    if (sentBack) return { kind: "repeat" };
    const hasProofs = !!current.proofRequests?.length;
    const observed = hasProofs ? await this.effects.committedCode(current) : undefined;
    const versions = await this.effects.invalidateAcceptance(current, observed?.versions) ?? observed?.versions
      ?? (hasProofs || current.repositories ? await this.effects.versions(current) : undefined);
    if (versions) refreshProofs(current, versions);
    // The tester tried an earlier version of the change: the final code gets one more pass first.
    const tester = current.plan!.stages.findIndex((entry) => entry.kind === "do" && this.host.role(entry.roleId, current)?.result === "checks");
    const acceptanceFailed = current.acceptancePassed === false;
    const changes = observed?.changes;
    const mainOnly = hasProofs && sameVersions(current.testedChanges, changes) && !sameVersions(current.testedVersions, versions);
    const ordinaryRetest = current.testedPatch !== undefined && (acceptanceFailed || (await this.effects.acceptanceVersion(
      scope,
      versions
    )) !== current.testedPatch);
    const requestedRetest = hasProofs && proofTestNeeded(current, mainOnly);
    // One rule with or without requested proof: a reproduced failure keeps its final retest after repair, while
    // required acceptance that could not be verified is never tried again unchanged. Extra probes decide neither.
    const reproducedFailure = current.journey?.findLast(step => step.kind === "agent" && step.endedAt !== undefined && this.host.role(
      step.roleId!,
      current
    )?.result === "checks")?.acceptanceChecks?.some(check => check.result === "fail");
    const acceptanceExhausted = (acceptanceFailed && current.acceptanceBlocked) || (requiredUnverified(current) && !reproducedFailure && !requestedRetest);
    const bounded = hasProofs && mainOnly && (current.proofRefreshes ?? 0) >= 2;
    if (hasProofs) current.proofRefreshBlocked = bounded && (ordinaryRetest || openProofs(current).some(request => request.status === "stale"));
    if (tester >= 0 && !acceptanceExhausted && !bounded && (ordinaryRetest || requestedRetest)) {
      if (hasProofs) {
        delete current.proofRefreshBlocked;
        if (mainOnly) current.proofRefreshes = (current.proofRefreshes ?? 0) + 1;
        current.proofRetestReason = openProofs(current).some(request => request.status === "pending") ? "requested" : mainOnly ? "main-moved" : current.testedChanges && !sameVersions(
          current.testedChanges,
          changes
        ) ? "code-changed" : "requested";
      }
      current.retest = true;
      current.stageIndex = tester;
      current.sub = 0;
      this.host.note(
        current,
        "milestone",
        hasProofs ? current.proofRetestReason === "main-moved" ? "Final acceptance testing: main moved since the proof was recorded" : current.proofRetestReason === "code-changed" ? "Final acceptance testing: the task's code changed since acceptance testing" : "Final acceptance testing: a reviewer asked for proof on the final code" : "Trying the acceptance list once more on the final code"
      );
      this.host.checkpoint();
      return { kind: "repeat" };
    }
    if (hasProofs) current.checkedProofDecision = proofDecision(current, versions!);
    if (this.host.shipsUnasked(current)) {
      if (hasProofs) current.approvedProofDecision = structuredClone(current.checkedProofDecision);
      for (const { work } of scopesFor(current)) {
        work.approvedSha = work.checkedSha;
        work.approvedPatch = work.checkedPatch;
        work.approvedFor = { by: "task", mode: work.delivery, destination: this.host.destination({ task: current, work }) };
      }
      this.host.note(
        current,
        "milestone",
        current.proofDeliveryGate && !current.approveDelivery ? `${current.proofRequests?.length ? "Requested proof is current" : "Required acceptance is verified"} and checks passed: shipping without asking you, as this task's settings allow` : "Low risk, checks passed and nothing left to fix: shipping without asking you, as this product's settings allow"
      );
      current.stageIndex += 1;
      current.sub = 0;
      this.host.checkpoint();
      return { kind: "repeat" };
    }
    this.host.gate(current);
    return { kind: "stop" };
  }
}
