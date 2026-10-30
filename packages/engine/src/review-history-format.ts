import type { Id, StoodThrough } from "@petrina/core";
export { settledReviewFindings } from "@petrina/core";
export type { StoodThrough } from "@petrina/core";
import { FINDING_TAG, formatFindings } from "./prompts.js";
import type { ReviewInput } from "./review-context.js";

export const CARD_OPENING = 600;
export interface CompactReviewHistory {
  file: string;
  digest: string;
  findings: Readonly<Record<Id, StoodThrough>>;
  cards: readonly Id[];
}

export function fullFollowUpCards(cards: ReviewInput["cards"]): string {
  return `${cards.map(card => `- ${card.id}: ${card.title}\n  ${card.problem}`).join("\n")}\nIf this is the same bug as one of these cards, set "sameBug" to that card's id. If it is none of them, set "sameBug" to "none".`;
}

export function historyGuidance(history: CompactReviewHistory): string {
  return `Complete frozen entries indexed by finding or card id: ${JSON.stringify(history.file)} (reference ${history.digest}). Read the relevant entry when checking whether a problem is back, reusing its reproduction or earlier proof, or deciding whether a new report is the same problem. Before pointing a finding at a card, or choosing "none" when a card could describe the same bug, read that complete card. Earlier support is historical, not a verdict on current code. You can confirm or dispute any finding by id; reopening requires current proof. If the copy is missing or its identity does not match, report it unavailable; never substitute current findings or cards.`;
}

export function compactFindings(input: ReviewInput): string {
  const history = input.history!;
  return input.findings.map(finding => {
    const stood = history.findings[finding.id];
    if (!stood) return formatFindings([finding], { complete: true });
    return [
      `- [${finding.id}] ${FINDING_TAG[finding.severity]} (${finding.status}): ${finding.text}${finding.where ? ` at ${finding.where}` : ""}`,
      `  Products: ${finding.productIds?.join(", ") || "not assigned"}. Raised by: ${finding.raisedBy}${finding.roleId ? `, role ${finding.roleId}` : ""}.`,
      finding.sameBug ? `  Matching follow-up: ${finding.sameBug}` : "",
      finding.tracking ? `  Follow-up tracking: ${"taskId" in finding.tracking ? finding.tracking.taskId : finding.tracking.reason}` : "",
      `  The Builder's claim stood through round ${stood.round}, journey step ${stood.step}; this does not establish a verified fix on current code. Reopened before: ${finding.reopenedAt !== undefined ? `yes, at ${new Date(finding.reopenedAt).toISOString()}` : "no"}. Full entry: findings[${JSON.stringify(finding.id)}].`,
    ].filter(Boolean).join("\n");
  }).join("\n");
}

export function compactCards(input: ReviewInput): string {
  const history = input.history!;
  return `${input.cards.map(card => history.cards.includes(card.id)
    ? `- ${card.id}: ${card.title}\n  Products: ${card.productIds?.join(", ") || "not recorded"}.\n  ${card.problem.slice(0, CARD_OPENING)}\n  ${card.problem.length - CARD_OPENING} characters remain; full entry: cards[${JSON.stringify(card.id)}].`
    : `- ${card.id}: ${card.title}\n  ${card.problem}`).join("\n")}\nIf this is the same bug as one of these cards, set "sameBug" to that card's id. If it is none of them, set "sameBug" to "none".`;
}

