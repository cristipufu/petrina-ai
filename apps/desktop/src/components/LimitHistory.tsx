import { useEffect, useId, useRef, useState } from "react";
import { agoText, initialAllowance, percentWords, reportedUsage, type AllowanceHistory, type LimitBucket, type LimitsOverTime, type ReadingsRequest, type ReadingsView, type UsagePeriod } from "@petrina/core";
import { sim } from "../engine";
import { Select } from "./Select";
import { ToolIcon } from "./ToolIcon";
import { ViewToggle, dayWords } from "./Charts";

const EMPTY = "No usage history for these dates. Account readings refresh while Analytics is open. A percentage appears only when a tool reports one.";
const SCHEDULE = "Reset times are the provider’s reported schedule. A possible reset means the percentage fell after that time passed or moved later. Neither confirms that a reset happened.";
const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const readingDate = (at: number) => new Date(at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "shortOffset" });
const dated = (at: number) => `${dayWords(at)} ${time(at)}`;
export const bucketValue = (bucket: LimitBucket): string => bucket.future ? "" : bucket.highest !== undefined ? percentWords(bucket.highest) : bucket.reports ? "No percentage" : "No readings recorded";
const bucketTitle = (bucket: LimitBucket, hourly: boolean) => hourly ? `${dayWords(bucket.start)} ${bucket.label}` : dayWords(bucket.start);
export const bucketDescription = (bucket: LimitBucket, hourly: boolean): string => `${bucketTitle(bucket, hourly)} · ${bucketValue(bucket)}${bucket.highestAt === undefined ? "" : `, first recorded ${dated(bucket.highestAt)}`} · With a percentage: ${bucket.numericCount} of ${bucket.reports} · Possible resets: ${bucket.possibleResets}${bucket.statuses.length ? ` · ${bucket.statuses.join(" · ")}` : ""}`;

function coverage(limit: AllowanceHistory, hourly: boolean, now: number): string {
  const recorded = limit.buckets.filter(bucket => bucket.reports > 0);
  if (!recorded.length) return "No readings recorded for these dates";
  const first = recorded[0]!.firstAt!;
  if (new Date(limit.firstAt).toDateString() === new Date(now).toDateString()) return `Only today has readings · first at ${time(first)}`;
  if (hourly) return `Readings in ${recorded.length} of ${limit.buckets.filter(bucket => !bucket.future).length} hours so far · first at ${time(first)}`;
  return `Readings on ${recorded.length} of ${limit.buckets.length} days · first ${dated(first)}`;
}

