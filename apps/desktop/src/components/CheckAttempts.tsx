import { LoaderCircle } from "lucide-react";
import { checkEntryResult, checkOutcome, checkOutcomeLabel, checkAttemptsOf, checkCounts, incompleteCheckOutcome, type JourneyProductCheck } from "@petrina/core";
import { duration, type Lookup } from "../lib";

function outcome(checks: readonly JourneyProductCheck[]) {
  const { failed, passed } = checkCounts(checks);
  if (checks.some((check) => check.result === "running" || check.result === "pending")) return `${passed} of ${checks.length} passed · in progress`;
  const incomplete = incompleteCheckOutcome(checks);
  if (incomplete) return `${incomplete} · ${passed} of ${checks.length} passed`;
  if (failed) return `${failed} of ${checks.length} failed`;
  return `${passed} of ${checks.length} passed${checks.some((check) => check.result === "skipped") ? " · remaining checks skipped" : ""}`;
}

type Props = { checks: readonly JourneyProductCheck[]; find: Lookup; now: number; taskId?: string; onOriginal?: (step: string, attempt?: string) => void; selectedAttempt?: string; evidence?: boolean };

const recordedDuration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 100) / 10}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;

function Attempt({ checks, find, now, taskId, onOriginal, evidence }: Props) {
  const product = checks[0]?.productId;
  const reused = checks.some((check) => check.reusedAt !== undefined);
  const starts = checks.flatMap((check) => check.queuedAt ?? check.startedAt ?? check.run?.startedAt ?? []);
  const ends = checks.flatMap((check) => check.endedAt ?? check.run?.endedAt ?? []);
  const start = starts.length ? Math.min(...starts) : undefined;
  const running = checks.some((check) => check.result === "pending" || check.result === "running");
  const end = ends.length ? Math.max(...ends) : undefined;
  const timing = start === undefined ? "Attempt timing unavailable" : `Started ${new Date(start).toLocaleString()} · ${running ? `${duration(start, now)} so far` : end !== undefined ? `${duration(start, end)} elapsed` : "duration unavailable"}`;
  return <div className="journey-context check-attempt">
    {(product || (!evidence && !reused)) && <p className="quiet-text num">{product && (find.product(product)?.name ?? "Removed product")}{!evidence && !reused && <>{product ? " · " : ""}{timing}</>}</p>}
    <ul className="journey-check-list">{checks.map((recorded, index) => {
      const result = checkEntryResult(recorded);
      const check = { ...recorded, result };
      const lifecycle = ["pending", "running", "stopped", "skipped"].includes(recorded.result);
      const pending = recorded.result === "pending" || recorded.result === "running";
      const run = check.run;
      const source = run?.source ?? check.source;
      const start = pending ? check.startedAt : run?.startedAt ?? check.startedAt;
      const end = pending ? undefined : run?.endedAt ?? check.endedAt;
      const words = run && !lifecycle && result === "stopped" ? checkOutcomeLabel(checkOutcome(run)) : undefined;
      const label = words ? words[0]!.toUpperCase() + words.slice(1) : result === "stopped" && !lifecycle ? "Unverified — execution details were not recorded" : ({ pass: "Passed", fail: "Failed", "did-not-finish": "Timed out", running: "Running", pending: "Pending", stopped: "Stopped — verification incomplete", skipped: "Skipped" } as const)[result];
      const href = new URL(window.location.href);
      if (taskId) href.pathname = `/tasks/${encodeURIComponent(taskId)}`;
      if (source) { href.searchParams.set("node", source.stepId); href.searchParams.set("attempt", source.attemptId); }
      return <li key={`${check.id ?? index}:${index}`}>
        <span className={`label ${check.result === "pass" ? "ok" : check.result === "fail" || check.result === "did-not-finish" ? "bad" : check.result === "running" ? "running" : ""}`}>{check.result === "running" && <LoaderCircle size={12} className="check-progress-spinner" aria-hidden="true" />}{label}</span>
        <strong>{check.name}</strong>
        {check.reusedAt !== undefined ? <span className="quiet-text num">Previous result reused {new Date(check.reusedAt).toLocaleString()}; no new execution</span> : evidence && <span className="quiet-text">Original execution</span>}
        {check.result === "skipped" ? <span className="quiet-text">Skipped in the original check attempt; no execution</span> : (evidence || reused) && <span className="quiet-text num">Original execution: {start !== undefined ? new Date(start).toLocaleString() : "time unavailable"}{run && Number.isFinite(run.ms) ? ` · ${recordedDuration(run.ms)} recorded duration` : start !== undefined && end !== undefined ? ` · ${recordedDuration(end - start)} recorded duration` : " · duration unavailable"}</span>}
        {!evidence && !reused && start !== undefined && <span className="quiet-text num">{duration(start, end ?? now)}{end === undefined ? " so far" : ""}</span>}
        {source && (evidence || reused) ? <a className="linkish" href={`${href.pathname}${href.search}`} onClick={(event) => { if (onOriginal && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOriginal(source.stepId, source.attemptId); } }}>See original checks · {/^run-\d+$/.test(source.attemptId) ? `attempt ${Number(source.attemptId.slice(4)) + 1}` : "recorded attempt"}</a> : (evidence || reused) && check.result !== "skipped" ? <span className="quiet-text">Original journey link unavailable</span> : null}
        {run?.interruption && <span>{run.interruption.source} · {new Date(run.interruption.at).toLocaleString()}: {run.interruption.event}. Sleep overlap does not prove the cause of every reported failure.</span>}
        {check.result === "stopped" && (run || recorded.result === "pass" || recorded.result === "fail") && <span>Original reported result: {run ? run.ok ? "passed" : run.timedOut ? "timed out" : "failed" : recorded.result === "pass" ? "passed" : "failed"}</span>}
        {check.detail || (run && checkOutcome(run).kind !== "passed") ? <span className="journey-check-detail">{check.detail ?? run!.output.slice(-1000)}</span> : null}
      </li>;
    })}</ul>
  </div>;
}

export function CheckAttempts(props: Props) {
  const attempts = checkAttemptsOf(props.checks);
  const latest = attempts.at(-1);
  if (!latest) return null;
  if (props.evidence || props.checks.some((check) => check.reusedAt !== undefined)) return <div className="journey-context"><h4>Supporting check evidence</h4>{attempts.map(([id, checks]) => <div key={id}><p>{outcome(checks)}</p><Attempt {...props} checks={checks} /></div>)}</div>;
  return <div className="journey-context">
    <h4>Automated check results</h4>
    <p>{attempts.length > 1 ? "Latest attempt · " : ""}{outcome(latest[1])}</p>
    <Attempt {...props} checks={latest[1]} />
    {attempts.slice(0, -1).reverse().map(([id, checks], index) => <details className="check-attempt-history" key={id} open={props.selectedAttempt !== undefined && checks.some((check) => (check.attemptId ?? check.id?.match(/^run-\d+(?=:)/)?.[0] ?? "run-0") === props.selectedAttempt)}>
      <summary>Earlier attempt {attempts.length - index - 1} · {outcome(checks)}</summary>
      <Attempt {...props} checks={checks} />
    </details>)}
  </div>;
}
