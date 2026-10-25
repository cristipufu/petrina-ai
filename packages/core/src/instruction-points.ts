// Text policy for coordinator-approved repository instructions. Native file and Git ownership stay in their adapters.
import type { GuideLine } from "./model.js";

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

/** Ignore presentation only. Keep case, paths, flags and every word of an instruction. */
function samePoint(text: string): string {
  return cleanPoint(text).replace(/^[-*+]\s+/, "").replace(/[.!]+$/, "");
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

/**
 * Where lines join a section of AGENTS.md (a "## " heading): the lines up to its last one that is not blank, and
 * what follows, before the next heading of the same or a higher level. Undefined when there is no such section.
 */
export function sectionEnd(text: string, heading: string): { before: string[]; after: string[] } | undefined {
  const trimmed = text.replace(/\s*$/, "");
  const all = trimmed ? trimmed.split("\n") : [];
  const start = all.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  // At the end of the section: before the next heading of the same or a higher level, or at the end of the file.
  let end = all.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  if (end < 0) end = all.length;
  let last = end;
  while (last > start + 1 && all[last - 1]!.trim() === "") last -= 1;
  return { before: all.slice(0, last), after: end < all.length ? ["", ...all.slice(end)] : [] };
}

/**
 * AGENTS.md's text with lines added at the end of a section, starting the section, after its intro, when there
 * is none, and the file when there is none.
 */
export function withSection(text: string, heading: string, intro: string, lines: readonly string[]): string {
  const at = sectionEnd(text, heading);
  if (at) return `${[...at.before, ...lines, ...at.after].join("\n")}\n`;
  const trimmed = text.replace(/\s*$/, "");
  const all = trimmed ? trimmed.split("\n") : [];
  return `${[...(all.length ? [...all, ""] : []), heading, "", intro, ...(lines.length ? ["", ...lines] : [])].join("\n")}\n`;
}

export const LEARNINGS_SECTION = "## Learnings";
export const LEARNINGS_INTRO = "What agents learned about working in this repository, added with the coordinator's OK.";

/** AGENTS.md's text as `addLearnings` leaves it. */
export function withLearnings(text: string, lessons: readonly string[]): string {
  return withSection(text, LEARNINGS_SECTION, LEARNINGS_INTRO, lessons.map((lesson) => `- ${cleanPoint(lesson)}`));
}

/**
 * The exact lessons Petrina's writer added at the end of `base`'s Learnings section to make `file`, in order:
 * writing them again gives `file` byte for byte. Undefined when `file` is anything else, or `base` has no
 * Learnings section yet.
 */
export function addedLessons(base: string, file: string): string[] | undefined {
  const at = sectionEnd(base, LEARNINGS_SECTION);
  if (!at || !file.endsWith("\n")) return undefined;
  const lines = file.slice(0, -1).split("\n");
  const middle = lines.slice(at.before.length, lines.length - at.after.length);
  if (lines.length < at.before.length + at.after.length || !middle.every((line) => line.startsWith("- "))) return undefined;
  const lessons = middle.map((line) => line.slice(2));
  return withLearnings(base, lessons) === file ? lessons : undefined;
}

/** The exact complete instructions offered in a learning Inbox item. */
export function offeredLessons(body: string | undefined): string[] {
  return (body ?? "").split("\n").map(line => cleanPoint(line.replace(/^- /, ""))).filter(Boolean);
}
