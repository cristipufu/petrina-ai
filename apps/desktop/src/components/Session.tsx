import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowRight, ChevronDown, Send, ShieldCheck, ShieldOff, User } from "lucide-react";
import type { ActiveAgent, Id, MessageMode, SessionLine, State, Task } from "@petrina/core";
import { sim, useEngineStatus, useUnsent } from "../engine";
import { ago, profileText, type Lookup } from "../lib";
import { RoleAvatar } from "./bits";
import { UnsentMessage } from "./EngineState";
import { Ask } from "./Inbox";
import type { SheetTab } from "./TaskCard";

interface LogProps {
  task: Task;
  state: State;
  find: Lookup;
  /** The sheet's scrolling area, which the conversation scrolls in. */
  scroller: RefObject<HTMLDivElement | null>;
  onTab: (tab: SheetTab) => void;
  active?: boolean;
  /** A journey step to read: the conversation opens at its first line, with its lines marked. */
  step?: { id: string; name: string };
  onStepDone?: () => void;
}

/** Consecutive activity lines read as one quiet block between messages. */
function groupLines(lines: readonly SessionLine[]): (SessionLine | SessionLine[])[] {
  const groups: (SessionLine | SessionLine[])[] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (line.from === "activity" && Array.isArray(last)) last.push(line);
    else groups.push(line.from === "activity" ? [line] : line);
  }
  return groups;
}

function when(at: number, now: number): string {
  const value = ago(at, now);
  return value === "now" ? "just now" : `${value} ago`;
}

