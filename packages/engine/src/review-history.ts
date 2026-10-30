import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openStep } from "@petrina/core";
export {
  settledReviewFindings,
  fullFollowUpCards,
  compactFindings,
  compactCards,
  historyGuidance,
  CARD_OPENING,
  type StoodThrough,
  type CompactReviewHistory
} from "./review-history-format.js";
import { CARD_OPENING, historyGuidance, type CompactReviewHistory } from "./review-history-format.js";
import { formatFindings } from "./prompts.js";
import type { ReviewInput } from "./review-context.js";
import { saveImmutable } from "./immutable-file.js";
import type { Section } from "./context.js";
import type { RepositoryContext } from "@petrina/orchestrator";

/** Only the already captured baseline is used to create the complete indexed copy. */
export async function freezeReviewHistory(folder: string, input: ReviewInput): Promise<void> {
  const findings = Object.fromEntries(input.findings.filter(finding => input.settled?.[finding.id]).map(finding => [
    finding.id,
    formatFindings(
    [finding],
    { complete: true }
  )
  ]));
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
  const body = await readFile(
    ref.file,
    "utf8"
  ).catch(() => { throw new Error("The frozen review history is unavailable. No newer evidence is substituted."); });
  if (createHash("sha256").update(body).digest("hex") !== ref.digest) throw new Error("The frozen review history changed. No newer evidence is substituted.");
  return body;
}

/** Run after native-context reduction: retain only history the supplied opening references. */
export async function supplyReviewHistory(scope: RepositoryContext, sections: readonly Section[], options: { continued?: boolean } = {}): Promise<{
  sections: Section[];
  retained?: true
}> {
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
  const { task } = scope;
  const hunt = task.hunt;
  const step = openStep(task);
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
