// The task sheet's Review tab: Petrina's own checks, the tamper check, and every finding with its outcome.

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { findingCount, independentVotes, trackingWords, type CheckRun, type Finding, type Task } from "@petrina/core";
import { ago, profileText, type Lookup } from "../../lib";
import { followLink, routeHref } from "../../routes";
import { openFirst } from "./order";

const FINDING_TAG: Record<Finding["severity"], string> = { blocking: "Important", suggestion: "Nit", "pre-existing": "Pre-existing" };

const VERDICT: Record<NonNullable<Finding["verification"]>["verdict"], string> = { real: "Checked: real", "not-a-bug": "Checked: not a bug", nit: "Checked: only a nit", "pre-existing": "Checked: older than this change" };

/** A link to the task a follow-up came from, or to the Backlog card that now tracks it. */
export function TaskLink({ taskId, find, onOpen, children }: { taskId: string; find: Lookup; onOpen?: (taskId: string) => void; children: string }) {
  const task = find.task(taskId);
  const finished = !task || task.state === "done" || task.state === "cancelled";
  const view = finished ? "history" : "board";
  const product = new URLSearchParams(window.location.search).get("product") || "all";
  const href = routeHref({ view, product, sheet: { taskId, tab: "overview", list: view } });
  return <a href={href} className="linkish" onClick={(event) => { if (onOpen) followLink(event, () => onOpen(taskId)); }}>{children}</a>;
}

export function FindingItem({ finding, find, onOpen }: { finding: Finding; find: Lookup; onOpen?: (taskId: string) => void }) {
  const votes = independentVotes(finding.votes);
  const beforeFix = !!finding.verification && !!finding.answer?.fixed && finding.verification.at < finding.answer.at;
  const followUp = finding.status === "open" && finding.severity === "pre-existing";
  const status = finding.status === "fixed" ? "Fixed" : finding.status === "dismissed" ? "Dismissed" : finding.status === "unverified" ? "Could not verify" : followUp ? "Follow-up" : "Open";
  return (
    <li className="issue">
      <div className="issue-status">
        <span className={`label ${finding.status === "fixed" ? "ok" : finding.status === "open" && !followUp ? (finding.severity === "blocking" ? "bad" : "warn") : ""}`}>{status}</span>
        <span aria-hidden="true">·</span>
        <span>{finding.status === "unverified" ? "Acceptance check" : FINDING_TAG[finding.severity]}</span>
      </div>
      <p className="issue-text">{finding.text}</p>
      {finding.evidence && <p className="issue-evidence">{finding.evidence}</p>}
      <p className="issue-who">
        Raised by {finding.roleId && find.role(finding.roleId) ? `${find.role(finding.roleId)!.name} on ` : ""}{profileText(find.profile(finding.raisedBy), find, true)}
        {finding.confirmedBy.length > 0 && `. Confirmed by ${finding.confirmedBy.map((profileId) => profileText(find.profile(profileId), find, true)).join(" and ")}`}
      </p>
      {finding.tracking && <FollowUpLine finding={finding} find={find} {...(onOpen ? { onOpen } : {})} />}
      {(finding.disputes ?? []).map((dispute, index) => (
        <div key={index} className="issue-response">
          <b>{finding.status === "dismissed" ? "Dismissed by" : "Disputed by"} {profileText(find.profile(dispute.by), find, true)}</b>
          {dispute.reason}
        </div>
      ))}
      {finding.verification && (
        <div className="issue-response">
          <b>
            {beforeFix && "Before the reported fix — "}{VERDICT[finding.verification.verdict]}
            {votes.length
              ? `: ${votes.filter((vote) => vote.verdict === "real").length} of ${votes.length} voter${votes.length === 1 ? "" : "s"} said it is real`
              : finding.votes?.length ? ": actual voting tools were not recorded"
              : `, by ${profileText(find.profile(finding.verification.by), find, true)}`}
          </b>
          {finding.verification.reason}
        </div>
      )}
      {finding.answers && Object.entries(finding.answers).map(([id, answer]) => <div className="issue-response" key={id}><b>{find.product(id)?.name ?? id}: {answer.fixed ? "Builder answered: fixed" : "Builder answered: not fixed"}</b>{answer.text}</div>)}
      {!finding.answers && finding.answer && (
        <div className="issue-response">
          <b>{finding.answer.fixed ? "Builder reported a fix" : "Builder left it unchanged"}</b>
          {finding.answer.text}
          {finding.answer.fixed && finding.status === "open" && <p>{finding.raisedBy === "petrina" ? "The latest automated check still fails." : "A later reviewer reopened this finding."}</p>}
        </div>
      )}
      {!!finding.earlierReviews?.length && <details className="issue-response">
        <summary>Earlier reviews</summary>
        {finding.earlierReviews.map((review, index) => <div key={index} className="issue-response">
          {review.confirmedBy.length > 0 && <p>Confirmed by {review.confirmedBy.map((id) => profileText(find.profile(id), find, true)).join(" and ")}</p>}
          {review.disputes?.map((dispute, i) => <p key={i}>Disputed by {profileText(find.profile(dispute.by), find, true)}: {dispute.reason}</p>)}
          {review.verification && <><b>Before the reported fix — {VERDICT[review.verification.verdict]}</b>{review.verification.reason}</>}
          {independentVotes(review.votes).map((vote) => <p key={vote.toolId}>{profileText(find.profile(vote.by), find, true)}: {vote.reason}</p>)}
          {review.answer && <p>Builder reported {review.answer.fixed ? "a fix" : "no fix"}: {review.answer.text}</p>}
        </div>)}
      </details>}
      {finding.status === "dismissed" && !finding.disputes?.length && !finding.verification && (
        <div className="issue-response">
          <b>Dismissed by a later reviewer</b>
          The reason was not recorded: reviewers did not have to give one before this change.
        </div>
      )}
    </li>
  );
}

