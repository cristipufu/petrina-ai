import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowUpToLine,
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  Ellipsis,
  ExternalLink,
  Hand,
  MessageSquare,
  Pause,
  Play,
  Repeat,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import type { Finding, Objection, Role, Stage, State, Task } from "@petrina/core";
import { sim } from "../engine";
import { ago, deliveryText, duration, profileText, safeUrl, STATE_LABEL, type Lookup } from "../lib";
import { ProductName, ProfileText, RoleAvatar, Stepper, useDismiss, useFocusTrap, useViewport } from "./bits";
import { Session } from "./Session";
import type { SheetTab } from "./TaskCard";

interface SheetProps {
  task: Task;
  state: State;
  find: Lookup;
  tab: SheetTab;
  onTab: (tab: SheetTab) => void;
  onClose: () => void;
  onToast: (title: string, detail?: string) => void;
  draft: string;
  onDraft: (text: string) => void;
  messageFocus: boolean;
  onMessageFocused: () => void;
  onMessage: () => void;
}

const TABS: readonly { id: SheetTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "design", label: "Design" },
  { id: "review", label: "Review" },
  { id: "session", label: "Session" },
];

export function TaskSheet({ task, state, find, tab, onTab, onClose, onToast, draft, onDraft, messageFocus, onMessageFocused, onMessage }: SheetProps) {
  const [menu, setMenu] = useState(false);
  const [titleGone, setTitleGone] = useState(false);
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
  }, [tab]);

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
        <div className={`sheet-bar ${scrolled ? "scrolled" : ""}`}>
          {compact || titleGone ? (
            <div className="compact-title" title={task.title}>
              {task.title}
            </div>
          ) : (
            <div className="crumb">
              <ProductName product={product} />
              <span aria-hidden="true">·</span>
              <span className={`label ${task.state === "needs-you" ? "needs-you" : task.state === "failed" ? "bad" : ""}`}>{task.held && task.state === "queued" ? "On hold" : STATE_LABEL[task.state]}</span>
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
              <button className={`btn quiet small ${compact ? "icon" : ""}`} aria-label="Pause" onClick={() => sim.pause(task.id)}>
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
                    <button role="menuitem" className="danger" autoFocus={task.state !== "queued"} onClick={act(() => sim.cancel(task.id))}>
                      <Ban size={16} />
                      Cancel task
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
                <span>{STATE_LABEL[task.state]}</span>
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
            {tab === "overview" && <Overview task={task} state={state} find={find} />}
            {tab === "plan" && <PlanView task={task} state={state} find={find} />}
            {tab === "design" && <DesignView task={task} find={find} />}
            {tab === "review" && <ReviewView task={task} find={find} />}
            {tab === "session" && <Session.Log task={task} state={state} find={find} scroller={scroller} onToast={onToast} onTab={onTab} />}
          </div>
        </div>

        {tab === "session" && <Session.Composer key={task.id} task={task} find={find} text={draft} onText={onDraft} focusRequest={messageFocus} onFocused={onMessageFocused} />}
      </section>
    </>
  );
}

function nowSentence(task: Task, role: Role | undefined): string {
  if (task.state === "needs-you") return role ? `${role.name} is waiting on you` : "Waiting on you";
  if (task.state === "running" && role) return `${role.name} is working`;
  if (task.state === "paused") return role ? `Paused while the ${role.name.toLowerCase()} was working` : "Paused";
  switch (task.state) {
    case "queued":
      return task.held ? "On hold in the queue" : "Waiting in the queue";
    case "waiting":
      return "Waiting for a free slot";
    case "failed":
      return "Stuck. It needs you to try again or cancel";
    case "pr-open":
      return "Delivered. Waiting for you to merge it on GitHub";
    case "done":
      return deliveryText(task)?.text ?? "Completed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Between stages";
  }
}