interface DetailScope { period: UsagePeriod; request: ReadingsRequest; tool: string; allowance: string; returnId: string }
export function LimitHistory({ history, period }: { history: LimitsOverTime | undefined; period: UsagePeriod }) {
  const historyId = useId();
  const [table, setTable] = useState(false);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [pages, setPages] = useState<Partial<Record<UsagePeriod, number>>>({});
  const [inspected, setInspected] = useState<Record<string, number>>({});
  const [detail, setDetail] = useState<DetailScope>();
  const [returnId, setReturnId] = useState<string>();
  const pageCount = Math.max(1, Math.ceil((history?.buckets.filter(bucket => bucket.start <= history.now).length ?? 0) / 7));
  const page = Math.min(pages[period] ?? 0, pageCount - 1);
  useEffect(() => {
    if (!history) return;
    setSelected(previous => {
      const next = { ...previous };
      for (const tool of history.tools) if (!next[tool.toolId]) { const first = initialAllowance(tool.limits); if (first) next[tool.toolId] = first.key; }
      return Object.keys(next).some(key => next[key] !== previous[key]) ? next : previous;
    });
  }, [history]);
  useEffect(() => {
    if (!detail && returnId && history) { (document.getElementById(returnId) ?? document.querySelector<HTMLElement>('.limit-history [role="tab"][aria-selected="true"]'))?.focus(); setReturnId(undefined); }
  }, [detail, returnId, history]);
  function open(toolId: string, limit: AllowanceHistory, tool: string, returnId: string, bucket?: LimitBucket) {
    if (!history) return;
    if (bucket) setInspected(all => ({ ...all, [toolId]: bucket.start }));
    setDetail({ period, tool, allowance: limit.label, returnId, request: { view: "readings", toolId, allowanceKey: limit.key,
      from: bucket?.start ?? history.from, to: bucket?.end ?? history.to, snapshotAt: history.now, latest: limit.latest, offset: 0 } });
  }
  function back() { if (detail) setReturnId(detail.returnId); setDetail(undefined); }
  useEffect(() => { if (detail && detail.period !== period) { setReturnId(detail.returnId); setDetail(undefined); } }, [detail, period]);
  return <div className="limit-history">
    <div className="chart-head row between wrap"><div><h3>Usage history</h3><p className="muted small">{period === "today" ? "Highest reported usage per hour, so far today" : "Highest reported usage per day"}</p></div>
      {!detail && <ViewToggle table={table} onTable={setTable} label="Usage history as a chart or a table" />}</div>
    {detail ? <ReadingPages scope={detail} back={back} /> : <>
      <p className="muted small">Each bar shows the highest percentage a tool reported. Percentages describe allowance levels and do not add up.</p>
      <p className="muted small">Petrina records a reading only when a report changes.</p>
      {!history ? <p className="muted small">Loading usage history…</p> : !history.tools.length ? <p className="muted small">{EMPTY}</p> : <>
        <div className="limit-history-grid">{history.tools.map(tool => {
          const limit = tool.limits.find(entry => entry.key === selected[tool.toolId]) ?? initialAllowance(tool.limits)!;
          return <HistoryCard key={tool.toolId} id={`${historyId}-${tool.toolId}`} tool={tool} limit={limit} history={history} table={table} page={page} inspected={inspected[tool.toolId]}
            choose={key => setSelected(all => ({ ...all, [tool.toolId]: key }))} open={(id, bucket) => open(tool.toolId, limit, tool.label, id, bucket)} />;
        })}</div>
        {table && <nav className="limit-history-pager" aria-label="Usage history dates"><button disabled={page === 0} onClick={() => setPages(all => ({ ...all, [period]: page - 1 }))}>Newer</button><span>Page {page + 1} of {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => setPages(all => ({ ...all, [period]: page + 1 }))}>Older</button></nav>}
      </>}
    </>}
  </div>;
}

