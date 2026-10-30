import { assignedProducts, endAgentStep, JOURNEY_WORDS, noteReproduction, openStep, refreshProofs, restorationReason, sameVersions } from "@petrina/core";
import type { RepositoryContext } from "./repository-context.js";
import type { AcceptanceRoutingInput } from "./ports/acceptance.js";
import type { AcceptanceResultHost, AcceptanceResultInput } from "./ports/acceptance-results.js";

/** Settle the accepted result on its observed versions, without performing native inspection or dispatch. */
export class AcceptanceResults {
  constructor(private readonly host: AcceptanceResultHost) {}

  async record(scope: RepositoryContext, input: AcceptanceResultInput): Promise<AcceptanceRoutingInput> {
    const { task } = scope;
    const { roleId, profileId: by, report: rawResult, run, testedVersions, currentVersions } = input;
    const staleRun = !!task.proofRequests?.length && !sameVersions(run.versions, currentVersions);
    // Saved by the step's cleanup before it undid commits or tracked edits anywhere in the task: every answer
    // from this run stays unverified, keeping any reason it was already unavailable. The agent's report is untouched.
    const restored = run.restored, invalid = restored && restorationReason(restored);
    const unavailable = <C extends { result: "pass" | "fail" | "blocked"; reason?: string | undefined }>(check: C): C => invalid
      ? { ...check, result: "blocked", reason: [invalid, check.result === "blocked" ? check.reason : undefined].filter(Boolean).join(" ") }
      : check;
    // Preserve observed failures and unavailable probes. Freshness belongs to each request's
    // affected products, independently of the outcome recorded on the run's starting versions.
    const answered = rawResult.proofAnswers.map(answer => answer.evidence?.trim() ? answer : { ...answer, result: "blocked" as const, reason: answer.reason?.trim() || "The agent did not record how it verified this request." });
    const proofAnswers = answered.map(unavailable);
    const proofChecks = answered.map(answer => ({ ...answer, proofRequestId: answer.id, text: task.proofRequests!.find(request => request.id === answer.id)!.text, productIds: [...task.proofRequests!.find(request => request.id === answer.id)!.productIds] }));
    const result = { ...rawResult, checks: [...rawResult.checks, ...proofChecks].map((check) => {
      const productIds = assignedProducts(task, "productIds" in check ? check.productIds : undefined);
      if (task.repositories && !productIds.length) return unavailable({ ...check, productIds: [], result: "blocked" as const, reason: "Together: no valid affected products were assigned. The coordinator must resolve ownership." });
      if (check.result !== "blocked" && !check.evidence) return unavailable({ ...check, productIds, result: "blocked" as const, reason: "The agent did not record how it verified this item." });
      return unavailable({ ...check, productIds });
    }) };
    const testerStep = openStep(task);
    if (testerStep?.kind === "agent" && testerStep.roleId === roleId) {
      const report = testerStep.agentResults?.findLast((entry) => entry.roleId === roleId && entry.profileId === by);
      if (report) report.versions = testedVersions;
      if (restored) testerStep.proofRun = structuredClone(run);
      testerStep.proofChecks = proofAnswers;
      testerStep.acceptanceChecks = result.checks.map((check) => ({ text: check.text, result: check.result, ...(check.evidence ? { evidence: check.evidence } : {}), ...("reason" in check && check.reason ? { reason: check.reason } : {}) }));
    }
    await this.host.noteLearnings(scope, result.learnings, roleId, by);
    if (task.brief) task.brief.acceptance = task.brief.acceptance.map((item) => {
      const check = result.checks.find((entry) => entry.text === item.text);
      if (!check) return item;
      return {
        ...item,
        // An invalidated run cannot reassign an item's products or versions.
        ...(task.repositories && !restored ? { productIds: check.productIds, versions: Object.fromEntries(check.productIds.map((id) => [id, testedVersions![id]!])) } : {}),
        met: check.result === "pass" ? true : check.result === "fail" ? false : undefined,
        verification: check.result === "pass" ? "passed" : check.result === "fail" ? "failed" : "blocked",
        ...(check.result === "blocked" && check.reason ? { reason: check.reason } : { reason: undefined }),
      };
    });
    const failed = result.checks.filter((check) => check.result === "fail");
    const blocked = result.checks.filter((check) => check.result === "blocked");
    // Required: the saved checklist and requested proof. An extra probe the Tester added stays an observation.
    const required = blocked.filter((check) => "proofRequestId" in check || task.brief?.acceptance.some((item) => item.text === check.text));
    // An invalidated run's reported failures stay in its history; earlier problems keep their own results.
    for (const check of restored ? [] : result.checks) {
      const proofRequestId = "proofRequestId" in check && typeof check.proofRequestId === "string" ? check.proofRequestId : undefined;
      const text = check.result === "blocked" ? `Could not verify acceptance check: ${check.text}` : `Failed acceptance check: ${check.text}`;
      const alternate = check.result === "blocked" ? `Failed acceptance check: ${check.text}` : `Could not verify acceptance check: ${check.text}`;
      const earlier = task.findings.find((finding) => proofRequestId ? finding.proofRequestId === proofRequestId : !finding.proofRequestId && (finding.text === text || finding.text === alternate));
      if (earlier) {
        earlier.text = text;
        if (task.repositories) earlier.productIds = check.productIds;
        earlier.status = check.result === "pass" ? "fixed" : check.result === "blocked" ? "unverified" : "open";
        if (check.result === "fail") noteReproduction(task, earlier, this.host.now());
        if (check.result === "blocked" && check.reason) earlier.evidence = check.reason;
        else if (check.result === "pass") delete earlier.evidence;
      } else if (check.result === "fail") task.findings.push({
        ...(proofRequestId ? { proofRequestId } : {}),
        ...(task.repositories ? { productIds: check.productIds } : {}),
        id: this.host.id(task), text,
        severity: "blocking", raisedBy: by, confirmedBy: [], status: "open",
      });
    }
    // Without checklist items or requested proof, an invalidated run is still unverified.
    const unverified = blocked.length > 0 || !!restored;
    const requiredGap = required.length > 0 || !!restored;
    this.host.note(scope, failed.length || unverified ? "warn" : "done", restored
      ? `Acceptance could not be verified: ${invalid}`
      : unverified
      ? `${blocked.length} acceptance check${blocked.length === 1 ? "" : "s"} could not be verified${failed.length ? `; ${failed.length} failed` : ""}`
      : failed.length ? `${failed.length} acceptance check${failed.length === 1 ? "" : "s"} failed` : staleRun ? "Acceptance passed on an earlier version; the final code still needs acceptance testing" : result.summary, roleId, by);
    endAgentStep(task, {
      outcome: restored && !blocked.length ? "Could not be verified" : unverified ? `${blocked.length} ${blocked.length === 1 ? "check" : "checks"} could not be verified${failed.length ? `; ${failed.length} failed` : ""}` : JOURNEY_WORDS.checks(failed.length, result.checks.length),
      reason: restored ? restored.products.length ? "Petrina undid changes during acceptance testing" : "Petrina could not confirm what its cleanup undid" : unverified ? "acceptance not fully verified" : failed.length ? JOURNEY_WORDS.checksFailed(failed.length) : staleRun ? "the code changed during acceptance testing; final acceptance is still pending" : JOURNEY_WORDS.checksPassed,
    }, this.host.now());
    for (const answer of proofAnswers) {
      const request = task.proofRequests!.find(request => request.id === answer.id)!;
      request.proof = { stepId: testerStep!.id, versions: { ...run.versions }, result: answer.result, ...(answer.evidence ? { evidence: answer.evidence } : {}), ...(answer.reason ? { reason: answer.reason } : {}) };
    }
    refreshProofs(task, currentVersions);
    task.testedChanges = { ...run.changes };
    delete task.acceptanceRun;
    delete task.proofRetestReason;
    delete task.repairCheck;
    const testedPatch = await this.host.acceptancePatch(scope, testedVersions);
    if (testerStep?.kind === "agent" && testerStep.roleId === roleId) testerStep.acceptancePatch = testedPatch;
    task.testedPatch = testedPatch ?? task.testedPatch;
    if (testedVersions) task.testedVersions = testedVersions;
    task.acceptancePassed = failed.length === 0 && !requiredGap && !staleRun;
    task.acceptanceUnverified = unverified;
    if (!requiredGap) delete task.acceptanceBlocked;

    return { failed: failed.length, requiredGap, requiredCount: required.length, restored: !!restored };
  }
}
