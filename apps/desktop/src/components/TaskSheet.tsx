import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpToLine, Ban, Ellipsis, ExternalLink, Hand, MessageSquare, Pause, Play, X } from "lucide-react";
import { TAKE_OVER_WORDS, type State, type Task } from "@petrina/core";
import { sim } from "../engine";
import { duration, safeUrl, STATE_LABEL, type Lookup } from "../lib";
import { ProductName, Stepper, useDismiss, useFocusTrap, useViewport, WaitingLine } from "./bits";
import { Session } from "./Session";
import type { SheetTab } from "./TaskCard";
import { Overview } from "./sheet/Overview";
import { PlanView } from "./sheet/PlanTab";
import { DesignView } from "./sheet/DesignTab";
import { ReviewView } from "./sheet/ReviewTab";

interface SheetProps {
  task: Task;
  state: State;
  find: Lookup;
  tab: SheetTab;
  onTab: (tab: SheetTab) => void;
  onClose: () => void;
  onToast: (title: string, detail?: string) => void;
  /** A notification's item that opens once the sheet closes, because something typed in it is not sent yet. */
  waiting?: string;
  draft: string;
  onDraft: (text: string) => void;
  messageFocus: boolean;
  onMessageFocused: () => void;
  onMessage: () => void;
  /** Open the "About these numbers" note on Analytics. */
  onAboutNumbers: () => void;
}

const TABS: readonly { id: SheetTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "design", label: "Design" },
  { id: "review", label: "Review" },
  { id: "session", label: "Session" },
];

