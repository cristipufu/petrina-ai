import { StartFromFields } from "./TaskStart";
import { useRef, useState } from "react";
import { DELIVERY_LABEL, type DeliveryMode, type State, type TaskKind, type WorkChoice } from "@petrina/core";
import { mode, sim } from "../engine";
import { useFocusTrap, WaitingLine } from "./bits";

const KINDS: readonly { id: TaskKind; label: string; hint: string }[] = [
  { id: "feature", label: "Feature", hint: "Designed, built and reviewed" },
  { id: "bug", label: "Bug fix", hint: "Builder and two reviewers" },
  { id: "new", label: "Something new", hint: "Research, design, screens, tests" },
  { id: "chore", label: "Small change", hint: "Quick build, one reviewer" },
];

export type Position = "bottom" | "top";

interface TaskOptionsProps {
  kind: TaskKind;
  delivery: DeliveryMode;
  position: Position;
  onKind: (kind: TaskKind) => void;
  onDelivery: (delivery: DeliveryMode) => void;
  onPosition: (position: Position) => void;
  /** While the task is being saved: what is on screen is what was sent. */
  disabled?: boolean;
  hideDelivery?: boolean;
  /** Replaces a delivery mode's usual label, for a chosen branch or pull request. */
  deliveryText?: (mode: DeliveryMode) => string;
}

