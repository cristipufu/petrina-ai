import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { DELIVERY_LABEL, type Column, type Product, type State } from "@petrina/core";
import { ProductSettingsDialog } from "./ProductSettings";
import { useDismiss } from "./bits";

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

/** What waits on you, who is working and what is queued, as quiet text. */
export function ProductCounts({ stats }: { stats: ProductStats }) {
  return (
    <span className="stats">
      {stats.needsYou > 0 && <span className="needs">{stats.needsYou} need you</span>}
      {stats.working > 0 && <span>{stats.working} working</span>}
      {stats.queued > 0 && <span>{stats.queued} queued</span>}
    </span>
  );
}

/** Scales to many products: search, then grouped by what needs attention. */
export function ProductSwitcher({ state, value, onChange }: { state: State; value: string; onChange: (productId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close);
  const stats = useMemo(() => productStats(state), [state]);
  const current = state.products.find((product) => product.id === value);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    <div style={{ position: "relative", minWidth: 0, flex: "0 1 auto" }} ref={box}>
      <button className="btn switcher" onClick={() => setOpen((on) => !on)} aria-expanded={open} aria-haspopup="dialog" title="Switch product (⌘P)">
        <span className="label-text">
          {current ? (
            <span className={`tone-${current.tone}`} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--tone)", display: "inline-block" }} aria-hidden="true" />
              {current.name}
            </span>
          ) : (
            <>
              All products <span className="num quiet-text">{state.products.length}</span>
            </>
          )}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="popover switcher-pop" role="dialog" aria-label="Switch product">
          <label className="search-field" style={{ width: "100%", marginBottom: 8 }}>
            <Search size={16} aria-hidden="true" />
            <input
              autoFocus
              aria-label="Search products"
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
              <button className={`switcher-row ${value === "all" ? "on" : ""}`} onClick={() => pick("all")} aria-current={value === "all"}>
                <span className="name">All products</span>
                {value === "all" && <Check size={16} aria-hidden="true" />}
              </button>
            )}
            {groups.map((group) =>
              group.items.length === 0 ? null : (
                <div key={group.title} role="group" aria-label={group.title}>
                  <div className="switcher-group">
                    {group.title} <span className="num">{group.items.length}</span>
                  </div>
                  {group.items.map((entry) => (
                    <button key={entry.product.id} className={`switcher-row tone-${entry.product.tone} ${value === entry.product.id ? "on" : ""}`} onClick={() => pick(entry.product.id)} aria-current={value === entry.product.id}>
                      <i aria-hidden="true" />
                      <span className="name">{entry.product.name}</span>
                      <ProductCounts stats={entry} />
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
export function ProductsPage({ state, onPick, onAdd, onRemoved }: { state: State; onPick: (productId: string) => void; onAdd?: () => void; onRemoved: (productId: string) => void }) {
  const [settings, setSettings] = useState<string>();
  const editing = state.products.find((product) => product.id === settings);
  const stats = productStats(state).sort(
    (a, b) => b.needsYou - a.needsYou || Number(b.active) - Number(a.active) || b.working - a.working || a.product.name.localeCompare(b.product.name),
  );
  const active = stats.filter((entry) => entry.active).length;
  const waiting = stats.reduce((sum, entry) => sum + entry.needsYou, 0);
  const count = (value: number) => (value > 0 ? value : <span className="zero" aria-label="none">–</span>);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p className="num">
            {state.products.length} products · {active} with work in flight · {waiting} {waiting === 1 ? "thing" : "things"} waiting on you
          </p>
        </div>
        {onAdd && (
          <div className="tools">
            <button className="btn outline" onClick={onAdd}>
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
      <div className="portfolio-wrap">
        <table className="portfolio">
          <thead>
            <tr>
              <th scope="col">Product</th>
              {PIPE.map((step) => (
                <th key={step.column} scope="col" className="c">
                  {step.label}
                </th>
              ))}
              <th scope="col" className="c">
                Shipped
              </th>
              <th scope="col" className="c">
                Needs you
              </th>
              <th scope="col">When ready</th>
              <th scope="col"><span className="sr-only">Settings</span></th>
            </tr>
          </thead>
          <tbody>
            {stats.map((entry) => (
              <tr
                key={entry.product.id}
                className={entry.active ? "" : "quiet"}
                onClick={(event) => {
                  if (!(event.target as HTMLElement).closest("button")) onPick(entry.product.id);
                }}
              >
                <th scope="row">
                  <span className={`product-cell tone-${entry.product.tone}`}>
                    <i aria-hidden="true" />
                    <span style={{ minWidth: 0 }}>
                      <button className="product-pick" onClick={() => onPick(entry.product.id)} title={`Show ${entry.product.name} on the board`}>
                        {entry.product.name}
                      </button>
                      <span className="repo">{entry.product.repo}</span>
                    </span>
                  </span>
                </th>
                {PIPE.map((step) => (
                  <td key={step.column} className="c">
                    {count(entry.byColumn[step.column])}
                  </td>
                ))}
                <td className="c">{count(entry.shipped)}</td>
                <td className="c">{entry.needsYou > 0 ? <span className="needs">{entry.needsYou}</span> : count(0)}</td>
                <td>
                  <span className="delivery-summary">{DELIVERY_LABEL[entry.product.delivery ?? "pull-request"]} · {(entry.product.approveDelivery ?? true) ? "asks first" : "ships automatically"}</span>
                </td>
                <td><button className="btn small" aria-label={`Settings for ${entry.product.name}`} onClick={() => setSettings(entry.product.id)}>Settings</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <ProductSettingsDialog key={editing.id} product={editing} state={state} onClose={() => setSettings(undefined)} onRemoved={() => { setSettings(undefined); onRemoved(editing.id); }} />}
    </div>
  );
}
