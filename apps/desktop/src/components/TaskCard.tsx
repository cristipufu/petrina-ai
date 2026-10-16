import { ArrowUpToLine, GitPullRequest, GripVertical, MessageSquare, Pause, Play, SquareTerminal } from "lucide-react";
import type { DragEvent } from "react";
import type { State, Task } from "@petrina/core";
import { sim } from "../engine";
import { duration, type Lookup } from "../lib";
import { Phases, ProductChip, ProfileChip, RoleAvatar } from "./bits";

export interface CardProps {
  task: Task;
  state: State;
  find: Lookup;
  selected: boolean;
  queuePosition?: number;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  onDragStart?: (event: DragEvent, taskId: string) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}

export type SheetTab = "overview" | "plan" | "design" | "review" | "session";

export function TaskCard({ task, state, find, selected, queuePosition, onOpen, onDragStart, onDragEnd, dragging }: CardProps) {
  const role = find.role(task.agent?.roleId);
  const profile = find.profile(task.agent?.profileId);
  const queued = task.state === "queued";
  const rounds = task.plan?.stages.reduce((max, stage) => Math.max(max, task.rounds[stage.id] ?? 1), 1) ?? 1;
  const canPause = task.state === "running" || task.state === "needs-you" || task.state === "waiting";

  const classes = ["card", task.state];
  if (task.held) classes.push("held");
  if (selected) classes.push("selected");
  if (dragging) classes.push("dragging");

  return (
    <div
      className={classes.join(" ")}
      draggable={queued}
      onDragStart={(event) => onDragStart?.(event, task.id)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(task.id);
      }}
      role="button"
      tabIndex={0}
      aria-label={task.title}
    >
      <div className="card-top">
        {queued && <GripVertical size={14} className="grip" aria-hidden="true" />}
        {queued && queuePosition !== undefined && <span className="prio">#{queuePosition + 1}</span>}
        {task.state === "needs-you" && <span className="pill needs-you">Needs you</span>}
        {task.held && <span className="pill">On hold</span>}
        {task.state === "paused" && <span className="pill">Paused</span>}
        {task.state === "waiting" && <span className="pill">Waiting for a slot</span>}
        <span className="product">
          <ProductChip product={find.product(task.productId)} />
        </span>
      </div>
      <div className="card-title">{task.title}</div>

      {!queued && <Phases task={task} />}

      {role && profile && (task.state === "running" || task.state === "needs-you") && (
        <div className="card-agent">
          <RoleAvatar role={role} size={20} />
          <span className="role-name">{role.name}</span>
          <ProfileChip profile={profile} find={find} showTool={false} />
        </div>
      )}

      {!queued && (
        <div className="status-line">
          <span className={`dot ${task.state}`} />
          <span>{task.statusLine}</span>
        </div>
      )}

      {queued && task.description && <div className="status-line">{task.description}</div>}

      <div className="card-foot">
        {task.startedAt !== undefined && task.state !== "queued" && <span className="num">{duration(task.startedAt, state.now)}</span>}
        {rounds > 1 && (
          <>
            <span className="sep">·</span>
            <span>round {rounds}</span>
          </>
        )}
        {task.queued.length > 0 && (
          <>
            <span className="sep">·</span>
            <span>{task.queued.length} queued message{task.queued.length === 1 ? "" : "s"}</span>
          </>
        )}
        <span className="right">
          {task.pr && (
            <span className={`pill ${task.pr.state === "merged" ? "done" : "pr-open"}`}>
              <GitPullRequest size={11} />#{task.pr.number}
            </span>
          )}
        </span>
      </div>

      <div className="card-actions" onClick={(event) => event.stopPropagation()}>
        {queued && queuePosition !== 0 && (
          <button title="Move to top" onClick={() => sim.moveToTop(task.id)}>
            <ArrowUpToLine size={14} />
          </button>
        )}
        <button title="Message" onClick={() => onOpen(task.id, "session")}>
          <MessageSquare size={14} />
        </button>
        {task.agent && task.state !== "paused" && (
          <button title="Join session" onClick={() => onOpen(task.id, "session")}>
            <SquareTerminal size={14} />
          </button>
        )}
        {canPause && (
          <button title="Pause" onClick={() => sim.pause(task.id)}>
            <Pause size={14} />
          </button>
        )}
        {task.state === "paused" && (
          <button title="Resume" onClick={() => sim.resume(task.id)}>
            <Play size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
