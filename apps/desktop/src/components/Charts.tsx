// Charts the app draws itself, in plain SVG: stacked bars over time with a running total under
// them, and lines over time with reset marks. Each has a legend when there are two or more
// series, the numbers on hover and on keyboard focus, and the same data as a table one click away.
// Thin marks, a 2px gap of surface between stacked segments, and a quiet grid.

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

/** The width a chart has to draw in, followed as its box resizes. */
function useWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** A round top for an axis: 1, 2, 2.5, 5 or 10 times a power of ten, at or above the value. */
function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const unit = value / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");
const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;

/** "Fri 17 Oct". */
export function dayWords(at: number): string {
  const date = new Date(at);
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** "14:30" within a day, "Fri 17 Oct, 14:30" across days. */
export function whenWords(at: number, hourly: boolean): string {
  return hourly ? clock(at) : `${dayWords(at)}, ${clock(at)}`;
}

/** Chart or table: the same data either way. */
export function ViewToggle({ table, onTable, label }: { table: boolean; onTable: (on: boolean) => void; label: string }) {
  return (
    <div className="segmented small" role="tablist" aria-label={label}>
      <button role="tab" aria-selected={!table} className={table ? "" : "on"} onClick={() => onTable(false)}>
        Chart
      </button>
      <button role="tab" aria-selected={table} className={table ? "on" : ""} onClick={() => onTable(true)}>
        Table
      </button>
    </div>
  );
}

function Legend({ series, lines, extra }: { series: readonly (ChartSeries & { note?: string })[]; lines?: boolean; extra?: ReactNode }) {
  return (
    <figcaption className="legend">
      {series.map((entry) => (
        <span key={entry.key}>
          <i className={lines ? "line" : ""} style={{ background: entry.color }} />
          {entry.label}
          {entry.note && <b className="num">{entry.note}</b>}
        </span>
      ))}
      {extra}
    </figcaption>
  );
}

interface TipRow {
  key: string;
  label: string;
  value: string;
  color?: string;
  line?: boolean;
}

/** The numbers at one spot, above it. Kept inside the plot's width. */
function Tip({ x, y, title, rows }: { x: number; y: number; title: string; rows: readonly TipRow[] }) {
  return (
    <div className="chart-tip" role="tooltip" style={{ left: `clamp(80px, ${Math.round(x)}px, calc(100% - 80px))`, top: Math.round(y) }}>
      <strong>{title}</strong>
      {rows.map((row) => (
        <span key={row.key}>
          {row.color && <i className={row.line ? "line" : ""} style={{ background: row.color }} />}
          {row.label} <b className="num">{row.value}</b>
        </span>
      ))}
    </div>
  );
}

// ── Stacked bars over time ─────────────────────────────────────────────────

export interface BarPoint {
  key: string;
  /** Under the bar: "Mon", "17", "09". */
  label: string;
  /** In the tooltip and the table: "Fri 17 Oct", "09:00". */
  title: string;
  /** Per series key. */
  values: Record<string, number>;
  /** Known amounts above omit some work. Absence of activity still means zero. */
  missing?: Record<string, boolean>;
}

interface BarsProps {
  points: readonly BarPoint[];
  series: readonly ChartSeries[];
  format: (value: number) => string;
  /** Exact figures for the table and tooltip; axes can stay compact. */
  formatDetail?: (value: number) => string;
  missingWord?: string;
  /** What the figure shows, for assistive technology. */
  label: string;
  /** The running total, drawn in its own strip under the bars, on its own scale. */
  running?: { label: string; values: readonly number[] };
  table: boolean;
  /** The table's first column: "Day" or "Hour". */
  periodWord: string;
  /** The table's total column: "Tokens". */
  measureWord: string;
}

/** The top segment of a stack: square at the bottom, rounded on top. */
function roundedTop(x: number, top: number, width: number, height: number): string {
  const r = Math.min(4, height, width / 2);
  return `M${x},${top + height} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${top + height} Z`;
}

export function BarsOverTime({ points, series, format, formatDetail = format, missingWord = "not reported", label, running, table, periodWord, measureWord }: BarsProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 640);
  const [hover, setHover] = useState<number>();
  const totals = points.map((point) => series.reduce((sum, entry) => sum + (point.values[entry.key] ?? 0), 0));
  const nothing = totals.every((total) => total === 0);
  const missing = points.map((point) => series.some((entry) => point.missing?.[entry.key]));
  let incomplete = false;
  const runningMissing = missing.map((value) => (incomplete ||= value));
  const detail = (value: number, absent = false) => absent ? value > 0 ? `> ${formatDetail(value)}` : missingWord : formatDetail(value);
  const compact = (value: number, absent = false) => `${absent ? "> " : ""}${format(value)}`;
  const missingNote = incomplete && <p className="muted small">Some work was not reported. Bars and the running total show known amounts.</p>;

  if (table) {
    return (
      <figure className="chart-figure" aria-label={label}>
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead>
              <tr>
                <th>{periodWord}</th>
                {series.map((entry) => (
                  <th key={entry.key}>{entry.label}</th>
                ))}
                <th>{measureWord}</th>
                {running && <th>{running.label}</th>}
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                <tr key={point.key}>
                  <th scope="row">{point.title}</th>
                  {series.map((entry) => (
                    <td key={entry.key} className="num">
                      {detail(point.values[entry.key] ?? 0, point.missing?.[entry.key])}
                    </td>
                  ))}
                  <td className="num">{detail(totals[index]!, missing[index])}</td>
                  {running && <td className="num">{detail(running.values[index] ?? 0, runningMissing[index])}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {missingNote}
      </figure>
    );
  }

  const margin = { left: 44, right: 12, top: 16, bottom: 20 };
  const plotH = 150;
  const stripH = 52;
  const stripGap = 24;
  const plotW = Math.max(40, width - margin.left - margin.right);
  const height = margin.top + plotH + margin.bottom + (running ? stripGap + stripH + 6 : 0);
  const max = niceMax(Math.max(0, ...totals));
  const baseline = margin.top + plotH;
  const y = (value: number) => baseline - (value / max) * plotH;
  const slot = plotW / Math.max(1, points.length);
  const barW = Math.min(24, Math.max(3, slot * 0.7));
  const centre = (index: number) => margin.left + index * slot + slot / 2;
  const dense = points.length > 7;
  // Every cap is labelled on a short week; a long run labels only its largest day.
  const labelled = new Set<number>();
  if (!dense) totals.forEach((total, index) => total > 0 && labelled.add(index));
  else if (!nothing) labelled.add(totals.indexOf(Math.max(...totals)));

  const stripTop = baseline + margin.bottom + stripGap;
  const stripBase = stripTop + stripH;
  // The strip runs up to the period's total, so the line ends at its top right, where the total is written.
  const runMax = running ? Math.max(1, ...running.values) : 1;
  const ry = (value: number) => stripBase - (value / runMax) * stripH;
  const linePath = running ? running.values.map((value, index) => `${index ? "L" : "M"}${centre(index).toFixed(1)},${ry(value).toFixed(1)}`).join(" ") : "";
  const lastIndex = points.length - 1;

  const stacks = points.map((point, index) => {
    let top = baseline;
    const segments: { entry: ChartSeries; value: number; top: number; height: number }[] = [];
    for (const entry of series) {
      const value = point.values[entry.key] ?? 0;
      if (value <= 0) continue;
      const h = Math.max(1, (value / max) * plotH);
      segments.push({ entry, value, top: top - h, height: h });
      top = top - h - 2;
    }
    return { index, segments, top: segments.length ? top + 2 : baseline };
  });

  const tipRows = (index: number): TipRow[] => [
    ...series
      .filter((entry) => (points[index]!.values[entry.key] ?? 0) > 0 || points[index]!.missing?.[entry.key])
      .slice()
      .reverse()
      .map((entry) => ({ key: entry.key, label: entry.label, value: detail(points[index]!.values[entry.key] ?? 0, points[index]!.missing?.[entry.key]), color: entry.color })),
    ...(running ? [{ key: "running", label: running.label, value: detail(running.values[index] ?? 0, runningMissing[index]) }] : []),
  ];

  return (
    <figure className="chart-figure" aria-label={label}>
      {series.length > 1 && <Legend series={series} />}
      <div className="chart-plot" ref={box}>
        <svg width={width} height={height} className={dense ? "dense" : ""}>
          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction}>
              <line className={fraction === 0 ? "axis" : "grid"} x1={margin.left} x2={margin.left + plotW} y1={y(max * fraction)} y2={y(max * fraction)} />
              <text x={margin.left - 6} y={y(max * fraction)} dy="0.35em" textAnchor="end">
                {format(max * fraction)}
              </text>
            </g>
          ))}
          {hover !== undefined && <rect className="band" x={margin.left + hover * slot} y={margin.top - 8} width={slot} height={plotH + 8} rx={6} />}
          {stacks.map(({ index, segments, top }) => (
            <g key={points[index]!.key}>
              {segments.map((segment, order) => {
                const x = centre(index) - barW / 2;
                return order === segments.length - 1 ? (
                  <path key={segment.entry.key} d={roundedTop(x, segment.top, barW, segment.height)} style={{ fill: segment.entry.color }} />
                ) : (
                  <rect key={segment.entry.key} x={x} y={segment.top} width={barW} height={segment.height} style={{ fill: segment.entry.color }} />
                );
              })}
              {labelled.has(index) && (
                <text className="cap" x={centre(index)} y={top - 4} textAnchor="middle">
                  {compact(totals[index]!, missing[index])}
                </text>
              )}
              <text className="x" x={centre(index)} y={baseline + 14} textAnchor="middle">
                {points[index]!.label}
              </text>
            </g>
          ))}
          {nothing && (
            <text className="empty" x={margin.left + plotW / 2} y={margin.top + plotH / 2} textAnchor="middle">
              {incomplete ? "No reported amounts in this period" : "Nothing in this period"}
            </text>
          )}
          {running && (
            <g>
              <text x={margin.left} y={stripTop - 8}>
                {running.label}
              </text>
              <line className="axis" x1={margin.left} x2={margin.left + plotW} y1={stripBase} y2={stripBase} />
              {!nothing && (
                <>
                  <path className="wash" d={`${linePath} L${centre(lastIndex).toFixed(1)},${stripBase} L${centre(0).toFixed(1)},${stripBase} Z`} style={{ fill: "var(--accent)" }} />
                  <path className="series-line" d={linePath} style={{ stroke: "var(--accent)" }} />
                  <circle className="dot" cx={centre(lastIndex)} cy={ry(running.values[lastIndex] ?? 0)} r={4} style={{ fill: "var(--accent)" }} />
                  <text className="cap" x={centre(lastIndex) - 7} y={ry(running.values[lastIndex] ?? 0) - 6} textAnchor="end">
                    {compact(running.values[lastIndex] ?? 0, runningMissing[lastIndex])}
                  </text>
                </>
              )}
              {hover !== undefined && (
                <>
                  <line className="crosshair" x1={centre(hover)} x2={centre(hover)} y1={stripTop} y2={stripBase} />
                  <circle className="dot" cx={centre(hover)} cy={ry(running.values[hover] ?? 0)} r={4} style={{ fill: "var(--accent)" }} />
                </>
              )}
            </g>
          )}
          <g role="list">
            {points.map((point, index) => (
              <rect
                key={point.key}
                className="hit"
                role="listitem"
                tabIndex={0}
                aria-label={totals[index]! > 0 || missing[index] || running ? [point.title, ...tipRows(index).map((row) => `${row.label}: ${row.value}`)].join(" · ") : `${point.title}: nothing`}
                x={margin.left + index * slot}
                y={margin.top - 8}
                width={slot}
                height={height - margin.top + 8}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(undefined)}
                onFocus={() => setHover(index)}
                onBlur={() => setHover(undefined)}
              />
            ))}
          </g>
        </svg>
        {hover !== undefined && (totals[hover]! > 0 || missing[hover] || running) && <Tip x={centre(hover)} y={stacks[hover]!.top - 6} title={points[hover]!.title} rows={tipRows(hover)} />}
      </div>
      {missingNote}
    </figure>
  );
}

