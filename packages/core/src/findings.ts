// Review findings in plain counts: every summary starts with a number, or says there is nothing to fix.

import type { Finding } from "./model.js";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "2 important, 1 nit", "Nothing to fix", with pre-existing problems counted as follow-ups. */
export function findingCount(findings: readonly Pick<Finding, "severity">[]): string {
  const count = (severity: Finding["severity"]) => findings.filter((finding) => finding.severity === severity).length;
  const important = count("blocking");
  const nits = count("suggestion");
  const older = count("pre-existing");
  const head = [important ? `${important} important` : "", nits ? plural(nits, "nit") : ""].filter(Boolean).join(", ") || "Nothing to fix";
  return older ? `${head} · ${plural(older, "follow-up")}` : head;
}