function FollowUpLine({ finding, find, onOpen }: { finding: Finding; find: Lookup; onOpen?: (taskId: string) => void }) {
  const tracking = finding.tracking;
  if (!tracking) return null;
  const words = trackingWords(tracking);
  if (!("taskId" in tracking)) return <p className="issue-who">{words.label}. {words.reason}</p>;
  const title = find.task(tracking.taskId)?.title ?? "Backlog";
  return <p className="issue-who">{words.label} <TaskLink taskId={tracking.taskId} find={find} {...(onOpen ? { onOpen } : {})}>{title}</TaskLink></p>;
}

export function ReviewView({ task, find, onOpen }: { task: Task; find: Lookup; onOpen?: (taskId: string) => void }) {
  const reviews = (task.plan?.stages ?? []).flatMap((stage, index) => stage.kind === "review-chain" ? [index] : []);
  const reviewing = reviews.some((index) => index <= task.stageIndex);
  // Reaching review is not completion: all planned review steps must be behind us.
  const reviewed = reviews.length > 0 && (reviews.every((index) => index < task.stageIndex) || task.state === "pr-open" || task.state === "done");
  const emptyReview = reviewed ? "Nothing to fix. Every reviewer passed it." : reviewing ? "No findings reported yet." : "Reviews start after the build.";
  const together = task.findings.filter((finding) => finding.productIds?.length !== 1 || !task.repositories?.some((work) => work.productId === finding.productIds?.[0]));
  if (task.repositories) return <>
    {task.repositories.map((work) => <section className="sheet-section repository-row" key={work.productId}>
      <h2>{work.source?.product.name ?? work.productId}</h2><p className="note">{work.source?.product.repo}</p>
      <p className="note">Deleted or skipped tests: {work.tamper ? work.tamper.problems.length ? "Needs attention" : "Passed" : "Not run"}</p>
      {work.checks?.current === false && <p className="note">These checks cover an earlier version. Current checks: Not run</p>}
      {!work.checks?.results.length && <p className="note">Product checks: Not run</p>}
      {!!work.checks?.results.length && <ChecksSection runs={work.checks.results} at={work.checks.at} />}
      <FindingsSection find={find} findings={task.findings.filter((finding) => finding.productIds?.length === 1 && finding.productIds[0] === work.productId)} empty={together.length ? "No findings assigned only to this product. Shared findings appear under Together." : emptyReview} {...(onOpen ? { onOpen } : {})} />
    </section>)}
    <section className="sheet-section"><h2>Together</h2>{!together.length && <p className="quiet-text">{emptyReview}</p>}<ol className="issues">{openFirst(together.map((finding) => ({ ...finding, blocking: finding.severity === "blocking" }))).map((finding) => <FindingItem key={finding.id} finding={finding} find={find} {...(onOpen ? { onOpen } : {})} />)}</ol></section>
  </>;

  const runs = task.checks?.results ?? [];
  if (task.findings.length === 0 && runs.length === 0) return <div className="empty-state">{emptyReview}</div>;

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
      <FindingsSection find={find} findings={task.findings} empty={emptyReview} {...(onOpen ? { onOpen } : {})} />
    </>
  );
}

function FindingsSection({ findings, find, empty, onOpen }: { findings: readonly Finding[]; find: Lookup; empty: string; onOpen?: (taskId: string) => void }) {
  if (!findings.length) return <p className="quiet-text">{empty}</p>;
  const ordered = openFirst(findings.map((finding) => ({ ...finding, blocking: finding.severity === "blocking" })));
  return <section className="sheet-section">
    <h2>Findings <span className="quiet-text num">{findingCount(findings.filter((finding) => finding.status === "open"))}</span></h2>
    <ol className="issues">{ordered.map((finding) => <FindingItem key={finding.id} finding={finding} find={find} {...(onOpen ? { onOpen } : {})} />)}</ol>
  </section>;
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
      {run.cleanupIncomplete && <p className="issue-text">Petrina could not confirm every child process stopped. Some may still be running.</p>}
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