/** The kind of work, what happens when it is ready, and its place in the queue: the same in this dialog and in first run's More options. */
export function TaskOptions({ kind, delivery, position, onKind, onDelivery, onPosition, disabled = false, hideDelivery = false, deliveryText }: TaskOptionsProps) {
  return (
    <div className="options">
      <div className="opt">
        <span id="new-kind">Kind of work</span>
        <div className="segmented" role="radiogroup" aria-labelledby="new-kind">
          {KINDS.map((entry) => (
            <button key={entry.id} role="radio" aria-checked={kind === entry.id} className={kind === entry.id ? "on" : ""} onClick={() => onKind(entry.id)} title={entry.hint} disabled={disabled}>
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      {!hideDelivery && <div className="opt">
        <span id="new-delivery">When it's ready</span>
        <div className="segmented" role="radiogroup" aria-labelledby="new-delivery">
          {(Object.keys(DELIVERY_LABEL) as DeliveryMode[]).map((mode) => (
            <button key={mode} role="radio" aria-checked={delivery === mode} className={delivery === mode ? "on" : ""} onClick={() => onDelivery(mode)} disabled={disabled}>
              {deliveryText?.(mode) ?? DELIVERY_LABEL[mode]}
            </button>
          ))}
        </div>
      </div>}
      <div className="opt">
        <span id="new-position">Place in the queue</span>
        <div className="segmented" role="radiogroup" aria-labelledby="new-position">
          <button role="radio" aria-checked={position === "bottom"} className={position === "bottom" ? "on" : ""} onClick={() => onPosition("bottom")} disabled={disabled}>
            Bottom
          </button>
          <button role="radio" aria-checked={position === "top"} className={position === "top" ? "on" : ""} onClick={() => onPosition("top")} disabled={disabled}>
            Top
          </button>
        </div>
      </div>
    </div>
  );
}

/** `waiting`: a notification's item that opens once this dialog closes. */
export function NewTaskDialog({ state, defaultProduct, initialTitle = "", waiting, onClose, onCreated }: { state: State; defaultProduct?: string; initialTitle?: string; waiting?: string; onClose: () => void; onCreated: () => void }) {
  const initial = state.products.find((product) => product.id === defaultProduct);
  const [choices, setChoices] = useState<WorkChoice[]>(initial ? [{ productId: initial.id, startFrom: { kind: "default" }, delivery: initial.delivery ?? "pull-request" }] : []);
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<TaskKind>("feature");
  const [position, setPosition] = useState<Position>("bottom");
  const [backlog, setBacklog] = useState(true);
  const supportsBacklog = mode === "demo" || state.history !== undefined;
  const [approvePlan, setApprovePlan] = useState(false);
  const [approveDelivery, setApproveDelivery] = useState(initial?.approveDelivery ?? true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [batch, setBatch] = useState<string[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, onClose);
  const invalidSource = choices.some(({ startFrom, delivery }) => (startFrom.kind === "branch" && !startFrom.name.trim()) || (startFrom.kind === "pull-request" && !startFrom.value.trim()) || (delivery === "release" && startFrom.kind !== "default"));
  const add = async (another: boolean) => {
    if (!title.trim() || invalidSource || saving || (backlog && !supportsBacklog)) return;
    setSaving(true); setError("");
    try {
      for (const entry of [title.trim(), ...batch.slice(1)]) await sim.addTask({ productId: choices[0]?.productId ?? "", worksOn: choices, title: entry, description, kind, position, approvePlan: approvePlan || choices.length !== 1, approveDelivery, backlog });
      if (another) { setTitle(""); setDescription(""); setBatch([]); titleRef.current?.focus(); } else onCreated();
    } catch (failure) { setError(String(failure)); } finally { setSaving(false); }
  };
  const change = (id: string, update: Partial<WorkChoice>) => setChoices(choices.map((choice) => choice.productId === id ? { ...choice, ...update } : choice));
  return <>
    <div className="dialog-scrim" onClick={onClose} />
    <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label="New task" tabIndex={-1}>
      <WaitingLine text={waiting} />
      <input ref={titleRef} autoFocus className="title-input" aria-label="What do you want done?" placeholder="What do you want done?" value={title} onChange={(event) => setTitle(event.target.value)} onPaste={(event) => { const lines = event.clipboardData.getData("text").split(/\r?\n/).map((line) => line.trim()).filter(Boolean); if (lines.length > 1) { event.preventDefault(); setTitle(lines[0]!); setBatch(lines); } }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void add(event.metaKey || event.ctrlKey ? false : event.shiftKey); } }} />
      {batch.length > 1 && <p className="note">Plus {batch.length - 1} more tasks <button className="linkish" onClick={() => setBatch([])}>Keep only the first</button></p>}
      <textarea className="details" aria-label="Details" placeholder="Add details, links or how you’ll judge it’s done (optional)" value={description} onChange={(event) => setDescription(event.target.value)} />
      <fieldset className="stack"><legend>Products</legend>
        <input className="select" type="search" aria-label="Find products" placeholder="Find products" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="row wrap">{state.products.filter((product) => product.name.toLowerCase().includes(search.toLowerCase())).map((product) => <label className="toggle" key={product.id}><input type="checkbox" checked={choices.some((choice) => choice.productId === product.id)} onChange={(event) => { if (event.target.checked) { setChoices([...choices, { productId: product.id, startFrom: { kind: "default" }, delivery: product.delivery ?? "pull-request" }]); if (product.approveDelivery) setApproveDelivery(true); } else setChoices(choices.filter((choice) => choice.productId !== product.id)); }} />{product.name}</label>)}</div>
        {!choices.length && <p className="note">Let the planner propose products.</p>}
        {choices.map((choice) => { const product = state.products.find((entry) => entry.id === choice.productId)!; return <fieldset className="repository-row" key={choice.productId}><legend>{product.name}</legend>
          <StartFromFields product={product.name} value={choice.startFrom} onChange={(startFrom) => change(product.id, { startFrom })} />
          <label>When ready for {product.name}<select className="select" value={choice.delivery} onChange={(event) => change(product.id, { delivery: event.target.value as DeliveryMode })}><option value="pull-request">{choice.startFrom.kind === "pull-request" ? "Update pull request" : "Open a pull request"}</option><option value="local">Commit and push to the starting branch</option><option value="release">Publish a release</option></select></label>
          {choice.delivery === "release" && choice.startFrom.kind !== "default" && <p className="note bad" role="alert">{product.name}: Releases use the default branch.</p>}
          <button className="btn quiet small" aria-label={`Remove ${product.name}`} onClick={() => setChoices(choices.filter((entry) => entry.productId !== product.id))}>Remove</button>
        </fieldset>; })}
        <p className="note">You’ll approve the complete product list and starting points before work begins.</p>
      </fieldset>
        <div className="new-task-destination">
          <div className="segmented" role="radiogroup" aria-label="When work starts">
            <button role="radio" aria-checked={backlog} className={backlog ? "on" : ""} onClick={() => setBacklog(true)}>Review in backlog</button>
            <button role="radio" aria-checked={!backlog} className={!backlog ? "on" : ""} onClick={() => setBacklog(false)}>Ready for the queue</button>
          </div>
          <p className="quiet-text">{backlog ? "Saved for review. No agent starts until you queue it." : "Starts when the pool is running and a place is free."}</p>
          {backlog && !supportsBacklog && <p className="note">Backlog will be available after the engine is updated.</p>}
        </div>

      <TaskOptions kind={kind} delivery={choices[0]?.delivery ?? "pull-request"} position={position} onKind={setKind} onDelivery={() => {}} onPosition={setPosition} hideDelivery disabled={saving} />
      {error && <p role="alert" className="note bad">{error}</p>}
      <div className="foot"><span className="left"><label className="toggle"><input type="checkbox" checked={approvePlan || choices.length !== 1} disabled={choices.length !== 1} onChange={(event) => setApprovePlan(event.target.checked)} />Show me the plan first</label><label className="toggle"><input type="checkbox" checked={approveDelivery} onChange={(event) => setApproveDelivery(event.target.checked)} />Ask me before shipping</label></span><button className="btn quiet" onClick={() => void add(true)} disabled={saving || !title.trim() || invalidSource || (backlog && !supportsBacklog)}>Add another <kbd>⇧↵</kbd></button><button className="btn lead" onClick={() => void add(false)} disabled={saving || !title.trim() || invalidSource || (backlog && !supportsBacklog)}>{saving ? "Adding…" : backlog ? "Add to backlog" : "Add to queue"} <kbd>↵</kbd></button></div>
    </div>
  </>;
}
