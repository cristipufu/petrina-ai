import { BUILT_IN_ROLES, createTaskState, type DeepMutable, type Finding, type Stage } from "@petrina/core";
import { ReviewReports, type ReviewReport, type ReviewReportHost, type RuntimeTask } from "../../src/index.js";

/** Normalized output only: schema and provider-format behavior belongs to the native contracts. */
export const report = (extra: Partial<ReviewReport> = {}): ReviewReport => ({ verdict: "pass", findings: [], confirms: [], confirmationEvidence: {}, disputes: [], resolves: [], ...extra });

export function reviewReportFixture(shared = true) {
  const first = "first", second = "second";
  const task: RuntimeTask = createTaskState({ productId: first, title: "Keep review reports", backlog: true },
    [first, second].map(id => ({ id, name: id, repo: `local/${id}`, tone: "blue" })),
    { id: "task", timelineId: "created", now: 100, priority: 0 });
  if (shared) task.repositories = [first, second].map(productId => ({ productId, delivery: "local", completedStages: [] }));
  else task.repository = { productId: first, delivery: "local" };
  const stage = { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 } satisfies Stage;
  task.plan = { rationale: "Report recording", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] }, stage,
  ] }; task.stageIndex = 1;
  task.hunt = { stageId: stage.id, round: 1, reported: {}, findings: 0,
    input: { file: "opaque-input.json", digest: "saved-input", heads: { first: "first-head", ...(shared ? { second: "second-head" } : {}) } } };
  const roles = structuredClone([...BUILT_IN_ROLES]);
  const verdicts: { taskId: string; roleId: string; profileId: string; round: number; verdict: string; count: number; blocking: number }[] = [];
  const notes: { taskId: string; tone: string; text: string; roleId: string; profileId: string }[] = [];
  let pending = true, id = 0, now = 200;
  const host: ReviewReportHost = { roles: () => roles, hasPendingReviewers: () => pending, id: task => `${task.id}-finding-${++id}`, now: () => now,
    verdict: (task, roleId, profileId, round, verdict, count, blocking) => { verdicts.push({ taskId: task.id, roleId, profileId, round, verdict, count, blocking }); },
    note: (task, tone, text, roleId, profileId) => { notes.push({ taskId: task.id, tone, text, roleId, profileId }); } };
  const reports = new ReviewReports(host);
  const finding = (id: string, extra: Partial<DeepMutable<Finding>> = {}): DeepMutable<Finding> => {
    const value: DeepMutable<Finding> = { id, text: `Finding ${id}`, severity: "blocking", raisedBy: "earlier-reviewer", confirmedBy: [], status: "open", ...extra };
    task.findings.push(value); return value;
  };
  return { first, second, task, stage, roles, host, reports, finding, verdicts, notes,
    pending: (value: boolean) => { pending = value; }, advance: () => { now++; } };
}
