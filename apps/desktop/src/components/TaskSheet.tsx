import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowUpToLine, Ban, Check, CheckCircle2, ChevronRight, Clock3, Ellipsis, ExternalLink, GitPullRequest, Hand, ListOrdered, LoaderCircle, MessageSquare, Monitor, Pause, Play, TriangleAlert, X } from "lucide-react";
import { canEditTaskDependencies, mainLine, openStep, sourceLabel, TAKE_OVER_WORDS, type State, type Task } from "@petrina/core";
import { sim } from "../engine";
import { duration, safeUrl, STATE_LABEL, stateLabel, type Lookup } from "../lib";
import { ProductName, useDismiss, useFocusTrap, useViewport, WaitingLine } from "./bits";
import { Journey } from "./Journey";
import { Ask } from "./Inbox";
import { Session } from "./Session";
import { TakeOverControls } from "./TakeOver";
import type { SheetTab } from "./TaskCard";
import { Overview } from "./sheet/Overview";
import { PlanView } from "./sheet/PlanTab";
import { DesignView } from "./sheet/DesignTab";
import { ReviewView } from "./sheet/ReviewTab";
import type { TaskDrafts } from "../drafts";

export type TaskListEntry = Pick<Task, "id" | "productId" | "title" | "state" | "statusLine"> & Partial<Pick<Task, "held" | "source" | "todo" | "retrying">>;

interface SheetProps {
  task: Task;
  tasks: readonly TaskListEntry[];
  onTask: (id: string) => void;
  state: State;
  find: Lookup;
  tab: SheetTab;
  onTab: (tab: SheetTab) => void;
  selectedStep?: string;
  selectedAttempt?: string;
  onStep: (id: string | undefined, attempt?: string) => void;
  onClose: () => void;
  onToast: (title: string, detail?: string) => void;
  /** A notification's item that opens once the sheet closes, because something typed in it is not sent yet. */
  waiting?: string;
  hasDraft: boolean;
  drafts: TaskDrafts;
  messageFocus: boolean;
  onMessageFocused: () => void;
  onMessage: () => void;
  /** Open the "About these numbers" note on Analytics. */
  onAboutNumbers: () => void;
  /** Open a follow-up card, or the finished task a report came from. */
  onOpenTask?: (taskId: string) => void;
  onDependencies?: (task: Task) => void;
}

const TABS: readonly { id: SheetTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "design", label: "Design" },
  { id: "review", label: "Review" },
  { id: "session", label: "Session" },
];

function TaskActivity({ task }: { task: TaskListEntry }) {
  const [Icon, label] = task.state === "running" ? [LoaderCircle, "Working"] as const
    : task.state === "needs-you" ? [Hand, "Needs you"] as const
    : task.state === "waiting" ? [Clock3, "Waiting"] as const
    : task.state === "queued" ? task.held ? [Hand, "On hold"] as const : [ListOrdered, "Queued"] as const
    : task.state === "backlog" ? [ListOrdered, "Backlog"] as const
    : task.state === "paused" ? [Pause, "Paused"] as const
    : task.state === "done" ? [CheckCircle2, "Done"] as const
    : task.state === "cancelled" ? [Ban, "Cancelled"] as const
    : task.state === "pr-open" ? [GitPullRequest, "Awaiting merge"] as const : [TriangleAlert, "Stuck"] as const;
  return <span className={`task-list-activity ${task.state}`}><Icon size={13} aria-hidden="true" /><span>{label}</span></span>;
}

