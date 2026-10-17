import { useEffect, useState } from "react";
import {
  ArrowUpToLine,
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  Ellipsis,
  ExternalLink,
  GitPullRequest,
  Hand,
  MessageSquare,
  Pause,
  Play,
  Repeat,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import type { Stage, State, Task } from "@petrina/core";
import { sim } from "../engine";
import { ago, currentPhase, duration, PHASES, phasesInPlan, safeUrl, type Lookup } from "../lib";
import { ProductChip, ProfileChip, RoleAvatar, StatePill } from "./bits";
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
}

const TABS: readonly { id: SheetTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "design", label: "Design" },
  { id: "review", label: "Review" },
  { id: "session", label: "Session" },
];

export function TaskSheet({ task, state, find, tab, onTab, onClose, onToast }: SheetProps) {
  const [menu, setMenu] = useState(false);
  const product = find.product(task.productId);
  const phase = currentPhase(task);
  const used = phasesInPlan(task);
  const prUrl = safeUrl(task.pr?.url);
  const canPause = task.state === "running" || task.state === "needs-you" || task.state === "waiting";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const counts: Partial<Record<SheetTab, number>> = {
    review: task.findings.filter((finding) => finding.status === "open").length,
    design: task.objections.filter((objection) => objection.status === "open").length,
    session: task.queued.length,
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section className="sheet" role="dialog" aria-label={task.title}>
        <header className="sheet-head">
          <div className="sheet-meta">
            <ProductChip product={product} />
            <span>·</span>
            <StatePill state={task.state} />
            {task.startedAt !== undefined && <span className="num">started {ago(task.startedAt, state.now)} ago</span>}
            <span className="actions">
              {prUrl && (
                <a className="btn small" href={prUrl} target="_blank" rel="noopener noreferrer">
                  <GitPullRequest size={14} />#{task.pr?.number}
                  <ExternalLink size={12} />
                </a>
              )}
              <button className="btn small ghost" onClick={() => onTab("session")}>
                <MessageSquare size={14} />
                Message
              </button>
              {canPause && (
                <button className="btn small ghost" onClick={() => sim.pause(task.id)}>
                  <Pause size={14} />
                  Pause
                </button>
              )}
              {task.state === "paused" && (
                <button className="btn small ghost" onClick={() => sim.resume(task.id)}>
                  <Play size={14} />
                  Resume
                </button>
              )}
              <span style={{ position: "relative" }}>
                <button className="btn small ghost icon" aria-label="More" onClick={() => setMenu((open) => !open)}>
                  <Ellipsis size={16} />
                </button>
                {menu && (
                  <div className="menu" style={{ right: 0, top: 34 }} onMouseLeave={() => setMenu(false)}>
                    {task.state === "queued" && (
                      <>
                        <button onClick={() => (sim.moveToTop(task.id), setMenu(false))}>
                          <ArrowUpToLine size={14} />
                          Move to top
                        </button>
                        <button onClick={() => (sim.setHeld(task.id, !task.held), setMenu(false))}>
                          <Hand size={14} />
                          {task.held ? "Release hold" : "Hold (don't start yet)"}
                        </button>
                      </>
                    )}
                    {task.state !== "done" && task.state !== "cancelled" && (
                      <button className="danger" onClick={() => (sim.cancel(task.id), setMenu(false))}>
                        <Ban size={14} />
                        Cancel task
                      </button>
                    )}
                  </div>
                )}
              </span>
              <button className="btn small ghost icon" aria-label="Close" onClick={onClose}>
                <X size={16} />
              </button>
            </span>
          </div>
          <h1 className="sheet-title">{task.title}</h1>

          <div className="stepper" aria-label="Progress">
            {PHASES.map((name, index) => {
              let cls = "step";
              if (!used.has(index)) cls += " skip";
              else if (index < phase) cls += " done";
              else if (index === phase) cls += ` now ${task.state}`;
              return (
                <span key={name} style={{ display: "contents" }}>
                  {index > 0 && <span className={`bar ${index <= phase && used.has(index) ? "done" : ""}`} />}
                  <span className={cls}>
                    <span className="ring">{index < phase && used.has(index) ? <Check size={11} strokeWidth={3} /> : index + 1}</span>
                    {name}
                  </span>
                </span>
              );
            })}
          </div>

          <nav className="tabs" role="tablist">
            {TABS.map((entry) => (
              <button key={entry.id} role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "on" : ""} onClick={() => onTab(entry.id)}>
                {entry.label}
                {counts[entry.id] ? <span className="count">{counts[entry.id]}</span> : null}
              </button>
            ))}
          </nav>
        </header>

        {tab === "session" ? (
          <div style={{ flex: 1, minHeight: 0 }}>
            <Session task={task} state={state} find={find} onToast={onToast} onTab={onTab} />
          </div>
        ) : (
          <div className="sheet-body">
            {tab === "overview" && <Overview task={task} state={state} find={find} />}
            {tab === "plan" && <PlanView task={task} state={state} find={find} />}
            {tab === "design" && <DesignView task={task} find={find} />}
            {tab === "review" && <ReviewView task={task} find={find} />}
          </div>
        )}
      </section>
    </>
  );
}

