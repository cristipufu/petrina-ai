import { useEffect, useRef, useState } from "react";
import type { State, TaskKind } from "@petrina/core";
import { sim } from "../engine";

const KINDS: readonly { id: TaskKind; label: string; hint: string }[] = [
  { id: "feature", label: "Feature", hint: "Designed, built and reviewed" },
  { id: "bug", label: "Bug fix", hint: "Builder and two reviewers" },
  { id: "new", label: "Something new", hint: "Research, design, screens, tests" },
  { id: "chore", label: "Small change", hint: "Quick build, one reviewer" },
];

export function NewTaskDialog({ state, defaultProduct, onClose, onCreated }: { state: State; defaultProduct?: string; onClose: () => void; onCreated: (taskId: string) => void }) {
  const [productId, setProductId] = useState(defaultProduct ?? state.products[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<TaskKind>("feature");
  const [position, setPosition] = useState<"bottom" | "top">("bottom");
  const [approvePlan, setApprovePlan] = useState(false);
  // A pasted list becomes one task per line: the first line stays editable, the rest ride along.
  const [batch, setBatch] = useState<string[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = (another: boolean) => {
    if (!title.trim()) return;
    const titles = [title.trim(), ...batch.slice(1)];
    let last = "";
    for (const entry of titles) last = sim.addTask({ productId, title: entry, description, kind, position, approvePlan });
    if (another) {
      setTitle("");
      setDescription("");
      setBatch([]);
      titleRef.current?.focus();
    } else {
      onCreated(last);
    }
  };

  return (
    <>
      <div className="dialog-scrim" onClick={onClose} />
      <div className="dialog" role="dialog" aria-label="New task">
        {state.products.length <= 5 ? (
          <div className="segmented" style={{ marginBottom: 8 }}>
            {state.products.map((product) => (
              <button key={product.id} className={productId === product.id ? "on" : ""} onClick={() => setProductId(product.id)}>
                <span className={`product-chip tone-${product.tone}`}>
                  <i />
                </span>
                {product.name}
              </button>
            ))}
          </div>
        ) : (
          <select className="field" style={{ marginBottom: 8, flex: "none" }} aria-label="Product" value={productId} onChange={(event) => setProductId(event.target.value)}>
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
            <span className="pill accent">+ {batch.length - 1} more tasks from your paste</span>
            <button className="linkish" onClick={() => setBatch([])}>
              Keep only the first
            </button>
          </div>
        )}
        <textarea placeholder="Add details, links or how you'll judge it's done (optional)" value={description} onChange={(event) => setDescription(event.target.value)} />
        <div className="options">
          <div className="opt">
            <label>Kind of work</label>
            <div className="segmented">
              {KINDS.map((entry) => (
                <button key={entry.id} className={kind === entry.id ? "on" : ""} onClick={() => setKind(entry.id)} title={entry.hint}>
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          <div className="opt">
            <label>Queue</label>
            <div className="segmented">
              <button className={position === "bottom" ? "on" : ""} onClick={() => setPosition("bottom")}>
                Bottom
              </button>
              <button className={position === "top" ? "on" : ""} onClick={() => setPosition("top")}>
                Top
              </button>
            </div>
          </div>
        </div>
        <div className="foot">
          <span className="left">
            <label className="toggle">
              <input type="checkbox" checked={approvePlan} onChange={(event) => setApprovePlan(event.target.checked)} />
              Show me the plan before it starts
            </label>
          </span>
          <button className="btn ghost" onClick={() => add(true)} disabled={!title.trim()}>
            Add another <kbd>⇧↵</kbd>
          </button>
          <button className="btn primary" onClick={() => add(false)} disabled={!title.trim()}>
            Add to queue <kbd style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,.4)" }}>↵</kbd>
          </button>
        </div>
      </div>
    </>
  );
}
