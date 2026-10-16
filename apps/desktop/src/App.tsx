import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Bot, Hand, LayoutGrid, Library, Moon, Plus, Search, Sun, X } from "lucide-react";
import type { Task } from "@petrina/core";
import { startClock, useSim } from "./engine";
import { blockingCount, lookup } from "./lib";
import { Logo } from "./components/bits";
import { Board } from "./components/Board";
import { Inbox } from "./components/Inbox";
import { NewTaskDialog } from "./components/NewTask";
import { AgentsPage, LibraryPage } from "./components/Pages";
import { PoolButton } from "./components/Pool";
import type { SheetTab } from "./components/TaskCard";
import { TaskSheet } from "./components/TaskSheet";
import { applyTheme, initialTheme, type Theme } from "./theme";

type View = "board" | "agents" | "library";

interface Toast {
  id: number;
  title: string;
  detail?: string;
  taskId?: string;
}

export function App() {
  const state = useSim();
  const find = useMemo(() => lookup(state), [state]);
  const [view, setView] = useState<View>("board");
  const [product, setProduct] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [inboxOpen, setInboxOpen] = useState(true);
  const [sheet, setSheet] = useState<{ taskId: string; tab: SheetTab }>();
  const [creating, setCreating] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const seenInbox = useRef(new Set(state.inbox.map((item) => item.id)));
  const toastId = useRef(0);

  useEffect(() => startClock(), []);

  useEffect(() => applyTheme(theme), [theme]);

  const toast = useCallback((title: string, detail?: string, taskId?: string) => {
    const id = (toastId.current += 1);
    setToasts((list) => [...list.slice(-2), { id, title, ...(detail ? { detail } : {}), ...(taskId ? { taskId } : {}) }]);
    setTimeout(() => setToasts((list) => list.filter((entry) => entry.id !== id)), 6000);
  }, []);

  // Anything new that needs the coordinator gets a toast (a system notification in the desktop build).
  useEffect(() => {
    for (const item of state.inbox) {
      if (seenInbox.current.has(item.id)) continue;
      seenInbox.current.add(item.id);
      const task = find.task(item.taskId);
      const role = find.role(item.roleId);
      toast(item.title, `${task?.title ?? ""}${role ? ` · ${role.name}` : ""}`, item.taskId);
    }
  }, [state.inbox, find, toast]);

  const open = useCallback((taskId: string, tab: SheetTab = "overview") => setSheet({ taskId, tab }), []);
  const close = useCallback(() => setSheet(undefined), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setCreating(true);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "i") setInboxOpen((on) => !on);
        if (event.key === "b") setView("board");
        if (event.key === "a") setView("agents");
        if (event.key === "l") setView("library");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = useCallback(
    (task: Task) => (product === "all" || task.productId === product) && (!query.trim() || task.title.toLowerCase().includes(query.trim().toLowerCase())),
    [product, query],
  );

  const sheetTask = sheet ? find.task(sheet.taskId) : undefined;
  const blocking = blockingCount(state);

  return (
    <div className="app" style={{ gridTemplateColumns: `64px minmax(0, 1fr) ${inboxOpen ? "auto" : "0px"}` }}>
      <header className="topbar">
        <div className="brand">
          <Logo />
          Petrina
        </div>
        <div className="segmented" role="radiogroup" aria-label="Product">
          <button className={product === "all" ? "on" : ""} onClick={() => setProduct("all")}>
            All products
          </button>
          {state.products.map((entry) => (
            <button key={entry.id} className={product === entry.id ? "on" : ""} onClick={() => setProduct(entry.id)}>
              <span className={`product-chip tone-${entry.tone}`}>
                <i />
              </span>
              {entry.name}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={14} />
          <input ref={searchRef} placeholder="Find a task" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query ? (
            <button className="btn ghost icon" style={{ padding: 2 }} aria-label="Clear" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          ) : (
            <kbd>⌘K</kbd>
          )}
        </label>
        <div className="spacer" />
        {blocking > 0 && (
          <button className="blocking-pill" style={{ cursor: "pointer" }} onClick={() => setInboxOpen(true)}>
            <Hand size={13} />
            You're blocking {blocking} agent{blocking === 1 ? "" : "s"}
          </button>
        )}
        <PoolButton state={state} find={find} onOpen={open} />
        <button className="btn" onClick={() => setInboxOpen((on) => !on)} aria-pressed={inboxOpen} title="Needs you (I)">
          <Bell size={15} />
          Inbox
          {state.inbox.length > 0 && <span className="count">{state.inbox.length}</span>}
        </button>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={15} />
          New task
        </button>
        <button className="btn ghost icon" aria-label="Switch theme" onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}>
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <nav className="rail" aria-label="Sections">
        <button className={view === "board" ? "on" : ""} onClick={() => setView("board")} title="Board (B)">
          <LayoutGrid size={19} />
          Board
        </button>
        <button className={view === "agents" ? "on" : ""} onClick={() => setView("agents")} title="Agents (A)">
          <Bot size={19} />
          Agents
          {blocking > 0 && <span className="badge">{blocking}</span>}
        </button>
        <button className={view === "library" ? "on" : ""} onClick={() => setView("library")} title="Library (L)">
          <Library size={19} />
          Library
        </button>
        <div className="grow" />
      </nav>

      <main className="main">
        {view === "board" && <Board state={state} find={find} visible={visible} selectedId={sheet?.taskId} onOpen={open} />}
        {view === "agents" && <AgentsPage state={state} find={find} onOpen={open} />}
        {view === "library" && <LibraryPage state={state} find={find} />}
      </main>

      {inboxOpen ? <Inbox state={state} find={find} onOpen={open} onClose={() => setInboxOpen(false)} /> : <div />}

      {sheetTask && sheet && (
        <TaskSheet task={sheetTask} state={state} find={find} tab={sheet.tab} onTab={(tab) => setSheet({ taskId: sheetTask.id, tab })} onClose={close} onToast={(title, detail) => toast(title, detail)} />
      )}

      {creating && (
        <NewTaskDialog
          state={state}
          {...(product !== "all" ? { defaultProduct: product } : {})}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setView("board");
          }}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((entry) => (
          <div key={entry.id} className="toast">
            <span className="avatar tone-amber" style={{ width: 28, height: 28 }}>
              <Bell size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="t">{entry.title}</div>
              {entry.detail && <div className="s">{entry.detail}</div>}
            </div>
            {entry.taskId && (
              <button
                className="btn small"
                onClick={() => {
                  setInboxOpen(true);
                  setToasts((list) => list.filter((item) => item.id !== entry.id));
                }}
              >
                View
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
