import { useEffect, useRef, useState } from "react";
import { EditorPanel } from "./EditorPanel";
import { combinedBacklogInput, type State, type Task } from "@petrina/core";
import { failureText, sim } from "../engine";
import { ConfirmDialog } from "./bits";

export function CombineBacklog({ state, tasks, onClose, onCreated }: { state: State; tasks: Task[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState(tasks[0]?.title ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const request = useRef(crypto.randomUUID());
  const original = useRef(tasks).current;
  const ids = useRef(tasks.map((task) => task.id)).current;
  const shown = original.map((source) => state.tasks.find((task) => task.id === source.id) ?? source);
  const returned = useRef(false);
  const attempted = useRef(false);
  const finish = (id: string) => { if (!returned.current) { returned.current = true; onCreated(id); } };
  useEffect(() => {
    const known = state.tasks.find((task) => task.clientId === request.current);
    if (known && JSON.stringify(known.combinedFrom?.map((entry) => entry.id)) === JSON.stringify(ids)) finish(known.id);
  }, [state.tasks]);
  const [discard, setDiscard] = useState(false);
  const close = () => { if (!saving) { if (title !== (original[0]?.title ?? "")) setDiscard(true); else onClose(); } };
  let blocked = "";
  try { combinedBacklogInput(state.tasks, ids, title); } catch (error) { blocked = failureText(error); }
  const combine = async () => {
    if ((blocked && !attempted.current) || saving) return;
    attempted.current = true;
    setSaving(true); setError("");
    try { finish(await sim.combineBacklog(ids, title.trim(), request.current)); }
    catch (error) { if (!returned.current) { setError(failureText(error)); setSaving(false); } }
  };
  return <>
    <EditorPanel title="Combine & queue" dialogLabel="Combine backlog tasks" description="One task, one build and review flow." closeLabel="Close combine tasks" className="new-task-dialog" bodyClassName="new-task-body" busy={saving} onClose={close} footer={<>
<button className="btn quiet" disabled={saving} onClick={close}>Cancel</button><span className="spacer" /><button className="btn lead" disabled={saving || (!!blocked && !attempted.current)} onClick={() => void combine()}>{saving ? "Combining…" : attempted.current && error ? "Retry confirmation" : "Combine and queue"}</button>    </>}>
        <section className="new-task-section new-task-request"><label htmlFor="combined-title">Combined task title</label><input id="combined-title" className="title-input" autoFocus value={title} maxLength={200} disabled={saving || attempted.current} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void combine(); } }} /></section>
        <section className="new-task-section"><h3>{original.length} original requests</h3><ol className="combine-requests">{shown.map((task) => <li key={task.id}><strong>{task.title}</strong><p>{task.description || "No additional details."}</p></li>)}</ol><p className="note">Every request and picture is included. Originals move to History with a link to the combined task. Existing plan and shipping approvals stay enabled if any original required them.</p></section>
        {(blocked || error) && <p className="note bad" role="alert">{error || blocked}</p>}
    </EditorPanel>
    {discard && <ConfirmDialog title="Discard combined task changes?" confirm="Discard changes" cancel="Keep editing" onCancel={() => setDiscard(false)} onConfirm={onClose}><p>Your unsaved combined title will be lost. The original tasks remain in Backlog.</p></ConfirmDialog>}
  </>;
}