function Overview({ task, state, find }: { task: Task; state: State; find: Lookup }) {
  const [all, setAll] = useState(false);
  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const entries = all ? task.timeline : task.timeline.slice(-14);

  return (
    <>
      {task.description && (
        <section className="sheet-section reading">
          <h2>What you asked for</h2>
          <p className="prose">{task.description}</p>
        </section>
      )}

      <section className="sheet-section">
        <h2>Right now</h2>
        <div className={`now ${task.state}`}>
          {role ? (
            <RoleAvatar role={role} size={32} />
          ) : (
            <span className="avatar tone-slate" style={{ width: 32, height: 32 }} aria-hidden="true">
              <User size={18} />
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <div className="who">{nowSentence(task, role)}</div>
            {profile && <div className="tool">{profileText(profile, find, true)}</div>}
            <div className="what">
              <span className={`dot ${task.state}`} aria-hidden="true" />
              <span>
                {task.statusLine}
                {task.agent && <span className="num quiet-text"> · {duration(task.agent.since, state.now)}</span>}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="sheet-section">
        <h2>Timeline</h2>
        {!all && task.timeline.length > entries.length && (
          <button className="linkish" style={{ alignSelf: "flex-start" }} onClick={() => setAll(true)}>
            Show {task.timeline.length - entries.length} earlier events
          </button>
        )}
        <ol className="timeline">
          {entries.map((entry) => {
            const entryRole = find.role(entry.roleId);
            return (
              <li key={entry.id} className={`tl ${entry.tone}`}>
                <span className="when">{ago(entry.at, state.now)}</span>
                <span className="icon" aria-hidden="true">
                  {entry.tone === "you" ? (
                    <User size={14} />
                  ) : entry.tone === "warn" ? (
                    <CircleAlert size={14} />
                  ) : entry.tone === "done" ? (
                    <CircleCheck size={14} />
                  ) : entryRole ? (
                    <RoleAvatar role={entryRole} size={24} />
                  ) : (
                    <span className="dot" />
                  )}
                </span>
                <span className="text">
                  {entryRole && entry.tone !== "you" && <span className="sr-only">{entryRole.name}: </span>}
                  {entry.text}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

const KIND_LABEL: Record<Stage["kind"], string> = {
  do: "",
  converge: "Until both agree",
  "review-chain": "One after another",
  gate: "Your check",
};

function PlanView({ task, state, find }: { task: Task; state: State; find: Lookup }) {
  const plan = task.plan;
  if (!plan)
    return (
      <div className="empty-state reading">
        The planner writes the plan when the task starts. It picks the roles, the tools and the order for this task.
      </div>
    );

  const planner = find.profile(plan.plannerProfileId);

  const select = (stage: Stage, list: "profileIds" | "reviewerProfileIds", index: number, value: string, editable: boolean) =>
    editable ? (
      <select className="select" value={value} aria-label={`Who does ${stage.title.toLowerCase()}`} onChange={(event) => sim.setStageProfile(task.id, stage.id, list, index, event.target.value)}>
        {state.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profileText(profile, find, true)}
          </option>
        ))}
      </select>
    ) : (
      <ProfileText profile={find.profile(value)} find={find} full />
    );

  return (
    <>
      <section className="sheet-section reading">
        <h2>Why this plan</h2>
        <p className="prose">{plan.rationale}</p>
        <p className="note">
          Composed by the planner on {profileText(planner, find, true)}. Stages that haven't started can be changed.
        </p>
      </section>

      <section className="sheet-section">
        <h2>Stages</h2>
        <ol className="stages">
          {plan.stages.map((stage, index) => {
            const role = find.role(stage.roleId);
            const reviewerRole = find.role(stage.reviewerRoleId);
            const past = index < task.stageIndex || task.state === "pr-open" || task.state === "done";
            const now = index === task.stageIndex && !past;
            const editable = index > task.stageIndex && task.state !== "done" && task.state !== "cancelled";
            const rounds = task.rounds[stage.id];
            return (
              <li key={stage.id} className={`stage ${past ? "past" : ""} ${now ? "now" : ""}`}>
                <span className="n" aria-hidden="true">
                  {past ? <Check size={14} strokeWidth={3} /> : index + 1}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="head">
                    <span>{stage.title}</span>
                    {KIND_LABEL[stage.kind] && <span className="kind">{KIND_LABEL[stage.kind]}</span>}
                    {stage.maxRounds && <span className="kind">Up to {stage.maxRounds} rounds</span>}
                    {rounds && rounds > 1 && <span className="kind num">Round {rounds}</span>}
                    {now && <span className="label running">Now</span>}
                    {past && <span className="sr-only">Done</span>}
                  </div>
                  <div className="who">
                    {stage.kind === "gate" ? (
                      <>
                        <ShieldCheck size={16} aria-hidden="true" />
                        You decide before the squad goes on.
                      </>
                    ) : stage.kind === "converge" ? (
                      <>
                        <RoleAvatar role={role} size={20} />
                        {role?.name}
                        {select(stage, "profileIds", 0, stage.profileIds[0] ?? "", editable)}
                        <Repeat size={14} aria-label="with" />
                        <RoleAvatar role={reviewerRole} size={20} />
                        {reviewerRole?.name}
                        {select(stage, "reviewerProfileIds", 0, stage.reviewerProfileIds?.[0] ?? "", editable)}
                      </>
                    ) : (
                      <>
                        <RoleAvatar role={role} size={20} />
                        {role?.name}
                        {stage.profileIds.map((profileId, at) => (
                          <span key={`${profileId}-${at}`} className="row" style={{ gap: 8 }}>
                            {at > 0 && <span aria-label="then">→</span>}
                            {select(stage, "profileIds", at, profileId, editable)}
                          </span>
                        ))}
                        {stage.kind === "review-chain" && editable && (
                          <button className="btn quiet small" onClick={() => sim.addReviewer(task.id, stage.id, "sonnet-medium")}>
                            Add a reviewer
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

/** Open blockers first, then other open points, then settled ones. */
function openFirst<T extends { status: string; blocking: boolean }>(items: readonly T[]): T[] {
  const rank = (item: T) => (item.status === "open" ? (item.blocking ? 0 : 1) : 2);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

function ObjectionItem({ objection, find }: { objection: Objection; find: Lookup }) {
  const status = objection.status === "open" ? "Open" : objection.status === "accepted" ? "Accepted" : "Rejected";
  return (
    <li className="issue">
      <div className="issue-status">
        <span className={`label ${objection.status === "open" ? (objection.blocking ? "bad" : "warn") : objection.status === "accepted" ? "ok" : ""}`}>{status}</span>
        <span aria-hidden="true">·</span>
        <span>{objection.blocking ? "Blocking" : "Not blocking"}</span>
        <span aria-hidden="true">·</span>
        <span className="num">Round {objection.round}</span>
        {objection.call !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            <span className="label accent">Your call</span>
          </>
        )}
      </div>
      <p className="issue-text">{objection.text}</p>
      <p className="issue-who">Raised by {profileText(find.profile(objection.raisedBy), find, true)}</p>
      {objection.call !== undefined && <CallWords text={objection.call} />}
      {objection.answer && (
        <div className="issue-response">
          <b>{objection.call !== undefined ? "The architect's note" : "The architect's answer"}</b>
          {objection.answer}
        </div>
      )}
    </li>
  );
}

function DesignView({ task, find }: { task: Task; find: Lookup }) {
  const brief = task.brief;
  return (
    <>
      {brief ? (
        <>
          <section className="sheet-section reading">
            <h2>Design brief</h2>
            <p className="prose">{brief.summary}</p>
          </section>
          <section className="sheet-section reading">
            <h2>What changes for users</h2>
            <ul className="list">
              {brief.forUsers.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          <section className="sheet-section reading">
            <h2>Parts of the product</h2>
            <p className="prose">{brief.areas.join(", ")}</p>
          </section>
          <section className="sheet-section reading">
            <h2>Acceptance checklist</h2>
            <ul className="checks">
              {brief.acceptance.map((item) => {
                const met = item.met ?? (task.state === "pr-open" || task.state === "done" || task.column === "ready");
                return (
                  <li key={item.text} className="check">
                    <span className={`box ${met ? "on" : ""}`} aria-hidden="true">
                      {met && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span>
                      <span className="sr-only">{met ? "Met: " : "Not met yet: "}</span>
                      {item.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
          {brief.risks.length > 0 && (
            <section className="sheet-section reading">
              <h2>Risks</h2>
              <ul className="list">
                {brief.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <div className="empty-state reading">{task.plan?.stages.some((stage) => stage.kind === "converge") ? "The architects haven't settled the brief yet." : "This plan has no design stage. The builder works from your description."}</div>
      )}

      {task.objections.length > 0 && (
        <section className="sheet-section">
          <h2>Disagreements</h2>
          <ol className="issues">
            {openFirst(task.objections).map((objection) => (
              <ObjectionItem key={objection.id} objection={objection} find={find} />
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

function FindingItem({ finding, find }: { finding: Finding; find: Lookup }) {
  const status = finding.status === "fixed" ? "Fixed" : finding.status === "dismissed" ? "Dismissed" : "Open";
  return (
    <li className="issue">
      <div className="issue-status">
        <span className={`label ${finding.status === "fixed" ? "ok" : finding.status === "open" ? (finding.severity === "blocking" ? "bad" : "warn") : ""}`}>{status}</span>
        <span aria-hidden="true">·</span>
        <span>{finding.severity === "blocking" ? "Blocking" : "Suggestion"}</span>
      </div>
      <p className="issue-text">{finding.text}</p>
      <p className="issue-who">
        Raised by {profileText(find.profile(finding.raisedBy), find, true)}
        {finding.confirmedBy.length > 0 && `. Confirmed by ${finding.confirmedBy.map((profileId) => profileText(find.profile(profileId), find, true)).join(" and ")}`}
      </p>
    </li>
  );
}

const CALL_PREVIEW = 140;

/** The coordinator's call on an objection it settled: shortened, with a way to read it all. */
function CallWords({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > CALL_PREVIEW;
  return (
    <div className="issue-response">
      <b>Your call</b>
      {all || !long ? text : `${text.slice(0, CALL_PREVIEW).trimEnd()}…`}
      {long && (
        <>
          {" "}
          <button className="linkish" onClick={() => setAll((on) => !on)}>
            {all ? "Show less" : "Read all"}
          </button>
        </>
      )}
    </div>
  );
}

function ReviewView({ task, find }: { task: Task; find: Lookup }) {
  const reviewing = task.plan?.stages.some((stage, index) => stage.kind === "review-chain" && index <= task.stageIndex) || task.state === "pr-open" || task.state === "done";
  if (task.findings.length === 0) return <div className="empty-state">{reviewing ? "No findings. Every reviewer passed it." : "Reviews start after the build."}</div>;

  const findings = openFirst(task.findings.map((finding) => ({ ...finding, blocking: finding.severity === "blocking" })));
  const open = findings.filter((finding) => finding.status === "open").length;

  return (
    <>
      <p className="tamper">
        <ShieldCheck size={16} aria-hidden="true" />
        Tamper check passed: no tests were removed, weakened or skipped.
      </p>
      <section className="sheet-section">
        <h2>
          Findings <span className="quiet-text num">{open > 0 ? `${open} open` : "all settled"}</span>
        </h2>
        <ol className="issues">
          {findings.map((finding) => (
            <FindingItem key={finding.id} finding={finding} find={find} />
          ))}
        </ol>
      </section>
    </>
  );
}
