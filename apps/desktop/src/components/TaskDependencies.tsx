import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ListOrdered, Search } from "lucide-react";
import { blocksDependents, canEditTaskDependencies, finishedTask, historyItem, historyDeliveryItem, landingOf, runtimeWaitView, taskProductIds, validateTaskDependencies, type HistoryItem, type State, type Task } from "@petrina/core";
import { failureText, sim } from "../engine";
import { uncertainReply } from "../commandFailures";
import { lookup, STATE_LABEL } from "../lib";
import { useHistoryPage } from "./History";
import { ConfirmDialog, useDismiss } from "./bits";
import { EditorPanel } from "./EditorPanel";
import { TaskLink } from "./sheet/ReviewTab";

export const DEPENDENCY_HELP = "This task waits until the selected tasks land, for example when their pull request merges or their release publishes. Finishing an agent turn does not count. Queue position only sets priority once this task is ready to start.";
type Choice = Task | HistoryItem;

function productsOf(task: Choice, state: State): string {
  const products = "products" in task ? task.products : undefined;
  const ids = products?.map((product) => product.id) ?? ("description" in task ? taskProductIds(task) : task.productIds ?? [task.productId]);
  return ids.map((id) => state.products.find((product) => product.id === id)?.name ?? products?.find((product) => product.id === id)?.name ?? ("repositories" in task ? task.repositories?.find((work) => work.productId === id)?.source?.product.name : undefined) ?? id).filter(Boolean).join(" · ") || "Products not chosen yet";
}

/** Outcome and eligibility are separate: a wait can end without a successful delivery. */
export function dependencyOutcome(task: Choice): string {
  if (task.state === "cancelled") return task.combinedInto ? "Combined into another task — did not land" : "Cancelled — did not land";
  const summary = "description" in task ? historyItem(task) : task;
  const deliveries = summary.deliveries;
  if (deliveries?.length) {
    const outcomes = [...new Set(deliveries.map((work) => work.nothingToPublish ? "No product changes" : dependencyOutcome({ ...historyDeliveryItem(summary, work), state: task.state } as Choice)))];
    return outcomes.every((outcome) => outcome === "Landed") && stillBlocks(task) ? "Delivery recorded — landing not confirmed" : outcomes.join(" · ");
  }
  // An open delivery stays open even when an older broad task state says done.
  if (task.pr?.state === "open" && landingOf(task) !== "marked-done") return "Awaiting merge — not landed yet";
  switch (landingOf(task)) {
    case "landed": return task.localUpdate?.pushed === false ? "Committed locally — push unfinished" : stillBlocks(task) ? "Delivery recorded — landing not confirmed" : "Landed";
    case "closed": return "Closed without merging — did not land";
    case "marked-done": return "Marked as done — delivery not confirmed";
    case "no-changes": return "Completed — no product changes";
    default: return STATE_LABEL[task.state];
  }
}
function stillBlocks(task: Choice): boolean | undefined {
  return "description" in task ? blocksDependents(task) : task.blocksDependents;
}

/** Selected summaries stay outside search results and are looked up by id in bounded History reads. */
function useChoices(state: State, ids: readonly string[]) {
  const [saved, setSaved] = useState<Record<string, { task?: HistoryItem; error?: string }>>({});
  const [retry, setRetry] = useState(0);
  const selectedKey = JSON.stringify(ids);
  const liveKey = JSON.stringify(ids.filter((id) => state.tasks.some((task) => task.id === id)));
  const revision = state.history?.revision;
  const metadata = state.history?.dependencies;
  useEffect(() => {
    let cancelled = false;
    for (const id of ids) {
      if (state.tasks.some((task) => task.id === id) || metadata?.some((task) => task.id === id)) continue;
      Promise.resolve().then(() => sim.historyPage({ taskId: id, limit: 1 })).then(
        (page) => { if (!cancelled) setSaved((current) => ({ ...current, [id]: { task: page.items[0] } })); },
        (failure) => { if (!cancelled) setSaved((current) => ({ ...current, [id]: { ...current[id], error: failureText(failure) } })); },
      );
    }
    return () => { cancelled = true; };
  }, [selectedKey, liveKey, revision, retry]); // IDs, rather than every board update, drive compact reads.
  const choice = (id: string) => {
    const task = state.tasks.find((task) => task.id === id) ?? metadata?.find((task) => task.id === id) ?? saved[id]?.task;
    return { task, error: saved[id]?.error, loading: !task && !Object.hasOwn(saved, id) };
  };
  return { choice, reload: () => setRetry((value) => value + 1) };
}

