import { checkSetupOutcome, checkSetupWords, type CheckSetupAttempt, type CheckSetupInvalidation } from "@petrina/core";

function recordedTime(attempt: CheckSetupAttempt) {
  const [label, at] = attempt.lifecycle === "settled" ? ["Observed", attempt.endedAt] : attempt.lifecycle === "stopped" ? ["Stopped", attempt.endedAt]
    : attempt.startedAt !== undefined ? ["Started", attempt.startedAt] : ["Queued", attempt.queuedAt];
  if (typeof at !== "number" || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return <span>Time unavailable</span>;
  return <span>{label} <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time></span>;
}

function Observation({ attempt, invalidated }: { attempt?: CheckSetupAttempt; invalidated?: CheckSetupInvalidation }) {
  const outcome = checkSetupOutcome(attempt, undefined, invalidated);
  const requirements = Array.isArray(attempt?.requirements) ? attempt.requirements : [];
  const results = Array.isArray(attempt?.results) ? attempt.results.filter(result => result?.run && typeof result.run.output === "string") : [];
  // Names are display text only; authority always comes from the unchanged canonical classifier.
  const requirement = outcome.kind === "unmet" ? requirements.find(requirement => requirement.id === outcome.requirementId) : undefined;
  const words = checkSetupWords(outcome.kind === "unmet" ? { ...outcome, requirementId: requirement?.name ?? "with no recorded name" } : outcome);
  return <div className="setup-observation">
    <p className={`setup-outcome ${outcome.kind === "verified" ? "ok-text" : outcome.kind === "unmet" ? "bad-text" : ""}`}>{words}</p>
    {attempt && <>
      <p className="quiet-text setup-observation-meta">{attempt.position === "before-checks" ? "Before automated checks" : attempt.position === "after-checks" ? "After automated checks" : "Position unavailable"}<span aria-hidden="true"> · </span>{recordedTime(attempt)}</p>
      {Array.isArray(attempt.requirements) && requirements.length === 0 && <p className="note">No local setup requirements were declared for this observation.</p>}
      {results.some(result => result.run.output) && <details className="setup-diagnostics"><summary>Recorded details</summary>{results.filter(result => result.run.output).map((
        result,
        index
      ) => <div key={`${result.requirementId}-${index}`}><p className="setup-detail-name">{requirements.find(requirement => requirement.id === result.requirementId)?.name ?? "Requirement with no recorded name"}</p><pre className="check-output">{result.run.output}</pre></div>)}</details>}
    </>}
  </div>;
}

function unique(attempts: readonly CheckSetupAttempt[]): CheckSetupAttempt[] {
  const byId = new Map<string, CheckSetupAttempt>();
  for (const attempt of attempts) byId.set(attempt.id, attempt);
  return [...byId.values()];
}

/** The task's actual latest pointer and its earlier immutable observations; never a live readiness claim. */
export function CheckSetupObservations({ latest, invalidated, history = [], title = "Local setup" }: {
  latest?: CheckSetupAttempt; invalidated?: CheckSetupInvalidation; history?: readonly CheckSetupAttempt[]; title?: string;
}) {
  const earlier = unique(history).filter(attempt => attempt.id !== latest?.id).reverse();
  return <section className="sheet-section check-setup-observations" aria-label={title}>
    <h2>{title}</h2><p className="quiet-text">Latest recorded observation</p><Observation attempt={latest} invalidated={invalidated} />
    {earlier.length > 0 && <details className="setup-history"><summary>Earlier setup observations ({earlier.length})</summary>{earlier.map(attempt => <div
      className="setup-history-entry"
      key={attempt.id}
    ><Observation attempt={attempt} /></div>)}</details>}
  </section>;
}

/** These records belong only to the selected step, including each owning product and both observation phases. */
export function StepCheckSetups({ attempts, productName }: { attempts: readonly CheckSetupAttempt[]; productName: (id: string) => string }) {
  const grouped = new Map<string, CheckSetupAttempt[]>();
  for (const attempt of unique(attempts)) grouped.set(attempt.productId, [...(grouped.get(attempt.productId) ?? []), attempt]);
  if (!grouped.size) return <div className="journey-context"><h4>Local setup</h4><p className="note">No local setup observation was recorded for this step.</p></div>;
  return <div className="journey-context check-setup-observations"><h4>Local setup recorded for this step</h4>{[...grouped].map(([productId, records]) => <div
    className="setup-product"
    key={productId}
  >
    <h5>{productName(productId)}</h5><p className="quiet-text">Latest recorded for this step</p><Observation attempt={records.at(-1)} />
    {records.length > 1 && <details className="setup-history"><summary>Earlier observations for this product ({records.length - 1})</summary>{records.slice(
      0,
      -1
    ).reverse().map(attempt => <div
      className="setup-history-entry"
      key={attempt.id}
    ><Observation attempt={attempt} /></div>)}</details>}
  </div>)}</div>;
}