export function TaskSheet({ task, tasks, onTask, state, find, tab, onTab, selectedStep, selectedAttempt, onStep, onClose, onToast, hasDraft, drafts, messageFocus, onMessageFocused, onMessage, onAboutNumbers, onOpenTask, onDependencies, waiting }: SheetProps) {
  const [pane, setPane] = useState(selectedStep || tab !== "overview" ? "details" : "flow");
  const [menu, setMenu] = useState(false);
  const [detailsTarget, setDetailsTarget] = useState<HTMLDivElement | null>(null);
  // "Read this step in the Session": the Session opens at the step's first line, with its lines marked.
  const [sessionStep, setSessionStep] = useState<{ id: string; name: string }>();
  const sheet = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const globalScroll = useRef(0);
  const menuBox = useRef<HTMLSpanElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  useDismiss(menuBox, menu, closeMenu);
  // Focus moves into the sheet, and back to whatever opened it when it closes: the task's card if
  // that moved meanwhile (pausing moves it between sections).
  useFocusTrap(sheet, onClose, () => document.querySelector<HTMLElement>(`.card-open[aria-describedby~="status-${task.id}"], .history-card[data-task-id="${task.id}"]`));
  const viewport = useViewport();
  // Narrow or short sheets keep the one-line title in the bar from the start.
  const compact = viewport.width < 900 || viewport.height < 640;
  const short = viewport.height < 640;

  const product = find.product(task.productId);
  const prUrl = safeUrl(task.pr?.url);
  const canPause = task.state === "running" || task.state === "needs-you" || task.state === "waiting";
  // Pause and Cancel wait until the coordinator hands back.
  const driving = task.driving !== undefined;
  const label = driving ? "You're driving" : stateLabel(task, state);

  useEffect(() => { globalScroll.current = 0; scroller.current?.scrollTo({ top: 0 }); setSessionStep(undefined); }, [task.id]);
  useLayoutEffect(() => { scroller.current?.scrollTo({ top: selectedStep ? 0 : globalScroll.current }); }, [selectedStep]);
  useEffect(() => {
    if (tab !== "session") { scroller.current?.scrollTo({ top: 0 }); setSessionStep(undefined); }
    if (tab !== "overview") setPane("details");
  }, [tab]);
  useEffect(() => { if (selectedStep) setPane("details"); }, [selectedStep, task.id]);
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [task.id]);
  const taskDetails = () => onStep(undefined);
  const readSession = (id: string, name: string) => { setSessionStep({ id, name }); onTab("session"); setPane("details"); };
  const listed = tasks.some((entry) => entry.id === task.id) ? tasks : [task, ...tasks];
  const asks = state.inbox.filter((item) => item.taskId === task.id);
  const activeStep = openStep(task);
  const showAgentControls = selectedStep ? activeStep?.id === selectedStep && activeStep.kind === "agent" : tab === "session";

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
      <section ref={sheet} className={`sheet task-workspace ${short ? "short" : ""}`} role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabIndex={-1}>
        <WaitingLine text={waiting} />
        <div className="task-workspace-bar">
          <button className="btn quiet small" onClick={onClose}><ArrowLeft size={16} aria-hidden="true" /> Back</button>
          <div className="task-workspace-title">
            <h1 className="sheet-title" id="sheet-title" title={task.title}>{task.title}</h1>
            <div className="sheet-meta"><ProductName product={product} />{task.source && <span className="source-label">{sourceLabel(task.source)}</span>}<span aria-hidden="true">·</span><span>{label}</span>{<span className="num">· {task.startedAt === undefined ? "created" : "started"} {duration(task.startedAt ?? task.createdAt, state.now)} ago</span>}{task.screenAllowed && <span>· Screen allowed for this task</span>}</div>
          </div>
          <div className="sheet-actions">
            {task.repositories ? <button className="btn quiet small" onClick={() => { taskDetails(); onTab("overview"); setPane("details"); }}>Deliveries · {task.repositories.filter((work) => work.pr || work.release || work.landed || work.nothingToPublish).length} of {task.repositories.length}</button> : prUrl && (
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
                    {canEditTaskDependencies(task) && onDependencies && <button role="menuitem" onClick={act(() => onDependencies(task))}>Start after other tasks…</button>}
                    {/* Its screen requests go ahead even while the switch is off, one agent at a time. */}
                    <button role="menuitemcheckbox" aria-checked={task.screenAllowed === true} autoFocus={task.state !== "queued"} onClick={act(() => sim.setTaskScreen(task.id, !task.screenAllowed))}>
                      <Monitor size={16} />
                      Allow the screen for this task
                      {task.screenAllowed && <Check size={16} className="menu-check" aria-hidden="true" />}
                    </button>
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
                        {task.startedAt === undefined && <button role="menuitem" onClick={act(() => sim.moveToBacklog(task.id))}>Move to backlog</button>}
                      </>
                    )}
                    <button role="menuitem" className="danger" disabled={driving} title={driving ? TAKE_OVER_WORDS.handBackFirst : undefined} onClick={act(() => sim.cancel(task.id))}>
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

        <nav className="task-workspace-switcher" aria-label="Task workspace">{["tasks", "flow", "details"].map((name) => <button key={name} className={`btn small ${pane === name ? "on" : "quiet"}`} aria-pressed={pane === name} onClick={() => setPane(name)}>{name === "tasks" ? "Tasks" : name === "flow" ? "Flow" : "Details"}</button>)}</nav>
        <div className="task-workspace-columns" data-pane={pane}>
          <aside className="task-list" aria-label="Tasks">
            <div className="task-list-heading"><h2>Tasks</h2><span className="quiet-text num">{listed.length}</span></div>
            <div className="task-list-scroll">
              {listed.map((entry) => (
                <button key={entry.id} className={`task-list-item ${entry.id === task.id ? "selected" : ""}`} aria-current={entry.id === task.id ? "true" : undefined} onClick={() => { onTask(entry.id); setPane("flow"); }}>
                  <span className="task-list-meta"><span className="task-list-product"><ProductName product={find.product(entry.productId)} />{entry.source && <> <span className="source-label">{sourceLabel(entry.source)}</span></>}</span><TaskActivity task={entry} /></span>
                  <span className="task-list-title">{entry.title}</span>
                  <span className="task-list-status">{entry.held && entry.state === "queued" ? "On hold" : mainLine(entry) || STATE_LABEL[entry.state]}</span>
                  {entry.id === task.id && <ChevronRight className="task-list-arrow" size={16} aria-hidden="true" />}
                </button>
              ))}
            </div>
          </aside>
          <Journey key={task.id} task={task} state={state} find={find} onReadSession={readSession} onPlan={() => { onTab("plan"); }} {...(onOpenTask ? { onOpenTask } : {})} workspace detailsTarget={detailsTarget} selectedStep={selectedStep} selectedAttempt={selectedAttempt} onSelectionChange={(id, attempt) => {
            if (id && !selectedStep) globalScroll.current = scroller.current?.scrollTop ?? 0;
            onStep(id, attempt);
            if (id) setPane("details");
            scroller.current?.scrollTo({ top: id ? 0 : globalScroll.current });
          }} />
          <aside className="task-detail-panel" aria-label="Task and step details">
          {selectedStep ? <div className="step-panel-bar"><button className="btn quiet small" onClick={taskDetails}><ArrowLeft size={16} aria-hidden="true" /> Back to task</button><span className="quiet-text">Step details</span></div> : <nav className="tabs" role="tablist" aria-label="Task details" onKeyDown={onTabKey}>
            {TABS.map((entry) => (
              <button
                key={entry.id}
                id={`tab-${entry.id}`}
                role="tab"
                aria-selected={tab === entry.id}
                aria-controls="sheet-panel"
                tabIndex={tab === entry.id ? 0 : -1}
                className={tab === entry.id ? "on" : ""}
                onClick={() => { onTab(entry.id); setPane("details"); }}
              >
                {entry.label}
                {entry.id === "session" && hasDraft && <span className="draft-mark" aria-label="Unsent message" title="Unsent message" />}
                {counts[entry.id] ? <span className="count">{counts[entry.id]}</span> : null}
              </button>
            ))}
          </nav>}

          <div className="sheet-scroll" ref={scroller}><div className="sheet-body" id="sheet-panel" role={selectedStep ? undefined : "tabpanel"} aria-labelledby={selectedStep ? "journey-details-title" : `tab-${tab}`}>
            <div className="selected-step" hidden={!selectedStep} ref={setDetailsTarget} />
            <div className="task-global-details" hidden={!!selectedStep}>
            {tab === "overview" && asks.length > 0 && <section className="sheet-section task-decisions" aria-label="Waiting for you">{asks.map((item) => <Ask key={item.id} item={item} state={state} find={find} onOpen={(_id, next) => onTab(next ?? "session")} />)}</section>}
            {tab === "overview" && (
              <Overview
                separateFlow
                task={task}
                state={state}
                find={find}
                onAboutNumbers={onAboutNumbers}
                onDependencies={onDependencies}
                onReadSession={readSession}
                onPlan={() => onTab("plan")}
                {...(onOpenTask ? { onOpenTask } : {})}
              />
            )}
            {tab === "plan" && <PlanView task={task} state={state} find={find} />}
            {tab === "design" && <DesignView task={task} find={find} />}
            {tab === "review" && <ReviewView task={task} now={state.now} find={find} {...(onOpenTask ? { onOpen: onOpenTask } : {})} />}
            {tab === "session" && !selectedStep && <Session.Log key={sessionStep?.id ?? "latest"} task={task} state={state} find={find} scroller={scroller} onTab={onTab} {...(sessionStep ? { step: sessionStep, onStepDone: () => setSessionStep(undefined) } : {})} />}
          </div>
          </div></div>

          {showAgentControls && <footer className="task-agent-footer" aria-label="Agent controls">
            <Session.Composer key={task.id} task={task} find={find} drafts={drafts} focusRequest={messageFocus} onFocused={onMessageFocused} />
            <div className="task-terminal-actions"><TakeOverControls task={task} state={state} onToast={onToast} /></div>
          </footer>}
          </aside>
        </div>
      </section>
    </>
  );
}
