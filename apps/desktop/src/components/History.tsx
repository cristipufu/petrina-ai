import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowDownWideNarrow, Ban, CheckCircle2, CircleMinus, Search, X } from "lucide-react";
import { HISTORY_STATUSES, historyDeliveryItem, type HistoryStatus, landingOf, type HistoryItem, type HistoryPage, type State, type TaskUsageSummary } from "@petrina/core";
import { failureText, sim } from "../engine";
import { type Lookup } from "../lib";
import { followLink } from "../routes";
import { ProductName, useFocusTrap } from "./bits";
import { FigureText } from "./Usage";

export const HISTORY_PAGE_SIZE = 24;
export interface HistoryPosition { status?: HistoryStatus; cursor?: string; query?: string; previous?: readonly string[] }

export function TaskLoading({ error, onRetry, onClose }: { error?: string; onRetry: () => void; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel, onClose);
  return <><div className="scrim" onClick={onClose} /><section ref={panel} className="task-detail-loading" role="dialog" aria-modal="true" aria-label="Task details" tabIndex={-1}><p role={error ? "alert" : "status"}>{error ?? "Loading task details…"}</p>{error && <button className="btn outline" onClick={onRetry}>Try again</button>}<button className="btn quiet" onClick={onClose}>Back</button></section></>;
}

/** The engine returns one indexed page. Completed task bodies are requested only when opened. */
export function useHistoryPage(state: State, enabled: boolean, product: string, position?: HistoryPosition, options?: { routineId?: string; includeUsage?: boolean }) {
  const { routineId, includeUsage = false } = options ?? {};
  const [result, setResult] = useState<{ key: string; page?: HistoryPage; error?: string }>();
  const [retry, setRetry] = useState(0);
  const cursor = position?.cursor;
  const query = position?.query;
  const status = position?.status;
  // The demo keeps its small fixture in memory. The engine sends only the archive revision.
  const revision = state.history?.revision ?? state.tasks.filter((task) => task.state === "done" || task.state === "cancelled").map((task) => `${task.id}:${task.finishedAt}`).join("|");
  const usageVersion = includeUsage ? state.work?.version ?? 0 : 0;
  const key = JSON.stringify([product, cursor, query, routineId, status, includeUsage]);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.resolve().then(() => sim.historyPage({ ...(includeUsage ? { includeUsage: true } : {}), ...(status ? { status } : {}), ...(routineId ? { routineId } : {}), ...(product !== "all" ? { productId: product } : {}), ...(query ? { query } : {}), ...(cursor ? { cursor } : {}), limit: HISTORY_PAGE_SIZE })).then(
      (page) => { if (!cancelled && currentKey.current === key) setResult({ key, page }); },
      (error) => { if (!cancelled && currentKey.current === key) setResult({ key, error: failureText(error) }); },
    );
    return () => { cancelled = true; };
  }, [enabled, product, cursor, query, routineId, status, includeUsage, usageVersion, revision, retry, key]);
  return { page: result?.key === key ? result.page : undefined, error: result?.key === key ? result.error : undefined, reload: () => setRetry((value) => value + 1) };
}

function HistoryUsage({ usage }: { usage?: TaskUsageSummary }) {
  if (!usage || usage.empty === "nothing") return null;
  if (usage.empty === "untracked") return <div className="history-usage">Tokens and agent time not recorded</div>;
  return <div className="history-usage num">
    <span>{usage.tokens.value === undefined && "Tokens "}<span className="history-usage-figure"><FigureText figure={usage.tokens} kind="tokens" /><span className="history-usage-separator" aria-hidden="true"> · </span></span></span>
    <span>{usage.time.value === undefined && <><span className="history-usage-label">Agent time</span>{" "}</>}<span className="history-usage-figure"><FigureText figure={usage.time} kind="time" /></span>{usage.time.value !== undefined && <>{" "}<span className="history-usage-label">agent time</span></>}</span>
  </div>;
}

function recordedDelivery(item: HistoryItem): string | undefined {
  if (item.deliveries?.length) {
    const deliveries = item.deliveries.map(work => ({ work, outcome: work.nothingToPublish ? "Nothing to publish" : recordedDelivery(historyDeliveryItem(item, work)) }));
    if (item.state === "cancelled" && deliveries.every(delivery => !delivery.outcome)) return undefined;
    return deliveries.map(({ work, outcome }) => `${item.products?.find(product => product.id === work.productId)?.name ?? work.productId}: ${outcome ?? (item.state === "cancelled" ? "Not delivered" : "Delivery not confirmed")}`).join(" · ");
  }
  if (item.release) return `Released ${item.release.tag}`;
  if (item.landed) return item.localUpdate?.pushed ? `Committed to ${item.landed.branch} · pushed to GitHub` : `Committed locally to ${item.landed.branch}`;
  if (landingOf(item) === "marked-done") return;
  if (item.pr?.state === "merged") return `Pull request #${item.pr.number} merged`;
  if (item.pr?.state === "open" && item.state === "cancelled") return `Pull request #${item.pr.number} still open`;
  if (item.pr && (item.pr.state === "closed" || landingOf(item) === "closed")) return `Pull request #${item.pr.number} closed without merging`;
}
function outcome(item: HistoryItem): string {
  if (item.combinedInto) return "Combined into another task";
  const delivery = recordedDelivery(item);
  if (item.state === "cancelled") return delivery ? `Cancelled · ${delivery}` : "Cancelled";
  if (delivery) return delivery;
  if (landingOf(item) === "no-changes") return "Completed · No product changes";
  if (landingOf(item) === "marked-done") return "Marked as done · delivery not confirmed";
  return "Completed";
}

