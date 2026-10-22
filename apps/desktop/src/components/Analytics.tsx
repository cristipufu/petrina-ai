import { useEffect, useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import { OVER_TIME_SPLITS, count, durationText, runningTotal, tokenNumber, type AnalyticsUsage, type OverTimeMeasure, type OverTimeSeries, type OverTimeSplit, type SquadRow, type State, type WorkUsageLine, type UsagePeriod } from "@petrina/core";
import { type Lookup } from "../lib";
import { useUsage } from "../usage";
import { BarsOverTime, ViewToggle, dayWords, type BarPoint, type ChartSeries } from "./Charts";
import { AboutNote, UsageList, ColumnChart, FigureText, SplitList, Stat, modelColors, providerColor, toolColor } from "./Usage";
import { LimitHistory } from "./LimitHistory";
import { ReviewsPanel } from "./Reviews";

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
  const [choices, setChoices] = useState<Choices>({ measure: "tokens", split: "tool", table: false, details: false, squadDetails: false });
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
            {scope} · what the squad used {words}.
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

      <section className="analytics-section usage-limits-section" aria-labelledby="analytics-limits">
      <header className="analytics-section-heading">
        <h2 id="analytics-limits">Usage limits</h2>
        <p className="muted small">These account limits are shared across products and sessions, including work outside Petrina.</p>
      </header>
      <UsageList state={state} expanded />
      <LimitHistory history={view?.limits} period={period} />
      </section>

      {!view ? (
        <div className="empty-state">Adding up the work log…</div>
      ) : (
        <>
          <Usage view={view} state={state} find={find} showAbout={showAbout} onAbout={() => setShowAbout((on) => !on)} noteRef={noteRef} onOpen={onOpen} period={period} choices={choices} onChoices={setChoices} />
          <Squad view={view} details={choices.squadDetails} onDetails={(squadDetails) => setChoices((all) => ({ ...all, squadDetails }))} />
        </>
      )}
      <section className="analytics-section analytics-reviews" aria-labelledby="analytics-reviews">
        <header className="analytics-section-heading">
          <h2 id="analytics-reviews">How reviews are going</h2>
          <p className="muted small">{scope} · all recorded reviews, across all dates.</p>
        </header>
        <ReviewsPanel tasks={productId ? state.tasks.filter((task) => task.productId === productId) : state.tasks} roles={state.roles} find={find} history={productId ? state.history?.reviewsByProduct[productId] : state.history?.reviews} />
      </section>
    </div>
  );
}

type Split = "tool" | "model" | "role" | "product" | "task";

/** What the coordinator chose to see: the chart's measure and split, chart or table, the details, and the extra split. */
interface Choices {
  measure: OverTimeMeasure;
  split: OverTimeSplit;
  table: boolean;
  details: boolean;
  extra?: Split;
  squadDetails: boolean;
}

const MEASURE_WORDS: Record<OverTimeMeasure, string> = { tokens: "Tokens", input: "New input", cacheRead: "Reused input", output: "Output", time: "Agent time" };
const SPLIT_WORDS: Record<OverTimeSplit, string> = { tool: "By tool", model: "By model", provider: "By provider" };

/** Fixed colours per series: the tool's, the provider's, or one per model. */
function seriesColors(split: OverTimeSplit, series: readonly OverTimeSeries[]): ChartSeries[] {
  const models = split === "model" ? modelColors(series.map((entry) => entry.label)) : undefined;
  return series.map((entry) => ({ key: entry.key, label: entry.label, color: models ? models.get(entry.label)! : split === "tool" ? toolColor(entry.toolId) : providerColor(entry.providerId) }));
}