function HistoryCard({ id, tool, limit, history, table, page, inspected, choose, open }: { id: string; tool: LimitsOverTime["tools"][number]; limit: AllowanceHistory; history: LimitsOverTime; table: boolean; page: number; inspected?: number; choose: (key: string) => void; open: (id: string, bucket?: LimitBucket) => void }) {
  const current = tool.limits.filter(entry => entry.current);
  const old = tool.limits.filter(entry => !entry.current);
  return <section className={`limit-history-card ${limit.current ? "" : "limit-history-only"}`} aria-label={`${tool.label} usage history`}>
    <h4 className="row"><ToolIcon toolId={tool.toolId} />{tool.label}</h4>
    <label className="limit-history-choice">Limit and model group<Select value={limit.key} onChange={event => choose(event.target.value)}>
      {current.length > 0 && <optgroup label="In latest reports">{current.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</optgroup>}
      {old.length > 0 && <optgroup label="History only">{old.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</optgroup>}
    </Select></label>
    <p className="muted small limit-history-membership">{limit.current ? `In latest report · reported ${agoText(limit.latest.at, history.now)}` : `History only · last reported ${dated(limit.latest.at)} · ${reportedUsage(limit.latest)}${limit.latest.utilization === 1 ? ", limit reached then" : ""}`}</p>
    <p className="muted small">{coverage(limit, history.hourly, history.now)}</p>
    {table ? <div className="limit-history-table-wrap"><table className="limit-history-table" aria-label={`${tool.label}: ${limit.label}`}><thead><tr><th>{history.hourly ? "Hour" : "Day"}</th><th>Highest reported</th><th>With a percentage</th><th>Possible resets</th></tr></thead><tbody>
      {limit.buckets.filter(bucket => !bucket.future).reverse().slice(page * 7, page * 7 + 7).map(bucket => <tr key={bucket.start}><th><button id={`${id}-${bucket.start}`} disabled={bucket.future} className="linkish" onClick={() => open(`${id}-${bucket.start}`, bucket)}>{history.hourly ? bucket.label : dayWords(bucket.start)}</button></th><td>{bucketValue(bucket)}</td><td>{bucket.future ? "" : `${bucket.numericCount} of ${bucket.reports}`}</td><td>{bucket.future ? "" : bucket.possibleResets}</td></tr>)}
    </tbody></table></div> : <HistoryBars key={limit.key} limit={limit} hourly={history.hourly} inspected={inspected} id={`${id}-chart`} open={bucket => open(`${id}-chart`, bucket)} />}
    <button className="linkish limit-history-readings" id={`${id}-readings`} onClick={() => open(`${id}-readings`)}>View readings</button>
  </section>;
}

function HistoryBars({ limit, hourly, inspected, id, open }: { limit: AllowanceHistory; hourly: boolean; inspected?: number; id: string; open: (bucket: LimitBucket) => void }) {
  const [active, setActive] = useState<number>();
  const axis = useRef<HTMLDivElement>(null);
  const [ticks, setTicks] = useState<number[]>([0, limit.buckets.length - 1]);
  const [valuesFit, setValuesFit] = useState(false);
  useEffect(() => {
    const element = axis.current;
    if (!element) return;
    const labels = [...element.querySelectorAll<HTMLElement>("[data-measure]")];
    const values = [...element.parentElement!.querySelectorAll<HTMLElement>(".limit-history-bar > span")];
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      const labelWidth = Math.max(1, ...labels.map(label => label.getBoundingClientRect().width));
      const count = Math.min(limit.buckets.length, Math.max(2, Math.floor(width / (2 * labelWidth + 16)) + 1));
      const next = Array.from({ length: count }, (_, index) => Math.round(index * (limit.buckets.length - 1) / (count - 1)));
      setTicks(previous => previous.join() === next.join() ? previous : next);
      // Measure the actual type, including enlarged text and vertical labels.
      setValuesFit(values.every(value => value.getBoundingClientRect().width + 1 <= width / limit.buckets.length));
    };
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    labels.forEach(label => observer.observe(label));
    values.forEach(value => observer.observe(value));
    return () => observer.disconnect();
  }, [limit.buckets]);
  const last = Math.max(0, limit.buckets.findLastIndex(bucket => !bucket.future));
  const bucket = active === undefined ? undefined : limit.buckets[active];
  return <div className="limit-history-chart">
    <div className="limit-history-scale" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
    <div id={id} className={`limit-history-plot ${limit.buckets.length > 10 ? "dense" : ""} ${valuesFit ? "" : "compact-values"}`} role="group" aria-roledescription="interactive chart" aria-label={`${limit.label}. Highest reported usage. Arrow keys move between dates; Enter opens readings.`} tabIndex={0} aria-describedby={bucket ? `${id}-tip` : undefined}
      onFocus={() => setActive(inspected === undefined ? last : Math.max(0, limit.buckets.findIndex(bucket => bucket.start === inspected)))} onBlur={() => setActive(undefined)} onMouseLeave={event => { if (document.activeElement !== event.currentTarget) setActive(undefined); }} onKeyDown={event => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        let next: number | undefined;
        if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(last, (active ?? last) + 1);
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, (active ?? last) - 1);
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = last;
        if (event.key === "Escape") { setActive(undefined); event.preventDefault(); event.stopPropagation(); }
        if (event.key === "Enter" && bucket) { event.preventDefault(); open(bucket); }
        if (next !== undefined) { event.preventDefault(); setActive(next); }
      }}>
      <div className="limit-history-bars">{limit.buckets.map((bucket, index) => <div key={bucket.start} className={`limit-history-slot ${active === index ? "active" : ""}`} onMouseEnter={() => !bucket.future && setActive(index)} onClick={() => !bucket.future && open(bucket)} aria-hidden="true">
        <div className="limit-history-bar-space">{!bucket.future && bucket.end > limit.firstAt && (bucket.highest !== undefined ? <div className={`limit-history-bar ${bucket.highest === 0 ? "zero" : ""}`} style={{ height: `${bucket.highest * 100}%` }}><span>{percentWords(bucket.highest)}</span></div> : <span className={`limit-history-unknown ${bucket.reports ? "status-only" : ""}`}>{bucket.reports ? "◇" : "·"}</span>)}</div>
      </div>)}</div>
      <div className="limit-history-axis" ref={axis} aria-hidden="true">
        <div className="limit-history-axis-measure">{limit.buckets.map(bucket => <span key={bucket.start} data-measure>{bucket.label}</span>)}</div>
        {ticks.map((index, position) => <span key={index} className="limit-history-tick" style={position === 0 ? { left: 0 } : position === ticks.length - 1 ? { right: 0 } : { left: `${index / (limit.buckets.length - 1) * 100}%`, transform: "translateX(-50%)" }}>{limit.buckets[index]!.label}</span>)}
      </div>
    </div>
    <div className="limit-history-tip small"><div role={bucket ? "tooltip" : undefined} id={`${id}-tip`} aria-live="polite">{bucket ? bucketDescription(bucket, hourly) : "Focus the chart or point to a bar for details. · No readings recorded   ◇ No percentage"}</div>
      {!valuesFit && limit.buckets.some(bucket => bucket.highest === 0) && <span className="limit-history-zero-key">— 0%</span>}
    </div>
  </div>;
}

