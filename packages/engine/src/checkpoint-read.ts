// A decision projection of existing task and journey evidence. No new evidence or gate state is saved.
import { assignedProducts, evidenceFor, findingReportCounts, originalCheck, outstandingReportsFirst, resultSeatOf, reviewDecisionPending, roleForTask, taskProductIds, type InboxItem, type Task } from "@petrina/core";
import type { Engine } from "./engine.js";
import { checkCommandOutcome, readCheckLog, SAVED_RESULT_PREVIEW, unreportedCheckExit } from "./check-log-read.js";
import { fingerprint } from "./evidence-read.js";
import { checkpointAcceptance } from "./checkpoint-acceptance.js";

export async function checkpointView(engine: Engine, task: Task, request: InboxItem) {
  const taskId = task.id;
  const read = (section: string) => ({ operation: "task.read", taskId, section });
  const works = task.repositories ?? [task];
  const products = await Promise.all(works.map(async (work) => {
    const saved = work.checks;
    const checks = saved && await Promise.all(evidenceFor(task, work).map(async (check, index) => {
      const run = check.run;
      const skippedSource = !run ? check.source : undefined;
      const skippedNode = skippedSource ? task.journey?.find((step) => step.id === skippedSource.stepId) : undefined;
      const skippedChecks = skippedSource ? skippedNode?.productChecks?.filter((entry) => entry.id === skippedSource.checkId && entry.attemptId === skippedSource.attemptId) : undefined;
      const skippedCheck = skippedChecks?.length === 1 ? skippedChecks[0] : undefined;
      const original = run ? originalCheck(task, run) : skippedNode && skippedCheck ? { stepId: skippedNode.id, check: skippedCheck } : undefined;
      const node = original && task.journey?.find((step) => step.id === original.stepId);
      const originalRead = node && { taskId, nodeId: node.id, index: node.productChecks!.indexOf(original!.check) };
      // Pin a legacy latest-run read to its exact saved contents. It is never an invented historical link.
      const savedRun = saved.results[index];
      const savedRead = savedRun && { taskId, productId: work.productId, index, ifRevision: fingerprint(savedRun) };
      const ref = original?.check.run ? originalRead : savedRead;
      const diagnostics = run && ref && await readCheckLog(engine.dataDir, task, { ...ref, limit: SAVED_RESULT_PREVIEW, preview: "ends" });
      const failure = run && (!run.ok || run.interruption || run.interrupted || run.timedOut || run.cleanupIncomplete);
      const attemptId = run?.source?.attemptId ?? check.attemptId;
      const attempt = node?.checkAttempts?.find((entry) => entry.id === attemptId && entry.productId === work.productId);
      const reuse = node?.reuses?.findLast((entry) => entry.productId === work.productId && (!entry.attemptId || entry.attemptId === attemptId));
      return {
        name: check.name, result: check.result,
        commandOutcome: run ? checkCommandOutcome(run) : "not-executed",
        ...(attemptId ? { attemptId } : {}),
        ...(attempt && (attempt.sha !== saved.sha || attempt.tree !== saved.tree || attempt.definition !== saved.definition) ? { versions: { sha: attempt.sha, tree: attempt.tree, definition: attempt.definition } } : {}),
        ...(run ? { startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null, durationMs: run.ms } : {}),
        ...(run?.interruption ? { interruption: run.interruption } : {}),
        ...(run?.timedOut ? { timedOut: true } : {}),
        ...(run?.interrupted ? { interrupted: true } : {}),
        ...(run?.cleanupIncomplete ? { cleanupIncomplete: true } : {}),
        ...(run && unreportedCheckExit(run) ? { exitUnreported: true } : {}),
        ...(check.reusedAt !== undefined ? { reusedAt: check.reusedAt } : {}),
        ...(reuse ? { reuse: { at: reuse.at, originalAt: reuse.originalAt, purpose: reuse.purpose, basis: reuse.basis }, reuseHistory: { operation: "journey.node", taskId, nodeId: node!.id } } : {}),
        original: originalRead ?? null,
        ...(!originalRead ? { originalUnavailable: "No unique original journey check was recorded or retained." } : run && !original?.check.run ? { originalUnavailable: "The original check entry has no retained run. Diagnostics use this exact saved result." } : {}),
        diagnostics: diagnostics ? {
          completeness: diagnostics.completeness,
          recordedComplete: run?.logComplete ?? null,
          ...(run?.logError ? { logError: run.logError } : {}),
          ...(diagnostics.message ? { message: diagnostics.message } : {}),
          omitted: failure ? "Complete process output and saved result" : "Successful process output and saved result",
          read: { operation: "journey.check", ...ref },
          ...(failure ? { savedResult: diagnostics.savedResult, ...(diagnostics.savedResultEnding ? { savedResultEnding: diagnostics.savedResultEnding } : {}), savedResultRead: { operation: "journey.check", ...ref, section: "result" } } : {}),
          ...(failure && !(diagnostics.savedResult as { text?: string } | undefined)?.text ? { processExcerpt: diagnostics.text, processExcerptOffset: diagnostics.offset, processOmittedBefore: diagnostics.omittedBefore ?? 0 } : {}),
        } : { completeness: "not-executed", message: "Skipped or unexecuted check; no command diagnostics exist.", ...(node ? { read: { operation: "journey.node", taskId, nodeId: node.id } } : {}), ...(check.detail ? { explanation: check.detail } : {}) },
      };
    }));
    return {
      id: work.productId,
      name: work.source?.product.name ?? engine.s.products.find((product) => product.id === work.productId)?.name ?? work.productId,
      delivery: work.delivery, source: work.source ?? null, choice: work.workChoice ?? null,
      checkedSha: work.checkedSha ?? null, checkedPatch: work.checkedPatch ?? null,
      checks: saved ? {
        recordedAt: saved.at,
        versions: { sha: saved.sha ?? null, tree: saved.tree ?? null, definition: saved.definition ?? null },
        binding: "Results use these recorded versions unless an entry records different versions.",
        freshness: saved.current === false ? "stale" : saved.current === true && (saved.sha || saved.tree) && saved.definition ? "recorded-current" : "unverified",
        state: saved.results.length ? "recorded" : "none-configured",
        results: checks,
      } : { state: "unavailable", message: "No saved check run. This does not mean nothing was configured." },
    };
  }));
  const reviewNodes = (task.journey ?? []).filter((node) => {
    const result = node.roleId && roleForTask(engine.s.roles, node.roleId, task)?.result;
    return node.kind === "agent" && (result === "findings" || result === "votes");
  });
  const supportingReview = reviewNodes.at(-1);
  return {
    request,
    task: { id: taskId, title: task.title, productIds: taskProductIds(task), request: { omitted: "Full task request", read: read("request") } },
    ...(request.kind === "plan" ? {
      plan: task.plan ?? null,
      scope: { selectedProducts: task.selectedProducts, proposed: task.workProposal, rows: task.workRows, proposedSource: task.proposedSource, error: task.workError, validating: task.workValidating, confirmWork: task.confirmWork, approvalExplanation: task.approvalExplanation },
    } : { plan: task.plan ? { omitted: "Plan stages and assigned profiles", read: { operation: "plan.inspect", taskId } } : { unavailable: "No plan recorded." } }),
    products,
    ...(request.kind === "delivery" ? {
      approvalMeaning: reviewDecisionPending(task) ? "Accept unresolved review and continue to final verification. This does not approve delivery." : "Delivery approval remains subject to the existing checks, acceptance and publishing gates.",
      reviewDecision: task.reviewDecision ?? null,
      proofRequests: task.proofRequests ?? [],
      proofRefreshes: task.proofRefreshes ?? 0,
      proofRefreshBlocked: task.proofRefreshBlocked ?? false,
      proofDecision: task.checkedProofDecision ?? null,
      acceptance: checkpointAcceptance(task, engine.s.roles),
      design: task.brief || task.objections.length || task.call ? { omitted: "Design brief, objections, responses and coordinator call", read: read("design") } : { unavailable: "No design recorded." },
    } : { brief: task.brief, objections: task.objections, call: task.call, designRead: read("design") }),
    findings: {
      counts: findingReportCounts(task.findings),
      reports: outstandingReportsFirst(task.findings).map((finding) => ({ id: finding.id, text: finding.text.slice(0, 160), shortened: finding.text.length > 160, severity: finding.severity, status: finding.status, productIds: assignedProducts(task, finding.productIds), ...(finding.tracking ? { tracking: finding.tracking } : {}), omitted: "Full report, evidence, answers and verification", read: { ...read("findings"), findingId: finding.id } })),
    },
    supportingReview: supportingReview ? {
      nodeId: supportingReview.id, endedAt: supportingReview.endedAt ?? null,
      read: { operation: "journey.node", taskId, nodeId: supportingReview.id },
      ...(supportingReview.reviewInput ? { input: { operation: "journey.review-input", taskId, nodeId: supportingReview.id } } : { inputUnavailable: "No saved review input reference." }),
      results: (supportingReview.agentResults ?? []).map((result, index) => ({ operation: "journey.result", taskId, nodeId: supportingReview.id, index, seat: resultSeatOf(supportingReview, result, engine.s.roles, task) })),
      exactInputs: { omitted: "Participant instructions and later updates", read: { operation: "journey.input", taskId, nodeId: supportingReview.id } },
    } : null,
  };
}
