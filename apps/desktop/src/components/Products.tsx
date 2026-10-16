import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { DELIVERY_LABEL, type Column, type DeliveryMode, type Product, type State } from "@petrina/core";
import { sim } from "../engine";
import type { Lookup } from "../lib";

/** Per-product numbers the switcher and the Products page both show. */
export interface ProductStats {
  product: Product;
  needsYou: number;
  working: number;
  queued: number;
  byColumn: Record<Column, number>;
  shipped: number;
  active: boolean;
}

export function productStats(state: State): ProductStats[] {
  return state.products.map((product) => {
    const tasks = state.tasks.filter((task) => task.productId === product.id);
    const byColumn = { queue: 0, planning: 0, designing: 0, building: 0, reviewing: 0, ready: 0, done: 0 } as Record<Column, number>;
    for (const task of tasks) byColumn[task.column] += 1;
    const ids = new Set(tasks.map((task) => task.id));
    const working = tasks.filter((task) => task.state === "running").length;
    const queued = tasks.filter((task) => task.state === "queued").length;
    const needsYou = state.inbox.filter((item) => ids.has(item.taskId)).length;
    const inFlight = tasks.filter((task) => !["queued", "done", "cancelled"].includes(task.state)).length;
    return {
      product,
      needsYou,
      working,
      queued,
      byColumn,
      shipped: tasks.filter((task) => task.state === "done").length,
      active: inFlight > 0 || needsYou > 0,
    };
  });
}

export function ProductBadges({ stats }: { stats: ProductStats }) {
  return (
    <span className="badges">
      {stats.needsYou > 0 && <span className="b amber" title="Waiting on you">{stats.needsYou}</span>}
      {stats.working > 0 && <span className="b blue" title="Agents working">{stats.working}</span>}
      {stats.queued > 0 && <span className="b" title="Queued">{stats.queued}</span>}
    </span>
  );
}

