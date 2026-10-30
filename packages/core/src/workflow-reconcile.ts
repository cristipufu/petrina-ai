// Finding baseline reconciliation and step result reference helpers for workflow events.
import { findingReportCounts } from "./finding-reports.js";
import type { Id } from "./model.js";
import type { FindingFacts, NodeFacts } from "./workflow-facts.js";

/** The events one task's changed facts produce, in causal order. `prev` undefined: the task is new. */
export interface FindingBaseline {
  findings: FindingFacts[];
  since: "node-start" | "engine-start";
  /** The Builder's claims this node examines. */
  claims: Id[];
}

/** Each accepted result on a step, by seat, with how many finding copies it left. */
export const resultRefs = (taskId: Id, node: NodeFacts) =>
  node.results.map((result) => ({
    taskId,
    nodeId: node.id,
    index: result.index,
    seat: result.seat,
    findingCopies: result.findingCopies ?? 0,
  }));

export interface Reconciliation {
  opening: number;
  closing: number;
  since: "node-start" | "engine-start";
  raised: Id[];
  fixed: Id[];
  claimedFixed: Id[];
  reopened: { id: Id; evidence: boolean }[];
  dismissed: Id[];
  unverified: Id[];
  /** Compatibility: open Important reports only, never all open reports. */
  stillOpen: Id[];
  stillOpenPopulation: "open-important";
  openImportant: Id[];
  openNits: Id[];
  openPreExisting: Id[];
  /**
   * Which of the open Important reports are shared acceptance failures whose automatic repairs are used up: they stay in
   * the task-wide counts and lists above, are held for the delivery decision, and were no work for this review.
   */
  heldForDecision?: Id[];
  reportCounts: { opening: ReturnType<typeof findingReportCounts>; closing: ReturnType<typeof findingReportCounts> };
  shortened?: true;
}

export function reconcile(baseline: FindingBaseline, closing: FindingFacts[]): Reconciliation {
  const opening = baseline.findings;
  const was = new Map(opening.map((finding) => [finding.id, finding]));
  const claims = new Set(baseline.claims);
  const raised = closing.filter((finding) => !was.has(finding.id)).map((finding) => finding.id);
  // Fixed: closed as fixed during the review, or a claim under test the review left standing. A reopened claim is open again.
  const fixed = closing
    .filter((finding) => finding.status === "fixed" && (was.get(finding.id)?.status !== "fixed" || claims.has(finding.id)))
    .map((finding) => finding.id);
  const claimedFixed = closing.filter((finding) => claims.has(finding.id)).map((finding) => finding.id);
  const reopened = closing
    .filter((finding) => finding.reopenedAt !== undefined && was.get(finding.id)?.reopenedAt !== finding.reopenedAt)
    .map((finding) => ({
      id: finding.id,
      evidence: finding.evidence,
    }));
  const dismissed = closing
    .filter((finding) => finding.status === "dismissed" && was.get(finding.id)?.status !== "dismissed")
    .map((finding) => finding.id);
  const unverified = closing
    .filter((finding) => finding.status === "unverified" && was.get(finding.id)?.status !== "unverified")
    .map((finding) => finding.id);
  const stillOpen = closing
    .filter((finding) => finding.status === "open" && finding.severity === "blocking")
    .map((finding) => finding.id);
  // Task-wide populations, as documented; the held acceptance failures among them are only named.
  const held = closing.filter((finding) => finding.held && finding.status === "open").map((finding) => finding.id);
  return {
    opening: opening.length,
    closing: closing.length,
    since: baseline.since,
    raised,
    fixed,
    claimedFixed,
    reopened,
    dismissed,
    unverified,
    stillOpen,
    stillOpenPopulation: "open-important",
    openImportant: stillOpen,
    openNits: closing
      .filter((finding) => finding.status === "open" && finding.severity === "suggestion")
      .map((finding) => finding.id),
    openPreExisting: closing
      .filter((finding) => finding.status === "open" && finding.severity === "pre-existing")
      .map((finding) => finding.id),
    ...(held.length ? { heldForDecision: held } : {}),
    reportCounts: { opening: findingReportCounts(opening), closing: findingReportCounts(closing) },
  };
}