function Selection({ state, ids, onChange, disabled, onOpenTask }: { state: State; ids: readonly string[]; onChange?: (ids: string[]) => void; disabled?: boolean; onOpenTask?: (id: string) => void }) {
  const { choice, reload } = useChoices(state, ids);
  const find = lookup(state);
  return ids.length ? <ul className="dependency-selection" aria-label="Selected prerequisites">{ids.map((id) => {
    const { task, loading, error } = choice(id);
    const blocking = task ? stillBlocks(task) : undefined;
    return <li key={id}><div>{task ? <>
      {onChange ? <strong>{task.title}</strong> : <TaskLink taskId={id} find={find} onOpen={onOpenTask}>{task.title}</TaskLink>}
      <span className="quiet-text">{productsOf(task, state)}</span>
      <span className="quiet-text">{dependencyOutcome(task)}{blocking === undefined ? "" : blocking ? " · Still blocks" : " · No longer blocks"}</span>
    </> : <><strong>{loading ? "Checking selected task…" : error ? "Selected task could not be checked" : "Unavailable task"}</strong><span className="quiet-text" role={error ? "alert" : undefined}>{error ?? (loading ? "Keeping this choice while it loads." : "This task was removed or is unavailable. Remove it and choose a replacement.")}</span></>}
    {error && task && <span className="note bad" role="alert">Could not refresh this task. {error}</span>}
    {error && <button type="button" className="linkish" onClick={reload}>Try checking again</button>}</div>
    {onChange && <button type="button" className="btn quiet small" disabled={disabled} aria-label={`Remove ${task?.title ?? "unavailable task"}`} onClick={(event) => { onChange(ids.filter((entry) => entry !== id)); event.currentTarget.closest(".dependency-picker")?.querySelector<HTMLButtonElement>("button")?.focus(); }}>Remove</button>}</li>;
  })}</ul> : null;
}

export function DependencyPicker({ state, ids, onChange, task, disabled = false, initiallyOpen = false, onOpenTask }: {
  state: State; ids: readonly string[]; onChange: (ids: string[]) => void; task?: Task; disabled?: boolean; initiallyOpen?: boolean; onOpenTask?: (id: string) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [liveLimit, setLiveLimit] = useState(24);
  const [earlier, setEarlier] = useState<readonly HistoryItem[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close, "click");
  const id = useId();
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setCursor(undefined); setEarlier([]); }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  const { page, error, reload } = useHistoryPage(state, open, "all", { query, cursor });
  const terms = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const live = state.tasks.filter((entry) => !finishedTask(entry) && terms.every((term) => `${entry.title} ${productsOf(entry, state)}`.toLocaleLowerCase().includes(term)));
  const results = [...live.slice(0, liveLimit), ...earlier, ...(page?.items ?? [])].filter((entry, at, all) => all.findIndex((other) => other.id === entry.id) === at);
  const done = () => { setOpen(false); box.current?.querySelector("button")?.focus(); };
  const reason = (entry: Choice): string | undefined => {
    if (ids.includes(entry.id)) return;
    if (task && entry.id === task.id) return "A task cannot wait for itself";
    if (task && state.tasks.some((other) => other.id === entry.id)) {
      try { validateTaskDependencies(task.id, [entry.id], (id) => state.tasks.find((other) => other.id === id)); }
      catch { return "Already waiting on this task"; }
    }
    if (ids.length >= 20) return "Choose up to 20 prerequisites";
  };
  return <div className="dependency-picker">
    <span className="sr-only" role="status">{ids.length} prerequisites selected</span>
    <div className="new-task-product-select" ref={box}>
      <button type="button" className="select new-task-product-trigger" aria-label="Choose tasks to wait for" aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => setOpen(!open)}><ListOrdered size={16} aria-hidden="true" /><span>Choose tasks to wait for…</span><span className="num quiet-text">{ids.length}</span><ChevronDown size={16} aria-hidden="true" /></button>
      {open && <div id={id} className="new-task-product-menu">
        <label className="new-task-product-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="Find tasks by title or product" placeholder="Find tasks by title or product…" value={search} disabled={disabled} onChange={(event) => { setSearch(event.target.value); setLiveLimit(24); setCursor(undefined); setEarlier([]); }} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} autoFocus /></label>
        <p className="note dependency-search-hint">Finished tasks are searched by title.</p>
        <div className="new-task-product-picker dependency-results" role="group" aria-label="Task prerequisites">{results.map((entry) => {
          const unavailable = reason(entry);
          return <label className={`new-task-product-choice ${ids.includes(entry.id) ? "chosen" : ""}`} key={entry.id}>
            <input type="checkbox" checked={ids.includes(entry.id)} disabled={disabled || !!unavailable} onChange={(event) => onChange(event.target.checked ? [...ids, entry.id] : ids.filter((id) => id !== entry.id))} />
            <span><strong>{entry.title}</strong><span className="quiet-text">{productsOf(entry, state)}</span><span className="quiet-text">{dependencyOutcome(entry)}</span>{unavailable && <span className="quiet-text">{unavailable}</span>}</span>
          </label>;
        })}
        {!results.length && <p className="note">{page ? search.trim() ? "No tasks match your search." : "No tasks to wait for yet. Create another task first." : "No matching tasks on the board."}</p>}
        </div>
        {(!page || search.trim() !== query) && !error && <p className="note" role="status">Finding finished tasks…</p>}
        {error && <p className="note bad" role="alert">Could not search finished tasks. {error} <button type="button" className="linkish" onClick={reload}>Try again</button></p>}
        {live.length > liveLimit && <button type="button" className="btn quiet small" disabled={disabled} onClick={() => setLiveLimit(liveLimit + 24)}>Show more board tasks</button>}
        {page?.nextCursor && <button type="button" className="btn quiet small" disabled={disabled || search.trim() !== query} onClick={() => { setEarlier([...earlier, ...page.items]); setCursor(page.nextCursor); }}>Show more</button>}
        <div className="new-task-product-menu-foot"><span className="quiet-text num" role="status">{ids.length} selected</span><div className="row"><button type="button" className="btn quiet small" disabled={disabled || !ids.length} onClick={() => onChange([])}>Clear all</button><button type="button" className="btn quiet small" onClick={done}>Done</button></div></div>
      </div>}
    </div>
    <Selection state={state} ids={ids} onChange={onChange} disabled={disabled} onOpenTask={onOpenTask} />
  </div>;
}