function Usage({ view, state, find, showAbout, onAbout, noteRef, onOpen, period, choices, onChoices }: { view: AnalyticsUsage; state: State; find: Lookup; showAbout: boolean; onAbout: () => void; noteRef: React.RefObject<HTMLDivElement | null>; onOpen: (taskId: string) => void; period: UsagePeriod; choices: Choices; onChoices: (update: (all: Choices) => Choices) => void }) {
  const { split, table, details, extra } = choices;
  // A part the period's records don't carry falls back to all tokens.
  const measure: OverTimeMeasure = view.overTime.measures.includes(choices.measure) ? choices.measure : "tokens";
  const setMeasure = (value: OverTimeMeasure) => onChoices((all) => ({ ...all, measure: value }));
  const setSplit = (value: OverTimeSplit) => onChoices((all) => ({ ...all, split: value }));
  const setTable = (value: boolean) => onChoices((all) => ({ ...all, table: value }));
  const setDetails = (value: boolean) => onChoices((all) => ({ ...all, details: value }));
  const setExtra = (pick: (on: Split | undefined) => Split | undefined) =>
    onChoices((all) => {
      const next = pick(all.extra);
      const { extra: _extra, ...rest } = all;
      return next ? { ...rest, extra: next } : rest;
    });
  const { headline } = view;

  const { overTime } = view;
  const shown = overTime.splits[split];
  const series = useMemo(() => seriesColors(split, shown.series), [split, shown.series]);
  const points = useMemo(
    (): BarPoint[] =>
      shown.points.map((point) => ({
        key: String(point.start),
        label: point.label,
        title: overTime.hourly ? `${point.label}:00` : dayWords(point.start),
        values: Object.fromEntries(Object.entries(point.values).map(([key, amounts]) => [key, amounts[measure]])),
        missing: Object.fromEntries(Object.entries(point.values).map(([key, amounts]) => [key, amounts.missing?.[measure] ?? false])),
      })),
    [shown, overTime.hourly, measure],
  );
  const running = useMemo(() => runningTotal(shown.points, measure), [shown, measure]);
  const format = measure === "time" ? shortDuration : tokenNumber;

  const roleColor = (line: WorkUsageLine) => `var(--t-${find.role(line.roleId)?.tone ?? "slate"})`;
  const productColor = (line: WorkUsageLine) => `var(--t-${find.product(line.productId)?.tone ?? "slate"})`;
  const lineTool = (line: WorkUsageLine) => toolColor(line.toolId);

  return (
    <section className="analytics-section" aria-labelledby="analytics-tokens">
      <header className="analytics-section-heading with-tools">
        <h2 id="analytics-tokens">Tokens and agent time</h2>
        <button className="linkish about-link" onClick={onAbout} aria-expanded={showAbout}>
          <Info size={12} />
          About these numbers
        </button>
      </header>
      {showAbout && (
        <div ref={noteRef}>
          <AboutNote about={view.about} period={period} />
        </div>
      )}
      <div className="stats">
        <Stat label="Tokens" value={<FigureText figure={headline.tokens} kind="tokens" bare />} sub="new input, cache reads and writes, and output" />
        <Stat label="Agent time" value={<FigureText figure={headline.time} kind="time" />} sub="adds up agents running at once" />
        <Stat label="Agent turns" value={<span className="num">{headline.turns}</span>} sub="finished or stopped, including interrupted turns" />
        <Stat label="Tasks worked on" value={<span className="num">{headline.tasks}</span>} />
      </div>
      <p className="muted small">Tokens and time are counted when an agent's turn ends.</p>


      <div className="chart-head tokens row between wrap">
        <span className="muted small">
          {MEASURE_WORDS[measure]} {overTime.hourly ? "per hour, today" : "per day"}, {SPLIT_WORDS[split].toLowerCase()}, with the running total
        </span>
        <div className="chart-controls">
          <div className="segmented small" role="tablist" aria-label="What the chart shows">
            {overTime.measures.map((entry) => (
              <button key={entry} role="tab" aria-selected={measure === entry} className={measure === entry ? "on" : ""} onClick={() => setMeasure(entry)}>
                {MEASURE_WORDS[entry]}
              </button>
            ))}
          </div>
          <div className="segmented small" role="tablist" aria-label="How the chart is split">
            {OVER_TIME_SPLITS.map((entry) => (
              <button key={entry} role="tab" aria-selected={split === entry} className={split === entry ? "on" : ""} onClick={() => setSplit(entry)}>
                {SPLIT_WORDS[entry]}
              </button>
            ))}
          </div>
          <ViewToggle table={table} onTable={setTable} label="Tokens as a chart or a table" />
        </div>
      </div>
      <BarsOverTime
        points={points}
        series={series}
        format={format}
        formatDetail={measure === "time" ? durationText : (value) => value.toLocaleString()}
        missingWord={measure === "time" ? "not known" : "not reported"}
        label={`${MEASURE_WORDS[measure]} ${overTime.hourly ? "per hour" : "per day"}, ${SPLIT_WORDS[split].toLowerCase()}`}
        running={{ label: "Running total", values: running }}
        table={table}
        periodWord={overTime.hourly ? "Hour" : "Day"}
        measureWord={MEASURE_WORDS[measure]}
      />

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
          // Archived task bodies are read only when opened. Removed products have no details left.
          canPick={(line) => line.taskId !== undefined && line.note !== "removed" && (state.tasks.some((task) => task.id === line.taskId) || Boolean(state.history && line.productId && state.products.some((product) => product.id === line.productId)))}
          onPick={(line) => line.taskId && onOpen(line.taskId)}
        />
      )}
      <div className={`splits ${details ? "stacked" : ""}`}>
        <SplitList title="By role" lines={view.byRole} color={roleColor} details={details} />
        <SplitList title="By tool" lines={view.byTool} color={lineTool} details={details} />
        <SplitList title="By model" lines={view.byModel} color={lineTool} details={details} />
      </div>
    </section>
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
    <section className="analytics-section" aria-labelledby="analytics-squad">
      <header className="analytics-section-heading"><h2 id="analytics-squad">How the squad works</h2></header>
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
    </section>
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