export function TaskSheet({ task, state, find, tab, onTab, onClose, onToast, draft, onDraft, messageFocus, onMessageFocused, onMessage, onAboutNumbers, waiting }: SheetProps) {
  const [menu, setMenu] = useState(false);
  const [titleGone, setTitleGone] = useState(false);
  // "Read this step in the Session": the Session opens at the step's first line, with its lines marked.
  const [sessionStep, setSessionStep] = useState<{ id: string; name: string }>();
  const [scrolled, setScrolled] = useState(false);
  const sheet = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLElement>(null);
  const heroTitle = useRef<HTMLHeadingElement>(null);
  const menuBox = useRef<HTMLSpanElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  useDismiss(menuBox, menu, closeMenu);
  // Focus moves into the sheet, and back to whatever opened it when it closes: the task's card if
  // that moved meanwhile (pausing moves it between sections).
  useFocusTrap(sheet, onClose, () => document.querySelector<HTMLElement>(`.card-open[aria-describedby="status-${task.id}"]`));
  const viewport = useViewport();
  // Narrow or short sheets keep the one-line title in the bar from the start.
  const compact = viewport.width < 900 || viewport.height < 640;
  const short = viewport.height < 640;

  const product = find.product(task.productId);
  const prUrl = safeUrl(task.pr?.url);
  const canPause = task.state === "running" || task.state === "needs-you" || task.state === "waiting";
  // Pause and Cancel wait until the coordinator hands back.
  const driving = task.driving !== undefined;
  const stateLabel = driving ? "You're driving" : STATE_LABEL[task.state];

  useEffect(() => {
    const title = heroTitle.current;
    const root = scroller.current;
    if (!title || !root) return;
    // The one-line title takes over as soon as the full title is no longer wholly in view.
    const observer = new IntersectionObserver(([entry]) => setTitleGone((entry?.intersectionRatio ?? 1) < 0.99), { root, threshold: [0, 0.99, 1] });
    observer.observe(title);
    return () => observer.disconnect();
  }, [task.id]);

  // Each task opens at its top (the session opens at its latest message instead). Switching
  // tabs keeps the tabs in view and starts the new tab from its beginning.
  useEffect(() => {
    if (tab !== "session") scroller.current?.scrollTo({ top: 0 });
  }, [task.id]);
  useEffect(() => {
    const el = scroller.current;
    const top = hero.current?.offsetHeight ?? 0;
    if (el && tab !== "session" && el.scrollTop > top) el.scrollTop = top;
    if (tab !== "session") setSessionStep(undefined);
  }, [tab]);
  useEffect(() => setSessionStep(undefined), [task.id]);

  const counts: Partial<Record<SheetTab, number>> = {
    review: task.findings.filter((finding) => finding.status === "open").length,
    design: task.objections.filter((objection) => objection.status === "open").length,
    session: task.queued.length,
  };

  const onTabKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.findIndex((entry) => entry.id === tab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
    onTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const act = (action: () => void) => () => {
    setMenu(false);
    action();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section ref={sheet} className={`sheet ${compact ? "compact" : ""} ${short ? "short" : ""}`} role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabIndex={-1}>
        <WaitingLine text={waiting} />
        <div className={`sheet-bar ${scrolled ? "scrolled" : ""}`}>
          {compact || titleGone ? (
            <div className="compact-title" title={task.title}>
              {task.title}
            </div>
          ) : (
            <div className="crumb">
              <ProductName product={product} />
              <span aria-hidden="true">·</span>
              <span className={`label ${task.state === "needs-you" ? "needs-you" : task.state === "failed" ? "bad" : ""}`}>{task.held && task.state === "queued" ? "On hold" : stateLabel}</span>
              {task.startedAt !== undefined && <span className="num">· started {duration(task.startedAt, state.now)} ago</span>}
            </div>
          )}
          <div className="sheet-actions">
            {prUrl && (
              <a className="btn quiet small" href={prUrl} target="_blank" rel="noopener noreferrer" title="Open the pull request on GitHub">
                Pull request #{task.pr?.number}
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            )}
            <button className={`btn quiet small ${compact ? "icon" : ""}`} aria-label="Message" onClick={onMessage}>
              <MessageSquare size={16} aria-hidden="true" />
              {!compact && "Message"}
            </button>
            {canPause && (
              <button
                className={`btn quiet small ${compact ? "icon" : ""}`}
                aria-label={driving ? `Pause. ${TAKE_OVER_WORDS.handBackFirst}` : "Pause"}
                title={driving ? TAKE_OVER_WORDS.handBackFirst : undefined}
                disabled={driving}
                onClick={() => sim.pause(task.id)}
              >
                <Pause size={16} aria-hidden="true" />
                {!compact && "Pause"}
              </button>
            )}
            {task.state === "paused" && (
              <button className={`btn quiet small ${compact ? "icon" : ""}`} aria-label="Resume" onClick={() => sim.resume(task.id)}>
                <Play size={16} aria-hidden="true" />
                {!compact && "Resume"}
              </button>
            )}
            {task.state !== "done" && task.state !== "cancelled" && (
              <span ref={menuBox} style={{ position: "relative" }}>
                <button className="btn quiet small icon" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
                  <Ellipsis size={16} />
                </button>
                {menu && (
                  <div className="menu" role="menu" style={{ right: 0, top: "calc(100% + 4px)" }}>
                    {task.state === "queued" && (
                      <>
                        <button role="menuitem" autoFocus onClick={act(() => sim.moveToTop(task.id))}>
                          <ArrowUpToLine size={16} />
                          Move to top
                        </button>
                        <button role="menuitem" onClick={act(() => sim.setHeld(task.id, !task.held))}>
                          <Hand size={16} />
                          {task.held ? "Release the hold" : "Hold (don't start yet)"}
                        </button>
                      </>
                    )}
                    <button role="menuitem" className="danger" autoFocus={task.state !== "queued"} disabled={driving} title={driving ? TAKE_OVER_WORDS.handBackFirst : undefined} onClick={act(() => sim.cancel(task.id))}>
                      <Ban size={16} />
                      {driving ? `Cancel task (${TAKE_OVER_WORDS.handBackFirst.toLowerCase()})` : "Cancel task"}
                    </button>
                  </div>
                )}
              </span>
            )}
            <button className="btn quiet small icon" aria-label="Close" title="Close (Esc)" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="sheet-scroll" ref={scroller} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}>
          <header className="sheet-hero" ref={hero}>
            {compact && (
              <div className="sheet-meta">
                <ProductName product={product} />
                <span aria-hidden="true">·</span>
                <span>{stateLabel}</span>
              </div>
            )}
            <h1 className="sheet-title" id="sheet-title" ref={heroTitle}>
              {task.title}
            </h1>
            <Stepper task={task} />
          </header>

          <nav className="tabs" role="tablist" aria-label="Task details" onKeyDown={onTabKey}>
            {TABS.map((entry) => (
              <button
                key={entry.id}
                id={`tab-${entry.id}`}
                role="tab"
                aria-selected={tab === entry.id}
                aria-controls="sheet-panel"
                tabIndex={tab === entry.id ? 0 : -1}
                className={tab === entry.id ? "on" : ""}
                onClick={() => onTab(entry.id)}
              >
                {entry.label}
                {entry.id === "session" && draft && <span className="draft-mark" aria-label="Unsent message" title="Unsent message" />}
                {counts[entry.id] ? <span className="count">{counts[entry.id]}</span> : null}
              </button>
            ))}
          </nav>

          <div className="sheet-body" id="sheet-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === "overview" && (
              <Overview
                task={task}
                state={state}
                find={find}
                onAboutNumbers={onAboutNumbers}
                onReadSession={(id, name) => {
                  setSessionStep({ id, name });
                  onTab("session");
                }}
                onPlan={() => onTab("plan")}
              />
            )}
            {tab === "plan" && <PlanView task={task} state={state} find={find} />}
            {tab === "design" && <DesignView task={task} find={find} />}
            {tab === "review" && <ReviewView task={task} find={find} />}
            {tab === "session" && <Session.Log key={sessionStep?.id ?? "latest"} task={task} state={state} find={find} scroller={scroller} onToast={onToast} onTab={onTab} {...(sessionStep ? { step: sessionStep, onStepDone: () => setSessionStep(undefined) } : {})} />}
          </div>
        </div>

        {tab === "session" && <Session.Composer key={task.id} task={task} find={find} text={draft} onText={onDraft} focusRequest={messageFocus} onFocused={onMessageFocused} />}
      </section>
    </>
  );
}
