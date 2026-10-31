import {
  count,
  durationText,
  type AnalyticsThroughput,
  type Id,
  type State,
  type ThroughputPhase,
} from "@petrina/core";
import { Stat } from "./Usage";

interface ThroughputProps {
  throughput: AnalyticsThroughput;
  state: State;
  scope: string;
  words: string;
  onOpen: (taskId: string) => void;
}

const PHASE_COLORS: Readonly<Record<ThroughputPhase["key"], string>> = {
  "agent-work": "var(--blue)",
  "check-execution": "var(--teal, var(--green))",
  "waiting-for-checks": "var(--amber)",
  "coordinator-decisions": "var(--violet, var(--accent))",
  prerequisites: "var(--indigo, var(--slate))",
  availability: "var(--orange, var(--amber))",
};

function asOfWords(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function zeroAwareDuration(ms: number): string {
  return ms <= 0 ? "0m" : durationText(ms);
}

function canOpenTask(state: State, taskId: Id, productId: Id, removedProduct: boolean): boolean {
  if (removedProduct) return false;
  return (
    state.tasks.some((task) => task.id === taskId) ||
    Boolean(state.history && state.products.some((product) => product.id === productId))
  );
}

export function ThroughputSection({ throughput, state, scope, words, onOpen }: ThroughputProps) {
  const { coverage, delivery, phases, capacity, repeatedWork, holdingUpNow } = throughput;
  const { checkSlot, agentPool } = capacity;
  const { checks, builderReturns, reviewsAndUpdates, cyclingTasks } = repeatedWork;

  const landedParts = [
    delivery.landedPerDay !== undefined ? `${delivery.landedPerDay}/day` : "under an hour elapsed",
    delivery.sharedLanded > 0 ? `${delivery.sharedLanded} shared` : "",
    delivery.awaitingMerge > 0 ? `${delivery.awaitingMerge} awaiting PR merge` : "none awaiting merge",
  ].filter(Boolean);

  const checkSubParts = [
    `${zeroAwareDuration(checkSlot.occupiedWallMs)} busy across ${count(checkSlot.configuredSlots, "slot")}`,
    `${count(checkSlot.completedBatches, "completed run")}${
      checkSlot.medianBatchMs !== undefined
        ? ` (median ${durationText(checkSlot.medianBatchMs)}${
            checkSlot.p90BatchMs !== undefined ? `, 90% within ${durationText(checkSlot.p90BatchMs)}` : ""
          })`
        : ""
    }`,
  ];

  const outcomeParts: string[] = [];
  if (delivery.createdToDelivery.medianMs !== undefined) {
    outcomeParts.push(
      `End-to-end created to delivery: median ${durationText(delivery.createdToDelivery.medianMs)}${
        delivery.createdToDelivery.p90Ms !== undefined
          ? ` (90% within ${durationText(delivery.createdToDelivery.p90Ms)})`
          : ""
      }`,
    );
  }
  if (delivery.inProgress > 0) {
    outcomeParts.push(
      `${delivery.inProgress} in progress${delivery.queued > 0 ? ` (${delivery.queued} waiting to start)` : ""}`,
    );
  }
  if (delivery.prsOpenedInWindow > 0) {
    outcomeParts.push(`${count(delivery.prsOpenedInWindow, "pull request")} opened`);
  }
  if (delivery.unfinishedPushes > 0) {
    outcomeParts.push(`${count(delivery.unfinishedPushes, "unfinished push", "unfinished pushes")}`);
  }
  if (delivery.noChanges > 0) {
    outcomeParts.push(`${delivery.noChanges} finished with no product changes`);
  }
  if (delivery.markedDone > 0) {
    outcomeParts.push(`${delivery.markedDone} marked done without confirmed delivery`);
  }
  if (delivery.closedWithoutMerge > 0) {
    outcomeParts.push(`${delivery.closedWithoutMerge} closed without merge`);
  }
  if (delivery.cancelled > 0) {
    outcomeParts.push(`${delivery.cancelled} cancelled`);
  }
  if (delivery.combined > 0) {
    outcomeParts.push(`${delivery.combined} combined`);
  }

  const maxPhaseWall = Math.max(1, ...phases.map((phase) => phase.wallMs));

  const poolParts = [
    `Agents were active for ${zeroAwareDuration(agentPool.activeWallMs)} of wall time (${zeroAwareDuration(agentPool.summedAgentMs)} summed across parallel runs)`,
    agentPool.slotShare !== undefined
      ? `using ${Math.round(agentPool.slotShare * 100)}% of ${count(agentPool.currentPoolLimit, "configured slot")}`
      : `${count(agentPool.currentPoolLimit, "configured slot")}`,
    agentPool.meanConcurrencyWhenBusy !== undefined ? `${agentPool.meanConcurrencyWhenBusy}x average concurrency while busy` : "",
    agentPool.poolPausedNow ? "pool paused right now" : "",
  ].filter(Boolean);

  return (
    <section className="analytics-section throughput-section" aria-labelledby="analytics-throughput">
      <header className="analytics-section-heading">
        <h2 id="analytics-throughput">Throughput and bottlenecks</h2>
        <p className="muted small">
          {scope} · delivery, waits and bottlenecks {words}, as of {asOfWords(coverage.asOf)}.
        </p>
      </header>

      <div className="stats">
        <Stat
          label="Confirmed landed"
          value={<span className="num">{delivery.landed}</span>}
          sub={landedParts.join(" · ")}
        />
        <Stat
          label="Wait before start"
          value={
            delivery.createdToStart.medianMs !== undefined ? (
              <span className="num">{durationText(delivery.createdToStart.medianMs)}</span>
            ) : (
              <span className="muted">not recorded</span>
            )
          }
          sub={
            delivery.createdToStart.p90Ms !== undefined
              ? `median · 90% within ${durationText(delivery.createdToStart.p90Ms)}`
              : delivery.landed > 0
                ? "start time not recorded"
                : "no landed tasks"
          }
        />
        <Stat
          label="Start to delivery"
          value={
            delivery.startToDelivery.medianMs !== undefined ? (
              <span className="num">{durationText(delivery.startToDelivery.medianMs)}</span>
            ) : (
              <span className="muted">not recorded</span>
            )
          }
          sub={
            delivery.startToDelivery.p90Ms !== undefined
              ? `median · 90% within ${durationText(delivery.startToDelivery.p90Ms)}`
              : delivery.landed > 0
                ? "start time not recorded"
                : "no landed tasks"
          }
        />
        <Stat
          label="Shared check line"
          value={
            <span className="num">
              {checkSlot.occupancyShare !== undefined
                ? `${Math.round(checkSlot.occupancyShare * 100)}%`
                : zeroAwareDuration(checkSlot.occupiedWallMs)}
            </span>
          }
          sub={checkSubParts.join(" · ")}
        />
      </div>

      {outcomeParts.length > 0 && <p className="muted small throughput-outcomes">{outcomeParts.join(" · ")}.</p>}
      {coverage.notes.length > 0 && <p className="muted small throughput-coverage">{coverage.notes.join(" ")}</p>}

      <div className="throughput-grid">
        <section className="split">
          <h3>Where time and waits went</h3>
          <div className="split-rows">
            {phases.map((phase) => {
              const parallelExtra =
                phase.summedMs > phase.wallMs
                  ? `${durationText(phase.summedMs)} across ${count(phase.taskCount, "task")}`
                  : phase.taskCount > 0
                    ? count(phase.taskCount, "task")
                    : phase.available
                      ? "none"
                      : "not separately timed";
              return (
                <div key={phase.key} className="split-row kinds">
                  <span className="who">
                    <span className="name">
                      {phase.label}
                      {phase.partial && phase.wallMs > 0 ? <span className="muted small">· partial</span> : null}
                      {phase.note ? <span className="context">· {phase.note}</span> : null}
                    </span>
                    <span className="bar" aria-hidden="true">
                      <i
                        style={{
                          width: `${phase.wallMs > 0 ? Math.max(2, (phase.wallMs / maxPhaseWall) * 100) : 0}%`,
                          background: PHASE_COLORS[phase.key],
                        }}
                      />
                    </span>
                  </span>
                  <span className="num">{zeroAwareDuration(phase.wallMs)}</span>
                  <span className="num muted">{parallelExtra}</span>
                </div>
              );
            })}
          </div>
          <p className="muted small throughput-pool-line">{poolParts.join(", ")}.</p>
        </section>

        <section className="split">
          <h3>Repeated work and recorded causes</h3>
          <ul className="plain">
            <li>
              <strong>Automated checks.</strong>{" "}
              {checks.executedBatches === 0 && checks.reusedPassedBatches === 0 && checks.reusedFailedBatches === 0 ? (
                "No check runs or cached check reuses in this period."
              ) : (
                <>
                  {count(checks.executedBatches, "fresh check run")} ({checks.failedBatches} failed
                  {checks.interruptedOrUnverifiedBatches > 0
                    ? `, ${checks.interruptedOrUnverifiedBatches} unfinished`
                    : ""}
                  ), {count(checks.reusedPassedBatches, "reused pass", "reused passes")} and{" "}
                  {count(checks.reusedFailedBatches, "reused cached failure")}.
                  {checks.freshReasons.length > 0
                    ? ` Recorded fresh-run reasons: ${checks.freshReasons
                        .slice(0, 4)
                        .map((entry) => `${entry.label.toLowerCase()} (${entry.count})`)
                        .join(", ")}.`
                    : ""}
                </>
              )}
            </li>
            <li>
              <strong>Builder returns.</strong>{" "}
              {builderReturns.total === 0 ? (
                "No tasks returned to a build role after an initial build."
              ) : (
                <>
                  {count(builderReturns.total, "return to build", "returns to build")} (
                  {builderReturns.byCause.map((entry) => `${entry.label.toLowerCase()}: ${entry.count}`).join(", ")})
                  {builderReturns.unchangedSourceReturns > 0
                    ? `, including ${count(builderReturns.unchangedSourceReturns, "return")} with no source changes`
                    : ""}
                  .
                </>
              )}
            </li>
            <li>
              <strong>Reviews and branch updates.</strong>{" "}
              {reviewsAndUpdates.reviewRounds === 0 &&
              reviewsAndUpdates.mainUpdates === 0 &&
              reviewsAndUpdates.reopenedFindings === 0 ? (
                "No finished review rounds or branch updates in this period."
              ) : (
                <>
                  {count(reviewsAndUpdates.reviewRounds, "review round")} ({reviewsAndUpdates.reviewSendBacks} sent work
                  back)
                  {reviewsAndUpdates.reopenedFindings > 0
                    ? `, ${count(reviewsAndUpdates.reopenedFindings, "reopened finding")}`
                    : ""}
                  {reviewsAndUpdates.mainUpdates > 0
                    ? `, ${count(reviewsAndUpdates.mainUpdates, "branch update")}`
                    : ""}
                  {reviewsAndUpdates.portReviews > 0 ? `, ${count(reviewsAndUpdates.portReviews, "port review")}` : ""}.
                </>
              )}
            </li>
          </ul>
          <p className="muted small throughput-honesty">
            Repeated failures can reflect product defects, test fixtures or setup issues; Petrina only reports recorded
            triggers and outcomes.
          </p>
          {cyclingTasks.length > 0 && (
            <div className="throughput-sublist">
              <div className="throughput-subhead">Most repeated check and repair cycles</div>
              <div className="split-rows">
                {cyclingTasks.map((item) => {
                  const openable = canOpenTask(state, item.taskId, item.productId, item.removedProduct);
                  return (
                    <div key={item.taskId} className={`split-row throughput-task-row ${openable ? "pick" : ""}`}>
                      <span className="who">
                        <span className="name">
                          {openable ? (
                            <button className="split-open" onClick={() => onOpen(item.taskId)}>
                              {item.title}
                            </button>
                          ) : (
                            item.title
                          )}
                          <span className="context">· {item.productLabel}</span>
                          {item.removedProduct ? <span className="usage-note">removed</span> : null}
                        </span>
                      </span>
                      <span className="muted small">{item.summary}</span>
                      <span className="muted small">{item.state === "done" ? "finished" : item.state}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="split throughput-now" aria-labelledby="throughput-holding-now">
        <h3 id="throughput-holding-now">Holding progress up now</h3>
        {holdingUpNow.pressures.length > 0 && (
          <ul className="plain throughput-pressures">
            {holdingUpNow.pressures.map((pressure) => (
              <li key={pressure.key}>
                <strong>{pressure.label}.</strong>{" "}
                {pressure.hypothesis ? <span className="throughput-badge">Hypothesis</span> : null} {pressure.detail}
              </li>
            ))}
          </ul>
        )}
        {holdingUpNow.tasks.length === 0 ? (
          <div className="muted small">No active tasks are blocked or aging right now.</div>
        ) : (
          <div className="split-rows">
            {holdingUpNow.tasks.map((item) => {
              const openable = canOpenTask(state, item.taskId, item.productId, item.removedProduct);
              const ageWords =
                item.startedAgeMs !== undefined
                  ? `Started ${durationText(item.startedAgeMs)} ago`
                  : item.queuedAgeMs !== undefined
                    ? `Queued ${durationText(item.queuedAgeMs)} ago`
                    : "Just created";
              return (
                <div key={item.taskId} className={`split-row throughput-blocker-row ${openable ? "pick" : ""}`}>
                  <span className="who">
                    <span className="name">
                      {openable ? (
                        <button className="split-open" onClick={() => onOpen(item.taskId)}>
                          {item.title}
                        </button>
                      ) : (
                        item.title
                      )}
                      <span className="context">· {item.productLabel}</span>
                      <span className="throughput-tag">{item.label}</span>
                      {item.hypothesis ? <span className="throughput-badge">Hypothesis</span> : null}
                    </span>
                    <span className="muted small">{item.detail}</span>
                  </span>
                  <span className="num small">{ageWords}</span>
                  <span className="muted small">{item.evidence}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}
