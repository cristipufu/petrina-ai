// The task sheet's Review tab: Petrina's own checks, the tamper check, and every finding with its outcome.

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { findingCount, type CheckRun, type Finding, type Task } from "@petrina/core";
import { ago, profileText, type Lookup } from "../../lib";
import { openFirst } from "./order";

const FINDING_TAG: Record<Finding["severity"], string> = { blocking: "Important", suggestion: "Nit", "pre-existing": "Pre-existing" };

const VERDICT: Record<NonNullable<Finding["verification"]>["verdict"], string> = { real: "Checked: real", "not-a-bug": "Checked: not a bug", nit: "Checked: only a nit", "pre-existing": "Checked: older than this change" };

function FindingItem({ finding, find }: { finding: Finding; find: Lookup }) {
  const followUp = finding.status === "open" && finding.severity === "pre-existing";
  const status = finding.status === "fixed" ? "Fixed" : finding.status === "dismissed" ? "Dismissed" : followUp ? "Follow-up" : "Open";
  return (
    <li className="issue">
      <div className="issue-status">
        <span className={`label ${finding.status === "fixed" ? "ok" : finding.status === "open" && !followUp ? (finding.severity === "blocking" ? "bad" : "warn") : ""}`}>{status}</span>
        <span aria-hidden="true">·</span>
        <span>{FINDING_TAG[finding.severity]}</span>
      </div>
      <p className="issue-text">{finding.text}</p>
      {finding.evidence && <p className="issue-evidence">{finding.evidence}</p>}
      <p className="issue-who">
        Raised by {profileText(find.profile(finding.raisedBy), find, true)}
        {finding.confirmedBy.length > 0 && `. Confirmed by ${finding.confirmedBy.map((profileId) => profileText(find.profile(profileId), find, true)).join(" and ")}`}
      </p>
      {(finding.disputes ?? []).map((dispute, index) => (
        <div key={index} className="issue-response">
          <b>{finding.status === "dismissed" ? "Dismissed by" : "Disputed by"} {profileText(find.profile(dispute.by), find, true)}</b>
          {dispute.reason}
        </div>
      ))}
      {finding.verification && (
        <div className="issue-response">
          <b>
            {VERDICT[finding.verification.verdict]}
            {finding.votes?.length
              ? `: ${finding.votes.filter((vote) => vote.verdict === "real").length} of ${finding.votes.length} voter${finding.votes.length === 1 ? "" : "s"} said it is real`
              : `, by ${profileText(find.profile(finding.verification.by), find, true)}`}
          </b>
          {finding.verification.reason}
        </div>
      )}
      {finding.answer && (
        <div className="issue-response">
          <b>{finding.answer.fixed ? "The builder fixed it" : "The builder did not fix it"}</b>
          {finding.answer.text}
        </div>
      )}
      {finding.status === "dismissed" && !finding.disputes?.length && !finding.verification && (
        <div className="issue-response">
          <b>Dismissed by a later reviewer</b>
          The reason was not recorded: reviewers did not have to give one before this change.
        </div>
      )}
    </li>
  );
}

export function ReviewView({ task, find }: { task: Task; find: Lookup }) {
  const reviewing = task.plan?.stages.some((stage, index) => stage.kind === "review-chain" && index <= task.stageIndex) || task.state === "pr-open" || task.state === "done";
  const runs = task.checks?.results ?? [];
  if (task.findings.length === 0 && runs.length === 0) return <div className="empty-state">{reviewing ? "Nothing to fix. Every reviewer passed it." : "Reviews start after the build."}</div>;

  const findings = openFirst(task.findings.map((finding) => ({ ...finding, blocking: finding.severity === "blocking" })));
  const open = findings.filter((finding) => finding.status === "open");
  // Petrina's own findings that aren't failing checks come from the tamper check.
  const tampered = task.findings.some((finding) => finding.raisedBy === "petrina" && finding.status === "open" && !finding.text.startsWith("Check failed"));

  return (
    <>
      {runs.length > 0 && <ChecksSection runs={runs} at={task.checks!.at} />}
      {reviewing && (
        <p className="tamper">
          <ShieldCheck size={16} aria-hidden="true" />
          {tampered ? "Tamper check found tests removed, weakened or skipped: see the findings below." : "Tamper check passed: no tests were removed, weakened or skipped."}
        </p>
      )}
      {findings.length === 0 ? (
        <p className="quiet-text">Nothing to fix. Every reviewer passed it.</p>
      ) : (
        <section className="sheet-section">
          <h2>
            Findings <span className="quiet-text num">{findingCount(open)}</span>
          </h2>
          <ol className="issues">
            {findings.map((finding) => (
              <FindingItem key={finding.id} finding={finding} find={find} />
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

/** What Petrina saw when it ran the product's checks itself: evidence, never an agent's word. */
function ChecksSection({ runs, at }: { runs: readonly CheckRun[]; at: number }) {
  const failed = runs.filter((run) => !run.ok).length;
  const when = ago(at, Date.now());
  return (
    <section className="sheet-section">
      <h2>
        Checks <span className="quiet-text num">{failed ? `${failed} of ${runs.length} failed` : `all ${runs.length} passed`} · run by Petrina {when === "now" ? "just now" : `${when} ago`}</span>
      </h2>
      <ol className="issues">
        {runs.map((run) => (
          <CheckItem key={run.name} run={run} />
        ))}
      </ol>
    </section>
  );
}

function CheckItem({ run }: { run: CheckRun }) {
  const [open, setOpen] = useState(!run.ok);
  return (
    <li className="issue">
      <div className="issue-status">
        <span className={`label ${run.ok ? "ok" : "bad"}`}>{run.ok ? "Passed" : run.timedOut ? "Too slow" : "Failed"}</span>
        <span aria-hidden="true">·</span>
        <span className="issue-text">{run.name}</span>
        <span aria-hidden="true">·</span>
        <span className="num">{Math.max(1, Math.round(run.ms / 1000))}s</span>
      </div>
      <p className="issue-who mono">{run.command}</p>
      {run.output && (
        <>
          <button className="linkish" onClick={() => setOpen((on) => !on)}>
            {open ? "Hide the output" : "Show the output"}
          </button>
          {open && <pre className="check-output">{run.output}</pre>}
        </>
      )}
    </li>
  );
}