export function DependencyEditor({ task, state, onClose, onOpenTask }: { task: Task; state: State; onClose: () => void; onOpenTask?: (id: string) => void }) {
  const [ids, setIds] = useState<string[]>([...(task.after ?? [])]);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<readonly string[]>();
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const sent = useRef(false);
  const baseline = useRef(JSON.stringify([...(task.after ?? [])].sort()));
  const dirty = JSON.stringify([...ids].sort()) !== baseline.current;
  const editable = canEditTaskDependencies(task);
  const close = () => { if (!saving) { if (dirty) setDiscard(true); else onClose(); } };
  const save = async () => {
    if (sent.current || (!dirty && !pending)) return;
    sent.current = true; setSaving(true); setError("");
    try { await sim.setAfter(task.id, [...(pending ?? ids)]); onClose(); }
    catch (failure) { setError(failureText(failure)); setPending(uncertainReply(failure) ? [...(pending ?? ids)] : undefined); }
    finally { sent.current = false; setSaving(false); }
  };
  return <><EditorPanel title="Start after other tasks land" caption={task.title} description={DEPENDENCY_HELP} busy={saving} onClose={close} footer={<><button type="button" className="btn quiet" disabled={saving} onClick={onClose}>Cancel</button><button type="button" className="btn lead" disabled={saving || !editable || (!dirty && !pending)} onClick={() => void save()}>{saving ? "Saving…" : pending ? "Retry confirmation" : "Save changes"}</button></>}>
    <DependencyPicker state={state} task={task} ids={ids} onChange={setIds} disabled={saving || !!pending || !editable} initiallyOpen onOpenTask={onOpenTask} />
    {!editable && <p className="note" role="status">This task has started or finished. Prerequisites can no longer change. Your attempted choices are still shown.</p>}
    {error && <p className="note bad" role="alert">{error}{pending ? " Retry confirmation sends the same choices again." : " Your choices have not been changed here. Review them and try again."}</p>}
  </EditorPanel>{discard && <ConfirmDialog title="Discard prerequisite changes?" confirm="Discard changes" cancel="Keep editing" onConfirm={onClose} onCancel={() => setDiscard(false)}><p>Your unsaved prerequisite choices will be lost.</p></ConfirmDialog>}</>;
}

