import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowRight, Send, SquareTerminal, User } from "lucide-react";
import type { MessageMode, SessionLine, State, Task } from "@petrina/core";
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
  onToast: (title: string, detail?: string) => void;
  onTab: (tab: SheetTab) => void;
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

/** Join the agent working on a task: its live conversation, with anything it waits on below. */
function Log({ task, state, find, scroller, onToast, onTab }: LogProps) {
  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const live = task.state === "running";
  const asks = state.inbox.filter((item) => item.taskId === task.id);
  // Answers to something still waiting show with it below; the rest show here, in the conversation.
  const unsent = useUnsent().filter((entry) => entry.taskId === task.id && !(entry.itemId && asks.some((item) => item.id === entry.itemId)));
  const connected = useEngineStatus().link === "live";
  // A refusal adds its reason and actions under the message.
  const refused = unsent.filter((entry) => entry.refused).length;
  const pinned = useRef(true);

  // Follow new lines only while the reader is at the bottom; reading earlier messages stays put.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [scroller]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
  }, [scroller, task.id]);

  // Follow new lines only while at the bottom, but always bring what you just sent into view.
  const sent = useRef({ queued: task.queued.length, lines: task.session.length, unsent: unsent.length });
  useLayoutEffect(() => {
    const el = scroller.current;
    const yours =
      task.queued.length > sent.current.queued || unsent.length > sent.current.unsent || (task.session.length > sent.current.lines && task.session.at(-1)?.from === "you");
    sent.current = { queued: task.queued.length, lines: task.session.length, unsent: unsent.length };
    if (el && (pinned.current || yours)) el.scrollTop = el.scrollHeight;
  }, [scroller, task.session.length, task.queued.length, unsent.length, refused, asks.length]);

  const speaker = (line: SessionLine): ReactNode => {
    const lineRole = find.role(line.roleId);
    const you = line.from === "you";
    return (
      <div key={line.id} className={`msg ${you ? "you" : "agent"}`}>
        {you ? (
          <span className="avatar tone-violet" style={{ width: 28, height: 28 }} aria-hidden="true">
            <User size={16} />
          </span>
        ) : (
          <RoleAvatar role={lineRole} size={28} />
        )}
        <div style={{ minWidth: 0 }}>
          <div className="name">
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
            <span>{live ? "Working" : task.state === "needs-you" ? "Waiting on you" : "Idle"}</span>
          </>
        ) : (
          <span>No agent is working on this right now. Messages wait until one starts.</span>
        )}
        <button
          className="btn small"
          disabled={!task.agent}
          title="Open this agent's own tool in your terminal, on the same session"
          onClick={() =>
            onToast("Take over arrives with the real agents", "It will open the agent's own tool in your terminal on this session and pause the stage until you hand back.")
          }
        >
          <SquareTerminal size={16} aria-hidden="true" />
          Take over in terminal
        </button>
      </div>

      <div className="chat reading" aria-label="Conversation">
        {task.session.length === 0 && <div className="empty-state">The conversation starts when an agent picks this task up.</div>}
        {groupLines(task.session).map((group) => {
          if (Array.isArray(group))
            return (
              <ul key={group[0]!.id} className="activity" aria-label="What the agent did">
                {group.map((line) => (
                  <li key={line.id}>
                    <ArrowRight size={12} aria-hidden="true" />
                    {line.text}
                  </li>
                ))}
              </ul>
            );
          if (group.from === "system")
            return (
              <div key={group.id} className="system">
                <RoleAvatar role={find.role(group.roleId)} size={16} />
                <span>
                  {group.text} · <span className="num">{when(group.at, state.now)}</span>
                </span>
              </div>
            );
          return speaker(group);
        })}
        {task.queued.map((message) => (
          <div key={message.id} className="msg you queued" data-queued>
            <span className="avatar tone-violet" style={{ width: 28, height: 28 }} aria-hidden="true">
              <User size={16} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="name">
                You
                <span className="queued-note">{live ? "Queued, delivered after the current step" : "Queued, delivered when an agent starts"}</span>
                <button className="btn ghost small" onClick={() => sim.removeQueued(task.id, message.id)} aria-describedby={`queued-${message.id}`}>
                  Remove
                </button>
              </div>
              <div className="bubble" id={`queued-${message.id}`}>
                {message.text}
              </div>
            </div>
          </div>
        ))}
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
function Composer({ task, find }: { task: Task; find: Lookup }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<MessageMode>("queue");
  const role = find.role(task.agent?.roleId);
  const live = task.state === "running";

  const send = () => {
    if (!text.trim()) return;
    sim.sendMessage(task.id, text, live ? mode : "queue");
    setText("");
  };

  return (
    <div className="composer">
      <div className="composer-row">
        <textarea
          rows={1}
          aria-label="Message"
          placeholder={live ? `Message the ${role?.name.toLowerCase() ?? "agent"}…` : "Message the next agent on this task…"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {live && (
          <div className="segmented" role="radiogroup" aria-label="When to deliver">
            <button role="radio" aria-checked={mode === "queue"} className={mode === "queue" ? "on" : ""} onClick={() => setMode("queue")} title="Deliver after the current step">
              Queue
            </button>
            <button role="radio" aria-checked={mode === "interrupt"} className={mode === "interrupt" ? "on" : ""} onClick={() => setMode("interrupt")} title="Stop the current step and deliver now">
              Interrupt
            </button>
          </div>
        )}
        <button className="btn lead" onClick={send} disabled={!text.trim()}>
          <Send size={16} aria-hidden="true" />
          Send
        </button>
      </div>
      <div className="hint">
        {live
          ? mode === "queue"
            ? "Delivered when the agent finishes its current step. Enter sends, Shift+Enter starts a new line."
            : "Stops the current step and delivers right away."
          : "Delivered as soon as an agent starts on this task."}
      </div>
    </div>
  );
}

export const Session = { Log, Composer };