function Overview({ task, state, find }: { task: Task; state: State; find: Lookup }) {
  const [all, setAll] = useState(false);
  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const entries = all ? task.timeline : task.timeline.slice(-14);

  return (
    <>
      {task.description && (
        <>
          <h3>What you asked for</h3>
          <p className="prose" style={{ marginTop: 0 }}>
            {task.description}
          </p>
        </>
      )}

      <h3>Right now</h3>
      <div className={`now-card ${task.state}`}>
        {role ? <RoleAvatar role={role} size={34} /> : <span className="avatar tone-slate" style={{ width: 34, height: 34 }}><User size={18} /></span>}
        <div style={{ minWidth: 0 }}>
          <div className="who">
            {role ? `${role.name} ${task.state === "needs-you" ? "is waiting on you" : "is working"}` : task.state === "needs-you" ? "Waiting on you" : stateSentence(task)}
            {profile && <ProfileChip profile={profile} find={find} />}
          </div>
          <div className="what">
            <span className={`dot ${task.state}`} />
            {task.statusLine}
            {task.agent && <span className="num" style={{ color: "var(--text-3)" }}>· {duration(task.agent.since, state.now)}</span>}
          </div>
        </div>
      </div>

      <h3>Timeline</h3>
      {!all && task.timeline.length > entries.length && (
        <button className="linkish show-earlier" onClick={() => setAll(true)}>
          Show {task.timeline.length - entries.length} earlier events
        </button>
      )}
      <div className="timeline">
        {entries.map((entry) => {
          const entryRole = find.role(entry.roleId);
          return (
            <div key={entry.id} className={`tl ${entry.tone}`}>
              <span className="icon">
                {entry.tone === "you" ? (
                  <User size={13} />
                ) : entry.tone === "warn" ? (
                  <CircleAlert size={13} />
                ) : entry.tone === "done" ? (
                  <CircleCheck size={13} />
                ) : entryRole ? (
                  <RoleAvatar role={entryRole} size={24} />
                ) : (
                  <span className="dot" />
                )}
              </span>
              <span className="text">{entry.text}</span>
              <span className="when">{ago(entry.at, state.now)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function stateSentence(task: Task): string {
  switch (task.state) {
    case "queued":
      return task.held ? "On hold in the queue" : "Waiting in the queue";
    case "waiting":
      return "Waiting for a free slot";
    case "paused":
      return "Paused";
    case "pr-open":
      return "Delivered. Waiting for you to merge on GitHub";
    case "done":
      return "Merged";
    case "cancelled":
      return "Cancelled";
    default:
      return "Between stages";
  }
}

const KIND_LABEL: Record<Stage["kind"], string> = {
  do: "",
  converge: "Until both agree",
  "review-chain": "One after another",
  gate: "Checkpoint",
};

function PlanView({ task, state, find }: { task: Task; state: State; find: Lookup }) {
  const plan = task.plan;
  if (!plan)
    return (
      <div className="empty-state">
        The planner writes the plan when the task starts.
        <br />
        It picks the roles, the tools and the order for this task.
      </div>
    );

  const planner = find.profile(plan.plannerProfileId);
  const profileOptions = state.profiles;

  const select = (stage: Stage, list: "profileIds" | "reviewerProfileIds", index: number, value: string, editable: boolean) =>
    editable ? (
      <select value={value} aria-label="Who does this" onChange={(event) => sim.setStageProfile(task.id, stage.id, list, index, event.target.value)}>
        {profileOptions.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {find.tool(profile.toolId)?.name} · {profile.model} · {profile.effort}
          </option>
        ))}
      </select>
    ) : (
      <ProfileChip profile={find.profile(value)} find={find} />
    );

  return (
    <>
      <h3>Why this plan</h3>
      <p className="prose" style={{ marginTop: 0 }}>
        {plan.rationale}
      </p>
      <div className="row" style={{ color: "var(--text-3)", fontSize: 12.5, marginBottom: 6 }}>
        Composed by the planner on <ProfileChip profile={planner} find={find} />. Stages that haven't started can be changed.
      </div>

      <h3>Stages</h3>
      {plan.stages.map((stage, index) => {
        const role = find.role(stage.roleId);
        const reviewerRole = find.role(stage.reviewerRoleId);
        const past = index < task.stageIndex || task.state === "pr-open" || task.state === "done";
        const now = index === task.stageIndex && !past;
        const editable = index > task.stageIndex && task.state !== "done" && task.state !== "cancelled";
        const rounds = task.rounds[stage.id];
        return (
          <div key={stage.id} className={`stage ${past ? "past" : ""} ${now ? "now" : ""}`}>
            <span className="n">{past ? <Check size={14} strokeWidth={3} /> : index + 1}</span>
            <div>
              <div className="head">
                {stage.title}
                {KIND_LABEL[stage.kind] && <span className="kind">· {KIND_LABEL[stage.kind]}</span>}
                {stage.maxRounds && <span className="kind">· up to {stage.maxRounds} rounds</span>}
                {rounds && rounds > 1 && <span className="pill accent">round {rounds}</span>}
                {now && <span className="pill running">now</span>}
              </div>
              <div className="who">
                {stage.kind === "gate" ? (
                  <>
                    <ShieldCheck size={14} />
                    You decide before the squad goes on.
                  </>
                ) : stage.kind === "converge" ? (
                  <>
                    <RoleAvatar role={role} size={20} />
                    {role?.name}
                    {select(stage, "profileIds", 0, stage.profileIds[0] ?? "", editable)}
                    <Repeat size={13} />
                    <RoleAvatar role={reviewerRole} size={20} />
                    {reviewerRole?.name}
                    {select(stage, "reviewerProfileIds", 0, stage.reviewerProfileIds?.[0] ?? "", editable)}
                  </>
                ) : (
                  <>
                    <RoleAvatar role={role} size={20} />
                    {role?.name}
                    {stage.profileIds.map((profileId, at) => (
                      <span key={`${profileId}-${at}`} className="row" style={{ gap: 6 }}>
                        {at > 0 && <span>→</span>}
                        {select(stage, "profileIds", at, profileId, editable)}
                      </span>
                    ))}
                    {stage.kind === "review-chain" && editable && (
                      <button className="btn small ghost" onClick={() => sim.addReviewer(task.id, stage.id, "sonnet-medium")}>
                        + reviewer
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

function DesignView({ task, find }: { task: Task; find: Lookup }) {
  const brief = task.brief;
  return (
    <>
      {brief ? (
        <>
          <h3>Design brief</h3>
          <p className="prose" style={{ marginTop: 0 }}>
            {brief.summary}
          </p>
          <div className="brief-grid">
            <div className="panel">
              <h4>What changes for users</h4>
              <ul>
                {brief.forUsers.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div className="panel">
              <h4>Parts of the product</h4>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {brief.areas.map((area) => (
                  <span key={area} className="chip">
                    {area}
                  </span>
                ))}
              </div>
              <h4 style={{ marginTop: 12 }}>Risks</h4>
              <ul>
                {brief.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </div>
          </div>
          <h3>Acceptance checklist</h3>
          <div className="panel">
            {brief.acceptance.map((item) => {
              const met = item.met ?? (task.state === "pr-open" || task.state === "done" || task.column === "ready");
              return (
                <div key={item.text} className="check">
                  <span className={`box ${met ? "on" : ""}`}>{met && <Check size={11} strokeWidth={3} />}</span>
                  {item.text}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="empty-state">{task.plan?.stages.some((stage) => stage.kind === "converge") ? "The architects haven't settled the brief yet." : "This plan has no design stage. The builder works from your description."}</div>
      )}

      {task.objections.length > 0 && (
        <>
          <h3>Disagreement log</h3>
          {task.objections.map((objection) => (
            <div key={objection.id} className="item">
              <span className="text">{objection.text}</span>
              <span className="row" style={{ gap: 6 }}>
                {objection.call !== undefined && <span className="pill accent">Your call</span>}
                <span className={`pill ${objection.status === "open" ? "needs-you" : objection.status === "accepted" ? "ok" : ""}`}>
                  {objection.status === "open" ? "Open" : objection.status === "accepted" ? "Accepted" : "Rejected"}
                </span>
              </span>
              <span className="sub">
                {objection.blocking ? <span className="pill bad">Blocking</span> : <span className="pill">Not blocking</span>}
                Round {objection.round} · raised by
                <ProfileChip profile={find.profile(objection.raisedBy)} find={find} />
              </span>
              {objection.call !== undefined ? (
                <>
                  <CallWords text={objection.call} />
                  {objection.answer && <span className="answer">Architect's note: {objection.answer}</span>}
                </>
              ) : (
                objection.answer && <span className="answer">Architect: {objection.answer}</span>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

const CALL_PREVIEW = 140;

/** The coordinator's call on an objection it settled: shortened, with a way to read it all. */
function CallWords({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > CALL_PREVIEW;
  return (
    <span className="answer">
      Your call: “{all || !long ? text : `${text.slice(0, CALL_PREVIEW).trimEnd()}…`}”
      {long && (
        <button className="linkish" style={{ marginLeft: 6 }} onClick={() => setAll((on) => !on)}>
          {all ? "Show less" : "Read all"}
        </button>
      )}
    </span>
  );
}

function ReviewView({ task, find }: { task: Task; find: Lookup }) {
  const reviewing = task.plan?.stages.some((stage, index) => stage.kind === "review-chain" && index <= task.stageIndex) || task.state === "pr-open" || task.state === "done";
  if (task.findings.length === 0)
    return <div className="empty-state">{reviewing ? "No findings. Every reviewer passed it." : "Reviews start after the build."}</div>;

  const groups = [
    { title: "Blocking", items: task.findings.filter((finding) => finding.severity === "blocking") },
    { title: "Suggestions", items: task.findings.filter((finding) => finding.severity === "suggestion") },
  ];

  return (
    <>
      <div className="row" style={{ color: "var(--green)", fontSize: 12.5, fontWeight: 600 }}>
        <ShieldCheck size={15} />
        Tamper check passed: no tests were removed, weakened or skipped.
      </div>
      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <div key={group.title}>
            <h3>{group.title}</h3>
            {group.items.map((finding) => (
              <div key={finding.id} className="item">
                <span className="text">{finding.text}</span>
                <span>
                  <span className={`pill ${finding.status === "fixed" ? "ok" : finding.severity === "blocking" ? "bad" : ""}`}>
                    {finding.status === "fixed" ? "Fixed" : finding.status === "dismissed" ? "Dismissed" : "Open"}
                  </span>
                </span>
                <span className="sub">
                  {finding.where && <span>{finding.where} ·</span>}
                  raised by <ProfileChip profile={find.profile(finding.raisedBy)} find={find} />
                  {finding.confirmedBy.length > 0 && (
                    <>
                      confirmed by
                      {finding.confirmedBy.map((profileId) => (
                        <ProfileChip key={profileId} profile={find.profile(profileId)} find={find} />
                      ))}
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        ),
      )}
    </>
  );
}
