import { useEffect, useRef, useState } from "react";
import { ArrowRight, Send, SquareTerminal, X } from "lucide-react";
import type { MessageMode, State, Task } from "@petrina/core";
import { sim, useEngineStatus, useUnsent } from "../engine";
import { UnsentNote } from "./EngineState";
import { ago, type Lookup } from "../lib";
import { ProfileChip, RoleAvatar } from "./bits";
import { Ask } from "./Inbox";
import type { SheetTab } from "./TaskCard";

interface SessionProps {
  task: Task;
  state: State;
  find: Lookup;
  onToast: (title: string, detail?: string) => void;
  onTab: (tab: SheetTab) => void;
}

/** Join the agent working on a task: its live transcript, and a composer that queues or interrupts. */
export function Session({ task, state, find, onToast, onTab }: SessionProps) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<MessageMode>("queue");
  const log = useRef<HTMLDivElement>(null);
  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const live = task.state === "running";
  const asks = state.inbox.filter((item) => item.taskId === task.id);
  const unsent = useUnsent().filter((entry) => entry.taskId === task.id);
  const connected = useEngineStatus().link === "live";

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.session.length, task.queued.length, unsent.length]);

  const send = () => {
    if (!text.trim()) return;
    sim.sendMessage(task.id, text, live ? mode : "queue");
    setText("");
  };

  return (
    <div className="session">
      <div className="session-bar">
        {role && profile ? (
          <>
            <RoleAvatar role={role} size={20} />
            <strong style={{ color: "var(--text)" }}>{role.name}</strong>
            <ProfileChip profile={profile} find={find} />
            <span className={`dot ${task.state}`} />
            <span>{live ? "working" : task.state === "needs-you" ? "waiting on you" : "idle"}</span>
          </>
        ) : (
          <span>No agent is working on this right now. Messages wait until one starts.</span>
        )}
        <button
          className="btn small"
          disabled={!task.agent}
          title="Open this agent's own CLI in your terminal, on the same session"
          onClick={() =>
            onToast(
              "Take over arrives with the real agents",
              "It will open the agent's CLI in your terminal on this session and pause the stage until you hand back.",
            )
          }
        >
          <SquareTerminal size={14} />
          Take over in terminal
        </button>
      </div>

      <div className="session-log" ref={log}>
        {task.session.length === 0 && <div className="empty-state">The conversation starts when an agent picks this task up.</div>}
        {task.session.map((line) => {
          const lineRole = find.role(line.roleId);
          if (line.from === "activity")
            return (
              <div key={line.id} className="activity">
                <ArrowRight size={12} />
                {line.text}
              </div>
            );
          if (line.from === "system")
            return (
              <div key={line.id} className="system">
                <RoleAvatar role={lineRole} size={16} />
                {line.text} · {ago(line.at, state.now)}
              </div>
            );
          if (line.from === "you")
            return (
              <div key={line.id} className="msg you">
                <div className="bubble">{line.text}</div>
              </div>
            );
          return (
            <div key={line.id} className="msg agent">
              <RoleAvatar role={lineRole} size={22} />
              <div>
                <div className="name">{lineRole?.name ?? "Agent"}</div>
                <div className="bubble">{line.text}</div>
              </div>
            </div>
          );
        })}
      </div>

      {asks.length > 0 && (
        <div className="session-asks">
          {asks.map((item) => (
            <Ask key={item.id} item={item} state={state} find={find} onOpen={(_taskId, tab) => tab && onTab(tab)} />
          ))}
        </div>
      )}

      <div className="composer">
        {(task.queued.length > 0 || unsent.length > 0) && (
          <div className="queued-msgs" aria-label="Queued messages">
            {unsent.map((entry) => (
              <UnsentNote key={entry.clientId} entry={entry} live={connected} />
            ))}
            {task.queued.map((message) => (
              <span key={message.id} className="q" title={message.text}>
                <span>Queued: {message.text}</span>
                <button aria-label="Remove queued message" onClick={() => sim.removeQueued(task.id, message.id)}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <textarea
            rows={1}
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
            <div className="segmented" role="radiogroup" aria-label="Delivery">
              <button className={mode === "queue" ? "on" : ""} onClick={() => setMode("queue")} title="Deliver after the current step">
                Queue
              </button>
              <button className={mode === "interrupt" ? "on" : ""} onClick={() => setMode("interrupt")} title="Stop the current step and deliver now">
                Interrupt
              </button>
            </div>
          )}
          <button className="btn primary" onClick={send} disabled={!text.trim()}>
            <Send size={14} />
          </button>
        </div>
        <div className="hint">
          {live
            ? mode === "queue"
              ? "Delivered when the agent finishes its current step. ↵ to send, ⇧↵ for a new line."
              : "Stops the current step and delivers right away."
            : "Delivered as soon as an agent starts on this task."}
        </div>
      </div>
    </div>
  );
}
