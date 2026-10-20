import { useEffect, useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { frequencyText, occurrenceText, routinePreview, routineReferenceProblem, type Routine, type RoutineDraft, type RoutineSchedule, type State } from "@petrina/core";
import { sim, useEngineStatus } from "../engine";
import { profileText, type Lookup } from "../lib";
import { followLink, routeHref } from "../routes";
import { ConfirmDialog, RoleAvatar, useFocusTrap } from "./bits";

export function Routines({ state, find, product, onOpen, onDialogChange }: { state: State; find: Lookup; product: string; onOpen: (id: string) => void; onDialogChange?: (open: boolean) => void }) {
  const [editor, setEditor] = useState<Routine | "new">();
  const [removing, setRemoving] = useState<Routine>();
  const [error, setError] = useState("");
  useEffect(() => {
    onDialogChange?.(!!editor || !!removing);
    return () => onDialogChange?.(false);
  }, [editor, removing, onDialogChange]);
  const connected = useEngineStatus().link === "live";
  const routines = (state.routines ?? []).filter(r => product === "all" || r.productId === product);
  const act = async (work: () => unknown | Promise<unknown>) => { try { setError(""); await work(); } catch (e) { setError(e instanceof Error ? e.message : "The routine could not be saved. Try again."); } };
  const taskLink = (id: string, label: string) => <a href={routeHref({ view: "library", product, sheet: { taskId: id, tab: "overview", list: undefined } })} onClick={e => followLink(e, () => onOpen(id))}>{label}</a>;
  return <section aria-labelledby="routines-title">
    <div className="section-row"><h2 className="section-title" id="routines-title">Routines</h2><button className="btn outline" disabled={!connected || !state.products.length} onClick={() => setEditor("new")}><Plus size={16} aria-hidden="true" />Add a routine</button></div>
    <p className="note section-note">When due, a routine adds a task to the Queue. Petrina must be open. After sleep or restart, missed times combine into one catch-up task. An unfinished run prevents another.</p>
    {!connected && <p role="status">Waiting for the engine to reconnect. Routine changes are unavailable.</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {!routines.length && <div className="tile"><strong>No routines yet</strong><p>{state.products.length ? "Schedule a focused investigation or small maintenance change for a saved product." : "Add a product before creating a routine."}</p></div>}
    <div className="grid routines-grid">{routines.map(routine => {
      const role = find.role(routine.roleId), profile = find.profile(routine.profileId);
      const attention = routineReferenceProblem(routine, state) ?? routine.attention;
      const unavailable = !state.tools.some(t => t.id === profile?.toolId && t.status === "ready");
      return <article className="tile" key={routine.id}>
        <div className="row between"><span>{find.product(routine.productId)?.name ?? "Product removed"}</span><span className={`label ${attention ? "warn" : ""}`}>{attention ? "Needs attention" : routine.enabled ? "Enabled" : "Disabled"}</span></div>
        <h3 className="title">{routine.name}</h3>
        <div className="row"><RoleAvatar role={role} size={24} /><strong>{role?.name ?? "Role removed"}</strong></div>
        <p>{profileText(profile, find, true) || "Profile unavailable"}</p>
        <p>{frequencyText(routine.schedule)}<br />{routine.zone}</p>
        <p>{routine.enabled && !attention ? `Next queue time: ${occurrenceText(routine.nextAt, routine.zone)}` : "Next run: none until enabled and ready"}</p>
        {attention && <p className="note" role="status">{attention}</p>}
        {routine.enabled && unavailable && <p className="note">The selected tool is unavailable. A queued run waits for its saved profile. Check the tool in Agents.</p>}
        {routine.enabled && state.pool.paused && <p className="note">The pool is paused. Tasks may join the Queue; agents and checks wait until it resumes.</p>}
        {routine.message && <p className="note">{routine.message} {routine.blockingTaskId && taskLink(routine.blockingTaskId, "View the unfinished run")}</p>}
        <div>{routine.latestTaskId ? taskLink(routine.latestTaskId, "Latest queued run") : <span className="quiet-text">No runs queued yet</span>}</div>
        <div className="grow" /><div className="foot routine-actions"><button className="btn small" disabled={!connected} onClick={() => setEditor(routine)}>Edit</button><button className="btn small" disabled={!connected || !!attention && !routine.enabled} onClick={() => void act(() => sim.setRoutineEnabled(routine.id, !routine.enabled))}>{routine.enabled ? "Disable" : "Enable"}</button><button className="btn small" disabled={!connected} onClick={() => setRemoving(routine)}>Remove</button></div>
      </article>;
    })}</div>
    {editor && <RoutineEditor key={editor === "new" ? "new" : editor.id} routine={editor === "new" ? undefined : editor} state={state} find={find} product={product} connected={connected} onClose={() => setEditor(undefined)} />}
    {removing && <ConfirmDialog title={`Remove ${removing.name}?`} children={<p>Future occurrences stop. Tasks already queued keep their saved instructions and profile.</p>} confirm="Remove routine" onCancel={() => setRemoving(undefined)} onConfirm={() => { void act(() => sim.removeRoutine(removing.id)); setRemoving(undefined); }} />}
  </section>;
}

function RoutineEditor({ routine, state, find, product, connected, onClose }: { routine?: Routine; state: State; find: Lookup; product: string; connected: boolean; onClose: () => void }) {
  const roles = state.roles.filter(r => r.category === "maintenance" && !r.removed);
  const [initial] = useState<RoutineDraft>(() => routine ?? { name: `${roles[0]?.name ?? "Maintenance"} · ${find.product(product)?.name ?? state.products[0]?.name ?? ""}`, productId: product === "all" ? state.products[0]?.id ?? "" : product, roleId: roles[0]?.id ?? "", profileId: state.profiles.find(p => p.id === "sol-medium")?.id ?? state.profiles[0]?.id ?? "", focus: "", zone: Intl.DateTimeFormat().resolvedOptions().timeZone, schedule: { kind: "daily", time: "09:00" }, enabled: true });
  const [draft, setDraft] = useState(initial), [error, setError] = useState(""), [busy, setBusy] = useState(false), [discard, setDiscard] = useState(false);
  const [named, setNamed] = useState(!!routine);
  const panel = useRef<HTMLElement>(null), id = useId();
  const close = () => JSON.stringify(initial) !== JSON.stringify(draft) ? setDiscard(true) : onClose();
  useFocusTrap(panel, close);
  const set = (change: Partial<RoutineDraft>) => setDraft(current => {
    const next = { ...current, ...change };
    if (!named && (change.productId || change.roleId)) next.name = `${find.role(next.roleId)?.name ?? "Maintenance"} · ${find.product(next.productId)?.name ?? ""}`;
    return next;
  });
  let preview: number[] = [], scheduleError = "";
  try { preview = routinePreview(draft.schedule, draft.zone, state.now); } catch (e) { scheduleError = (e as Error).message; }
  const referenceError = routineReferenceProblem(draft, state);
  const selectedRole = find.role(draft.roleId);
  const save = async () => {
    if (scheduleError || referenceError) { setError(scheduleError || referenceError!); return; }
    setBusy(true); setError("");
    try { await sim.saveRoutine(draft, routine?.id); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save the routine. Try again."); setBusy(false); }
  };
  const schedule = (value: RoutineSchedule) => set({ schedule: value });
  const time = draft.schedule.kind === "cron" ? "09:00" : draft.schedule.time;
  const select = (label: string, key: "productId" | "roleId" | "profileId", choices: { id: string; name: string }[]) => <label className="form-field"><span className="field-label">{label}</span><select className="select" value={draft[key]} onChange={e => set({ [key]: e.target.value })}>{!choices.some(c => c.id === draft[key]) && <option value={draft[key]}>Choose an available {label.toLowerCase()}</option>}{choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>;
  return <><div className="scrim" onClick={close} /><section ref={panel} className="sheet panel routine-panel" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (connected && !busy) void save(); } }}>
    <div className="sheet-bar"><span>{routine ? "Edit routine" : "New routine"}</span><button className="btn quiet icon" aria-label="Close routine editor" onClick={close}><X size={18} /></button></div>
    <div className="sheet-scroll"><header className="sheet-hero"><h1 id={`${id}-title`}>{routine ? "Edit routine" : "Schedule maintenance"}</h1></header>
      <div className="sheet-body role-form">
        {select("Product", "productId", state.products.map(p => ({ id: p.id, name: p.name })))}
        {select("Maintenance role", "roleId", roles.map(r => ({ id: r.id, name: r.name })))}
        {select("Agent profile", "profileId", state.profiles.map(p => ({ id: p.id, name: profileText(p, find, true) })))}
        <label className="form-field"><span className="field-label">Name</span><input className="field" value={draft.name} maxLength={100} onChange={e => { setNamed(true); set({ name: e.target.value }); }} /></label>
        <label className="form-field"><span className="field-label">Focus instructions (optional)</span><textarea className="field area" rows={4} maxLength={4000} value={draft.focus} onChange={e => set({ focus: e.target.value })} /></label>
        <label className="form-field"><span className="field-label">Frequency</span><select className="select" value={draft.schedule.kind} onChange={e => schedule(e.target.value === "daily" ? { kind: "daily", time } : e.target.value === "weekly" ? { kind: "weekly", time, weekdays: [1] } : { kind: "cron", expression: "0 9 * * 1" })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="cron">Custom</option></select></label>
        {draft.schedule.kind !== "cron" && <label className="form-field"><span className="field-label">Local time</span><input className="field" type="time" value={draft.schedule.time} onChange={e => schedule({ ...draft.schedule as Exclude<RoutineSchedule, { kind: "cron" }>, time: e.target.value })} /></label>}
        {draft.schedule.kind === "weekly" && <fieldset className="form-field"><legend>Weekdays</legend><div className="routine-weekdays">{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, n) => <label key={day}><input type="checkbox" checked={draft.schedule.kind === "weekly" && draft.schedule.weekdays.includes(n)} onChange={e => { if (draft.schedule.kind === "weekly") schedule({ ...draft.schedule, weekdays: e.target.checked ? [...draft.schedule.weekdays, n] : draft.schedule.weekdays.filter(d => d !== n) }); }} />{day}</label>)}</div></fieldset>}
        {draft.schedule.kind === "cron" && <label className="form-field"><span className="field-label">Custom cron schedule</span><input className="field" value={draft.schedule.expression} maxLength={200} aria-describedby={`${id}-cron`} onChange={e => schedule({ kind: "cron", expression: e.target.value })} /><span className="hint" id={`${id}-cron`}>Five fields: minute (0–59), hour (0–23), date (1–31), month (1–12), weekday (0–7, Sunday is 0 or 7). Use numbers, commas, ranges, * for every value, and / for steps. When date and weekday are both restricted, either day matches.</span></label>}
        <label className="form-field"><span className="field-label">Time zone</span><input className="field" list={`${id}-zones`} value={draft.zone} onChange={e => set({ zone: e.target.value })} /><datalist id={`${id}-zones`}>{Intl.supportedValuesOf("timeZone").map(zone => <option key={zone} value={zone} />)}<option value="UTC" /></datalist></label>
        <div className="form-field" aria-live="polite" aria-atomic="true"><h2>Next three queue times</h2>{scheduleError ? <p>{scheduleError}</p> : <ol>{preview.map(at => <li key={at}>{occurrenceText(at, draft.zone)}</li>)}</ol>}<p className="hint">A daylight-saving time that does not exist is skipped. A repeated local time runs once, at its first occurrence. This saved zone stays fixed if your Mac changes zone. Queue time is not a guaranteed agent start.</p></div>
        <p className="note">Completed investigations with no product changes finish in History with their findings. {selectedRole?.result === "build" ? "Product changes receive automated checks, two independent Code reviewers and your delivery approval. Repairs return to this maintenance agent." : "This role is read-only. It reports findings without changing the product."}</p>
        <p className="hint">Petrina must be open to queue work. Missed occurrences combine into one catch-up task. Unfinished earlier runs block new ones; skipped work does not replay. Schedule changes and re-enabling begin with the first future time.</p>
        <label><input type="checkbox" checked={draft.enabled} onChange={e => set({ enabled: e.target.checked })} /> Enabled</label>
        {(error || referenceError) && <p className="error-text" role="alert">{error || referenceError}</p>}
        {!connected && <p role="status">Waiting for the engine to reconnect.</p>}
        <div className="routine-actions"><button className="btn lead" disabled={!connected || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save routine"}</button><button className="btn" onClick={close}>Cancel</button></div>
      </div>
    </div>
  </section>{discard && <ConfirmDialog title="Discard routine changes?" children={<p>Your unsaved changes will be lost.</p>} confirm="Discard changes" cancel="Keep editing" onCancel={() => setDiscard(false)} onConfirm={onClose} />}</>;
}