export function History({ page, error, reload, position, onPosition, find, selectedId, onFocus, onOpen, hrefFor, drafts }: {
  page?: HistoryPage; error?: string; reload: () => void; position?: HistoryPosition;
  onPosition: (position: HistoryPosition) => void; find: Lookup; selectedId?: string;
  onFocus: (id?: string) => void; onOpen: (id: string) => void; hrefFor: (id: string) => string;
  drafts: Readonly<Record<string, boolean>>;
}) {
  const [query, setQuery] = useState(position?.query ?? "");
  useEffect(() => setQuery(position?.query ?? ""), [position?.query]);
  const previous = position?.previous ?? [];
  const newest = { ...(position?.status ? { status: position.status } : {}), ...(position?.query ? { query: position.query } : {}) };
  const search = (value: string) => onPosition({ ...(position?.status ? { status: position.status } : {}), ...(value.trim() ? { query: value.trim() } : {}) });
  return <div className="history-page page" tabIndex={-1} onFocus={(event) => { if (!(event.target as HTMLElement).closest("[data-task-id]")) onFocus(); }}>
    <header className="history-header">
      <div className="history-toolbar">
        <form className="history-search" role="search" onSubmit={event => { event.preventDefault(); search(query); }}>
          <Search size={17} aria-hidden="true" />
          <input type="search" aria-label="Search finished task titles" placeholder="Find a finished task" value={query} onChange={event => setQuery(event.target.value)} />
          {query && <button className="btn quiet small icon" type="button" aria-label="Clear history search" onClick={() => { setQuery(""); search(""); }}><X size={15} aria-hidden="true" /></button>}
          <button className="btn small" type="submit">Search</button>
        </form>
        <label className="history-status"><span>Status</span><Select aria-label="Status" value={position?.status ?? ""} onChange={event => onPosition({ ...(position?.query ? { query: position.query } : {}), ...(event.target.value ? { status: event.target.value as HistoryStatus } : {}) })}><option value="">All statuses</option>{Object.entries(HISTORY_STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
      </div>
      <div className="history-summary"><span className="num" aria-live="polite">{page ? <>{page.total.toLocaleString()} {page.total === 1 ? "task" : "tasks"}{position?.status ? ` · ${HISTORY_STATUSES[position.status]}` : " in history"}{position?.query ? ` matching “${position.query}”` : ""}</> : error ? "History unavailable" : "Finding finished tasks…"}</span><span className="history-order"><ArrowDownWideNarrow size={14} aria-hidden="true" />Newest first</span></div>
    </header>
    {error ? <div className="history-empty" role="alert"><p>{error}</p><button className="btn outline" onClick={reload}>Try again</button>{position?.cursor && <button className="btn quiet" onClick={() => onPosition(newest)}>Back to the newest tasks</button>}</div>
      : !page ? <p className="history-empty" role="status">Loading task history…</p>
      : <>
        {page.items.length ? <div className="history-grid">{page.items.map((item) => {
          const date = item.finishedAt ?? item.createdAt;
          const delivered = item.state !== "cancelled" && (item.deliveries?.length ? item.deliveries.every((work) => work.nothingToPublish || landingOf(historyDeliveryItem(item, work)) === "landed") : ["landed", "no-changes"].includes(landingOf(item)));
          const names = item.products?.map((product) => find.product(product.id)?.name ?? product.name);
          const Icon = item.state === "cancelled" ? Ban : delivered ? CheckCircle2 : CircleMinus;
          return <a key={item.id} href={hrefFor(item.id)} className={`history-card ${item.state} ${selectedId === item.id ? "selected" : ""}`} data-task-id={item.id} onFocus={() => onFocus(item.id)} onClick={(event) => followLink(event, () => onOpen(item.id))}>
            <div className="history-card-meta">{names?.length ? <span title={names.join(" · ")} aria-label={names.join(" · ")}>{names.slice(0, 2).join(" · ")}{names.length > 2 ? ` +${names.length - 2} products` : ""}</span> : <ProductName product={find.product(item.productId)} />}<time dateTime={new Date(date).toISOString()} title={new Date(date).toLocaleString()}>{new Date(date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</time></div>
            <h2 title={item.title}>{item.title}</h2>
            <div className={`history-outcome ${delivered ? "delivered" : "unconfirmed"}`}><Icon size={15} aria-hidden="true" /><span>{outcome(item)}</span></div>
            <HistoryUsage usage={item.usage} />
            {drafts[item.id] && <span className="draft-note"><span className="draft-mark" aria-hidden="true" />Unsent message</span>}
          </a>;
        })}</div> : <div className="history-empty"><p>{position?.query || position?.status ? "No finished tasks match these filters." : position?.cursor ? "There are no more tasks on this page." : "Completed and cancelled tasks will appear here."}</p>{position?.cursor && <button className="btn outline" onClick={() => onPosition(newest)}>Back to the newest tasks</button>}</div>}
        <nav className="history-pagination" aria-label="History pages">
          <button className="btn outline" disabled={!position?.cursor} onClick={() => { const cursors = [...previous]; const cursor = cursors.pop(); onPosition({ ...newest, ...(cursor ? { cursor } : {}), ...(cursors.length ? { previous: cursors } : {}) }); }}><ArrowLeft size={15} aria-hidden="true" />{position?.cursor && !previous.length ? "Newest" : "Previous"}</button>
          <span className="quiet-text num">{page.items.length} on this page</span>
          <button className="btn outline" disabled={!page.nextCursor} onClick={() => onPosition({ ...newest, cursor: page.nextCursor, previous: [...previous, position?.cursor ?? ""].slice(-50) })}>Next<ArrowRight size={15} aria-hidden="true" /></button>
        </nav>
      </>}
  </div>;
}
