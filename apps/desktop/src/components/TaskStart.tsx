import { useState } from "react";
import { deliveryLabel, sourceLabel, workSummary, type StartFrom, type State, type Task, type WorkChoice } from "@petrina/core";
import { sim } from "../engine";

export function StartFromFields({ value, onChange }: { value: StartFrom; onChange: (value: StartFrom) => void }) {
  return <div className="start-fields">
    <label>Start from
      <select className="select" aria-label="Start from" value={value.kind} onChange={(event) => onChange(event.target.value === "branch" ? { kind: "branch", name: "" } : event.target.value === "pull-request" ? { kind: "pull-request", value: "" } : { kind: "default" })}>
        <option value="default">Default branch</option><option value="branch">Branch</option><option value="pull-request">Pull request</option>
      </select>
    </label>
    {value.kind !== "default" && <label>{value.kind === "branch" ? "Exact branch name" : "Pull request number or link"}
      <input className="select" aria-label={value.kind === "branch" ? "Exact branch name" : "Pull request number or link"} value={value.kind === "branch" ? value.name : value.value} placeholder={value.kind === "branch" ? "release-2.x" : "#123 or a GitHub link"} onChange={(event) => onChange(value.kind === "branch" ? { kind: "branch", name: event.target.value } : { kind: "pull-request", value: event.target.value })} />
    </label>}
  </div>;
}

export function TaskStart({ task, state }: { task: Task; state: State }) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<WorkChoice>(task.workProposal?.[0] ?? task.workChoice ?? { productId: task.productId, startFrom: { kind: "default" }, delivery: task.delivery });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const source = task.proposedSource ?? task.source;
  const editable = !task.worktree && state.inbox.some((item) => item.taskId === task.id && item.kind === "plan");
  return <section className="sheet-section reading task-start">
    <h2>Works on</h2>
    {source && <><p className="prose">{source.product.name} ({sourceLabel(source)})</p><p className="prose">{workSummary(source).split("\n").slice(1).join("\n")}</p></>}
    {task.workError && <p className="note bad" role="alert">{task.workError}</p>}
    {task.workProposal && task.workProposal.length > 1 && <p className="note">Proposed products: {task.workProposal.map((entry) => state.products.find((product) => product.id === entry.productId)?.name ?? `${entry.productId} (Needs adding)`).join(", ")}</p>}
    {task.proposedSource && <p className="note">The planner proposed a change. Your earlier choices stay in place until you approve this plan.</p>}
    {editable && !editing && <button className="btn quiet small" onClick={() => { setChoice(task.workProposal?.[0] ?? task.workChoice ?? { productId: task.productId, startFrom: { kind: "default" }, delivery: task.delivery }); setError(""); setEditing(true); }}>Change product or starting point</button>}
    {editable && editing && <div className="stack">
      <label>Product<select className="select" aria-label="Works on product" value={choice.productId} onChange={(event) => setChoice({ ...choice, productId: event.target.value })}>
        {!state.products.some((product) => product.id === choice.productId) && <option value={choice.productId}>{choice.productId || "Choose a product"} — Needs adding</option>}
        {state.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select></label>
      <p className="note">Add an unregistered product through Products, then choose it here.</p>
      <StartFromFields value={choice.startFrom} onChange={(startFrom) => setChoice({ ...choice, startFrom })} />
      <label>When it’s ready<select className="select" aria-label="Delivery destination" value={choice.delivery} onChange={(event) => setChoice({ ...choice, delivery: event.target.value as WorkChoice["delivery"] })}>
        <option value="pull-request">{choice.startFrom.kind === "pull-request" ? "Update the pull request" : "Open a pull request"}</option><option value="local">Commit and push to the starting branch</option><option value="release">Publish a release</option>
      </select></label>
      {error && <p role="alert" className="note bad">{error}</p>}
      <button className="btn" disabled={saving} onClick={async () => { setSaving(true); setError(""); try { await sim.setTaskStart(task.id, choice); setEditing(false); } catch (error) { setError(String(error)); } finally { setSaving(false); } }}>Apply choices</button>
    </div>}
    {!source && !task.workError && <p className="note">{deliveryLabel(task)}. The planner will confirm the starting point.</p>}
  </section>;
}
