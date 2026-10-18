import { StartFromFields } from "./TaskStart";
import { useRef, useState } from "react";
import { DELIVERY_LABEL, type DeliveryMode, type State, type TaskKind, type StartFrom } from "@petrina/core";
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
  /** Replaces a delivery mode's usual label, for a chosen branch or pull request. */
  deliveryText?: (mode: DeliveryMode) => string;
}

/** The kind of work, what happens when it is ready, and its place in the queue: the same in this dialog and in first run's More options. */
export function TaskOptions({ kind, delivery, position, onKind, onDelivery, onPosition, disabled = false, deliveryText }: TaskOptionsProps) {
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
      <div className="opt">
        <span id="new-delivery">When it's ready</span>
        <div className="segmented" role="radiogroup" aria-labelledby="new-delivery">
          {(Object.keys(DELIVERY_LABEL) as DeliveryMode[]).map((mode) => (
            <button key={mode} role="radio" aria-checked={delivery === mode} className={delivery === mode ? "on" : ""} onClick={() => onDelivery(mode)} disabled={disabled}>
              {deliveryText?.(mode) ?? DELIVERY_LABEL[mode]}
            </button>
          ))}
        </div>
      </div>
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
  const [productId, setProductId] = useState(defaultProduct ?? "");
  const [startFrom, setStartFrom] = useState<StartFrom>({ kind: "default" });
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<TaskKind>("feature");
  const [position, setPosition] = useState<Position>("bottom");
  const [backlog, setBacklog] = useState(true);
  const supportsBacklog = mode === "demo" || state.history !== undefined;
  const [approvePlan, setApprovePlan] = useState(false);
  const productOf = (id: string) => state.products.find((product) => product.id === id);
  const [delivery, setDelivery] = useState<DeliveryMode>(productOf(productId)?.delivery ?? "pull-request");
  const [approveDelivery, setApproveDelivery] = useState(productOf(productId)?.approveDelivery ?? true);
  const pickProduct = (id: string) => {
    setProductId(id);
    setDelivery(productOf(id)?.delivery ?? "pull-request");
    setApproveDelivery(productOf(id)?.approveDelivery ?? true);
  };
  // A pasted list becomes one task per line: the first line stays editable, the rest ride along.
  const [batch, setBatch] = useState<string[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, onClose);

  const invalidSource = (startFrom.kind === "branch" && !startFrom.name.trim()) || (startFrom.kind === "pull-request" && !startFrom.value.trim()) || (delivery === "release" && startFrom.kind !== "default");
  const add = (another: boolean) => {
    if (!title.trim() || invalidSource || (backlog && !supportsBacklog)) return;
    const titles = [title.trim(), ...batch.slice(1)];
    for (const entry of titles) void Promise.resolve(sim.addTask({ productId, title: entry, description, kind, position, approvePlan, delivery, approveDelivery, startFrom, backlog })).catch(() => undefined);
    if (another) {
      setTitle("");
      setDescription("");
      setBatch([]);
      titleRef.current?.focus();
    } else {
      onCreated();
    }
  };

  return (
    <>
      <div className="dialog-scrim" onClick={onClose} />
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label="New task" tabIndex={-1}>
        <WaitingLine text={waiting} />
        {state.products.length <= 5 ? (
          <div className="segmented" role="radiogroup" aria-label="Product" style={{ marginBottom: 8 }}>
            <button role="radio" aria-checked={!productId} className={!productId ? "on" : ""} onClick={() => pickProduct("")}>Let the planner choose</button>
            {state.products.map((product) => (
              <button key={product.id} role="radio" aria-checked={productId === product.id} className={`tone-${product.tone} ${productId === product.id ? "on" : ""}`} onClick={() => pickProduct(product.id)}>
                <i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--tone)" }} aria-hidden="true" />
                {product.name}
              </button>
            ))}
          </div>
        ) : (
          <select className="select" style={{ marginBottom: 8 }} aria-label="Product" value={productId} onChange={(event) => pickProduct(event.target.value)}>
            <option value="">Let the planner choose</option>
            {[...state.products].sort((a, b) => a.name.localeCompare(b.name)).map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        )}
        <input
          ref={titleRef}
          autoFocus
          className="title-input"
          aria-label="What do you want done?"
          placeholder="What do you want done?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onPaste={(event) => {
            const lines = event.clipboardData.getData("text").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            if (lines.length > 1) {
              event.preventDefault();
              setTitle(lines[0] ?? "");
              setBatch(lines);
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // The dialog closes mid-key and focus returns to the opener: the rest of this Enter must not reach it.
            event.preventDefault();
            add(event.metaKey || event.ctrlKey ? false : event.shiftKey);
          }}
        />
        {batch.length > 1 && (
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="label running">Plus {batch.length - 1} more tasks from your paste</span>
            <button className="linkish" onClick={() => setBatch([])}>
              Keep only the first
            </button>
          </div>
        )}
        <textarea className="details" aria-label="Details" placeholder="Add details, links or how you'll judge it's done (optional)" value={description} onChange={(event) => setDescription(event.target.value)} />
        <div className="new-task-destination">
          <div className="segmented" role="radiogroup" aria-label="When work starts">
            <button role="radio" aria-checked={backlog} className={backlog ? "on" : ""} onClick={() => setBacklog(true)}>Review in backlog</button>
            <button role="radio" aria-checked={!backlog} className={!backlog ? "on" : ""} onClick={() => setBacklog(false)}>Ready for the queue</button>
          </div>
          <p className="quiet-text">{backlog ? "Saved for review. No agent starts until you queue it." : "Starts when the pool is running and a place is free."}</p>
          {backlog && !supportsBacklog && <p className="note">Backlog will be available after the engine is updated.</p>}
        </div>
        <StartFromFields value={startFrom} onChange={setStartFrom} />
        {delivery === "release" && startFrom.kind !== "default" && <p className="note bad" role="alert">Releases use the default branch. Change the starting point or delivery mode.</p>}
        {startFrom.kind === "pull-request" && delivery !== "release" && <p className="note">The checked work will update this pull request’s working branch. Fork destinations are shown in the plan.</p>}
        <TaskOptions
          kind={kind}
          delivery={delivery}
          position={position}
          onKind={setKind}
          onDelivery={setDelivery}
          onPosition={setPosition}
          deliveryText={(mode) => (mode === "local" && startFrom.kind === "pull-request" ? "Commit to pull request branch" : mode === "local" ? `Commit to ${startFrom.kind === "branch" ? startFrom.name.trim() || "branch" : productOf(productId)?.defaultBranch ?? "main"}` : mode === "pull-request" && startFrom.kind === "pull-request" ? "Update pull request" : DELIVERY_LABEL[mode])}
        />
        <div className="foot">
          <span className="left">
            <label className="toggle">
              <input type="checkbox" checked={approvePlan} onChange={(event) => setApprovePlan(event.target.checked)} />
              Show me the plan first
            </label>
            <label className="toggle">
              <input type="checkbox" checked={approveDelivery} onChange={(event) => setApproveDelivery(event.target.checked)} />
              Ask me before shipping
            </label>
          </span>
          <button className="btn quiet" onClick={() => add(true)} disabled={!title.trim() || invalidSource || (backlog && !supportsBacklog)}>
            Add another <kbd>⇧↵</kbd>
          </button>
          <button className="btn lead" onClick={() => add(false)} disabled={!title.trim() || invalidSource || (backlog && !supportsBacklog)}>
            {backlog ? "Add to backlog" : "Add to queue"} <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </>
  );
}
