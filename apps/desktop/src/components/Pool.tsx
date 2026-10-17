import { useCallback, useRef, useState } from "react";
import { ChevronDown, Minus, Pause, Play, Plus } from "lucide-react";
import { queueOf, slotUses, type State, type Task } from "@petrina/core";
import { sim } from "../engine";
import { type Lookup } from "../lib";
import { RoleAvatar, useDismiss } from "./bits";
import type { SheetTab } from "./TaskCard";

export function LimitStepper({ limit }: { limit: number }) {
  return (
    <span className="stepper-input" role="group" aria-label="Agents at once">
      <button aria-label="One fewer agent" onClick={() => sim.setPoolLimit(limit - 1)} disabled={limit <= 1}>
        <Minus size={16} />
      </button>
      <span aria-live="polite">{limit}</span>
      <button aria-label="One more agent" onClick={() => sim.setPoolLimit(limit + 1)} disabled={limit >= 12}>
        <Plus size={16} />
      </button>
    </span>
  );
}

function holdersOf(state: State, find: Lookup): Task[] {
  return slotUses(state)
    .map((use) => find.task(use.taskId))
    .filter((task) => task !== undefined);
}

/** The pool's controls and who is in each slot: in the pool popover, or in the top bar's More menu. */
export function PoolPanel({ state, find, onOpen, onDone }: { state: State; find: Lookup; onOpen: (taskId: string, tab?: SheetTab) => void; onDone: () => void }) {
  const holders = holdersOf(state, find);
  const next = queueOf(state.tasks).find((task) => !task.held);
  const slots = Array.from({ length: Math.max(state.pool.limit, holders.length) }, (_, index) => holders[index]);
  return (
    <>
      <h4>Agents at work</h4>
      <p>How many agents may run at the same time. Lowering it never stops anyone mid-stage.</p>
      <div className="row between wrap">
        <LimitStepper limit={state.pool.limit} />
        <button className="btn" onClick={() => sim.setPoolPaused(!state.pool.paused)}>
          {state.pool.paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
          {state.pool.paused ? "Resume the pool" : "Pause the pool"}
        </button>
      </div>
      <p className="caps num">
        Most at once per tool:{" "}
        {Object.entries(state.pool.toolCaps)
          .map(([toolId, cap]) => `${find.tool(toolId)?.name ?? toolId} ${cap}`)
          .join(", ")}
      </p>
      <div className="divider" />
      <div className="slot-list">
        {slots.map((task, index) => {
          if (!task)
            return (
              <div key={`free-${index}`} className="slot-row free">
                Free slot{next ? ` · next up: ${next.title}` : ""}
              </div>
            );
          const role = find.role(task.agent?.roleId);
          return (
            <button
              key={task.id}
              className="slot-row"
              onClick={() => {
                onDone();
                onOpen(task.id, "session");
              }}
            >
              <RoleAvatar role={role} size={20} />
              <span className="t">{task.title}</span>
              {task.driving ? <span className="s needs-you">You're driving</span> : task.state === "needs-you" ? <span className="s needs-you">Waiting on you</span> : <span className="s">{role?.name}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** The pool indicator in the top bar: one square per slot, coloured by the role in it. */
export function PoolButton({ state, find, onOpen, compact }: { state: State; find: Lookup; onOpen: (taskId: string, tab?: SheetTab) => void; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close);
  const holders = holdersOf(state, find);
  const slots = Array.from({ length: Math.max(state.pool.limit, holders.length) }, (_, index) => holders[index]);

  return (
    <div style={{ position: "relative" }} ref={box}>
      <button
        className="btn quiet"
        onClick={() => setOpen((on) => !on)}
        aria-expanded={open}
        aria-label={`Agents at work: ${holders.length} of ${state.pool.limit}${state.pool.paused ? ", pool paused" : ""}`}
        title="Agents running at once"
      >
        {state.pool.paused ? <Pause size={14} aria-hidden="true" /> : null}
        {!compact && (
          <span className="slots" aria-hidden="true">
            {slots.map((task, index) => {
              const role = find.role(task?.agent?.roleId);
              const waiting = task?.state === "needs-you";
              return <span key={index} className={`slot ${task ? (waiting ? "waiting" : `used tone-${role?.tone ?? "slate"}`) : ""}`} />;
            })}
          </span>
        )}
        <span className="num" style={{ color: "var(--text)" }}>
          {holders.length}/{state.pool.limit}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="popover">
          <PoolPanel state={state} find={find} onOpen={onOpen} onDone={close} />
        </div>
      )}
    </div>
  );
}
