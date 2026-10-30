import { addedLessons, AGENTS_FILE, completeAll, hasPoint, withLearnings } from "@petrina/core";
import type { LearningMergeEffects, LearningMergeRecords, LearningMergeRequest, LearningMergeResult } from "./ports/learning-merge.js";

/** Keep only the exact approved additions; unavailable history always falls back to the ordinary conflict path. */
export async function keepApprovedLearnings(records: LearningMergeRecords | undefined, { taskId, fork, onto, merged, ref }: LearningMergeRequest, effects: LearningMergeEffects): Promise<LearningMergeResult | undefined> {
  if (!records || merged.conflicts.length !== 1 || merged.conflicts[0] !== AGENTS_FILE) return undefined;
  try {
    // Register every read even when an effect throws synchronously; no failed peer releases a still-running read.
    const [base, main, own] = await completeAll([fork, onto, ref].map((version) => {
      try { return effects.instructionsAt(version); } catch (error) { return Promise.reject(error); }
    }));
    if (!base || !main || !own || main.mode !== base.mode || own.mode !== base.mode) return undefined;
    // A version that does not read back as it is (not UTF-8) could not be kept exactly.
    if ([base, main, own].some((file) => file.text.includes("\uFFFD"))) return undefined;
    const theirs = addedLessons(base.text, main.text);
    const ours = addedLessons(base.text, own.text);
    if (!theirs?.length || !ours?.length) return undefined;
    // The starting point and main's history as the commits record them, whatever Git's commit index says.
    if ((await effects.objectMergeBase(ref, onto)) !== fork) return undefined;
    const versions = await effects.instructionVersionsBetween(fork, onto);
    // Read in one go after Git answers: the tidy-up turns a waiting lesson into a receipt in one step.
    const product = records.current();
    const receipts = [...(product.learningReceipts ?? [])];
    const accepted = [...(product.learnings ?? []), ...receipts];
    const wrote = (
      text: string,
      here: boolean
    ) => accepted.some((line) => line.text === text && line.writtenOn !== undefined && (line.writtenOn === taskId) === here);
    if (!theirs.every((text) => wrote(text, false)) || !ours.every((text) => wrote(text, true))) return undefined;
    const added: string[] = [];
    const present: string[] = [];
    for (const [index, text] of ours.entries()) {
      if (hasPoint(base.text, text) || ours.some((other, at) => at !== index && hasPoint(other, text))) return undefined;
      const same = theirs.filter((line) => hasPoint(line, text));
      if (same.some((line) => line !== text)) return undefined;
      if (same.length) present.push(text);
      // Nothing main removed comes back: a version of the file since the starting point had it.
      else if (versions.some((version) => hasPoint(version, text))) return undefined;
      else added.push(text);
    }
    // Or a receipt says main took it in, at a version latest main includes.
    const taken = new Set(receipts.filter((receipt) => added.some((text) => hasPoint(receipt.text, text))).map((receipt) => receipt.foundOn));
    for (const sha of taken) if (await effects.objectHistoryContains(onto, sha)) return undefined;
    const text = withLearnings(main.text, added);
    if (text !== withLearnings(base.text, [...theirs, ...added])) return undefined;
    return { tree: await effects.instructionsInTree(merged.tree, main.mode, text), added, present };
  } catch {
    return undefined;
  }
}

/** The exact recorded Update message, shared with portable policy/wording contracts. */
export function keptLearningsMessage(kept: LearningMergeResult, sourceName: string, commits: string): string {
  const added = kept.added.length ? `kept ${sourceName}'s and added this work's: ${kept.added.join("; ")}` : `kept ${sourceName}'s, which already has this work's`;
  const present = kept.present.length ? `${kept.added.length ? `; already on ${sourceName}, kept once` : ""}: ${kept.present.join("; ")}` : "";
  return `Brought up to date with ${sourceName} (${commits} there): ${sourceName} and this work only added approved learnings to ${AGENTS_FILE}, so Petrina ${added}${present}`;
}