// ── Lines over time ────────────────────────────────────────────────────────

export interface LineSeries extends ChartSeries {
  /** Readings in time order; values from 0 to 1. */
  points: readonly { at: number; value: number }[];
  /** Moments the line reset, marked with a tick. */
  resets: readonly number[];
  /** A reset still ahead, marked more quietly. */
  nextReset?: number;
}

interface LinesProps {
  from: number;
  to: number;
  series: readonly LineSeries[];
  /** Where to write times under the axis. Thinned to what fits. */
  ticks: readonly { at: number; label: string }[];
  format: (value: number) => string;
  /** A time in words, for the tooltip and the table. */
  when: (at: number) => string;
  label: string;
  title?: ReactNode;
  table: boolean;
}

const ResetKey = () => (
  <span className="reset-key">
    <svg viewBox="0 0 10 8" aria-hidden="true">
      <path d="M0,0 H10 L5,7 Z" fill="currentColor" />
    </svg>
    reset
  </span>
);

export function LinesOverTime({ from, to, series, ticks, format, when, label, title, table }: LinesProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 420);
  const [hover, setHover] = useState<number>();
  const times = [...new Set(series.flatMap((entry) => entry.points.map((point) => point.at)))].sort((a, b) => a - b);
  const resetBetween = (entry: LineSeries, from: number, to: number) => [...entry.resets, ...(entry.nextReset === undefined ? [] : [entry.nextReset])].some((reset) => reset > from && reset <= to);
  /** A reading stops applying when its window resets; a new reading is needed. */
  const valueAt = (entry: LineSeries, at: number) => {
    const point = entry.points.findLast((point) => point.at <= at);
    return point && !resetBetween(entry, point.at, at) ? point.value : undefined;
  };
  const legend = series.map((entry) => {
    const last = entry.points.at(-1);
    return { ...entry, ...(last ? { note: format(last.value) } : {}) };
  });
  const anyReset = series.some((entry) => entry.resets.length > 0 || entry.nextReset !== undefined);

  if (table) {
    const rows = series
      .flatMap((entry) => [...entry.points.map((point) => ({ at: point.at, limit: entry.label, used: format(point.value) })), ...entry.resets.map((at) => ({ at, limit: entry.label, used: "reset" }))])
      .sort((a, b) => a.at - b.at || a.limit.localeCompare(b.limit));
    return (
      <figure className="chart-figure" aria-label={label}>
        {title}
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Limit</th>
                <th>Used</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.at}:${row.limit}:${index}`}>
                  <th scope="row">{when(row.at)}</th>
                  <td>{row.limit}</td>
                  <td className="num">{row.used}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </figure>
    );
  }

  const margin = { left: 38, right: 12, top: 14, bottom: 20 };
  const plotH = 140;
  const plotW = Math.max(40, width - margin.left - margin.right);
  const height = margin.top + plotH + margin.bottom;
  const span = Math.max(1, to - from);
  const x = (at: number) => margin.left + ((at - from) / span) * plotW;
  const y = (value: number) => margin.top + plotH - Math.max(0, Math.min(1, value)) * plotH;
  const every = Math.max(1, Math.ceil(ticks.length / Math.max(1, Math.floor(plotW / 44))));
  const shownTicks = ticks.filter((_, index) => index % every === 0);

  const pick = (clientX: number, node: SVGSVGElement) => {
    if (times.length === 0) return;
    const at = from + ((clientX - node.getBoundingClientRect().left - margin.left) / plotW) * span;
    let best = 0;
    for (let index = 1; index < times.length; index += 1) if (Math.abs(times[index]! - at) < Math.abs(times[best]! - at)) best = index;
    setHover(best);
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (times.length === 0) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setHover((on) => Math.max(0, Math.min(times.length - 1, (on ?? times.length) + (event.key === "ArrowLeft" ? -1 : 1))));
    } else if (event.key === "Escape") setHover(undefined);
  };
  const at = hover !== undefined ? times[hover] : undefined;
  const tipRows: TipRow[] = at === undefined ? [] : series.flatMap((entry) => {
    const value = valueAt(entry, at);
    return value === undefined ? [] : [{ key: entry.key, label: entry.label, value: format(value), color: entry.color, line: true }];
  });

  return (
    <figure className="chart-figure" aria-label={label}>
      {title}
      {(series.length > 1 || anyReset || legend.some((entry) => entry.note)) && <Legend series={legend} lines extra={anyReset ? <ResetKey /> : undefined} />}
      <div className="chart-plot" ref={box}>
        <svg
          width={width}
          height={height}
          tabIndex={0}
          role="img"
          aria-label={`${label}. Arrow keys move between readings.`}
          onMouseMove={(event: MouseEvent<SVGSVGElement>) => pick(event.clientX, event.currentTarget)}
          onMouseLeave={() => setHover(undefined)}
          onBlur={() => setHover(undefined)}
          onKeyDown={onKey}
        >
          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction}>
              <line className={fraction === 0 ? "axis" : "grid"} x1={margin.left} x2={margin.left + plotW} y1={y(fraction)} y2={y(fraction)} />
              <text x={margin.left - 6} y={y(fraction)} dy="0.35em" textAnchor="end">
                {format(fraction)}
              </text>
            </g>
          ))}
          {shownTicks.map((tick) => (
            <text key={tick.at} className="x" x={x(tick.at)} y={margin.top + plotH + 14} textAnchor="middle">
              {tick.label}
            </text>
          ))}
          {series.map((entry) => (
            <g key={entry.key}>
              {entry.resets.map((reset) => (
                <g key={reset} className="reset">
                  <line x1={x(reset)} x2={x(reset)} y1={margin.top} y2={margin.top + plotH} style={{ stroke: entry.color }} />
                  {/* A window that resets many times in the period keeps its hairlines and drops the markers, so they don't pile up. */}
                  {entry.resets.length <= 8 && <path d={`M${x(reset) - 4},${margin.top - 2} H${x(reset) + 4} L${x(reset)},${margin.top + 5} Z`} style={{ fill: entry.color }} />}
                </g>
              ))}
              {entry.nextReset !== undefined && (
                <g className="reset ahead">
                  <line x1={x(entry.nextReset)} x2={x(entry.nextReset)} y1={margin.top} y2={margin.top + plotH} style={{ stroke: entry.color }} />
                  <path d={`M${x(entry.nextReset) - 4},${margin.top - 2} H${x(entry.nextReset) + 4} L${x(entry.nextReset)},${margin.top + 5} Z`} style={{ fill: "none", stroke: entry.color }} />
                </g>
              )}
              {entry.points.length > 0 && (
                <>
                  <path className="series-line" d={entry.points.map((point, index) => `${index && !resetBetween(entry, entry.points[index - 1]!.at, point.at) ? "L" : "M"}${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")} style={{ stroke: entry.color }} />
                  {entry.points.slice(0, -1).filter((point, index) => index === 0 || resetBetween(entry, entry.points[index - 1]!.at, point.at)).map((point) => (
                    <circle key={point.at} className="dot" cx={x(point.at)} cy={y(point.value)} r={2.5} style={{ fill: entry.color }} />
                  ))}
                  <circle className="dot" cx={x(entry.points.at(-1)!.at)} cy={y(entry.points.at(-1)!.value)} r={4} style={{ fill: entry.color }} />
                </>
              )}
            </g>
          ))}
          {at !== undefined && (
            <g>
              <line className="crosshair" x1={x(at)} x2={x(at)} y1={margin.top} y2={margin.top + plotH} />
              {series.map((entry) => {
                const value = valueAt(entry, at);
                return value === undefined ? null : <circle key={entry.key} className="dot" cx={x(at)} cy={y(value)} r={4} style={{ fill: entry.color }} />;
              })}
            </g>
          )}
          {times.length === 0 && (
            <text className="empty" x={margin.left + plotW / 2} y={margin.top + plotH / 2} textAnchor="middle">
              No readings in this period
            </text>
          )}
        </svg>
        {at !== undefined && tipRows.length > 0 && <Tip x={x(at)} y={margin.top} title={when(at)} rows={tipRows} />}
      </div>
    </figure>
  );
}
