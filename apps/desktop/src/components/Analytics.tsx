import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Info } from "lucide-react";
import { count, durationText, tokenNumber, type AnalyticsUsage, type SquadRow, type State, type WorkUsageLine, type UsagePeriod } from "@petrina/core";
import { type Lookup } from "../lib";
import { useUsage } from "../usage";
import { AboutNote, UsageList, ColumnChart, FigureText, SplitList, Stat, toolColor } from "./Usage";

const PERIODS: readonly { id: UsagePeriod; label: string; words: string }[] = [
  { id: "today", label: "Today", words: "today" },
  { id: "7d", label: "7 days", words: "in the last 7 days" },
  { id: "30d", label: "30 days", words: "in the last 30 days" },
];

interface Props {
  state: State;
  find: Lookup;
  /** "all", or the product chosen in the switcher. */
  product: string;
  /** Open the "About these numbers" note (the task sheet links here). */
  about: boolean;
  onAboutSeen: () => void;
  onOpen: (taskId: string) => void;
}

/** What the whole squad used and how it works: limits first, then tokens and time, then the squad. */
export function AnalyticsPage({ state, find, product, about, onAboutSeen, onOpen }: Props) {
  const [period, setPeriod] = useState<UsagePeriod>("7d");
  const [showAbout, setShowAbout] = useState(about);
  // Kept here, so they stay as chosen while another period's numbers load.
  const [choices, setChoices] = useState<Choices>({ measure: "tokens", details: false, squadDetails: false });
  const productId = product !== "all" && state.products.some((entry) => entry.id === product) ? product : undefined;
  const view = useUsage({ view: "analytics", period, ...(productId ? { productId } : {}) }, state);
  const noteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!about) return;
    setShowAbout(true);
    onAboutSeen();
  }, [about, onAboutSeen]);

  useEffect(() => {
    if (showAbout && about) noteRef.current?.scrollIntoView({ block: "center" });
  }, [showAbout, about, view]);

  const words = PERIODS.find((entry) => entry.id === period)!.words;
  const scope = productId ? find.product(productId)?.name : "All products";

  return (
    <div className="page analytics">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>
            {scope} · what the squad used {words}. Tokens and time, no prices.
          </p>
        </div>
        <div className="tools">
          <div className="segmented" role="tablist" aria-label="Period">
            {PERIODS.map((entry) => (
              <button key={entry.id} role="tab" aria-selected={period === entry.id} className={period === entry.id ? "on" : ""} onClick={() => setPeriod(entry.id)}>
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="section-title">Usage limits</div>
      <UsageList state={state} expanded />

      {!view ? (
        <div className="empty-state">Adding up the work log…</div>
      ) : (
        <>
          <Usage view={view} state={state} find={find} showAbout={showAbout} onAbout={() => setShowAbout((on) => !on)} noteRef={noteRef} onOpen={onOpen} period={period} choices={choices} onChoices={setChoices} />
          <Squad view={view} details={choices.squadDetails} onDetails={(squadDetails) => setChoices((all) => ({ ...all, squadDetails }))} />
        </>
      )}
    </div>
  );
}

type Split = "tool" | "model" | "role" | "product" | "task";

/** What the coordinator chose to see: the chart's measure, the details, and the extra split. */
interface Choices {
  measure: "tokens" | "time";
  details: boolean;
  extra?: Split;
  squadDetails: boolean;
}

function Usage({ view, state, find, showAbout, onAbout, noteRef, onOpen, period, choices, onChoices }: { view: AnalyticsUsage; state: State; find: Lookup; showAbout: boolean; onAbout: () => void; noteRef: React.RefObject<HTMLDivElement | null>; onOpen: (taskId: string) => void; period: UsagePeriod; choices: Choices; onChoices: (update: (all: Choices) => Choices) => void }) {
  const { measure, details, extra } = choices;
  const setMeasure = (value: Choices["measure"]) => onChoices((all) => ({ ...all, measure: value }));
  const setDetails = (value: boolean) => onChoices((all) => ({ ...all, details: value }));
  const setExtra = (pick: (on: Split | undefined) => Split | undefined) =>
    onChoices((all) => {
      const next = pick(all.extra);
      const { extra: _extra, ...rest } = all;
      return next ? { ...rest, extra: next } : rest;
    });
  const { headline } = view;

  const legend = view.chart.tools.map((tool) => ({ key: tool.toolId, label: tool.label, color: toolColor(tool.toolId) }));
  const buckets = useMemo(
    () =>
      view.chart.buckets.map((bucket) => ({
        key: String(bucket.start),
        label: bucket.label,
        segments: view.chart.tools.map((tool) => ({ key: tool.toolId, label: tool.label, color: toolColor(tool.toolId), value: (measure === "tokens" ? bucket.tokens : bucket.timeMs)[tool.toolId] ?? 0 })),
      })),
    [view, measure],
  );

  const roleColor = (line: WorkUsageLine) => `var(--t-${find.role(line.roleId)?.tone ?? "slate"})`;
  const productColor = (line: WorkUsageLine) => `var(--t-${find.product(line.productId)?.tone ?? "slate"})`;
  const lineTool = (line: WorkUsageLine) => toolColor(line.toolId);

  return (
    <>
      <div className="section-title row between">
        <span>Tokens and agent time</span>
        <button className="linkish about-link" onClick={onAbout} aria-expanded={showAbout}>
          <Info size={12} />
          About these numbers
        </button>
      </div>
      {showAbout && (
        <div ref={noteRef}>
          <AboutNote about={view.about} period={period} />
        </div>
      )}
      <div className="stats">
        <Stat label="Tokens" value={<FigureText figure={headline.tokens} kind="tokens" bare />} sub="input, reused input and output" />
        <Stat label="Agent time" value={<FigureText figure={headline.time} kind="time" />} sub="adds up agents running at once" />
        <Stat label="Turns" value={<span className="num">{headline.turns}</span>} sub="messages to an agent and its replies" />
        <Stat label="Tasks worked on" value={<span className="num">{headline.tasks}</span>} />
      </div>
      {view.atLeast && (
        <div className="at-least">
          <CircleAlert size={13} />
          {view.atLeast}
        </div>
      )}

      <div className="chart-head row between">
        <span className="muted small">{measure === "tokens" ? "Tokens" : "Agent time"} {view.chart.hourly ? "per hour, today" : "per day"}, by tool</span>
        <div className="segmented small" role="tablist" aria-label="What the chart shows">
          <button role="tab" aria-selected={measure === "tokens"} className={measure === "tokens" ? "on" : ""} onClick={() => setMeasure("tokens")}>
            Tokens
          </button>
          <button role="tab" aria-selected={measure === "time"} className={measure === "time" ? "on" : ""} onClick={() => setMeasure("time")}>
            Agent time
          </button>
        </div>
      </div>
      <ColumnChart buckets={buckets} legend={legend} label={`${measure === "tokens" ? "Tokens" : "Agent time"} by tool`} format={measure === "tokens" ? tokenNumber : shortDuration} />

      <div className="splits-head row between">
        <div className="row">
          <button className={`btn small ${extra === "product" ? "on" : ""}`} disabled={!view.byProduct} title={view.byProduct ? undefined : "Showing one product"} onClick={() => setExtra((on) => (on === "product" ? undefined : "product"))} aria-pressed={extra === "product"}>
            By product
          </button>
          <button className={`btn small ${extra === "task" ? "on" : ""}`} onClick={() => setExtra((on) => (on === "task" ? undefined : "task"))} aria-pressed={extra === "task"}>
            By task
          </button>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={details} onChange={(event) => setDetails(event.target.checked)} />
          Show details
        </label>
      </div>
      {extra === "product" && view.byProduct && <SplitList title="By product" lines={view.byProduct} color={productColor} details={details} />}
      {extra === "task" && (
        <SplitList
          title="By task"
          lines={view.byTask}
          color={productColor}
          details={details}
          limit={10}
          // Only a task still on the board has a sheet to open.
          canPick={(line) => line.taskId !== undefined && state.tasks.some((task) => task.id === line.taskId)}
          onPick={(line) => line.taskId && onOpen(line.taskId)}
        />
      )}
      <div className={`splits ${details ? "stacked" : ""}`}>
        <SplitList title="By tool" lines={view.byTool} color={lineTool} details={details} />
        <SplitList title="By model" lines={view.byModel} color={lineTool} details={details} />
        <SplitList title="By role" lines={view.byRole} color={roleColor} details={details} />
      </div>
    </>
  );
}

const shortDuration = (ms: number) => {
  const text = durationText(ms);
  return text === "under a minute" ? "<1m" : text;
};

function Squad({ view, details, onDetails }: { view: AnalyticsUsage; details: boolean; onDetails: (on: boolean) => void }) {
  const squad = view.squad;
  const buckets = squad.chart.map((bucket) => ({
    key: String(bucket.start),
    label: bucket.label,
    segments: [
      { key: "delivered", label: "Delivered", value: bucket.delivered, color: "var(--green)" },
      { key: "cancelled", label: "Cancelled", value: bucket.cancelled, color: "var(--slate)" },
    ],
  }));
  const longest = Math.max(1, ...squad.stageKinds.map((kind) => kind.typicalMs));
  return (
    <>
      <div className="section-title">How the squad works</div>
      <div className="stats">
        <Stat label="Stages run" value={<span className="num">{squad.stagesRun}</span>} />
        <Stat label="Turns run" value={<span className="num">{squad.turnsRun}</span>} />
        <Stat label="Tasks delivered" value={<span className="num">{squad.delivered}</span>} />
        <Stat label="Tasks cancelled" value={<span className="num">{squad.cancelled}</span>} />
      </div>
      <div className="chart-head">
        <span className="muted small">Tasks delivered and cancelled per day</span>
      </div>
      <ColumnChart
        buckets={buckets}
        legend={[
          { key: "delivered", label: "Delivered", color: "var(--green)" },
          { key: "cancelled", label: "Cancelled", color: "var(--slate)" },
        ]}
        label="Tasks delivered and cancelled"
        format={(value) => String(value)}
      />

      <div className="squad-grid">
        <section className="split">
          <h3>How long each kind of stage usually takes</h3>
          {squad.stageKinds.length === 0 ? (
            <div className="muted small">No stages finished in this period.</div>
          ) : (
            <div className="split-rows">
              {squad.stageKinds.map((kind) => (
                <div key={kind.key} className="split-row kinds">
                  <span className="who">
                    <span className="name">
                      {kind.label} <span className="muted small">· {count(kind.runs, "run")}</span>
                    </span>
                    <span className="bar" aria-hidden="true">
                      <i style={{ width: `${(kind.typicalMs / longest) * 100}%`, background: "var(--accent)" }} />
                    </span>
                  </span>
                  <span className="num">{durationText(kind.typicalMs)}</span>
                  <span className="num muted">{kind.agentShare === undefined ? "agent work not reported" : `${Math.round(kind.agentShare * 100)}% agent work`}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="split">
          <h3>In plain words</h3>
          <ul className="plain">
            <li>
              <strong>Reviews.</strong> {squad.sendBacks}
            </li>
            <li>
              <strong>Designs.</strong> {squad.designRounds}
            </li>
            <li>
              <strong>Asking you.</strong> {squad.asks}
            </li>
            <li>
              <strong>Failures.</strong> {squad.failures}
            </li>
          </ul>
          <button className="linkish" onClick={() => onDetails(!details)} aria-expanded={details}>
            {details ? "Hide the details" : "Details per reviewer and per profile"}
          </button>
        </section>
      </div>

      {details && (
        <div className="squad-details">
          <p className="muted small">{squad.details.settingsLine}</p>
          <ProfileTable title="Code and Security reviewers" rows={squad.details.reviewers} columns={[["Reviews", (row) => row.rounds], ["Blocking findings", (row) => row.blocking], ["Asked for fixes", (row) => row.sentBack]]} />
          <ProfileTable title="Architects" rows={squad.details.architects} columns={[["Design rounds", (row) => row.rounds], ["Designs", (row) => row.designs], ["Came to you", (row) => row.sentBack]]} />
          <ProfileTable title="Design reviewers" rows={squad.details.designReviewers} columns={[["Design rounds", (row) => row.rounds], ["Blocking objections", (row) => row.blocking]]} />
          <section className="split">
            <h3>Failures and retries</h3>
            <ul className="plain">
              {squad.details.failuresByReason.length === 0 ? <li>No failures.</li> : squad.details.failuresByReason.map((entry) => <li key={entry.label}>{`${entry.count} × ${entry.label}`}</li>)}
              <li>{count(squad.details.retries, "retry", "retries")}</li>
              <li>{count(squad.details.redone, "result", "results")} an agent had to redo</li>
              <li>{count(squad.details.interrupted, "interrupted turn")}</li>
            </ul>
          </section>
        </div>
      )}
    </>
  );
}

function ProfileTable({ title, rows, columns }: { title: string; rows: readonly SquadRow[]; columns: readonly [string, (row: SquadRow) => number][] }) {
  if (rows.length === 0) return null;
  return (
    <section className="split wide">
      <h3>{title}</h3>
      <div className="split-rows" role="table" aria-label={title}>
        <div className="split-row head profiles" role="row" style={{ gridTemplateColumns: `minmax(220px, 2fr) repeat(${columns.length + 2}, minmax(80px, 1fr))` }}>
          <span role="columnheader">Ran on</span>
          <span role="columnheader">Stages</span>
          <span role="columnheader">Agent time</span>
          {columns.map(([label]) => (
            <span key={label} role="columnheader">
              {label}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.label} className="split-row profiles" role="row" style={{ gridTemplateColumns: `minmax(220px, 2fr) repeat(${columns.length + 2}, minmax(80px, 1fr))` }}>
            <span role="cell" className={row.credited ? "" : "muted"}>
              {row.label}
            </span>
            <span role="cell" className="num">
              {row.stages}
            </span>
            <span role="cell" className="num">
              <FigureText figure={row.time} kind="time" />
            </span>
            {columns.map(([label, value]) => (
              <span key={label} role="cell" className="num">
                {value(row)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
