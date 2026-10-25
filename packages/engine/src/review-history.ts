import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Id } from "@petrina/core";
import { openStep, type StoodThrough } from "@petrina/core";
export { settledReviewFindings } from "@petrina/core";
export type { StoodThrough } from "@petrina/core";
import { FINDING_TAG, formatFindings } from "./prompts.js";
import type { ReviewInput } from "./review-context.js";
import { saveImmutable } from "./immutable-file.js";
import type { Section } from "./context.js";
import type { RepositoryContext } from "@petrina/orchestrator";

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

/** Only the already captured baseline is used to create the complete indexed copy. */
export async function freezeReviewHistory(folder: string, input: ReviewInput): Promise<void> {
  const findings = Object.fromEntries(input.findings.filter(finding => input.settled?.[finding.id]).map(finding => [finding.id, formatFindings([finding], { complete: true })]));
  const cards = Object.fromEntries(input.cards.filter(card => card.problem.length > CARD_OPENING).map(card => [card.id, card]));
  if (!Object.keys(findings).length && !Object.keys(cards).length) return;
  const body = JSON.stringify({ findings, cards }, null, 2);
  try {
    const saved = await saveImmutable(folder, "history.json", body, "The frozen review history changed.");
    input.history = { ...saved, findings: input.settled ?? {}, cards: Object.keys(cards) };
  } catch {
    // Optional shortening must never remove context when its copy cannot be frozen.
  }
}

export async function readReviewHistory(ref: Pick<CompactReviewHistory, "file" | "digest">): Promise<string> {
  const body = await readFile(ref.file, "utf8").catch(() => { throw new Error("The frozen review history is unavailable. No newer evidence is substituted."); });
  if (createHash("sha256").update(body).digest("hex") !== ref.digest) throw new Error("The frozen review history changed. No newer evidence is substituted.");
  return body;
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

/** Run after native-context reduction: retain only history the supplied opening references. */
export async function supplyReviewHistory(scope: RepositoryContext, sections: readonly Section[], options: { continued?: boolean } = {}): Promise<{ sections: Section[]; retained?: true }> {
  const reference = sections.find(section => section.reviewHistory)?.reviewHistory;
  if (!reference) return { sections: [...sections] };
  const complete = () => sections.map(section => {
    if (!section.reviewHistory) return section;
    const { reviewHistory: _reference, background, ...rest } = section;
    return { ...rest, body: background ?? section.body };
  });
  // Continued conversations keep their existing delta contract: a changed
  // card is resent complete, and an unchanged one is already omitted.
  if (options.continued) return { sections: complete() };
  const body = await readReviewHistory(reference);
  const { task } = scope, hunt = task.hunt, step = openStep(task);
  const retained = hunt?.input && task.journey?.some(entry => entry.stageId === hunt.stageId && entry.round === hunt.round && entry.reviewInput?.digest === hunt.input!.digest && entry.reviewHistory?.digest === reference.digest && entry.reviewHistory.roundId === hunt.id);
  let added = false;
  if (!retained) {
    if (!step?.reviewInput?.digest || step.reviewInput.digest !== hunt?.input?.digest || step.stageId !== hunt.stageId || step.round !== hunt.round) {
      // Without a durable round owner the complete entries must travel inline.
      return { sections: complete() };
    }
    if (step.reviewHistory) throw new Error("This journey step already retained different review history. Start this review again.");
    step.reviewHistory = { file: reference.file, digest: reference.digest, body, ...(hunt?.id ? { roundId: hunt.id } : {}) };
    added = true;
  }
  let guided = false;
  return { sections: sections.map(section => {
    if (!section.reviewHistory || guided) return section;
    guided = true;
    return { ...section, body: `${section.body}\n${historyGuidance(reference)}` };
  }), ...(added ? { retained: true } : {}) };
}
