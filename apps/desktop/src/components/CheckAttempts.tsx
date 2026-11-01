import { LoaderCircle } from "lucide-react";
import {
  checkEntryResult,
  checkOutcome,
  checkAttemptsOf,
  checkCounts,
  checkReasonWords,
  inCheckLine,
  incompleteCheckOutcome,
  runsAhead,
  type CheckActivity,
  type CheckRunReason,
  type JourneyProductCheck
} from "@petrina/core";
import { checkBadge, duration, type Lookup } from "../lib";

function outcome(checks: readonly JourneyProductCheck[]) {
  const { failed, passed } = checkCounts(checks);
  if (checks.every((check) => check.result === "pending")) return `${checks.length} ${checks.length === 1 ? "check" : "checks"} not started yet`;
  if (checks.some((check) => check.result === "running" || check.result === "pending")) return `${passed} of ${checks.length} passed · in progress`;
  const incomplete = incompleteCheckOutcome(checks);
  if (incomplete) return `${incomplete} · ${passed} of ${checks.length} passed`;
  if (failed) return `${failed} of ${checks.length} failed`;
  return `${passed} of ${checks.length} passed${checks.some((check) => check.result === "skipped") ? " · remaining checks skipped" : ""}`;
}

/** `activity`: the task's current check fact, on the live step only. `reasons`: why each fresh run was needed, as recorded. */
type Props = {
  checks: readonly JourneyProductCheck[];
  find: Lookup;
  now: number;
  taskId?: string;
  onOriginal?: (step: string, attempt?: string) => void;
  selectedAttempt?: string;
  evidence?: boolean;
  activity?: CheckActivity;
  reasons?: readonly CheckRunReason[];
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A run that has not started waits in the check line: since when, and how it stands there now. */
function lineWords(activity: CheckActivity, since: number): string {
  const where =
    activity.phase === "held"
      ? "held for cleanup"
      : activity.phase === "paused"
        ? `keeping its place while the pool is paused${activity.ahead !== undefined ? ` · ${runsAhead(activity.ahead)}` : ""}`
        : runsAhead(activity.ahead ?? 0);
  return `Waiting in the check line since ${clock(since)} · ${where}`;
}

const recordedDuration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 100) / 10}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;

function Attempt({ checks, find, now, taskId, onOriginal, evidence, activity, reasons }: Props) {
  const product = checks[0]?.productId;
  const reused = checks.some((check) => check.reusedAt !== undefined);
  const starts = checks.flatMap((check) => check.queuedAt ?? check.startedAt ?? check.run?.startedAt ?? []);
  const ends = checks.flatMap((check) => check.endedAt ?? check.run?.endedAt ?? []);
  const start = starts.length ? Math.min(...starts) : undefined;
  const running = checks.some((check) => check.result === "pending" || check.result === "running");
  const end = ends.length ? Math.max(...ends) : undefined;
  const queued = !!activity && inCheckLine(activity) && checks.every((check) => check.result === "pending");
  const timing = start === undefined
    ? "Attempt timing unavailable"
    : queued
      ? lineWords(activity!, start)
      : `Started ${new Date(start).toLocaleString()} · ${running ? `${duration(
        start,
        now
      )} so far` : end !== undefined ? `${duration(
        start,
        end
      )} elapsed` : "duration unavailable"}`;
  const attempt = checks[0]?.attemptId ?? "run-0";
  const reason = reasons?.findLast((entry) => (entry.attemptId ?? "run-0") === attempt && (!entry.productId || entry.productId === product));
  return <div className="journey-context check-attempt">
    {(product || (!evidence && !reused)) && <p className="quiet-text num">{product && (find.product(product)?.name ?? "Removed product")}{!evidence && !reused && <>{product ? " · " : ""}{timing}</>}</p>}
    {reason && !evidence && !reused && <p className="check-reason">Why these checks run: {checkReasonWords(reason)}</p>}
    <ul className="journey-check-list">{checks.map((recorded, index) => {
      const result = checkEntryResult(recorded);
      const check = { ...recorded, result };
      const lifecycle = ["pending", "running", "stopped", "skipped"].includes(recorded.result);
      const pending = recorded.result === "pending" || recorded.result === "running";
      const run = check.run;
      const source = run?.source ?? check.source;
      const start = pending ? check.startedAt : run?.startedAt ?? check.startedAt;
      const end = pending ? undefined : run?.endedAt ?? check.endedAt;
      const badge = checkBadge(result, { ...(run ? { run } : {}), lifecycle });
      const href = new URL(window.location.href);
      if (taskId) href.pathname = `/tasks/${encodeURIComponent(taskId)}`;
      if (source) {
        href.searchParams.set("node", source.stepId);
        href.searchParams.set("attempt", source.attemptId);
      }
      return <li key={`${check.id ?? index}:${index}`}>
        <span className={`label ${badge.tone}`}>{check.result === "running" && <LoaderCircle
          size={12}
          className="check-progress-spinner"
          aria-hidden="true"
        />}{badge.label}</span>
        <strong>{check.name}</strong>
        {check.reusedAt !== undefined ? <span className="quiet-text num">Previous result reused {new Date(check.reusedAt).toLocaleString()}; no new execution</span> : evidence && <span className="quiet-text">Original execution</span>}
        {check.result === "skipped" ? <span className="quiet-text">Skipped in the original check attempt; no execution</span> : (evidence || reused) && <span className="quiet-text num">Original execution: {start !== undefined ? new Date(start).toLocaleString() : "time unavailable"}{run && Number.isFinite(run.ms) ? ` · ${recordedDuration(run.ms)} recorded duration` : start !== undefined && end !== undefined ? ` · ${recordedDuration(end - start)} recorded duration` : " · duration unavailable"}</span>}
        {!evidence && !reused && start !== undefined && <span className="quiet-text num">{duration(
          start,
          end ?? now
        )}{end === undefined ? " so far" : ""}</span>}
        {source && (evidence || reused) ? <a
          className="linkish"
          href={`${href.pathname}${href.search}`}
          onClick={(event) => { if (onOriginal && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          onOriginal(
          source.stepId,
          source.attemptId
        );
        } }}
        >See original checks · {/^run-\d+$/.test(source.attemptId) ? `attempt ${Number(source.attemptId.slice(4)) + 1}` : "recorded attempt"}</a> : (evidence || reused) && check.result !== "skipped" ? <span className="quiet-text">Original journey link unavailable</span> : null}
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
  if (props.evidence || props.checks.some((check) => check.reusedAt !== undefined)) return <div className="journey-context"><h4>Supporting check evidence</h4>{attempts.map(([id, checks]) => <div key={id}><p>{outcome(checks)}</p><Attempt
    {...props}
    checks={checks}
  /></div>)}</div>;
  return <div className="journey-context">
    <h4>Automated check results</h4>
    <p>{attempts.length > 1 ? "Latest attempt · " : ""}{outcome(latest[1])}</p>
    <Attempt {...props} checks={latest[1]} />
    {attempts.slice(
      0,
      -1
    ).reverse().map(([id, checks], index) => <details
      className="check-attempt-history"
      key={id}
      open={props.selectedAttempt !== undefined && checks.some((check) => (check.attemptId ?? check.id?.match(/^run-\d+(?=:)/)?.[0] ?? "run-0") === props.selectedAttempt)}
    >
      <summary>Earlier attempt {attempts.length - index - 1} · {outcome(checks)}</summary>
      <Attempt {...props} checks={checks} activity={undefined} />
    </details>)}
  </div>;
}
