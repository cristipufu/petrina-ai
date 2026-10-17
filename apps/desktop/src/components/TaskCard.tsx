import { useCallback, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUpToLine, Ban, Clock3, Ellipsis, GripVertical, Hand, MessageSquare, Pause, PanelRightOpen, Play, SquareTerminal } from "lucide-react";
import type { State, Task } from "@petrina/core";
import { sim } from "../engine";
import { deliveryText, duration, STATE_LABEL, type Lookup } from "../lib";
import { Pipeline, ProductName, ProfileText, RoleAvatar, useDismiss } from "./bits";

export interface CardProps {
  task: Task;
  state: State;
  find: Lookup;
  selected: boolean;
  /** Index in the whole queue, for queued cards. */
  queuePosition?: number;
  queueLength?: number;
  /** One of the cards that start as soon as a slot frees. */
  startsNext?: boolean;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  onDragStart?: (event: DragEvent, taskId: string) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
  drop?: "before" | "after";
}

export type SheetTab = "overview" | "plan" | "design" | "review" | "session";

/**
 * The state a card names next to its product. Working cards say it through their status line,
 * and cards that need the coordinator through their section and amber edge.
 */
function flagOf(task: Task): { text: string; tone: string } | undefined {
  if (task.state === "queued") return task.held ? { text: "On hold", tone: "" } : undefined;
  if (task.state === "running" || task.state === "needs-you") return undefined;
  return { text: STATE_LABEL[task.state], tone: task.state === "pr-open" ? "" : task.state };
}

export function TaskCard({ task, state, find, selected, queuePosition, queueLength = 0, startsNext, onOpen, onDragStart, onDragEnd, dragging, drop }: CardProps) {
  const [menu, setMenu] = useState(false);
  const menuBox = useRef<HTMLSpanElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  useDismiss(menuBox, menu, closeMenu);

  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const queued = task.state === "queued";
  // A queued task that starts after others says what it waits for until they land.
  const waitsOnOthers = queued && (task.after ?? []).some((id) => {
    const other = find.task(id);
    return other !== undefined && other.state !== "done" && other.state !== "cancelled";
  });
  const finished = task.state === "done" || task.state === "cancelled";
  const rounds = task.plan?.stages.reduce((max, stage) => Math.max(max, task.rounds[stage.id] ?? 1), 1) ?? 1;
  const canPause = task.state === "running" || task.state === "needs-you" || task.state === "waiting";
  const flag = flagOf(task);
  const delivery = deliveryText(task);
  const showAgent = role && profile && (task.state === "running" || task.state === "needs-you" || task.state === "paused");

  const classes = ["card", task.state];
  if (task.held) classes.push("held");
  if (selected) classes.push("selected");
  if (dragging) classes.push("dragging");
  if (drop) classes.push(`drop-${drop}`);

  // ⌥↑ and ⌥↓ move a queued card, like dragging it.
  const onKey = (event: KeyboardEvent) => {
    if (!queued || queuePosition === undefined || !event.altKey) return;
    if (event.key === "ArrowUp" && queuePosition > 0) {
      event.preventDefault();
      sim.moveInQueue(task.id, queuePosition - 1);
    } else if (event.key === "ArrowDown" && queuePosition < queueLength - 1) {
      event.preventDefault();
      sim.moveInQueue(task.id, queuePosition + 1);
    }
  };

  const act = (action: () => void) => () => {
    setMenu(false);
    action();
  };

  return (
    <article className={classes.join(" ")} data-task-id={task.id} draggable={queued} onDragStart={(event) => onDragStart?.(event, task.id)} onDragEnd={onDragEnd} aria-label={task.title}>
      <div className="card-meta">
        <span className="where">
          {queued && <GripVertical size={14} className="grip" aria-hidden="true" />}
          <ProductName product={find.product(task.productId)} />
          {queued && queuePosition !== undefined && <span className="num">#{queuePosition + 1} in queue</span>}
          {startsNext && <span className="next-up">Starts next</span>}
        </span>
        {flag && (
          <span className={`flag ${flag.tone}`}>
            {task.state === "paused" && <Pause size={12} strokeWidth={2.4} aria-hidden="true" />}
            {flag.text}
          </span>
        )}
      </div>

      <h3 className="card-title">
        <button className="card-open" onClick={() => onOpen(task.id)} onKeyDown={onKey} aria-describedby={`status-${task.id}`}>
          {task.title}
        </button>
      </h3>

      {queued && !waitsOnOthers ? (
        task.description && (
          <p className="card-desc" id={`status-${task.id}`}>
            {task.description}
          </p>
        )
      ) : (
        <p className="card-status" id={`status-${task.id}`}>
          <span className={`dot ${task.state}`} aria-hidden="true" />
          <span>{task.statusLine}</span>
        </p>
      )}

      {!queued && !finished && <Pipeline task={task} onActivate={() => onOpen(task.id)} />}

      <div className="card-foot">
        <div className="card-info">
          {showAgent && (
            <span className="agent">
              <RoleAvatar role={role} size={16} />
              {role.name}
            </span>
          )}
          {showAgent && <ProfileText profile={profile} find={find} />}
          {task.startedAt !== undefined && !queued && !finished && (
            <span className="num" title="Time since the work started">
              <Clock3 size={12} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
              {duration(task.startedAt, state.now)}
            </span>
          )}
          {rounds > 1 && !finished && <span className="num">Round {rounds}</span>}
          {task.queued.length > 0 && (
            <span className="num">
              {task.queued.length} message{task.queued.length === 1 ? "" : "s"} queued
            </span>
          )}
          {delivery && <span className={`delivery ${delivery.done ? "done" : ""}`}>{delivery.text}</span>}
        </div>

        <div className="card-actions">
          {queued && queuePosition !== undefined && queuePosition > 0 && (
            <button aria-label="Move to top" title="Move to top" onClick={() => sim.moveToTop(task.id)}>
              <ArrowUpToLine size={16} />
            </button>
          )}
          <button aria-label="Message" title="Message" onClick={() => onOpen(task.id, "session")}>
            <MessageSquare size={16} />
          </button>
          {canPause && (
            <button aria-label="Pause" title="Pause" onClick={() => sim.pause(task.id)}>
              <Pause size={16} />
            </button>
          )}
          {task.state === "paused" && (
            <button aria-label="Resume" title="Resume" onClick={() => sim.resume(task.id)}>
              <Play size={16} />
            </button>
          )}
          <span ref={menuBox} style={{ position: "relative" }}>
            <button aria-label="More" title="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
              <Ellipsis size={16} />
            </button>
            {menu && (
              <div className="menu" role="menu" style={{ right: 0, top: "calc(100% + 4px)" }}>
                <button role="menuitem" autoFocus onClick={act(() => onOpen(task.id))}>
                  <PanelRightOpen size={16} />
                  Open details
                </button>
                {task.agent && (
                  <button role="menuitem" onClick={act(() => onOpen(task.id, "session"))}>
                    <SquareTerminal size={16} />
                    Join the session
                  </button>
                )}
                {queued && (
                  <button role="menuitem" onClick={act(() => sim.setHeld(task.id, !task.held))}>
                    <Hand size={16} />
                    {task.held ? "Release the hold" : "Hold (don't start yet)"}
                  </button>
                )}
                {!finished && (
                  <button role="menuitem" className="danger" onClick={act(() => sim.cancel(task.id))}>
                    <Ban size={16} />
                    Cancel task
                  </button>
                )}
              </div>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}