function ReadingPages({ scope, back }: { scope: DetailScope; back: () => void }) {
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<ReadingsView>();
  const [error, setError] = useState(false);
  const cache = useRef(new Map<number, ReadingsView>());
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { backRef.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    setError(false);
    setResult(cache.current.get(offset));
    if (!cache.current.has(offset)) void Promise.resolve().then(() => sim.usage({ ...scope.request, offset })).then(raw => {
      const value = raw as ReadingsView;
      cache.current.set(offset, value);
      if (live) setResult(value);
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [scope, offset]);
  const canNewer = !!result && offset > 0;
  const canOlder = !!result?.older && offset < 100000;
  // Plain reading text focuses its containing panel; paging controls keep focus even
  // while loading or at an end, so Escape stays local without losing its target.
  return <section className="limit-history-readings-view" aria-label="Usage readings" tabIndex={-1} onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector('[role="dialog"], .popover, .menu')) { event.preventDefault(); event.stopPropagation(); back(); }
  }}>
    <button ref={backRef} onClick={back}>Back to usage history</button>
    <h4>{scope.tool} · {scope.allowance}</h4><p className="muted small">{dated(scope.request.from)} to {dated(Math.min(scope.request.to - 1, scope.request.snapshotAt))}</p>
    <p className="muted small">{SCHEDULE}</p>
    {!result ? <p role="status">{error ? "Couldn’t load readings. Return to usage history and try again." : "Loading readings…"}</p> : <>
      <div className="limit-history-table-wrap"><table className="limit-history-table"><thead><tr><th>Reported at</th><th>Usage</th><th>Reported reset</th><th>Change</th></tr></thead><tbody>{result.rows.map((row, index) => <tr key={`${row.report.at}-${index}`}><td><time dateTime={new Date(row.report.at).toISOString()}>{readingDate(row.report.at)}</time></td><td>{reportedUsage(row.report)}</td><td>{row.report.resetsAt === undefined ? "Not reported" : <time dateTime={new Date(row.report.resetsAt).toISOString()} title={readingDate(row.report.resetsAt)}>{row.resetUnchanged ? "Unchanged" : readingDate(row.report.resetsAt)}</time>}</td><td>{row.change}</td></tr>)}</tbody></table></div>
      {!result.rows.length && <p>No readings recorded for these dates</p>}
    </>}
    <nav className="limit-history-pager" aria-label="Reading pages"><button aria-disabled={!canNewer} onClick={() => { if (canNewer) setOffset(value => value - 20); }}>Newer</button><span>Page {offset / 20 + 1}</span><button aria-disabled={!canOlder} onClick={() => { if (canOlder) setOffset(value => value + 20); }}>Older</button></nav>
  </section>;
}
