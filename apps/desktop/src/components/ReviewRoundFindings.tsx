import { ChevronRight } from "lucide-react";
import type { ReviewRoundGroups } from "../reviewRound";
import type { Lookup } from "../lib";
import { FindingItem } from "./sheet/ReviewTab";

export function ReviewRoundFindings({ groups, find, onOpen }: { groups: ReviewRoundGroups; find: Lookup; onOpen?: (taskId: string) => void }) {
  const sections = [
    { key: "reopened", title: "Reopened", note: "Earlier findings with fresh evidence that a problem remains.", findings: groups.reopened },
    { key: "fresh", title: "New", note: "Findings first raised in this round.", findings: groups.fresh },
    { key: "still-open", title: "Still open", note: "Earlier findings that remain open in this round.", findings: groups.stillOpen },
    { key: "fixed", title: "Fixed", note: "Reviewers left these earlier fixes closed in this round.", findings: groups.fixed },
    { key: "dismissed", title: "Not a bug", note: "Findings dismissed in this round.", findings: groups.dismissed },
  ];
  return <section className="journey-context journey-review" aria-label="Review result">
    <h4>Review result</h4>
    <dl className="journey-review-counts">
      <div><dt>Fixed</dt><dd className="num">{groups.fixedRecorded ? groups.fixed.length : "Not recorded"}</dd></div>
      <div><dt>Reopened</dt><dd className="num">{groups.reopened.length}</dd></div>
      <div><dt>New</dt><dd className="num">{groups.fresh.length}</dd></div>
    </dl>
    <p className="note">{groups.settled ? "Settled decisions for this review round." : "Hand-back copies; no settled decision was saved."}</p>
    {!groups.fixedRecorded && <p className="note">Some earlier fix answers were not recorded, so a complete fixed count is unavailable.</p>}
    {sections.filter((section) => section.findings.length).map((section) => <details className="journey-review-group" key={section.key} open={section.key !== "fixed"}>
      <summary><ChevronRight size={14} aria-hidden="true" /><span>{section.title}</span><span className="num">{section.findings.length}</span></summary>
      <p className="note">{section.note}</p>
      <ol className="issues">{section.findings.map((finding) => <FindingItem key={finding.id} finding={finding} find={find} {...(onOpen ? { onOpen } : {})} />)}</ol>
    </details>)}
    {sections.every((section) => !section.findings.length) && <p className="note">No findings were raised or reopened in this round.</p>}
  </section>;
}
