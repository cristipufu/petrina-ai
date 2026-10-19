import { useRef, useState } from "react";
import { X } from "lucide-react";
import { combinedBacklogInput, type State, type Task } from "@petrina/core";
import { failureText, sim } from "../engine";
import { useFocusTrap } from "./bits";

export function CombineBacklog({ state, tasks, onClose, onCreated }: { state: State; tasks: Task[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState(tasks[0]?.title ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const request = useRef(crypto.randomUUID());
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, () => { if (!saving) onClose(); });
  let blocked = "";
  try { combinedBacklogInput(state.tasks, tasks.map((task) => task.id), title); } catch (error) { blocked = failureText(error); }
  const combine = async () => {
    if (blocked || saving) return;
    setSaving(true); setError("");
    try { onCreated(await sim.combineBacklog(tasks.map((task) => task.id), title.trim(), request.current)); }
    catch (error) { setError(failureText(error)); setSaving(false); }
  };
  return <>
    <div className="dialog-scrim" onClick={saving ? undefined : onClose} />
    <div ref={box} className="dialog new-task-dialog" role="dialog" aria-modal="true" aria-label="Combine backlog tasks" tabIndex={-1}>
      <header className="new-task-head"><div><h2>Combine & queue</h2><p>One task, one build and review flow.</p></div><button className="btn quiet small icon" aria-label="Close combine tasks" disabled={saving} onClick={onClose}><X size={20} /></button></header>
      <div className="new-task-body">
        <section className="new-task-section new-task-request"><label htmlFor="combined-title">Combined task title</label><input id="combined-title" className="title-input" autoFocus value={title} maxLength={200} disabled={saving} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void combine(); } }} /></section>
        <section className="new-task-section"><h3>{tasks.length} original requests</h3><ol className="combine-requests">{tasks.map((task) => <li key={task.id}><strong>{task.title}</strong><p>{task.description || "No additional details."}</p></li>)}</ol><p className="note">Every request and picture is included. Originals move to History with a link to the combined task. Existing plan and shipping approvals stay enabled if any original required them.</p></section>
        {(blocked || error) && <p className="note bad" role="alert">{error || blocked}</p>}
      </div>
      <footer className="new-task-foot"><button className="btn quiet" disabled={saving} onClick={onClose}>Cancel</button><button className="btn lead" disabled={saving || !!blocked} onClick={() => void combine()}>{saving ? "Combining…" : "Combine and queue"}</button></footer>
    </div>
  </>;
}
