import { useCallback, useRef, useState } from "react";
import { ChartColumn, ChevronDown, Minus, Monitor, MonitorDot, Pause, Play, Plus } from "lucide-react";
import { onScreen, queueOf, screenMode, screenQueue, slotUses, type ScreenMode, type State, type Task } from "@petrina/core";
import { sim } from "../engine";
import { clockTime, screenMark, type Lookup } from "../lib";
import { useUsage } from "../usage";
import { RoleAvatar, useDismiss } from "./bits";
import { UsageList, usageNote } from "./Usage";
import type { SheetTab } from "./TaskCard";
import { Amount, toolColor } from "./Usage";

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

/** Who is in each slot in use: the task, and the agent in that slot (several reviewers at once each have one). */
function holdersOf(state: State, find: Lookup): { task: Task; roleId?: string; key: string }[] {
  return slotUses(state).flatMap((use, index) => {
    const task = find.task(use.taskId);
    return task ? [{ task, ...(use.roleId ? { roleId: use.roleId } : {}), key: `${use.taskId}:${use.profileId ?? index}` }] : [];
  });
}

const SCREEN_CHOICES: readonly { mode: ScreenMode; label: string }[] = [
  { mode: "off", label: "Off" },
  { mode: "hour", label: "For an hour" },
  { mode: "on", label: "On" },
];

/** "Agents may use the screen": Off, For an hour or On, what that means, and who is on the screen now. */
function ScreenUse({ state, find }: { state: State; find: Lookup }) {
  const mode = screenMode(state.pool, state.now);
  const holder = onScreen(state.tasks);
  const waiting = screenQueue(state.tasks).length;
  const role = find.role(holder?.screen?.roleId);
  const note =
    mode === "off"
      ? "Agents work in the background. One that needs the screen asks first, and its task waits until you allow it."
      : `${mode === "hour" ? `On until ${clockTime(state.pool.screen?.until ?? state.now)}. ` : ""}Agents may run apps on your screen when they need to, one at a time, and close what they open.`;
  return (
    <div className="screen-use">
      <h4 id="screen-use-title">Agents may use the screen</h4>
      <div className="segmented" role="radiogroup" aria-labelledby="screen-use-title">
        {SCREEN_CHOICES.map((choice) => (
          <button key={choice.mode} role="radio" aria-checked={mode === choice.mode} className={mode === choice.mode ? "on" : ""} onClick={() => sim.setScreenUse(choice.mode)}>
            {choice.label}
          </button>
        ))}
      </div>
      <p className="screen-note">{note}</p>
      {holder && (
        <p className="screen-note">
          On the screen now: <span className="screen-who">{holder.title}</span> · {role?.name ?? "Agent"}
        </p>
      )}
      {waiting > 0 && (
        <p className="screen-note num">
          {waiting} task{waiting === 1 ? "" : "s"} waiting for the screen
        </p>
      )}
    </div>
  );
}

/** The top bar's sign that screen use is on, or that an agent is on the screen. Its words go in the button's label. */
export function ScreenMarkIcon({ state }: { state: State }) {
  const mark = screenMark(state);
  if (!mark) return null;
  const Icon = mark.inUse ? MonitorDot : Monitor;
  return <Icon size={16} className={`screen-mark ${mark.inUse ? "in-use" : ""}`} aria-hidden="true" />;
}

/** The pool's controls, who is in each slot, and today's numbers: in the pool popover, or in the top bar's More menu. */
export function PoolPanel({ state, find, onOpen, onDone, onAnalytics }: { state: State; find: Lookup; onOpen: (taskId: string, tab?: SheetTab) => void; onDone: () => void; onAnalytics: () => void }) {
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
      <h4>Usage</h4>
      <UsageList state={state} />
      <div className="divider" />
      <div className="slot-list">
        {slots.map((holder, index) => {
          if (!holder)
            return (
              <div key={`free-${index}`} className="slot-row free">
                Free slot{next ? ` · next up: ${next.title}` : ""}
              </div>
            );
          const { task } = holder;
          const role = find.role(holder.roleId ?? task.agent?.roleId);
          return (
            <button
              key={holder.key}
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
      <div className="divider" />
      <ScreenUse state={state} find={find} />
      <div className="divider" />
      <Today
        state={state}
        onAnalytics={() => {
          onDone();
          onAnalytics();
        }}
      />
    </>
  );
}

/** The pool indicator in the top bar: one square per slot, coloured by the role in it. */
export function PoolButton({ state, find, onOpen, onAnalytics, compact }: { state: State; find: Lookup; onOpen: (taskId: string, tab?: SheetTab) => void; onAnalytics: () => void; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close);
  const holders = holdersOf(state, find);
  const slots = Array.from({ length: Math.max(state.pool.limit, holders.length) }, (_, index) => holders[index]);
  const usage = usageNote(state);
  const mark = screenMark(state);

  return (
    <div style={{ position: "relative" }} ref={box}>
      <button
        className="btn quiet"
        onClick={() => setOpen((on) => !on)}
        aria-expanded={open}
        aria-label={`Agents at work: ${holders.length} of ${state.pool.limit}${state.pool.paused ? ", pool paused" : ""}${usage ? `. ${usage}` : ""}${mark ? `. ${mark.label}` : ""}`}
        title={[usage ?? "Agents running at once", mark?.label].filter(Boolean).join(". ")}
      >
        <ScreenMarkIcon state={state} />
        {state.pool.paused ? <Pause size={14} aria-hidden="true" /> : null}
        {!compact && (
          <span className="slots" aria-hidden="true">
            {slots.map((holder, index) => {
              const role = find.role(holder?.roleId ?? holder?.task.agent?.roleId);
              const waiting = holder?.task.state === "needs-you";
              return <span key={index} className={`slot ${holder ? (waiting ? "waiting" : `used tone-${role?.tone ?? "slate"}`) : ""}`} />;
            })}
          </span>
        )}
        <span className="num" style={{ color: "var(--text)" }}>
          {holders.length}/{state.pool.limit}
        </span>
        {usage && <span className="usage-dot" aria-hidden="true" />}
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="popover">
          <PoolPanel state={state} find={find} onOpen={onOpen} onDone={close} onAnalytics={onAnalytics} />
        </div>
      )}
    </div>
  );
}

/** Today's tokens and agent time, since local midnight across all products, per tool with its nearest limit. */
function Today({ state, onAnalytics }: { state: State; onAnalytics: () => void }) {
  const today = useUsage({ view: "today" }, state);
  return (
    <div className="pool-today">
      <div className="row between">
        <strong>Today</strong>
        <button className="linkish row" style={{ gap: 4 }} onClick={onAnalytics}>
          <ChartColumn size={12} />
          Analytics
        </button>
      </div>
      {!today ? null : (
        <>
          {today.turns === 0 ? (
            <p>{today.atLeast ? "Not reported today." : "Nothing used yet today."}</p>
          ) : (
            <div className="usage-total">
              <Amount tokens={today.tokens} time={today.time} />
              <span className="muted"> agent time</span>
            </div>
          )}
          {today.byTool
            .filter((tool) => tool.turns > 0)
            .map((tool) => {
              return (
                <div key={tool.toolId} className="pool-tool">
                  <i style={{ background: toolColor(tool.toolId) }} />
                  <span className="t">{tool.label}</span>
                  <span className="small">{tool.turns > 0 ? <Amount tokens={tool.tokens} time={tool.time} /> : <span className="muted">nothing yet</span>}</span>

                </div>
              );
            })}
        </>
      )}
      <p className="small">Agent time adds up agents running at once.</p>
    </div>
  );
}
