import type { DeepMutable } from "./flow.js";
import type { Finding, Id, Task } from "./model.js";
import { recordStepResult } from "./journey.js";

/** Apply an accepted Builder's answers to the exact finding references supplied before its turn. */
export function recordBuilderFindingAnswers(
  task: DeepMutable<Pick<Task, "fixing" | "journey">>,
  given: readonly DeepMutable<Finding>[],
  answers: readonly { id: Id; fixed: boolean; text: string }[],
  owner: { productId: Id; shared: boolean; at: number },
): number {
  let fixed = 0;
  for (const answer of answers) {
    const finding = given.find((entry) => entry.id === answer.id && entry.status === "open");
    if (!finding) continue;
    finding.answer = { fixed: answer.fixed, text: answer.text, at: owner.at };
    if (owner.shared) {
      finding.answers = { ...finding.answers, [owner.productId]: finding.answer };
      // Shared work stays open until every owner has answered, then combined review verifies it.
      if (answer.fixed && finding.raisedBy !== "petrina" && finding.productIds?.length === 1) finding.status = "fixed";
      // A failed check stays open whatever the builder says: only a passing run on the new code settles it.
    } else if (answer.fixed && !(finding.raisedBy === "petrina" && finding.text.startsWith("Check failed"))) finding.status = "fixed";
    if (answer.fixed) fixed += 1;
  }
  task.fixing = false;
  recordStepResult(task, { findings: given });
  return fixed;
}

/** Normalized references to findings supplied in the participant's saved review input. */
export interface ReviewEvidenceInput {
  confirms: readonly Id[];
  confirmationEvidence: Readonly<Record<Id, string>>;
  disputes: readonly { id: Id; reason: string }[];
  resolves: readonly { id: Id; evidence: string }[];
}

/**
 * Keep each dispute with who and why. Status is settled after every reviewer reports, so an objection
 * arriving before a confirmation cannot hide a problem from the rest of the round.
 */
export function recordDisputes(findings: DeepMutable<Finding>[], disputes: readonly { id: string; reason: string }[], by: Id, at: number): void {
  for (const dispute of disputes) {
    const finding = findings.find((entry) => entry.id === dispute.id);
    if (!finding || finding.status !== "open") continue;
    finding.disputes = [...(finding.disputes ?? []), { by, reason: dispute.reason, at }];
  }
}

export function closedFinding(finding: Finding): boolean {
  return finding.status === "fixed" || finding.status === "dismissed";
}

function needsCurrentEvidence(finding: Finding): boolean {
  return finding.raisedBy !== "petrina" && (closedFinding(finding) || finding.reopenedAt !== undefined || finding.answer?.fixed === true);
}

/**
 * Closed findings, and open ones the coordinator chose to continue with, are judged again only from current reproductions,
 * never unexplained old ids.
 */
export function checkReviewEvidence(findings: readonly Finding[], result: ReviewEvidenceInput, task?: Pick<Task, "reviewDecision">): string | undefined {
  const unknown = [...result.confirms, ...result.disputes.map((entry) => entry.id), ...result.resolves.map(entry => entry.id)].filter((id) => !findings.some((finding) => finding.id === id));
  if (unknown.length) return `Confirm or dispute only finding ids provided in your saved review input. These ids were not shown: ${[...new Set(unknown)].join(", ")}. Report a new problem as a new finding instead.`;
  const invalid = result.resolves.filter(entry => !findings.some(finding => finding.id === entry.id && finding.severity === "pre-existing" && finding.raisedBy !== "petrina") || result.confirms.includes(entry.id) || result.disputes.some(dispute => dispute.id === entry.id));
  if (invalid.length) return `Use "resolves" only for a supplied pre-existing bug you proved was repaired in current code, without also confirming or disputing that id: ${invalid.map(entry => entry.id).join(", ")}. Include the original reproduction, current observed result and nearby controls in the evidence.`;
  const continued = new Set(task?.reviewDecision?.accepted ? task.reviewDecision.covers ?? [] : []);
  const missing = new Set(result.confirms.filter((id) => {
    const finding = findings.find((entry) => entry.id === id);
    return finding && (needsCurrentEvidence(finding) || (finding.raisedBy !== "petrina" && continued.has(id))) && !result.confirmationEvidence[id]?.trim();
  }));
  return missing.size ? `Current evidence is required to reopen or support a previously closed finding, or one the coordinator chose to continue with while it stays open. For ${[...missing].join(", ")}, return "confirms": [{"id": "<finding id>", "evidence": "<exact current failing case, expected and observed result>"}]. Include a nearby passing control when it distinguishes the regression. If there is no current failing case, omit the confirmation. The old report alone is not current evidence.` : undefined;
}

/** Preserve independent current reproductions when more than one reviewer supplies evidence. */
export function addEvidence(finding: DeepMutable<Finding>, evidence: string | undefined): void {
  const current = evidence?.trim();
  const previous = finding.evidence?.trim();
  // Match a complete block, including multi-paragraph proofs, rather than shared words within one.
  if (!current || finding.raisedBy === "petrina" || (previous && `\n\n${previous}\n\n`.includes(`\n\n${current}\n\n`))) return;
  finding.evidence = previous ? `${previous}\n\n${current}` : current;
}

/** A new reproduction reopens the same finding; its earlier support and dismissal remain history. */
export function reopenFinding(finding: DeepMutable<Finding>, at: number, evidence?: string): void {
  finding.earlierReviews = [...(finding.earlierReviews ?? []), {
    at,
    ...(finding.evidence ? { evidence: finding.evidence } : {}),
    confirmedBy: finding.confirmedBy,
    ...(finding.disputes ? { disputes: finding.disputes } : {}),
    ...(finding.verification ? { verification: finding.verification } : {}),
    ...(finding.votes ? { votes: finding.votes } : {}),
    ...(finding.unresolved ? { unresolved: finding.unresolved } : {}),
    ...(finding.answer ? { answer: finding.answer } : {}),
    ...(finding.resolution ? { resolution: finding.resolution } : {}),
  }];
  finding.confirmedBy = [];
  delete finding.disputes;
  delete finding.verification;
  delete finding.votes;
  delete finding.unresolved;
  delete finding.resolution;
  finding.status = "open";
  finding.reopenedAt = at;
  if (evidence !== undefined) finding.evidence = evidence.trim();
}
