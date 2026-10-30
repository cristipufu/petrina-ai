// Review findings in plain counts: every summary starts with a number, or says there is nothing to fix.

import type { Finding, FindingKind } from "./model.js";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Canonical origin of a finding. Prefers the saved `kind` discriminator and falls back to
 * legacy text prefixes only when reading older saved records that predate `Finding.kind`.
 */
export function findingKind(
  finding: Pick<Finding, "text"> & { kind?: FindingKind; raisedBy?: string },
): FindingKind {
  if (finding.kind) return finding.kind;
  if (finding.text.startsWith("Failed acceptance check:")) return "acceptance-failed";
  if (finding.text.startsWith("Could not verify acceptance check:")) return "acceptance-unverified";
  if (finding.raisedBy === "petrina") {
    if (finding.text.startsWith("Check failed")) return "product-check";
    if (finding.text.startsWith("Getting the delivery ready failed,")) return "delivery";
    return "tamper";
  }
  return "review";
}

/** "2 important, 1 nit", "Nothing to fix", with pre-existing problems counted as follow-ups. */
export function findingCount(findings: readonly Pick<Finding, "severity">[]): string {
  const count = (severity: Finding["severity"]) => findings.filter((finding) => finding.severity === severity).length;
  const important = count("blocking");
  const nits = count("suggestion");
  const older = count("pre-existing");
  const head = [important ? `${important} important` : "", nits ? plural(nits, "nit") : ""].filter(Boolean).join(", ") || "Nothing to fix";
  return older ? `${head} · ${plural(older, "follow-up")}` : head;
}
