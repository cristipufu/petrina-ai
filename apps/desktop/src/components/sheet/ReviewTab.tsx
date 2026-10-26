// The task sheet's Review tab: Petrina's own checks, the tamper check, and every finding with its outcome.

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { CheckSetupObservations } from "../CheckSetupObservations";
import { checkCounts, checkOutcome, checkOutcomeLabel, checkProblemWords, checkResult, findingCount, independentVotes, trackingWords, VERDICT_WORDS, voteSummary, type CheckRun, type Finding, type Task, type Vote } from "@petrina/core";
import { ago, profileText, type Lookup } from "../../lib";
import { followLink, routeHref } from "../../routes";
import { openFirst } from "./order";

const FINDING_TAG: Record<Finding["severity"], string> = { blocking: "Important", suggestion: "Nit", "pre-existing": "Pre-existing" };

function voteAttribution(vote: Vote, find: Lookup): string {
  return [find.tool(vote.toolId)?.name ?? vote.toolId, profileText(find.profile(vote.by), find)].filter(Boolean).join(" · ");
}

function answerAttribution(finding: Finding, fixed: boolean): string | undefined {
  if (finding.raisedBy !== "petrina" || !finding.text.startsWith("Check failed")) return;
  if (!fixed) return "Builder’s explanation — not independently confirmed.";
  if (finding.status !== "fixed") return "Builder’s fix claim — awaiting automated verification.";
}

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
  const voteWords = voteSummary(finding.votes);
  const decisionAt = finding.verification?.at ?? finding.unresolved?.at;
  const beforeFix = decisionAt !== undefined && !!finding.answer?.fixed && decisionAt < finding.answer.at;
  const unfinishedVote = `${finding.status === "open" && finding.severity === "blocking" ? "Still Important: " : ""}${finding.unresolved ? "verification is unresolved." : "waiting for the remaining verifier answers."}`;
  const followUp = finding.status === "open" && finding.severity === "pre-existing";
  const status = finding.status === "fixed" ? "Fixed" : finding.status === "dismissed" ? "Dismissed" : finding.status === "unverified" ? "Could not verify" : followUp ? "Follow-up" : "Open";
  return (
    <li className="issue">
      <div className="issue-status">
        <span className={`label ${finding.status === "fixed" ? "ok" : finding.status === "open" && !followUp ? (finding.severity === "blocking" ? "bad" : "warn") : ""}`}>{status}</span>
        <span aria-hidden="true">·</span>
        <span>{finding.status === "unverified" ? finding.text.startsWith("Could not verify acceptance check:") ? "Acceptance check" : "Unverified check" : FINDING_TAG[finding.severity]}</span>
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
      {(finding.verification || finding.unresolved || voteWords) && (
        <div className="issue-response">
          <b>
            {beforeFix && "Before the reported fix — "}{finding.verification ? `Checked: ${VERDICT_WORDS[finding.verification.verdict]}.` : unfinishedVote}
            {finding.verification && !finding.votes?.length && ` By ${profileText(find.profile(finding.verification.by), find, true)}.`}
          </b>
          {voteWords && <p>{beforeFix && "Before the reported fix — "}{voteWords}</p>}
          {finding.verification?.reason ?? finding.unresolved?.reason}
        </div>
      )}
      {votes.length > 0 && <details className="issue-response">
        <summary>{beforeFix ? "Votes before the reported fix" : "Tool verdicts and reasons"}</summary>
        {votes.map(vote => <p key={vote.toolId}><b>{voteAttribution(vote, find)}: {VERDICT_WORDS[vote.verdict]}</b>{vote.reason}</p>)}
      </details>}
      {finding.answers && Object.entries(finding.answers).map(([id, answer]) => <div className="issue-response" key={id}><b>{find.product(id)?.name ?? id}: {answer.fixed ? "Builder claims a fix" : "Builder answered: not fixed"}</b>{answer.text}{answerAttribution(finding, answer.fixed) && <p>{answerAttribution(finding, answer.fixed)}</p>}</div>)}
      {!finding.answers && finding.answer && (
        <div className="issue-response">
          <b>{finding.answer.fixed ? "Builder reported a fix" : "Builder reported no fix"}</b>
          {finding.answer.text}
          {answerAttribution(finding, finding.answer.fixed) && <p>{answerAttribution(finding, finding.answer.fixed)}</p>}
          {finding.answer.fixed && finding.status === "open" && <p>{finding.raisedBy === "petrina" ? "The latest automated check still fails." : "A later reviewer reopened this finding."}</p>}
        </div>
      )}
      {!!finding.earlierReviews?.length && <details className="issue-response">
        <summary>Earlier reviews</summary>
        {finding.earlierReviews.map((review, index) => <div key={index} className="issue-response">
          {review.confirmedBy.length > 0 && <p>Confirmed by {review.confirmedBy.map((id) => profileText(find.profile(id), find, true)).join(" and ")}</p>}
          {review.disputes?.map((dispute, i) => <p key={i}>Disputed by {profileText(find.profile(dispute.by), find, true)}: {dispute.reason}</p>)}
          {review.verification && <><b>Before the reported fix — Checked: {VERDICT_WORDS[review.verification.verdict]}.</b>{review.verification.reason}</>}
          {!review.verification && review.unresolved && <><b>Before the reported fix — verification was unresolved.</b>{review.unresolved.reason}</>}
          {voteSummary(review.votes) && <p>Before the reported fix — {voteSummary(review.votes)}</p>}
          {independentVotes(review.votes).map((vote) => <p key={vote.toolId}>{voteAttribution(vote, find)}: {VERDICT_WORDS[vote.verdict]}. {vote.reason}</p>)}
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

export function ReviewView({ task, now, find, onOpen }: { task: Task; now: number; find: Lookup; onOpen?: (taskId: string) => void }) {
  const setupHistory = task.journey?.flatMap(step => step.checkSetups ?? []) ?? [];
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
      <CheckSetupObservations latest={work.checkSetup} invalidated={work.checkSetupInvalidated} history={setupHistory.filter(attempt => attempt.productId === work.productId)} />
      {work.checks?.current === false && <p className="note">Recorded check results need fresh verification before delivery.</p>}
      {!work.checks?.results.length && <p className="note">Product checks: Not run</p>}
      {!!work.checks?.results.length && <ChecksSection runs={work.checks.results} at={work.checks.at} now={now} />}
      <FindingsSection find={find} findings={task.findings.filter((finding) => finding.productIds?.length === 1 && finding.productIds[0] === work.productId)} empty={together.length ? "No findings assigned only to this product. Shared findings appear under Together." : emptyReview} {...(onOpen ? { onOpen } : {})} />
    </section>)}
    <section className="sheet-section"><h2>Together</h2>{!together.length && <p className="quiet-text">{emptyReview}</p>}<ol className="issues">{openFirst(together.map((finding) => ({ ...finding, blocking: finding.severity === "blocking" }))).map((finding) => <FindingItem key={finding.id} finding={finding} find={find} {...(onOpen ? { onOpen } : {})} />)}</ol></section>
  </>;

  const runs = task.checks?.results ?? [];
  if (task.findings.length === 0 && runs.length === 0) return <><CheckSetupObservations latest={task.checkSetup} invalidated={task.checkSetupInvalidated} history={setupHistory.filter(attempt => attempt.productId === task.productId)} /><div className="empty-state">{emptyReview}</div></>;

  // Petrina's own findings that aren't failing checks come from the tamper check.
  const tampered = task.findings.some((finding) => finding.raisedBy === "petrina" && finding.status === "open" && !finding.text.startsWith("Check failed"));

  return (
    <>
      <CheckSetupObservations latest={task.checkSetup} invalidated={task.checkSetupInvalidated} history={setupHistory.filter(attempt => attempt.productId === task.productId)} />
      {task.checks?.current === false && <p className="note">Recorded check results need fresh verification before delivery.</p>}
      {runs.length > 0 && <ChecksSection runs={runs} at={task.checks!.at} now={now} />}
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
function ChecksSection({ runs, at, now }: { runs: readonly CheckRun[]; at: number; now: number }) {
  const checks = runs.map(run => ({ name: run.name, result: checkResult(run), run }));
  const { failed, unverified } = checkCounts(checks);
  const result = unverified ? checkProblemWords(checks) : failed ? `${failed} of ${runs.length} failed` : `all ${runs.length} passed`;
  const when = ago(at, now);
  return (
    <section className="sheet-section">
      <h2>
        Checks <span className="quiet-text num">{result} · run by Petrina {when === "now" ? "just now" : `${when} ago`}</span>
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
  const outcome = checkOutcome(run);
  const passed = outcome.kind === "passed", failed = outcome.kind === "failed";
  const words = checkOutcomeLabel(outcome);
  const label = words[0]!.toUpperCase() + words.slice(1);
  const [open, setOpen] = useState(!passed);
  return (
    <li className="issue">
      <div className="issue-status">
        <span className={`label ${passed ? "ok" : failed ? "bad" : ""}`}>{label}</span>
        <span aria-hidden="true">·</span>
        <span className="issue-text">{run.name}</span>
        <span aria-hidden="true">·</span>
        <span className="num">{Math.max(1, Math.round(run.ms / 1000))}s</span>
      </div>
      <p className="issue-who mono">{run.command}</p>
      {!passed && !failed && <p className="quiet-text">Original reported result: {run.ok ? "passed" : "failed"}</p>}
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
