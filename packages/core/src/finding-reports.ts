import type { Finding } from "./model.js";

/** Compact previews show unresolved work before settled history, without changing any report. */
export function outstandingReportsFirst<T extends Pick<Finding, "status" | "severity">>(reports: readonly T[]): T[] {
  const rank = (report: T) => report.status === "open" ? ({ blocking: 0, suggestion: 1, "pre-existing": 2 }[report.severity]) : report.status === "unverified" ? 3 : 4;
  return [...reports].sort((a, b) => rank(a) - rank(b));
}

/** Counts reports, not deduplicated bugs. Settled reports remain part of the total. */
export function findingReportCounts(findings: readonly Pick<Finding, "status" | "severity">[]) {
  const open = findings.filter((finding) => finding.status === "open");
  return {
    total: findings.length,
    open: {
      total: open.length,
      important: open.filter((finding) => finding.severity === "blocking").length,
      nits: open.filter((finding) => finding.severity === "suggestion").length,
      preExisting: open.filter((finding) => finding.severity === "pre-existing").length,
    },
    fixed: findings.filter((finding) => finding.status === "fixed").length,
    dismissed: findings.filter((finding) => finding.status === "dismissed").length,
    unverified: findings.filter((finding) => finding.status === "unverified").length,
  };
}