export function TaskDependencies({ task, state, onOpenTask, onEdit }: { task: Task; state: State; onOpenTask?: (id: string) => void; onEdit?: (task: Task) => void }) {
  const [editing, setEditing] = useState(false);
  const editable = canEditTaskDependencies(task);
  if (!editable && !task.after?.length) return null;
  return <section className="sheet-section reading">
    <h2>Start after other tasks land</h2><p className="quiet-text">{DEPENDENCY_HELP}</p>
    <Selection state={state} ids={task.after ?? []} onOpenTask={onOpenTask} />
    {editable ? <button type="button" className="btn outline" onClick={() => onEdit ? onEdit(task) : setEditing(true)}>{task.after?.length ? "Change prerequisites" : "Choose tasks to wait for…"}</button> : <p className="note">Work has started. These pre-start prerequisites can no longer change.</p>}
    {editing && <DependencyEditor task={task} state={state} onClose={() => setEditing(false)} onOpenTask={onOpenTask} />}
  </section>;
}

/** Runtime waits are coordinated through the CLI or MCP; the window shows their saved record. */
export function TaskRuntimeWait({ task, state, onOpenTask }: { task: Task; state: State; onOpenTask?: (id: string) => void }) {
  const wait = task.runtimeWait;
  const ids = [...new Set([...(wait?.after ?? []), ...(wait?.changes.flatMap((change) => [...change.before, ...change.after]) ?? [])])];
  const { choice, reload } = useChoices(state, ids);
  const find = lookup(state);
  const view = runtimeWaitView(task, (id) => choice(id).task);
  if (!wait || !view) return null;
  const checking = wait.after.some((id) => choice(id).loading || choice(id).error);
  const list = (selected: readonly string[]) => selected.length ? selected.map((id, index) => <span key={id}>{index > 0 ? ", " : ""}<TaskLink taskId={id} find={find} onOpen={onOpenTask}>{choice(id).task?.title ?? wait.titles?.[id] ?? "Unavailable task"}</TaskLink></span>) : "None";
  const date = (at: number) => <time className="num" dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time>;
  return <section className="sheet-section reading runtime-wait" aria-label="Wait for other tasks to land">
    <h2>Wait for other tasks to land</h2>
    <p>{view.phase === "released" ? view.releaseReason ?? "The wait ended" : view.phase === "after-current-work" ? "The hold starts after the current work finishes." : "The hold is active. No new work starts for this task."}</p>
    <p className="prose">{view.reason}</p>
    {view.held && !checking && view.decisionNeeded && <p className="warn-text">Waiting for your decision. Change the awaited tasks or clear the wait, with a reason.</p>}
    {!!view.prerequisites.length && <ul className="dependency-selection" aria-label="Awaited tasks">{view.prerequisites.map((entry) => {
      const saved = choice(entry.id);
      return <li key={entry.id}><div>
        <TaskLink taskId={entry.id} find={find} onOpen={onOpenTask}>{saved.loading ? "Checking awaited task…" : entry.title}</TaskLink>
        <span className="quiet-text">{saved.loading ? "Checking its current outcome…" : saved.error ? "The current outcome could not be checked." : entry.state}{!saved.loading && !saved.error && view.held && entry.decisionNeeded ? " · Your decision is needed" : ""}</span>
        {saved.error && <><span className="note bad" role="alert">{saved.error}</span><button type="button" className="linkish" onClick={reload}>Try checking again</button></>}
      </div></li>;
    })}</ul>}
    {view.releasedAt !== undefined && <p className="note">Wait ended {date(view.releasedAt)}.</p>}
    {view.latestChange && <p className="note">Latest change: {date(view.latestChange.at)} · {view.latestChange.reason}</p>}
    {!!view.changeCount && <details className="runtime-wait-history"><summary>{view.changeCount} {view.changeCount === 1 ? "recorded change" : "recorded changes"}</summary><ol>{view.changes.map((change, index) => <li key={`${change.at}-${index}`}>
      <p>{date(change.at)}</p><p>Before: {list(change.before)}</p><p>After: {list(change.after)}</p><p className="prose">{change.reason}</p>{change.requestId && <p className="note">Request reference: {change.requestId}</p>}
    </li>)}</ol></details>}
    <p className="note">The coordinator changes this wait from the command line or MCP.</p>
  </section>;
}
