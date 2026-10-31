import { messageDeliveryText, messageRemovalText, type QueuedMessage } from "@petrina/core";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { ArrowRight, ChevronDown, Send, ShieldCheck, ShieldOff, User } from "lucide-react";
import type { ActiveAgent, Id, MessageMode, ReportImage, SessionLine, State, Task } from "@petrina/core";
import { sim, useEngineStatus, useUnsent } from "../engine";
import { ago, profileText, type Lookup } from "../lib";
import { RoleAvatar } from "./bits";
import { UnsentMessage } from "./EngineState";
import { Ask } from "./Inbox";
import { ImagePreview } from "./MessageBody";
import { PublicMessageBody } from "./PublicMessageBody";
import type { SheetTab } from "./TaskCard";
import type { TaskDrafts } from "../drafts";

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

function messageProduct(id: Id, find: Lookup, repositories?: Task["repositories"]): string {
  return find.product(id)?.name ?? repositories?.find((work) => work.productId === id)?.source?.product.name ?? id;
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

/** Collapsing releases the rows and their icons, rather than only hiding a long list. */
function ActivityGroup({ lines, className = "", reveal = false, children }: {
  lines: SessionLine[];
  className?: string;
  reveal?: boolean;
  children: (line: SessionLine) => ReactNode
}) {
  const [expanded, setExpanded] = useState(reveal);
  return <details className={`step-activity ${className}`} open={expanded} data-line={lines[0]!.id} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{lines.length} agent action{lines.length === 1 ? "" : "s"}</summary>
    {expanded && <ul className="activity" aria-label="What the agent did">{lines.map(children)}</ul>}
  </details>;
}

function when(at: number, now: number): string {
  const value = ago(at, now);
  return value === "now" ? "just now" : `${value} ago`;
}

function ReportPicture({ taskId, image, finished }: { taskId: string; image: ReportImage; finished: boolean }) {
  return <span className="message-images"><ImagePreview taskId={taskId} imageId={image.id} label={image.caption} finished={finished} /></span>;
}

/** Only this run's saved conversation, read in place without changing the task's Session tab. */
export function StepConversation({ lines, find, now, live = false, taskId, repositories = find.task(taskId)?.repositories, finished = false }: {
  lines: readonly SessionLine[];
  find: Lookup;
  now: number;
  live?: boolean;
  taskId: string;
  repositories?: Task["repositories"];
  finished?: boolean
}) {
  const section = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const textSize = useMemo(() => lines.reduce((size, line) => size + line.text.length, 0), [lines]);
  const groups = useMemo(() => groupLines(lines), [lines]);
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
      {groups.map((group) => Array.isArray(group) ? (
        <ActivityGroup
          key={group[0]!.id}
          lines={group}
        >{(line) => <li key={line.id}><ArrowRight
          size={12}
          aria-hidden="true"
        /><span>{line.productId && `${messageProduct(
          line.productId,
          find,
          repositories
        )}: `}{line.text}</span></li>}</ActivityGroup>
      ) : group.from === "system" ? (
        <p key={group.id} className="system">{group.text} · {when(group.at, now)}</p>
      ) : (
        <div key={group.id} className={`msg ${group.from === "you" ? "you" : "agent"}`}>
          {group.from === "you" ? <span
            className="avatar tone-slate"
            style={{
            width: 28,
            height: 28
          }}
            aria-hidden="true"
          ><User size={16} /></span> : <RoleAvatar
            role={find.role(group.roleId)}
            size={28}
          />}
          <div style={{ minWidth: 0 }}><div className="name">{group.from === "you" ? "You" : find.role(group.roleId)?.name ?? "Agent"}{group.productId && <> · {messageProduct(
            group.productId,
            find,
            repositories
          )}</>}<time>{when(
            group.at,
            now
          )}</time>{group.coordinatorMessageId && <DeliveryStatus
            message={find.task(taskId)?.queued.find(message => message.id === group.coordinatorMessageId)}
            taskId={taskId}
          />}</div><div className="bubble"><PublicMessageBody
            line={group}
            taskId={taskId}
            finished={finished}
            onRead={() => {
              pinned.current = false;
            }}
          /></div>{group.images?.map((image) => <ReportPicture
            key={image.id}
            taskId={taskId}
            image={image}
            finished={finished}
          />)}</div>
        </div>
      ))}
      {live && find.task(taskId)?.queued.filter(message => !lines.some(line => line.coordinatorMessageId === message.id)).map(message => <div
        key={message.id}
        className="msg you queued"
        data-queued
      ><span
        className="avatar tone-slate"
        style={{
        width: 28,
        height: 28
      }}
        aria-hidden="true"
      ><User size={16} /></span><div style={{ minWidth: 0 }}><div className="name">You <DeliveryStatus
        message={message}
        taskId={taskId}
      /></div><div className="bubble">{message.text}</div></div></div>)}
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
  const live = task.state === "running" && !task.driving;
  // "You're driving" has its own controls in the footer.
  const asks = state.inbox.filter((item) => item.taskId === task.id && item.kind !== "driving");
  // Answers to something still waiting show with it below; the rest show here, in the conversation.
  const unsent = useUnsent().filter((entry) => entry.taskId === task.id && !(entry.itemId && asks.some((item) => item.id === entry.itemId)));
  const connected = useEngineStatus().link === "live";
  // A refusal adds its reason and actions under the message.
  const refused = unsent.filter((entry) => entry.refused).length;
  // Streaming can grow an earlier bubble while another agent's activity is the last line.
  const textSize = useMemo(() => task.session.reduce((size, line) => size + line.text.length, 0), [task.session]);
  const groups = useMemo(() => groupLines(task.session), [task.session]);
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
  }, [scroller, task.id]);

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
            {you ? "You" : (lineRole?.name ?? "Agent")}{line.productId && <> · {messageProduct(line.productId, find, task.repositories)}</>}
            <time className="num">{when(line.at, state.now)}</time>
            {line.coordinatorMessageId && <DeliveryStatus message={task.queued.find(message => message.id === line.coordinatorMessageId)} taskId={task.id} />}
          </div>
          <div className="bubble"><PublicMessageBody
            line={line}
            taskId={task.id}
            finished={task.state === "done" || task.state === "cancelled"}
            active={active}
            onRead={() => {
              pinned.current = false;
            }}
          /></div>
          {line.images?.map((image) => <ReportPicture
            key={image.id}
            taskId={task.id}
            image={image}
            finished={task.state === "done" || task.state === "cancelled"}
          />)}
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
        {groups.map((group) => {
          if (Array.isArray(group))
            return (
              <ActivityGroup
                key={group[0]!.id}
                lines={group}
                className={`session-activity ${group.some((line) => inStep(line)) ? "in-step" : ""}`}
                reveal={group.some((line) => Boolean(inStep(line)))}
              >
                {(line) => (
                  <li key={line.id} data-line={line.id} className={inStep(line)}>
                    <ArrowRight size={12} aria-hidden="true" />
                    {stepStart(line)}
                    <span>{line.productId && `${messageProduct(line.productId, find, task.repositories)}: `}{line.text}</span>
                  </li>
                )}
              </ActivityGroup>
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
        {task.queued.filter(message => !task.session.some(line => line.coordinatorMessageId === message.id)).map(message => (
          <div key={message.id} className="msg you queued" data-queued>
            <span className="avatar tone-violet" style={{ width: 28, height: 28 }} aria-hidden="true"><User size={16} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="name">You <DeliveryStatus message={message} taskId={task.id} /></div>
              <div className="bubble" id={`queued-${message.id}`}>{message.text}</div>
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

function DeliveryStatus({ message, taskId }: { message?: QueuedMessage; taskId: Id }) {
  const kept = message ? messageRemovalText(message) : undefined;
  return <><span
    className="queued-note"
    role="status"
  >{message ? messageDeliveryText(message) : "Heard"}</span>{message && <button
    className="btn ghost small"
    disabled={kept !== undefined}
    title={kept}
    onClick={() => sim.removeQueued(
    taskId,
    message.id
  )}
  >Remove</button>}</>;
}

/** Guidance can join active work, wait, or explicitly stop it first. */
function Composer({ task, find, drafts, focusRequest, onFocused }: {
  task: Task;
  find: Lookup;
  drafts: TaskDrafts;
  focusRequest: boolean;
  onFocused: () => void
}) {
  const text = useSyncExternalStore(drafts.subscribe, () => drafts.get(task.id));
  const onText = (value: string) => drafts.set(task.id, value);
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (focusRequest) setExpanded(true);
  }, [focusRequest]);
  useEffect(() => {
    if (focusRequest && expanded) {
      textarea.current?.focus();
      onFocused();
    }
  }, [focusRequest, expanded, onFocused]);
  const [mode, setMode] = useState<MessageMode>("now");
  const role = find.role(task.agent?.roleId ?? task.driving?.roleId ?? task.conversation?.roleId);
  const live = task.state === "running" && !task.driving;
  const tool = find.profile(task.agent?.profileId ?? task.conversation?.profileId)?.toolId;
  const recipient = (task.helpers?.length ?? 0) > 1 ? "all agents in this step" : `the ${role?.name.toLowerCase() ?? "agent"}`;

  const send = () => {
    if (!text.trim()) return;
    sim.sendMessage(task.id, text, live ? mode : "now");
    onText("");
  };

  return (
    <div className="composer">
      <button
        type="button"
        className="composer-toggle"
        id={`${id}-title`}
        aria-expanded={expanded}
        aria-controls={`${id}-body`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{live || task.driving || task.conversation ? `Message ${recipient}` : "Message the next agent"}</span>
        {!expanded && text.trim() && <span className="composer-draft">Draft</span>}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <form hidden={!expanded} className="composer-body" id={`${id}-body`} onSubmit={(event) => {
        event.preventDefault();
        send();
      }}>
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
            <button
              type="button"
              role="radio"
              aria-checked={mode === "now"}
              className={mode === "now" ? "on" : ""}
              onClick={() => setMode("now")}
              title="Try to reach the working agent now"
            >Send now</button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "queue"}
              className={mode === "queue" ? "on" : ""}
              onClick={() => setMode("queue")}
              title="Deliver after the current step"
            >
              Wait
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "interrupt"}
              className={mode === "interrupt" ? "on" : ""}
              onClick={() => setMode("interrupt")}
              title="Stop the current step and deliver now"
            >
              Stop and send
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
            ? "Waits until the current turn finishes. Enter sends, Shift+Enter starts a new line."
            : mode === "interrupt" ? "Stops the current turn, then sends your message."
            : tool === "antigravity" ? "Antigravity cannot take live guidance. Your message waits until the turn finishes."
            : "Tries to reach every agent still working in this step. Enter sends, Shift+Enter starts a new line."
          : task.driving
            ? "You're driving in your terminal. Delivered when you hand back."
            : "Delivered as soon as an agent starts on this task."}
      </p>
      </form>
    </div>
  );
}

export const Session = { Log, Composer };