/** Only this run's saved conversation, read in place without changing the task's Session tab. */
export function StepConversation({ lines, find, now, live = false }: { lines: readonly SessionLine[]; find: Lookup; now: number; live?: boolean }) {
  const section = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const textSize = lines.reduce((size, line) => size + line.text.length, 0);
  useLayoutEffect(() => {
    const scroller = section.current?.closest<HTMLElement>(".sheet-scroll");
    if (!scroller) return;
    const onScroll = () => { pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64; };
    scroller.addEventListener("scroll", onScroll);
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const scroller = section.current?.closest<HTMLElement>(".sheet-scroll");
    if (live && pinned.current && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [live, lines.length, textSize]);
  return <section ref={section} className="step-conversation" aria-label="This step's conversation">
    <div className="chat">
      {groupLines(lines).map((group) => Array.isArray(group) ? (
        <details key={group[0]!.id} className="step-activity"><summary>{group.length} agent action{group.length === 1 ? "" : "s"}</summary><ul className="activity">{group.map((line) => <li key={line.id}><ArrowRight size={12} aria-hidden="true" />{line.text}</li>)}</ul></details>
      ) : group.from === "system" ? (
        <p key={group.id} className="system">{group.text} · {when(group.at, now)}</p>
      ) : (
        <div key={group.id} className={`msg ${group.from === "you" ? "you" : "agent"}`}>
          {group.from === "you" ? <span className="avatar tone-slate" style={{ width: 28, height: 28 }} aria-hidden="true"><User size={16} /></span> : <RoleAvatar role={find.role(group.roleId)} size={28} />}
          <div style={{ minWidth: 0 }}><div className="name">{group.from === "you" ? "You" : find.role(group.roleId)?.name ?? "Agent"}<time>{when(group.at, now)}</time></div><div className="bubble">{group.text}</div></div>
        </div>
      ))}
    </div>
  </section>;
}

const SANDBOX_TIPS: Readonly<Record<string, string>> = {
  "claude-code":
    "Claude Code's own sandbox: its commands can change only the working copy, temporary folders, package download caches and sign-in caches. Also the product's shared git history, and whatever your or the product's Claude Code settings allow. Reading, websites and your logins stay open, and Auto mode can let a command run outside it (on a Mac, SSH and headless browsers). On a Mac, process-list checks can fail; Petrina's own checks run the full test suite.",
  codex: "Sandboxed by Codex's own workspace sandbox, as Codex sets it.",
};

/** Whether the agent's commands run in its tool's own sandbox; hover or focus says what that covers, or why it is off. */
function Sandbox({ sandbox, toolId }: { sandbox: NonNullable<ActiveAgent["sandbox"]>; toolId: Id }) {
  const tip = sandbox.on ? (SANDBOX_TIPS[toolId] ?? "The tool's own sandbox.") : `Running without Claude Code's sandbox: ${sandbox.reason}. Auto mode still reviews each command.`;
  const label = sandbox.on ? "Sandboxed" : "Not sandboxed";
  return (
    <span className={`sandbox ${sandbox.on ? "on" : "off"}`} tabIndex={0} data-tip={tip} aria-label={`${label}. ${tip}`}>
      {sandbox.on ? <ShieldCheck size={12} aria-hidden="true" /> : <ShieldOff size={12} aria-hidden="true" />}
      {label}
    </span>
  );
}

/** Join the agent working on a task: its live conversation, with anything it waits on below. */
function Log({ task, state, find, scroller, onTab, step, onStepDone, active = true }: LogProps) {
  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const live = task.state === "running";
  // "You're driving" has its own controls in the footer.
  const asks = state.inbox.filter((item) => item.taskId === task.id && item.kind !== "driving");
  // Answers to something still waiting show with it below; the rest show here, in the conversation.
  const unsent = useUnsent().filter((entry) => entry.taskId === task.id && !(entry.itemId && asks.some((item) => item.id === entry.itemId)));
  const connected = useEngineStatus().link === "live";
  // A refusal adds its reason and actions under the message.
  const refused = unsent.filter((entry) => entry.refused).length;
  // Streaming can grow an earlier bubble while another agent's activity is the last line.
  const textSize = task.session.reduce((size, line) => size + line.text.length, 0);
  const pinned = useRef(true);
  const marked = step && task.session.some((line) => line.step === step.id) ? step : undefined;
  const firstMarked = marked ? task.session.find((line) => line.step === marked.id)?.id : undefined;

  // Follow new lines only while the reader is at the bottom; reading earlier messages stays put.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !active) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [scroller, active]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = firstMarked ? el.querySelector<HTMLElement>(`[data-line="${firstMarked}"]`) : null;
    if (first) {
      // At the step's first line, just below the tabs that stay in view.
      const tabs = el.querySelector(".tabs")?.getBoundingClientRect().height ?? 0;
      el.scrollTop += first.getBoundingClientRect().top - el.getBoundingClientRect().top - tabs - 16;
      pinned.current = false;
      return;
    }
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
  }, [scroller, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow new lines only while at the bottom, but always bring what you just sent into view.
  const sent = useRef({ queued: task.queued.length, lines: task.session.length, unsent: unsent.length });
  useLayoutEffect(() => {
    const el = scroller.current;
    const yours =
      task.queued.length > sent.current.queued || unsent.length > sent.current.unsent || (task.session.length > sent.current.lines && task.session.at(-1)?.from === "you");
    sent.current = { queued: task.queued.length, lines: task.session.length, unsent: unsent.length };
    if (active && el && (pinned.current || yours)) el.scrollTop = el.scrollHeight;
  }, [scroller, active, task.session.length, textSize, task.queued.length, unsent.length, refused, asks.length]);

  const inStep = (line: SessionLine) => (marked && line.step === marked.id ? "in-step" : "");
  const stepStart = (line: SessionLine) => (line.id === firstMarked && marked ? <span className="sr-only">From {marked.name}: </span> : null);

  const speaker = (line: SessionLine): ReactNode => {
    const lineRole = find.role(line.roleId);
    const you = line.from === "you";
    return (
      <div key={line.id} data-line={line.id} className={`msg ${you ? "you" : "agent"} ${inStep(line)}`}>
        {you ? (
          <span className="avatar tone-violet" style={{ width: 28, height: 28 }} aria-hidden="true">
            <User size={16} />
          </span>
        ) : (
          <RoleAvatar role={lineRole} size={28} />
        )}
        <div style={{ minWidth: 0 }}>
          <div className="name">
            {stepStart(line)}
            {you ? "You" : (lineRole?.name ?? "Agent")}
            <time className="num">{when(line.at, state.now)}</time>
          </div>
          <div className="bubble">{line.text}</div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="session-head">
        {role && profile ? (
          <>
            <RoleAvatar role={role} size={24} />
            <strong>{role.name}</strong>
            <span className="quiet-text">{profileText(profile, find, true)}</span>
            <span className={`dot ${task.state}`} aria-hidden="true" />
            <span>{task.driving ? "Paused while you drive" : live ? "Working" : task.state === "needs-you" ? "Waiting on you" : "Idle"}</span>
            {/* While you drive, the tool runs in your terminal with your own setup: Petrina's sandbox settings don't apply. */}
            {task.agent?.sandbox && !task.driving && <Sandbox sandbox={task.agent.sandbox} toolId={profile.toolId} />}
          </>
        ) : (
          <span>No agent is working on this right now. Messages wait until one starts.</span>
        )}
      </div>

      {marked && (
        <p className="step-marked reading">
          <span>
            Lines from <strong>{marked.name}</strong> are marked.
          </span>
          <button className="linkish" onClick={onStepDone}>
            Stop marking
          </button>
        </p>
      )}
      <div className="chat reading" aria-label="Conversation">
        {task.session.length === 0 && <div className="empty-state">The conversation starts when an agent picks this task up.</div>}
        {groupLines(task.session).map((group) => {
          if (Array.isArray(group))
            return (
              <details key={group[0]!.id} className={`step-activity session-activity ${group.some((line) => inStep(line)) ? "in-step" : ""}`}>
                <summary>{group.length} agent action{group.length === 1 ? "" : "s"}</summary>
              <ul className="activity" aria-label="What the agent did">
                {group.map((line) => (
                  <li key={line.id} data-line={line.id} className={inStep(line)}>
                    <ArrowRight size={12} aria-hidden="true" />
                    {stepStart(line)}
                    {line.text}
                  </li>
                ))}
              </ul>
              </details>
            );
          if (group.from === "system")
            return (
              <div key={group.id} data-line={group.id} className={`system ${inStep(group)}`}>
                <RoleAvatar role={find.role(group.roleId)} size={16} />
                <span>
                  {stepStart(group)}
                  {group.text} · <span className="num">{when(group.at, state.now)}</span>
                </span>
              </div>
            );
          return speaker(group);
        })}
        {task.queued.map((message) => {
          const recipients = Object.values(message.recipients ?? {});
          const heard = recipients.filter(Boolean).length;
          const note = heard ? `Sent to ${heard} of ${recipients.length} agents` : recipients.length ? `Queued for ${recipients.length} agents` : task.driving ? "Queued, delivered when you hand back" : live ? "Queued, delivered after the current step" : "Queued, delivered when an agent starts";
          return (
          <div key={message.id} className="msg you queued" data-queued>
            <span className="avatar tone-violet" style={{ width: 28, height: 28 }} aria-hidden="true">
              <User size={16} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="name">
                You
                <span className="queued-note">{note}</span>
                <button className="btn ghost small" disabled={heard > 0} title={heard ? "An agent has already received this message" : undefined} onClick={() => sim.removeQueued(task.id, message.id)} aria-describedby={`queued-${message.id}`}>
                  Remove
                </button>
              </div>
              <div className="bubble" id={`queued-${message.id}`}>
                {message.text}
              </div>
            </div>
          </div>
          );
        })}
        {unsent.map((entry) => (
          <UnsentMessage key={entry.clientId} entry={entry} live={connected} />
        ))}
      </div>

      {asks.length > 0 && (
        <div className="session-asks reading" aria-label="Waiting on you">
          {asks.map((item) => (
            <Ask key={item.id} item={item} state={state} find={find} onOpen={(_taskId, tab) => tab && onTab(tab)} />
          ))}
        </div>
      )}
    </>
  );
}

/** Messages queue until the agent finishes its step, or interrupt it. */
function Composer({ task, find, text, onText, focusRequest, onFocused }: { task: Task; find: Lookup; text: string; onText: (text: string) => void; focusRequest: boolean; onFocused: () => void }) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (focusRequest) setExpanded(true);
  }, [focusRequest]);
  useEffect(() => {
    if (focusRequest && expanded) { textarea.current?.focus(); onFocused(); }
  }, [focusRequest, expanded, onFocused]);
  const [mode, setMode] = useState<MessageMode>("queue");
  const role = find.role(task.agent?.roleId ?? task.driving?.roleId ?? task.conversation?.roleId);
  const live = task.state === "running";
  const recipient = (task.helpers?.length ?? 0) > 1 ? "all agents in this step" : `the ${role?.name.toLowerCase() ?? "agent"}`;

  const send = () => {
    if (!text.trim()) return;
    sim.sendMessage(task.id, text, live ? mode : "queue");
    onText("");
  };

  return (
    <div className="composer">
      <button type="button" className="composer-toggle" id={`${id}-title`} aria-expanded={expanded} aria-controls={`${id}-body`} onClick={() => setExpanded((value) => !value)}>
        <span>{live || task.driving || task.conversation ? `Message ${recipient}` : "Message the next agent"}</span>
        {!expanded && text.trim() && <span className="composer-draft">Draft</span>}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {expanded && <form className="composer-body" id={`${id}-body`} onSubmit={(event) => { event.preventDefault(); send(); }}>
        <textarea
          id={id}
          ref={textarea}
          rows={2}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
          placeholder="Add guidance or ask a question…"
          value={text}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
      <div className="composer-actions">
        {live && (
          <div className="segmented" role="radiogroup" aria-label="When to deliver">
            <button type="button" role="radio" aria-checked={mode === "queue"} className={mode === "queue" ? "on" : ""} onClick={() => setMode("queue")} title="Deliver after the current step">
              Queue
            </button>
            <button type="button" role="radio" aria-checked={mode === "interrupt"} className={mode === "interrupt" ? "on" : ""} onClick={() => setMode("interrupt")} title="Stop the current step and deliver now">
              Interrupt
            </button>
          </div>
        )}
        <button type="submit" className="btn lead" disabled={!text.trim()}>
          <Send size={16} aria-hidden="true" />
          Send
        </button>
      </div>
      <p className="hint" id={`${id}-hint`}>
        {live
          ? mode === "queue"
            ? "Delivered when the agent finishes its current step. Enter sends, Shift+Enter starts a new line."
            : "Stops the current step and delivers right away."
          : task.driving
            ? "You're driving in your terminal. Delivered when you hand back."
            : "Delivered as soon as an agent starts on this task."}
      </p>
      </form>}
    </div>
  );
}

export const Session = { Log, Composer };
