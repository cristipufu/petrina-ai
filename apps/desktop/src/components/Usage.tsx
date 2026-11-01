import { useState, type ReactNode } from "react";
import { useLimitClock } from "../usage";
import { TOOL_COLORS } from "../lib";
import {
  CHANGED_LABEL,
  MODEL_FAMILY_CATALOG,
  NOT_CONFIRMED_LABEL,
  displayLimits,
  getProviderDescriptor,
  usageLines,
  usagePauseWords,
  agoText,
  limitWords,
  count,
  figureText,
  tokenNumber,
  type AboutCounts,
  type Figure,
  type WorkUsageLine,
  type State,
  type UsagePeriod,
  TOKEN_PARTS
} from "@petrina/core";

/** Chart colours per tool: the app's tool colours, with their own step in dark mode. */
export const toolColor = (toolId: string | undefined) => (toolId ? `var(--tool-${toolId}, var(--slate))` : "var(--slate)");

/** Chart colours per provider (Anthropic, OpenAI, xAI, Google), with their own step in dark mode. */
export const providerColor = (providerId: string | undefined) => (providerId ? `var(--provider-${providerId}, var(--slate))` : "var(--slate)");

const tone = (name: string) => `var(--t-${name})`;
const hashOf = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

const MODEL_TONES = ["purple", "blue", "teal", "amber", "pink", "green", "orange", "indigo"];

/**
 * One fixed colour per model, so a model keeps its colour whatever else is on the chart. Models
 * Petrina knows have their own; others take a stable colour from their name, moved to the next
 * free one only when two models on the same chart would share it.
 */
export function modelColors(labels: readonly string[]): Map<string, string> {
  const colors = new Map<string, string>();
  const taken = new Set<string>();
  const claim = (label: string, name: string) => {
    colors.set(label, tone(name));
    taken.add(name);
  };
  for (const label of labels) {
    if (label === NOT_CONFIRMED_LABEL || label === "Model not reported") claim(label, "slate");
    else if (label === CHANGED_LABEL) claim(label, "amber");
    else {
      const family = MODEL_FAMILY_CATALOG.find((entry) => entry.pattern.test(label));
      if (family) claim(label, family.tone);
    }
  }
  for (const label of labels) {
    if (colors.has(label)) continue;
    const start = hashOf(label) % MODEL_TONES.length;
    let pick = MODEL_TONES[start]!;
    for (let offset = 0; offset < MODEL_TONES.length; offset += 1) {
      const candidate = MODEL_TONES[(start + offset) % MODEL_TONES.length]!;
      if (!taken.has(candidate)) {
        pick = candidate;
        break;
      }
    }
    claim(label, pick);
  }
  return colors;
}

