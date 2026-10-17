// Plain files of one-line points at a repository's root, which grow only with the coordinator's OK: the review
// guide (REVIEW.md), which reviewers check every change against, and the learnings in AGENTS.md.
//
// Reviewers read the guide as it is on the base branch, never from the change: a branch cannot soften the
// rules it is judged by. Petrina writes only to a plain file, never through a link.

import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuideLine } from "@petrina/core";

export interface PointsFile {
  name: string;
  /** How a new file starts. */
  heading: string;
}

export const GUIDE: PointsFile = { name: "REVIEW.md", heading: "# Review guide\n\nReviewers check every change against these points.\n\n" };
export const GUIDE_FILE = GUIDE.name;
const KEPT = 8000;

/** One point on one line: no line breaks or control characters, whatever the agent wrote. */
export function cleanPoint(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The same point, however it is spaced, capitalised or bulleted. */
function samePoint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function hasPoint(text: string, line: string): boolean {
  const wanted = samePoint(line);
  return text.split("\n").some((entry) => samePoint(entry) === wanted);
}

/** What agents read: the file from the base branch, then accepted points it does not have yet. Empty when there is none. */
export function pointsText(file: PointsFile, base: string, lines: readonly GuideLine[]): string {
  const text = base.trim();
  const pending = lines.filter((line) => !hasPoint(text, line.text)).map((line) => `- ${line.text}`);
  const kept = text.length > KEPT ? `${text.slice(0, KEPT)}\n…` : text;
  return [kept, pending.length ? `Accepted by the coordinator, not in ${file.name} yet:\n${pending.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

/** The working copy's file when it is a plain file; "" when there is none. Anything else (a link) is refused. */
export function localPoints(root: string, name: string): string {
  const path = join(root, name);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return "";
  }
  if (!stat.isFile()) throw new Error(`${name} is not a plain file, so Petrina leaves it alone`);
  return readFileSync(path, "utf8");
}

/** Add points to the end of a points file, starting it when there is none. Replaces the file in one step. */
export function appendPoints(root: string, file: PointsFile, points: readonly string[]): void {
  const current = localPoints(root, file.name);
  const head = current ? (current.endsWith("\n") ? current : `${current}\n`) : file.heading;
  const path = join(root, file.name);
  const draft = `${path}.petrina-${process.pid}`;
  writeFileSync(draft, `${head}${points.map((point) => `- ${cleanPoint(point)}`).join("\n")}\n`, { flag: "wx" });
  renameSync(draft, path);
}