/** Scales to many products: search, then grouped by what needs attention. */
export function ProductSwitcher({ state, value, onChange }: { state: State; find: Lookup; value: string; onChange: (productId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const stats = useMemo(() => productStats(state), [state]);
  const current = state.products.find((product) => product.id === value);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, []);

  const match = (entry: ProductStats) => !query.trim() || entry.product.name.toLowerCase().includes(query.trim().toLowerCase());
  const byName = (a: ProductStats, b: ProductStats) => a.product.name.localeCompare(b.product.name);
  const groups = [
    { title: "Needs you", items: stats.filter((entry) => entry.needsYou > 0 && match(entry)).sort((a, b) => b.needsYou - a.needsYou || byName(a, b)) },
    { title: "Active", items: stats.filter((entry) => entry.needsYou === 0 && entry.active && match(entry)).sort(byName) },
    { title: "Quiet", items: stats.filter((entry) => entry.needsYou === 0 && !entry.active && match(entry)).sort(byName) },
  ];
  const first = groups.flatMap((group) => group.items)[0];

  const pick = (productId: string) => {
    onChange(productId);
    setOpen(false);
    setQuery("");
  };

  return (
    <div style={{ position: "relative" }} ref={box}>
      <button className="btn switcher" onClick={() => setOpen((on) => !on)} aria-expanded={open} title="Switch product (⌘P)">
        {current ? (
          <span className={`product-chip tone-${current.tone}`} style={{ color: "var(--text)", fontSize: 13 }}>
            <i />
            {current.name}
          </span>
        ) : (
          <>All products · {state.products.length}</>
        )}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="popover switcher-pop" style={{ left: 0, right: "auto" }}>
          <label className="search" style={{ width: "100%", marginBottom: 8 }}>
            <Search size={14} />
            <input
              autoFocus
              placeholder={`Search ${state.products.length} products`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && first) pick(first.product.id);
              }}
            />
            <kbd>⌘P</kbd>
          </label>
          <div className="switcher-list">
            {!query.trim() && (
              <button className={`switcher-row ${value === "all" ? "on" : ""}`} onClick={() => pick("all")}>
                <span className="name">All products</span>
                {value === "all" && <Check size={14} />}
              </button>
            )}
            {groups.map((group) =>
              group.items.length === 0 ? null : (
                <div key={group.title}>
                  <div className="switcher-group">
                    {group.title} · {group.items.length}
                  </div>
                  {group.items.map((entry) => (
                    <button key={entry.product.id} className={`switcher-row ${value === entry.product.id ? "on" : ""}`} onClick={() => pick(entry.product.id)}>
                      <span className={`product-chip tone-${entry.product.tone}`}>
                        <i />
                      </span>
                      <span className="name">{entry.product.name}</span>
                      <ProductBadges stats={entry} />
                    </button>
                  ))}
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const PIPE: readonly { column: Column; label: string }[] = [
  { column: "queue", label: "Queue" },
  { column: "planning", label: "Plan" },
  { column: "designing", label: "Design" },
  { column: "building", label: "Build" },
  { column: "reviewing", label: "Review" },
  { column: "ready", label: "Ready" },
];

/** The portfolio: every product on one screen, what is in flight and what waits on you. */
export function ProductsPage({ state, onPick, onAdd }: { state: State; onPick: (productId: string) => void; onAdd?: () => void }) {
  const stats = productStats(state).sort(
    (a, b) => b.needsYou - a.needsYou || Number(b.active) - Number(a.active) || b.working - a.working || a.product.name.localeCompare(b.product.name),
  );
  const active = stats.filter((entry) => entry.active).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>
            {state.products.length} products · {active} with work in flight · {stats.reduce((sum, entry) => sum + entry.needsYou, 0)} things waiting on you
          </p>
        </div>
        {onAdd && (
          <div className="tools">
            <button className="btn primary" onClick={onAdd}>
              Add product
            </button>
          </div>
        )}
      </div>
      {state.products.length === 0 && (
        <div className="empty-state" style={{ marginBottom: 16 }}>
          No products yet. Add a local clone of a GitHub repository to give the squad something to work on.
        </div>
      )}
      <div className="portfolio">
        <div className="portfolio-row head">
          <span>Product</span>
          {PIPE.map((step) => (
            <span key={step.column} className="c">
              {step.label}
            </span>
          ))}
          <span className="c">Shipped</span>
          <span className="c">Needs you</span>
          <span>When ready</span>
        </div>
        {stats.map((entry) => (
          <button key={entry.product.id} className={`portfolio-row ${entry.active ? "" : "quiet"}`} onClick={() => onPick(entry.product.id)}>
            <span className="who">
              <span className={`product-chip tone-${entry.product.tone}`}>
                <i />
              </span>
              <span>
                <span className="name">{entry.product.name}</span>
                <span className="repo">{entry.product.repo}</span>
              </span>
            </span>
            {PIPE.map((step) => {
              const count = entry.byColumn[step.column];
              return (
                <span key={step.column} className="c">
                  <span className={`cell ${count > 0 ? "on" : ""} ${step.column}`}>{count || "·"}</span>
                </span>
              );
            })}
            <span className="c num">{entry.shipped || "·"}</span>
            <span className="c">{entry.needsYou > 0 ? <span className="pill needs-you">{entry.needsYou}</span> : <span className="muted">·</span>}</span>
            <span onClick={(event) => event.stopPropagation()} className="delivery-cell">
              <select
                aria-label={`What happens when ${entry.product.name} work is ready`}
                value={entry.product.delivery ?? "pull-request"}
                onChange={(event) => sim.setProductDelivery(entry.product.id, event.target.value as DeliveryMode, entry.product.approveDelivery ?? true)}
              >
                {(Object.keys(DELIVERY_LABEL) as DeliveryMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {DELIVERY_LABEL[mode]}
                  </option>
                ))}
              </select>
              <label className="toggle" title="Ask me before shipping">
                <input type="checkbox" checked={entry.product.approveDelivery ?? true} onChange={(event) => sim.setProductDelivery(entry.product.id, entry.product.delivery ?? "pull-request", event.target.checked)} />
                ask me
              </label>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
