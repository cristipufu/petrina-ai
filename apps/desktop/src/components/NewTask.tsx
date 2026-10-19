import { X, ChevronDown, Package } from "lucide-react";
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
  hidePosition?: boolean;
  /** Replaces a delivery mode's usual label, for a chosen branch or pull request. */
  deliveryText?: (mode: DeliveryMode) => string;
}

/** The kind of work, what happens when it is ready, and its place in the queue: the same in this dialog and in first run's More options. */
export function TaskOptions({ kind, delivery, position, onKind, onDelivery, onPosition, disabled = false, hideDelivery = false, hidePosition = false, deliveryText }: TaskOptionsProps) {
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
      {!hidePosition && <div className="opt">
        <span id="new-position">Place in the queue</span>
        <div className="segmented" role="radiogroup" aria-labelledby="new-position">
          <button role="radio" aria-checked={position === "bottom"} className={position === "bottom" ? "on" : ""} onClick={() => onPosition("bottom")} disabled={disabled}>
            Bottom
          </button>
          <button role="radio" aria-checked={position === "top"} className={position === "top" ? "on" : ""} onClick={() => onPosition("top")} disabled={disabled}>
            Top
          </button>
        </div>
      </div>}
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
  useFocusTrap(box, () => { if (!saving) onClose(); });
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
  const available = state.products.filter((product) => product.name.toLowerCase().includes(search.toLowerCase()));
  const disabled = saving || !title.trim() || invalidSource || (backlog && !supportsBacklog);
  return <>
    <div className="dialog-scrim" onClick={saving ? undefined : onClose} />
    <div ref={box} className="dialog new-task-dialog" role="dialog" aria-modal="true" aria-label="New task" tabIndex={-1}>
      <header className="new-task-head">
        <div><h2>New task</h2><p>Describe the outcome. Choose where and when to work.</p></div>
        <button className="icon" aria-label="Close new task" onClick={onClose} disabled={saving}><X size={20} /></button>
      </header>
      <div className="new-task-body">
        <WaitingLine text={waiting} />
        <section className="new-task-section new-task-request" aria-labelledby="request-heading">
          <label id="request-heading" htmlFor="task-title">What do you want done?</label>
          <input id="task-title" maxLength={200} ref={titleRef} autoFocus className="title-input" aria-label="What do you want done?" placeholder="A short, specific task title" value={title} disabled={saving} onChange={(event) => setTitle(event.target.value)} onPaste={(event) => { const lines = event.clipboardData.getData("text").split(/\r?\n/).map((line) => line.trim()).filter(Boolean); if (lines.length > 1) { event.preventDefault(); setTitle(lines[0]!); setBatch(lines); } }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void add(event.metaKey || event.ctrlKey ? false : event.shiftKey); } }} />
          {batch.length > 1 && <p className="note">Plus {batch.length - 1} more tasks <button className="linkish" disabled={saving} onClick={() => setBatch([])}>Keep only the first</button></p>}
          <label htmlFor="task-description">Details <span className="quiet-text">Optional</span></label>
          <textarea id="task-description" maxLength={8000} className="details" aria-label="Details" placeholder="What should change? Add context, links and how you’ll judge success." value={description} disabled={saving} onChange={(event) => setDescription(event.target.value)} />
        </section>

        <fieldset className="new-task-section new-task-products" disabled={saving}><legend>Products & delivery <span className="quiet-text">{choices.length ? `${choices.length} selected` : "Optional"}</span></legend>
          <p className="note">Select the products involved, or let the planner propose them.</p>
          <input className="select" type="search" aria-label="Find products" placeholder="Find products" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="new-task-product-picker">{available.map((product) => <label className={`new-task-product-choice ${choices.some((choice) => choice.productId === product.id) ? "chosen" : ""}`} key={product.id}>
            <input type="checkbox" checked={choices.some((choice) => choice.productId === product.id)} onChange={(event) => { if (event.target.checked) { setChoices([...choices, { productId: product.id, startFrom: { kind: "default" }, delivery: product.delivery ?? "pull-request" }]); if (product.approveDelivery) setApproveDelivery(true); } else setChoices(choices.filter((choice) => choice.productId !== product.id)); }} />
            <Package size={16} aria-hidden="true" /><span>{product.name}</span>
          </label>)}</div>
          {!available.length && <p className="note">{state.products.length ? "No products match your search." : "No products added yet. The planner can help choose them."}</p>}
          {!choices.length && <p className="note">Let the planner propose products.</p>}
          {choices.map((choice) => { const product = state.products.find((entry) => entry.id === choice.productId); if (!product) return null; return <details className="repository-row new-task-product-settings" key={choice.productId}>
            <summary><span><strong>{product.name}</strong><span className="quiet-text">{choice.startFrom.kind === "default" ? "Default branch" : choice.startFrom.kind === "branch" ? choice.startFrom.name || "Choose a branch" : choice.startFrom.value || "Choose a pull request"} · {choice.delivery === "local" ? "Commit and push" : choice.delivery === "release" ? "Publish a release" : choice.startFrom.kind === "pull-request" ? "Update pull request" : "Open a pull request"}</span></span><ChevronDown size={16} aria-hidden="true" /></summary>
            <div className="new-task-product-fields">
              <StartFromFields product={product.name} value={choice.startFrom} onChange={(startFrom) => change(product.id, { startFrom })} />
              <label>When ready for {product.name}<select className="select" value={choice.delivery} onChange={(event) => change(product.id, { delivery: event.target.value as DeliveryMode })}><option value="pull-request">{choice.startFrom.kind === "pull-request" ? "Update pull request" : "Open a pull request"}</option><option value="local">Commit and push to the starting branch</option><option value="release">Publish a release</option></select></label>
              {choice.delivery === "release" && choice.startFrom.kind !== "default" && <p className="note bad" role="alert">{product.name}: Releases use the default branch.</p>}
              <button className="btn quiet small" aria-label={`Remove ${product.name}`} onClick={() => setChoices(choices.filter((entry) => entry.productId !== product.id))}>Remove product</button>
            </div>
          </details>; })}
          <p className="note">You’ll approve the complete product list and starting points before work begins.</p>
        </fieldset>

        <section className="new-task-section" aria-labelledby="new-task-work-heading">
          <h3 id="new-task-work-heading">Work & review</h3>
          <TaskOptions kind={kind} delivery={choices[0]?.delivery ?? "pull-request"} position={position} onKind={setKind} onDelivery={() => {}} onPosition={setPosition} hideDelivery hidePosition={backlog} disabled={saving} />
          <div className="new-task-approvals">
            <label className="toggle"><input type="checkbox" checked={approvePlan || choices.length !== 1} disabled={saving || choices.length !== 1} onChange={(event) => setApprovePlan(event.target.checked)} />Show me the plan first</label>
            <label className="toggle"><input type="checkbox" checked={approveDelivery} disabled={saving} onChange={(event) => setApproveDelivery(event.target.checked)} />Ask me before shipping</label>
          </div>
        </section>
        <section className="new-task-section new-task-destination" aria-labelledby="new-task-start-heading">
          <h3 id="new-task-start-heading">When to start</h3>
          <div className="segmented" role="radiogroup" aria-label="When work starts">
            <button role="radio" aria-checked={backlog} className={backlog ? "on" : ""} disabled={saving} onClick={() => setBacklog(true)}>Review in backlog</button>
            <button role="radio" aria-checked={!backlog} className={!backlog ? "on" : ""} disabled={saving} onClick={() => setBacklog(false)}>Ready for the queue</button>
          </div>
          <p className="quiet-text">{backlog ? "Saved for review. No agent starts until you queue it." : "Starts when the pool is running and a place is free."}</p>
          {backlog && !supportsBacklog && <p className="note">Backlog will be available after the engine is updated.</p>}
        </section>
        {error && <p role="alert" className="note bad">{error}</p>}
      </div>
      <footer className="new-task-foot">
        <button className="btn quiet" disabled={saving} onClick={onClose}>Cancel</button>
        <div className="new-task-submit"><button className="btn quiet" onClick={() => void add(true)} disabled={disabled}>Add another <kbd>⇧↵</kbd></button><button className="btn lead" onClick={() => void add(false)} disabled={disabled}>{saving ? "Adding…" : backlog ? "Add to backlog" : "Add to queue"} <kbd>↵</kbd></button></div>
      </footer>
    </div>
  </>;
}
