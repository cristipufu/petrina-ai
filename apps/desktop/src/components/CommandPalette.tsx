import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import {
  landingOf,
  matchesWords,
  queueOf,
  reconcileHighlight,
  searchTasks,
  type HistoryPage,
  type State,
  type Task,
} from "@petrina/core";
import { failureText, sim } from "../engine";
import { mod, SHORTCUTS } from "../keyboard";
import { stateLabel } from "../lib";
import { useFocusTrap } from "./bits";
import { productStats } from "./Products";

export interface PaletteAction {
  id: string;
  label: string;
  detail?: string;
  shortcut: string;
  run: () => void;
}

export type PaletteMode = "default" | "limit" | "product";

export function taskState(task: Task, state: State): string {
  if (task.state === "queued") return `${task.held ? "Held · " : ""}Queued #${queueOf(state.tasks).findIndex((entry) => entry.id === task.id) + 1}`;
  if (task.state === "done") return task.pr ? "Merged" : "Finished";
  return stateLabel(task, state);
}

export function CommandPalette({
  state,
  actions,
  taskActions,
  currentProduct = "all",
  initialMode = "default",
  onClose,
  onTask,
  onProduct,
  onHistoryProduct,
  onNew,
  onFilter,
  onLimit,
}: {
  state: State;
  actions: PaletteAction[];
  taskActions: PaletteAction[];
  currentProduct?: string;
  initialMode?: PaletteMode;
  onClose: () => void;
  onTask: (id: string) => void;
  onProduct: (id: string) => void;
  onHistoryProduct: (id: string) => void;
  onNew: (title: string) => void;
  onFilter: (query: string) => void;
  onLimit: (limit: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  const [selected, setSelected] = useState<string | undefined>(() =>
    initialMode === "limit" ? `limit-${state.pool.limit}` : initialMode === "product" ? `pick-product-${currentProduct}` : undefined,
  );
  const previousRows = useRef<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<{ query: string; page?: HistoryPage; error?: string }>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const trimmed = query.trim();
  const limit = mode === "limit";
  const pickingProduct = mode === "product";
  const searchHistory = mode === "default" && Boolean(trimmed && state.history?.total);
  const historyRevision = state.history?.revision;
  useEffect(() => {
    if (!searchHistory) return;
    let cancelled = false;
    setHistoryLoading(true);
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => sim.historyPage({ query: trimmed, limit: 40 }))
        .then(
          (page) => {
            if (!cancelled) {
              setHistory({ query: trimmed, page });
              setHistoryLoading(false);
            }
          },
          (error) => {
            if (!cancelled) {
              setHistory({ query: trimmed, error: failureText(error) });
              setHistoryLoading(false);
            }
          },
        );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, searchHistory, historyRevision]);
  const past = searchHistory && history?.query === trimmed ? history.page : undefined;
  const historyError = searchHistory && history?.query === trimmed ? history.error : undefined;
  const historyPending = searchHistory && (historyLoading || (!past && !historyError));
  useFocusTrap(box, onClose, undefined, "overlay");
  const stats = useMemo(() => productStats(state), [state]);
  const search = useMemo(() => {
    const tasks = searchTasks(state, query).filter((task) => query.trim() || task.state === "needs-you" || task.state === "failed");
    const products = query.trim() ? stats.filter((entry) => matchesWords(query, entry.product.name)) : [];
    const matched = [...taskActions, ...actions].filter((action) => matchesWords(query, action.label));
    return { tasks, products, matched };
  }, [state, query, stats, taskActions, actions]);

  const finish = (run: () => void) => () => {
    onClose();
    run();
  };
  const actionRow = (action: PaletteAction): PaletteAction => {
    if (action.id === "limit") {
      return {
        ...action,
        run: () => {
          setMode("limit");
          setQuery("");
          setSelected(`limit-${state.pool.limit}`);
          input.current?.focus();
        },
      };
    }
    if (action.id === "switch-product") {
      return {
        ...action,
        run: () => {
          setMode("product");
          setQuery("");
          setSelected(`pick-product-${currentProduct}`);
          input.current?.focus();
        },
      };
    }
    return { ...action, run: finish(action.run) };
  };
  const liveTaskIds = new Set(search.tasks.map((task) => task.id));
  const pastTasks = past?.items.filter((task) => !liveTaskIds.has(task.id)) ?? [];
  const taskRows: PaletteAction[] = [
    ...search.tasks.slice(0, 40).map((task) => ({
      id: `task-${task.id}`,
      label: task.title,
      detail: `${state.products.find((product) => product.id === task.productId)?.name ?? "Product"} · ${taskState(task, state)}`,
      shortcut: "↵",
      run: finish(() => onTask(task.id)),
    })),
    ...pastTasks.map((task) => ({
      id: `task-${task.id}`,
      label: task.title,
      detail: `${task.products?.map((product) => product.name).join(" · ") ?? state.products.find((product) => product.id === task.productId)?.name ?? "Product"} · ${task.state === "cancelled" ? "Cancelled" : landingOf(task) === "no-changes" ? "Completed without product changes" : landingOf(task) === "marked-done" ? "Marked as done" : landingOf(task) === "closed" ? "Closed without merging" : "Finished"}`,
      shortcut: "↵",
      run: finish(() => onTask(task.id)),
    })),
  ].slice(0, 40);
  const productRows: PaletteAction[] = search.products.slice(0, 20).flatMap((entry) => [
    {
      id: `product-${entry.product.id}`,
      label: entry.product.name,
      detail: `Product · ${entry.needsYou} needs you · ${entry.working} working · ${entry.queued} queued`,
      shortcut: "↵",
      run: finish(() => onProduct(entry.product.id)),
    },
    {
      id: `history-product-${entry.product.id}`,
      label: `Finished tasks in ${entry.product.name}`,
      detail: "Open this product’s task history",
      shortcut: "↵",
      run: finish(() => onHistoryProduct(entry.product.id)),
    },
  ]);
  const pickerRows: PaletteAction[] = pickingProduct
    ? [
        ...(!trimmed || matchesWords(trimmed, "All products")
          ? [
              {
                id: "pick-product-all",
                label: "All products",
                detail: `${state.products.length} product${state.products.length === 1 ? "" : "s"}${currentProduct === "all" ? " · Current scope" : ""}`,
                shortcut: "↵",
                run: finish(() => onProduct("all")),
              },
            ]
          : []),
        ...stats
          .filter((entry) => !trimmed || matchesWords(trimmed, entry.product.name))
          .map((entry) => ({
            id: `pick-product-${entry.product.id}`,
            label: entry.product.name,
            detail: `${entry.needsYou} needs you · ${entry.working} working · ${entry.queued} queued${currentProduct === entry.product.id ? " · Current product" : ""}`,
            shortcut: "↵",
            run: finish(() => onProduct(entry.product.id)),
          })),
      ]
    : [];
  const nothing = search.matched.length + taskRows.length + search.products.length === 0;
  const rows: PaletteAction[] = limit
    ? Array.from({ length: 12 }, (_, index) => ({
        id: `limit-${index + 1}`,
        label: `${index + 1} agent${index ? "s" : ""}${state.pool.limit === index + 1 ? " · Current limit" : ""}`,
        shortcut: "↵",
        run: finish(() => onLimit(index + 1)),
      }))
    : pickingProduct
      ? pickerRows
      : !query.trim()
        ? [...taskActions.map(actionRow), ...taskRows, ...actions.map(actionRow)]
        : [
            ...search.matched.filter((action) => action.label.toLocaleLowerCase().startsWith(query.trim().toLocaleLowerCase())).map(actionRow),
            ...taskRows,
            ...productRows,
            ...search.matched.filter((action) => !action.label.toLocaleLowerCase().startsWith(query.trim().toLocaleLowerCase())).map(actionRow),
            {
              id: "new-query",
              label: `New task: “${query.trim()}”`,
              detail: "Choose a product and review before creating",
              shortcut: "↵",
              run: finish(() => onNew(query.trim())),
            },
            ...(!nothing ? [{ id: "filter", label: `Filter the board: “${query.trim()}”`, shortcut: "↵", run: finish(() => onFilter(query.trim())) }] : []),
          ];
  const rowIds = rows.map((row) => row.id);
  const activeId = reconcileHighlight(previousRows.current, rowIds, selected) ?? rowIds[0];
  const active = rows.find((row) => row.id === activeId);
  const signature = rowIds.join("|");
  useEffect(() => {
    document.getElementById(`palette-${active?.id}`)?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);
  useEffect(() => {
    // Late search results may choose the initial row, but never replace a row the person chose.
    if (selected !== undefined && selected !== activeId) setSelected(activeId);
    previousRows.current = rowIds;
  }, [activeId, signature, selected]);

  const dialogLabel = limit ? "Change the pool limit" : pickingProduct ? "Switch product" : "Command palette";
  const inputLabel = limit ? "Choose a pool limit" : pickingProduct ? "Search products" : "Find tasks, products or actions";
  const placeholder = limit ? "Type a number from 1 to 12" : pickingProduct ? `Search ${state.products.length} products` : "Find tasks, products or actions…";
  const listLabel = limit ? "Pool limits" : pickingProduct ? "Products" : "Tasks, products and actions";

  return (
    <>
      <div className="palette-scrim" onClick={onClose} />
      <div className="command-palette" ref={box} role="dialog" aria-modal="true" aria-label={dialogLabel} tabIndex={-1}>
        <div className="palette-search">
          <Search size={20} aria-hidden="true" />
          <input
            ref={input}
            autoFocus
            role="combobox"
            aria-label={inputLabel}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={active ? `palette-${active.id}` : undefined}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              if (!limit) setSelected(undefined);
              else if (/^(?:[1-9]|1[0-2])$/.test(value)) setSelected(`limit-${Number(value)}`);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = rowIds.indexOf(activeId!);
                setSelected(rowIds[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]);
              }
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!(historyPending && nothing && active?.id === "new-query")) active?.run();
              }
            }}
          />
          <button className="btn quiet small" onClick={onClose}>
            Esc
          </button>
        </div>
        {limit && <p className="palette-note">Lowering the limit never stops anyone. Running stages finish first.</p>}
        {mode === "default" && historyPending && <p className="palette-note" role="status">Searching finished tasks…</p>}
        {mode === "default" && historyError && <p className="palette-note" role="status">Finished tasks could not be searched. {historyError}</p>}
        {mode === "default" && nothing && query.trim() && !historyPending && !historyError && (
          <p className="palette-note" role="status">
            Nothing matched. Enter opens New task for you to review.
          </p>
        )}
        <div className="palette-list" id="palette-list" role="listbox" aria-label={listLabel}>
          {rows.map((row) => (
            <div
              key={row.id}
              id={`palette-${row.id}`}
              role="option"
              aria-selected={row.id === active?.id}
              className={`palette-row ${row.id === active?.id ? "on" : ""}`}
              onMouseMove={() => setSelected(row.id)}
              onClick={row.run}
            >
              <span>
                <strong>{row.label}</strong>
                {row.detail && <small>{row.detail}</small>}
              </span>
              <kbd>{row.shortcut}</kbd>
            </div>
          ))}
        </div>
        {mode === "default" && (search.tasks.length + pastTasks.length > 40 || past?.nextCursor || search.products.length > 20) && (
          <p className="palette-note">More matches. Keep typing to narrow the list.</p>
        )}
        <div className="palette-footer">
          <span>↑ ↓ choose · Enter open</span>
          <span>{mod}K to close</span>
        </div>
      </div>
    </>
  );
}

export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, onClose, undefined, "overlay");
  return (
    <>
      <div className="dialog-scrim" onClick={onClose} />
      <div className="dialog shortcut-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" ref={box} tabIndex={-1}>
        <div className="row between">
          <h2>Keyboard shortcuts</h2>
          <button className="btn quiet" onClick={onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
        <p>Single keys rest while you type. An open task takes the keys first, then the inbox, then the visible board.</p>
        <dl>
          {SHORTCUTS.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                <kbd>{key}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}
