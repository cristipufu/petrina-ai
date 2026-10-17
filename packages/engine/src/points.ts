// Plain files at a repository's root that grow only with the coordinator's OK: the review guide (REVIEW.md),
// which reviewers check every change against, and AGENTS.md, which Claude Code and Codex load by themselves
// (its Learnings, and a pointer to the review guide). Petrina writes only to a plain file, never through a link.

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
export const AGENTS_FILE = "AGENTS.md";
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

/**
 * Lines added at the end of a section of AGENTS.md (a "## " heading), starting the section, after its intro,
 * when there is none, and the file when there is none. Replaces the file in one step.
 */
export function addToSection(root: string, heading: string, intro: string, lines: readonly string[]): void {
  const text = localPoints(root, AGENTS_FILE).replace(/\s*$/, "");
  const all = text ? text.split("\n") : [];
  const start = all.findIndex((line) => line.trim() === heading);
  let next: string[];
  if (start < 0) {
    next = [...(all.length ? [...all, ""] : []), heading, "", intro, ...(lines.length ? ["", ...lines] : [])];
  } else {
    // At the end of the section: before the next heading of the same or a higher level, or at the end of the file.
    let end = all.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
    if (end < 0) end = all.length;
    let last = end;
    while (last > start + 1 && all[last - 1]!.trim() === "") last -= 1;
    next = [...all.slice(0, last), ...lines, ...(end < all.length ? ["", ...all.slice(end)] : [])];
  }
  const path = join(root, AGENTS_FILE);
  const draft = `${path}.petrina-${process.pid}`;
  writeFileSync(draft, `${next.join("\n")}\n`, { flag: "wx" });
  renameSync(draft, path);
}

/** Words that say little about what a point is: left out when two points are compared. */
const FILLER = new Set("a an and are as at be by can do does for from has have in into is it its no not of on one or so such than that the their then there this to too was when which while will with without you your".split(" "));

/** A point's meaningful words, with common endings set aside ("installing" and "install" are one word). */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !FILLER.has(word))
      .map((word) => word.replace(/(ing|ed|es|s)$/, "")),
  );
}

/** Two points that say mostly the same, in other words: most of the shorter one's meaningful words are in the other. */
export function samePointRoughly(a: string, b: string): boolean {
  const one = words(a);
  const two = words(b);
  const [small, large] = one.size <= two.size ? [one, two] : [two, one];
  if (small.size < 4) return false;
  let shared = 0;
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / small.size >= 0.5;
}
