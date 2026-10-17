// A product's review guide: REVIEW.md at the repository root, which reviewers check every change
// against, plus points the coordinator accepted that have not reached the file yet.
//
// Reviewers read the guide as it is on the base branch, never from the change they review: a branch
// cannot soften the rules it is judged by. Petrina writes only to a plain file, never through a link.

import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuideLine } from "@petrina/core";

export const GUIDE_FILE = "REVIEW.md";
const GUIDE_KEPT = 8000;

/** One point on one line: no line breaks or control characters, whatever the agent wrote. */
export function cleanPoint(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The same point, however it is spaced, capitalised or bulleted. */
function samePoint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function inGuide(guide: string, line: string): boolean {
  const wanted = samePoint(line);
  return guide.split("\n").some((entry) => samePoint(entry) === wanted);
}

/** What reviewers read: the guide from the base branch, then accepted points it does not have yet. Empty when there is none. */
export function guideText(base: string, lines: readonly GuideLine[]): string {
  const file = base.trim();
  const pending = lines.filter((line) => !inGuide(file, line.text)).map((line) => `- ${line.text}`);
  const kept = file.length > GUIDE_KEPT ? `${file.slice(0, GUIDE_KEPT)}\n…` : file;
  return [kept, pending.length ? `Accepted by the coordinator, not in ${GUIDE_FILE} yet:\n${pending.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

/** The working copy's guide when it is a plain file; "" when there is none. Anything else (a link) is refused. */
export function localGuide(root: string): string {
  const path = join(root, GUIDE_FILE);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return "";
  }
  if (!stat.isFile()) throw new Error(`${GUIDE_FILE} is not a plain file, so Petrina leaves it alone`);
  return readFileSync(path, "utf8");
}

/** Add points to the end of the guide, starting the file when there is none. Replaces the file in one step. */
export function appendToGuide(root: string, lines: readonly string[]): void {
  const current = localGuide(root);
  const head = current ? (current.endsWith("\n") ? current : `${current}\n`) : "# Review guide\n\nReviewers check every change against these points.\n\n";
  const path = join(root, GUIDE_FILE);
  const draft = `${path}.petrina-${process.pid}`;
  writeFileSync(draft, `${head}${lines.map((line) => `- ${cleanPoint(line)}`).join("\n")}\n`, { flag: "wx" });
  renameSync(draft, path);
}