export function FigureText({ figure, kind, missing, bare }: { figure: Figure; kind: "tokens" | "time"; missing?: string; bare?: boolean }) {
  const text = figureText(figure, kind, { ...(missing ? { missing } : {}), ...(bare ? { bare } : {}) }).replace(/^at least /, "> ");
  // Keep the lower-bound marker next to its number.
  const lead = text.startsWith("> ") ? "> " : "";
  return (
    <span className={`num ${figure.value === undefined ? "muted" : ""}`}>
      {lead && <span>{lead}</span>}
      <span className="figure">{text.slice(lead.length)}</span>
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export interface ColumnBucket {
  key: string;
  label: string;
  /** Bottom to top. */
  segments: { key: string; label: string; value: number; color: string }[];
}

/**
 * Plain columns drawn by the app: stacked by series, a 2px gap between segments, the total
 * on each column's cap, and the numbers on hover.
 */
export function ColumnChart({ buckets, format, legend, label }: {
  buckets: readonly ColumnBucket[];
  format: (value: number) => string;
  legend: readonly {
  key: string;
  label: string;
  color: string
}[];
  label: string
}) {
  const [hover, setHover] = useState<string>();
  const totals = buckets.map((bucket) => bucket.segments.reduce((sum, segment) => sum + segment.value, 0));
  const max = Math.max(1, ...totals);
  const dense = buckets.length > 14;
  return (
    <figure className="columns-figure" aria-label={label}>
      {legend.length > 1 && (
        <figcaption className="legend">
          {legend.map((entry) => (
            <span key={entry.key}>
              <i style={{ background: entry.color }} />
              {entry.label}
            </span>
          ))}
        </figcaption>
      )}
      <div className={`columns ${dense ? "dense" : ""}`} role="list">
        {buckets.map((bucket, index) => {
          const total = totals[index]!;
          const shown = bucket.segments.filter((segment) => segment.value > 0);
          const tip = [bucket.label, ...shown.map((segment) => `${segment.label}: ${format(segment.value)}`)].join(" · ");
          return (
            <div
              key={bucket.key}
              className={`col ${hover === bucket.key ? "on" : ""}`}
              role="listitem"
              aria-label={total > 0 ? tip : `${bucket.label}: nothing`}
              onMouseEnter={() => setHover(bucket.key)}
              onMouseLeave={() => setHover(undefined)}
            >
              <div className="plot">
                {total > 0 && <span className="cap num">{format(total)}</span>}
                <div className="stack" style={{ height: `${(total / max) * 100}%` }}>
                  {shown.map((segment) => (
                    <span key={segment.key} style={{ flexGrow: segment.value, background: segment.color }} />
                  ))}
                </div>
              </div>
              <span className="x">{bucket.label}</span>
              {hover === bucket.key && total > 0 && (
                <div className="tip" role="tooltip">
                  <strong>{bucket.label}</strong>
                  {shown
                    .slice()
                    .reverse()
                    .map((segment) => (
                      <span key={segment.key}>
                        <i style={{ background: segment.color }} />
                        {segment.label} <b className="num">{format(segment.value)}</b>
                      </span>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </figure>
  );
}

const DETAIL_COLUMNS = TOKEN_PARTS;

/** One split: a line per tool, model, role, product or task, largest first, each with a bar. */
export function SplitList({
  title,
  lines,
  color,
  details,
  limit,
  onPick,
  canPick = () => true,
  note,
}: {
  title: string;
  lines: readonly WorkUsageLine[];
  color: (line: WorkUsageLine) => string;
  details: boolean;
  limit?: number;
  onPick?: (line: WorkUsageLine) => void;
  /** Which lines open something: the others are plain rows. */
  canPick?: (line: WorkUsageLine) => boolean;
  note?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...lines.map((line) => line.tokens.value ?? 0));
  const shown = limit && !all ? lines.slice(0, limit) : lines;
  return (
    <section className={`split ${details ? "wide" : ""}`}>
      <h3>{title}</h3>
      {lines.length === 0 ? (
        <div className="muted small">Nothing in this period.</div>
      ) : (
        <div className="split-rows" role="table" aria-label={title}>
          {details && (
            <div className="split-row head" role="row">
              <span role="columnheader" />
              <span role="columnheader">Tokens</span>
              <span role="columnheader">Agent time</span>
              {DETAIL_COLUMNS.map((column) => (
                <span key={column.key} role="columnheader">
                  {column.label}
                </span>
              ))}
            </div>
          )}
          {shown.map((line) => {
            const open = onPick && canPick(line) ? onPick : undefined;
            return (
              <div key={line.key} className={`split-row ${open ? "pick" : ""}`} role="row">
                <span className="who" role="cell">
                  <span className="name">
                    {/* A button stretched over the row, as on a card: it opens with a click, Enter or Space. */}
                    {open ? (
                      <button type="button" className="split-open" onClick={() => open(line)}>
                        {line.label}
                      </button>
                    ) : (
                      line.label
                    )}
                    {line.context && <span className="context">{line.context}</span>}
                    {line.note && <span className="usage-note">{line.note}</span>}
                  </span>
                  <span className="bar" aria-hidden="true">
                    <i style={{ width: `${((line.tokens.value ?? 0) / max) * 100}%`, background: color(line) }} />
                  </span>
                </span>
                <span role="cell">
                  <FigureText figure={line.tokens} kind="tokens" bare={details} />
                </span>
                <span role="cell">
                  <FigureText figure={line.time} kind="time" />
                </span>
                {details &&
                  DETAIL_COLUMNS.map((column) => (
                    <span key={column.key} role="cell" className={`num ${line.detail[column.key] === undefined ? "muted" : ""}`}>
                      {/* A part the tools gave no figure for. */}
                      {line.detail[column.key] === undefined ? "not reported" : tokenNumber(line.detail[column.key]!)}
                    </span>
                  ))}
              </div>
            );
          })}
        </div>
      )}
      {limit && lines.length > limit && (
        <button className="linkish show-earlier" onClick={() => setAll((on) => !on)}>
          {all ? `Show the top ${limit}` : `Show all ${lines.length}`}
        </button>
      )}
      {note}
    </section>
  );
}

const PERIOD_WORDS: Record<UsagePeriod, string> = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days" };

/** Every caveat in one place, for the chosen period. Never repeated line by line. */
export function AboutNote({ about, period }: { about: AboutCounts; period: UsagePeriod }) {
  return (
    <div className="about-note" id="about-these-numbers">
      <h4>About these numbers</h4>
      <ul>
        <li>Tokens are counted the same way for every tool: new input, input reused from the cache, input written to the cache, and output.</li>
        <li>Input reused from the cache is each tool's own count, not an exact measure of what agents re-read.</li>
        <li>The tools count slightly differently, so totals across tools are approximate. The split by tool is the reliable comparison.</li>
        <li>Claude Code's numbers include its helper agents and compaction inside each model's line.</li>
        <li>Grok counts all model calls in a turn, including collected helper work. Thinking is already included in its output.</li>
        <li>Antigravity tokens come from the increase in its native session totals per turn. It reports no separate cache breakdown.</li>
        <li>
          Codex reports only its main agent. {PERIOD_WORDS[period].charAt(0).toUpperCase() + PERIOD_WORDS[period].slice(1)}, {count(
            about.codexHelperTurns,
            "Codex turn"
          )} started helper agents whose use Codex doesn't report.
        </li>
        {about.claudeMainOnly > 0 && <li>{count(
          about.claudeMainOnly,
          "Claude Code turn"
        )} counted the main agent only, because Claude Code sent no per-model breakdown.</li>}
        <li>Agent time sits with the model the agent ran on. A model that only appeared inside a turn shows its tokens, and its agent time reads “not reported”.</li>
        <li>“Not known” means the work wasn't recorded: it ran before Petrina started keeping track, or was cut off when Petrina stopped.</li>
        <li>Agent time adds up agents running at once, so a day can hold more than 24 hours of it.</li>
        <li>No prices: on subscriptions they would mislead.</li>
      </ul>
    </div>
  );
}

/** "48k tokens · 1h 05m". */
export function Amount({ tokens, time }: { tokens: Figure; time: Figure }) {
  return (
    <>
      <FigureText figure={tokens} kind="tokens" />
      <span className="muted"> · </span>
      <FigureText figure={time} kind="time" />
    </>
  );
}


/** Each tool's usage in plain words: how much of its limits is used, and who is out until when. */
export function UsageList({ state, expanded = false }: { state: State; expanded?: boolean }) {
  const reports = state.pool.usage ?? [];
  const now = useLimitClock(reports, state.now);
  const lines = usageLines(state, now);
  if (expanded) {
    const tools = state.tools.filter(
      (tool) =>
        tool.status === "ready"
        || reports.some((report) => report.toolId === tool.id)
        || Boolean(getProviderDescriptor(tool.id)?.starter),
    );
    const limits = displayLimits(state.pool, now);
    return (
      <div className="usage-limits">
        {tools.map((tool) => {
          const own = reports.filter((report) => report.toolId === tool.id);
          const out = limits.filter((limit) => limit.toolId === tool.id);
          return (
            <div key={tool.id} className="limit-card">
              <div className="row">
                <i className="tool-dot" style={{ width: 10, height: 10, borderRadius: 3, background: TOOL_COLORS[tool.id] ?? "var(--slate)" }} />
                <strong>{tool.name}</strong>
              </div>
              {state.pool.usageReads?.[tool.id]?.state === "reading" && <div className="muted small" role="status">Updating usage…</div>}
              {state.pool.usageReads?.[tool.id]?.state === "unavailable" && <div
                className="muted small"
                role="status"
              >Couldn’t refresh usage.{own.length ? " Showing the last report." : " No current reading is available."}</div>}
              {own.length === 0 && out.length === 0 && (
                <div className="muted small">Not reported. Account readings refresh while Analytics is open. A percentage appears only when a tool reports one.</div>
              )}
              {own.map((report) => {
                const text = limitWords(report, now);
                const tone = text.status === "reached" ? "bad" : text.status === "close" ? "warn" : "ok";
                return (
                  <div key={`${report.kind}:${report.model ?? ""}`} className="limit">
                    <div className="row between">
                      <span>{text.label}</span>
                      <span className={`num ${text.stale ? "muted" : ""}`}>{text.used}</span>
                    </div>
                    {text.percent !== undefined && (
                      <span
                        className={`meter ${tone}`}
                        role="meter"
                        aria-valuenow={text.percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${tool.name} ${text.label}`}
                      >
                        <i style={{ width: `${text.percent}%` }} />
                      </span>
                    )}
                    <div className="muted small">{[text.resets, text.reported].filter(Boolean).join(" · ")}</div>
                  </div>
                );
              })}
              {out.map((limit) => (
                <div className="limit" key={`pause:${limit.model ?? ""}`}>
                  <div className="bad small">{usagePauseWords(limit, now)}</div>
                  {limit.retry && <div className="muted small">{limit.reason}</div>}
                  <div className="muted small">{limit.at === undefined ? "Report time not reported" : `Reported ${agoText(limit.at, now)}`}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="usage-list" role="list" aria-label="Usage by tool">
      {lines.map((line) => (
        <div key={line.toolId} className="usage-row" role="listitem">
          <i style={{ background: TOOL_COLORS[line.toolId] ?? "var(--slate)" }} aria-hidden="true" />
          <strong>{line.name}</strong>
          <span className={`label ${line.tone === "out" ? "bad" : line.tone === "near" ? "warn" : ""}`}>{line.text}</span>
          {reports.filter((report) => report.toolId === line.toolId).map((report) => {
            const text = limitWords(report, now);
            return (
              <span className="usage-reported muted small" key={`${report.kind}:${report.model ?? ""}`}>
                {text.label} · {[text.resets, text.reported].filter(Boolean).join(" · ")}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** What the top bar's pool button adds for a tool close to or past its limit, or undefined when all is well. */
export function usageNote(state: State): string | undefined {
  const lines = usageLines(state, state.now).filter((line) => line.tone !== "fine");
  return lines.length ? lines.map((line) => `${line.name}: ${line.text}`).join(". ") : undefined;
}
