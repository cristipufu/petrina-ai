import type { Finding, Id, Role, Task } from "./model.js";
import { reviewRoundSteps } from "./workflow-events.js";

export interface StoodThrough { round: number; step: Id }

// A label is never proof. Require a dated claim and the engine's saved, completed
// examination of that very claim. Unknown legacy evidence stays fully inline.
function claimTime(finding: Finding): number | undefined {
  const claims = finding.productIds?.length && finding.productIds.length > 1
    ? finding.productIds.map(id => finding.answers?.[id]) : [finding.answer];
  if (!claims.length || claims.some(claim => !claim?.fixed || !Number.isFinite(claim.at))) return;
  return Math.max(...claims.map(claim => claim!.at));
}

export function settledReviewFindings(task: Pick<Task, "journey" | "maintenance" | "findings">, roles: readonly Role[]): Record<Id, StoodThrough> {
  const settled: Record<Id, StoodThrough> = {};
  for (const finding of task.findings) {
    if (finding.raisedBy === "petrina" || finding.status !== "fixed" || finding.severity === "pre-existing" || roles.find(role => role.id === finding.roleId)?.result !== "findings") continue;
    const at = claimTime(finding);
    if (at === undefined || (finding.reopenedAt !== undefined && at <= finding.reopenedAt)) continue;
    for (const step of [...(task.journey ?? [])].reverse()) {
      if (step.kind !== "agent" || roles.find(role => role.id === step.roleId)?.result !== "findings" || step.endedAt === undefined || !step.result?.findingsSettled || !step.result.findingChanges?.claimedFixed?.includes(finding.id)) continue;
      const start = reviewRoundSteps(task, step.id, roles)[0]?.startedAt;
      const saved = step.result.findings?.find(entry => entry.id === finding.id);
      if (start === undefined || start <= at || step.endedAt < start || (finding.reopenedAt !== undefined && finding.reopenedAt >= start) || saved?.status !== "fixed" || claimTime(saved) !== at || saved.reopenedAt !== finding.reopenedAt) continue;
      settled[finding.id] = { round: step.round, step: step.id };
      break;
    }
  }
  return settled;
}
