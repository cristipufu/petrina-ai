import { useEffect, useRef, useState } from "react";
import { ChevronDown, Minus, Pause, Play, Plus } from "lucide-react";
import { queueOf, slotUses, type State } from "@petrina/core";
import { sim } from "../engine";
import { type Lookup } from "../lib";
import { RoleAvatar } from "./bits";
import type { SheetTab } from "./TaskCard";

export function LimitStepper({ limit }: { limit: number }) {
  return (
    <span className="stepper-input">
      <button aria-label="One fewer agent" onClick={() => sim.setPoolLimit(limit - 1)} disabled={limit <= 1}>
        <Minus size={14} />
      </button>
      <span>{limit}</span>
      <button aria-label="One more agent" onClick={() => sim.setPoolLimit(limit + 1)} disabled={limit >= 12}>
        <Plus size={14} />
      </button>
    </span>
  );
}

/** The pool indicator in the top bar: one square per slot, coloured by the role in it. */
export function PoolButton({ state, find, onOpen }: { state: State; find: Lookup; onOpen: (taskId: string, tab?: SheetTab) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const uses = slotUses(state);
  const holders = uses.map((use) => find.task(use.taskId)).filter((task) => task !== undefined);
  const next = queueOf(state.tasks).find((task) => !task.held);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const slots = Array.from({ length: Math.max(state.pool.limit, holders.length) }, (_, index) => holders[index]);

  return (
    <div style={{ position: "relative" }} ref={box}>
      <button className="btn pool-button" onClick={() => setOpen((on) => !on)} aria-expanded={open} title="Agents running at once">
        {state.pool.paused ? <Pause size={13} /> : null}
        <span className="slots">
          {slots.map((task, index) => {
            const role = find.role(task?.agent?.roleId);
            const waiting = task?.state === "needs-you";
            return <span key={index} className={`slot ${task ? (waiting ? "waiting" : `used tone-${role?.tone ?? "slate"}`) : ""}`} />;
          })}
        </span>
        <span className="num">
          {holders.length}/{state.pool.limit}
        </span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="popover">
          <h4>Agents at work</h4>
          <p>How many agents may run at the same time. Lowering it never stops anyone mid-stage.</p>
          <div className="row between">
            <LimitStepper limit={state.pool.limit} />
            <button className="btn small" onClick={() => sim.setPoolPaused(!state.pool.paused)}>
              {state.pool.paused ? <Play size={13} /> : <Pause size={13} />}
              {state.pool.paused ? "Resume pool" : "Pause pool"}
            </button>
          </div>
          <div className="row" style={{ marginTop: 10, color: "var(--text-3)", fontSize: 12 }}>
            Caps per tool:
            {Object.entries(state.pool.toolCaps).map(([toolId, cap]) => (
              <span key={toolId} className="chip">
                {find.tool(toolId)?.name ?? toolId} ≤ {cap}
              </span>
            ))}
          </div>
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
                <div
                  key={task.id}
                  className="slot-row"
                  onClick={() => {
                    setOpen(false);
                    onOpen(task.id, "session");
                  }}
                >
                  <RoleAvatar role={role} size={20} />
                  <span className="t">{task.title}</span>
                  {task.state === "needs-you" ? <span className="pill needs-you">waiting on you</span> : <span className="pill running">{role?.name}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
