import { Check } from "lucide-react";
import { acceptanceResultWords, acceptanceSummary, type Role, type Task } from "@petrina/core";

export function AcceptanceChecklist({ task, roleFor }: { task: Task; roleFor: (id?: string) => Role | undefined }) {
  const summary = acceptanceSummary(task, roleFor);
  return <>
    <p className="note">{summary.current ? "Recorded results apply to the current version" : summary.partlyCurrent ? "Current version partly verified" : summary.running ? "Acceptance testing in progress" : summary.notStarted ? "Acceptance testing not started" : "Current version not verified"}</p>
    <ul className="checks">
      {summary.items.map(({ text, check, current }) => <li key={text} className="check">
        <span className={`box ${current && check?.result === "pass" ? "on" : ""}`} aria-hidden="true">
          {current && check?.result === "pass" && <Check size={12} strokeWidth={3} />}
        </span>
        <span>{text}<span className="check-unverified">{check ? `Last recorded result: ${acceptanceResultWords(check)}` : summary.notStarted ? "Not tested yet" : summary.running ? "Testing in progress" : "Last recorded result: Unavailable"}{check?.reason ? ` · ${check.reason}` : ""}</span>
          {check?.evidence && <span className="check-unverified">{check.evidence}</span>}
          {current && <span className="check-unverified">Current version: {acceptanceResultWords(check)}</span>}
        </span>
      </li>)}
    </ul>
  </>;
}
