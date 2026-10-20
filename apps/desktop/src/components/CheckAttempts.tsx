import { LoaderCircle } from "lucide-react";
import type { JourneyProductCheck } from "@petrina/core";
import { duration, type Lookup } from "../lib";

function attemptsOf(checks: readonly JourneyProductCheck[]) {
  const attempts = new Map<string, JourneyProductCheck[]>();
  for (const check of checks) {
    // Earlier records encode the preparation identity in their command ids.
    const id = `${check.productId ?? ""}:${check.attemptId ?? check.id?.match(/^run-\d+(?=:)/)?.[0] ?? "run-0"}`;
    const attempt = attempts.get(id) ?? [];
    attempt.push(check);
    attempts.set(id, attempt);
  }
  return [...attempts.entries()];
}

function outcome(checks: readonly JourneyProductCheck[]) {
  const failed = checks.filter((check) => check.result === "fail" || check.result === "did-not-finish").length;
  const passed = checks.filter((check) => check.result === "pass").length;
  if (checks.some((check) => check.result === "running" || check.result === "pending")) return `${passed} of ${checks.length} passed · in progress`;
  if (checks.some((check) => check.result === "stopped")) return `Interrupted · ${passed} of ${checks.length} passed`;
  if (failed) return `${failed} of ${checks.length} failed`;
  return `${passed} of ${checks.length} passed${checks.some((check) => check.result === "skipped") ? " · remaining checks not needed" : ""}`;
}

function Attempt({ checks, find, now }: { checks: readonly JourneyProductCheck[]; find: Lookup; now: number }) {
  const starts = checks.flatMap((check) => check.queuedAt ?? check.startedAt ?? []);
  const start = starts.length ? Math.min(...starts) : undefined;
  const ends = checks.flatMap((check) => check.endedAt ?? []);
  const active = checks.some((check) => check.result === "pending" || check.result === "running");
  const end = active ? now : ends.length ? Math.max(...ends) : undefined;
  const product = checks[0]?.productId;
  const metadata = [product ? find.product(product)?.name ?? "Removed product" : undefined, start !== undefined ? `Started ${new Date(start).toLocaleString()}` : undefined, start !== undefined && end !== undefined ? `${duration(start, end)}${active ? " so far" : " elapsed"}` : undefined].filter(Boolean).join(" · ");
  return <div className="journey-context check-attempt">
    {metadata && <p className="quiet-text num">{metadata}</p>}
    <ul className="journey-check-list">{checks.map((check, index) => <li key={check.id ?? index}>
      <span className={`label ${check.result === "pass" ? "ok" : check.result === "fail" || check.result === "did-not-finish" ? "bad" : check.result === "running" ? "running" : ""}`}>{check.result === "running" && <LoaderCircle size={12} className="check-progress-spinner" aria-hidden="true" />}{({ pass: "Passed", fail: "Failed", "did-not-finish": "Timed out", running: "Running", pending: "Pending", stopped: "Stopped", skipped: "Not needed" } as const)[check.result]}</span>
      <strong>{check.name}</strong>
      {check.startedAt !== undefined && <span className="quiet-text num">{duration(check.startedAt, check.endedAt ?? now)}{check.endedAt === undefined ? " so far" : ""}</span>}
      {check.detail ? <span className="journey-check-detail">{check.detail}</span> : null}
    </li>)}</ul>
  </div>;
}

export function CheckAttempts({ checks, find, now }: { checks: readonly JourneyProductCheck[]; find: Lookup; now: number }) {
  const attempts = attemptsOf(checks);
  const latest = attempts.at(-1);
  if (!latest) return null;
  return <div className="journey-context">
    <h4>Automated check results</h4>
    <p>{attempts.length > 1 ? "Latest attempt · " : ""}{outcome(latest[1])}</p>
    <Attempt checks={latest[1]} find={find} now={now} />
    {attempts.slice(0, -1).reverse().map(([id, checks], index) => <details className="check-attempt-history" key={id}>
      <summary>Earlier attempt {attempts.length - index - 1} · {outcome(checks)}</summary>
      <Attempt checks={checks} find={find} now={now} />
    </details>)}
  </div>;
}
