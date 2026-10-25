// Plain files at a repository's root that grow only with the coordinator's OK: the review guide (REVIEW.md),
// which reviewers check every change against, and AGENTS.md, which Claude Code and Codex load by themselves
// (its Learnings, and a pointer to the review guide). Petrina writes only to a plain file, never through a link.

import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_FILE, cleanPoint, withSection, type PointsFile } from "@petrina/core";

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

/** Lines added at the end of a section of AGENTS.md, as `withSection` writes them. Replaces the file in one step. */
export function addToSection(root: string, heading: string, intro: string, lines: readonly string[]): void {
  const next = withSection(localPoints(root, AGENTS_FILE), heading, intro, lines);
  const path = join(root, AGENTS_FILE);
  const draft = `${path}.petrina-${process.pid}`;
  writeFileSync(draft, next, { flag: "wx" });
  renameSync(draft, path);
}
