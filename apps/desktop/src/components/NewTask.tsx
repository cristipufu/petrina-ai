import { useRef, useState } from "react";
import { DELIVERY_LABEL, type DeliveryMode, type State, type TaskKind } from "@petrina/core";
import { sim } from "../engine";
import { useFocusTrap, WaitingLine } from "./bits";

const KINDS: readonly { id: TaskKind; label: string; hint: string }[] = [
  { id: "feature", label: "Feature", hint: "Designed, built and reviewed" },
  { id: "bug", label: "Bug fix", hint: "Builder and two reviewers" },
  { id: "new", label: "Something new", hint: "Research, design, screens, tests" },
  { id: "chore", label: "Small change", hint: "Quick build, one reviewer" },
];

/** `waiting`: a notification's item that opens once this dialog closes. */
export function NewTaskDialog({ state, defaultProduct, waiting, onClose, onCreated }: { state: State; defaultProduct?: string; waiting?: string; onClose: () => void; onCreated: () => void }) {
  const [productId, setProductId] = useState(defaultProduct ?? state.products[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<TaskKind>("feature");
  const [position, setPosition] = useState<"bottom" | "top">("bottom");
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

  const add = (another: boolean) => {
    if (!title.trim()) return;
    const titles = [title.trim(), ...batch.slice(1)];
    for (const entry of titles) void Promise.resolve(sim.addTask({ productId, title: entry, description, kind, position, approvePlan, delivery, approveDelivery })).catch(() => undefined);
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
            {state.products.map((product) => (
              <button key={product.id} role="radio" aria-checked={productId === product.id} className={`tone-${product.tone} ${productId === product.id ? "on" : ""}`} onClick={() => pickProduct(product.id)}>
                <i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--tone)" }} aria-hidden="true" />
                {product.name}
              </button>
            ))}
          </div>
        ) : (
          <select className="select" style={{ marginBottom: 8 }} aria-label="Product" value={productId} onChange={(event) => pickProduct(event.target.value)}>
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
            if (event.key === "Enter") add(event.metaKey || event.ctrlKey ? false : event.shiftKey);
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
        <div className="options">
          <div className="opt">
            <span id="new-kind">Kind of work</span>
            <div className="segmented" role="radiogroup" aria-labelledby="new-kind">
              {KINDS.map((entry) => (
                <button key={entry.id} role="radio" aria-checked={kind === entry.id} className={kind === entry.id ? "on" : ""} onClick={() => setKind(entry.id)} title={entry.hint}>
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          <div className="opt">
            <span id="new-delivery">When it's ready</span>
            <div className="segmented" role="radiogroup" aria-labelledby="new-delivery">
              {(Object.keys(DELIVERY_LABEL) as DeliveryMode[]).map((mode) => (
                <button key={mode} role="radio" aria-checked={delivery === mode} className={delivery === mode ? "on" : ""} onClick={() => setDelivery(mode)}>
                  {DELIVERY_LABEL[mode]}
                </button>
              ))}
            </div>
          </div>
          <div className="opt">
            <span id="new-position">Place in the queue</span>
            <div className="segmented" role="radiogroup" aria-labelledby="new-position">
              <button role="radio" aria-checked={position === "bottom"} className={position === "bottom" ? "on" : ""} onClick={() => setPosition("bottom")}>
                Bottom
              </button>
              <button role="radio" aria-checked={position === "top"} className={position === "top" ? "on" : ""} onClick={() => setPosition("top")}>
                Top
              </button>
            </div>
          </div>
        </div>
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
          <button className="btn quiet" onClick={() => add(true)} disabled={!title.trim()}>
            Add another <kbd>⇧↵</kbd>
          </button>
          <button className="btn lead" onClick={() => add(false)} disabled={!title.trim()}>
            Add to queue <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </>
  );
}
