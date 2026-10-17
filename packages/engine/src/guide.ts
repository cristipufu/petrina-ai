// A product's review guide: REVIEW.md at the repository root, which reviewers check every change
// against, plus lines the coordinator accepted that have not reached the file yet.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuideLine } from "@petrina/core";

export const GUIDE_FILE = "REVIEW.md";
const GUIDE_KEPT = 8000;

export function readGuide(root: string): string {
  try {
    return readFileSync(join(root, GUIDE_FILE), "utf8");
  } catch {
    return "";
  }
}

/** The same point, however it is spaced, capitalised or bulleted. */
function samePoint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function inGuide(guide: string, line: string): boolean {
  const wanted = samePoint(line);
  return guide.split("\n").some((entry) => samePoint(entry) === wanted);
}

/** What reviewers read: the file, then the accepted lines it does not have yet. Empty when there is no guide. */
export function guideText(root: string, lines: readonly GuideLine[]): string {
  const file = readGuide(root).trim();
  const pending = lines.filter((line) => !inGuide(file, line.text)).map((line) => `- ${line.text}`);
  const kept = file.length > GUIDE_KEPT ? `${file.slice(0, GUIDE_KEPT)}\n…` : file;
  return [kept, pending.length ? `Accepted by the coordinator, not in ${GUIDE_FILE} yet:\n${pending.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

/** Add points to the end of the guide, starting the file when there is none. */
export function appendToGuide(root: string, lines: readonly string[]): void {
  const current = readGuide(root);
  const head = current ? (current.endsWith("\n") ? current : `${current}\n`) : "# Review guide\n\nReviewers check every change against these points.\n\n";
  writeFileSync(join(root, GUIDE_FILE), `${head}${lines.map((line) => `- ${line}`).join("\n")}\n`);
}
