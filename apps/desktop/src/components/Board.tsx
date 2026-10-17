import { useState, type DragEvent } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Hand, Lightbulb, X } from "lucide-react";
import { boardSections, firstTaskTip, queueOf, startsNextCount, type State, type Task } from "@petrina/core";
import { sim } from "../engine";
import { alt, mod } from "../keyboard";
import { ago, deliveryText, STATE_LABEL, type Lookup } from "../lib";
import { ProductName } from "./bits";
import { TaskCard, type SheetTab } from "./TaskCard";

interface BoardProps {
  state: State;
  find: Lookup;
  visible: (task: Task) => boolean;
  selectedId: string | undefined;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  onFocus: (taskId?: string) => void;
  showDone: boolean;
  onShowDone: (show: boolean) => void;
  drafts: Readonly<Record<string, string>>;
  onPlace: (taskId: string, anchorId: string, side: "before" | "after") => void;
  onNewTask: () => void;
  onShowInbox: () => void;
  /** Only where products can be added (not in the demo). */
  onAddProduct?: () => void;
}

function finishedAgo(task: Task, now: number): string {
  if (task.finishedAt === undefined) return "";
  const when = ago(task.finishedAt, now);
  return when === "now" ? "just now" : `${when} ago`;
}

const SECTIONS = [
  { id: "needs-you", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "waiting", title: "Waiting" },
] as const;

/**
 * The board: one grid of task cards, ordered by what they need. Cards that need the coordinator
 * come first, then working ones, then waiting ones, then the queue in priority order (drag to
 * reorder), with finished work folded away at the end.
 */
export function Board({ state, find, visible, selectedId, onOpen, onFocus, showDone, onShowDone, drafts, onPlace, onNewTask, onShowInbox, onAddProduct }: BoardProps) {
  const [dragId, setDragId] = useState<string>();
  const [dropIndex, setDropIndex] = useState<number>();
  const sections = boardSections(state.tasks, visible);

  const queue = queueOf(state.tasks);
  // Whatever starts as soon as the next slot frees (at least one task).
  const nextUp = new Set(
    queue
      .filter((task) => !task.held)
      .slice(0, Math.max(1, startsNextCount(state)))
      .map((task) => task.id),
  );

  const onDragStart = (event: DragEvent, taskId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
    setDragId(taskId);
  };

  // The grid flows left to right, then down: the drop goes before the first card the pointer is
  // above, or left of on the same row.
  const onDragOverQueue = (event: DragEvent<HTMLDivElement>) => {
    if (!dragId) return;
    event.preventDefault();
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-queue-index]"));
    let index = visibleQueue.length ? queue.indexOf(visibleQueue.at(-1)!) + 1 : 0;
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      if (event.clientY < box.top || (event.clientY <= box.bottom && event.clientX < box.left + box.width / 2)) {
        index = Number(card.dataset.queueIndex);
        break;
      }
    }
    setDropIndex(index);
  };

  const endDrag = () => {
    setDragId(undefined);
    setDropIndex(undefined);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (dragId !== undefined && dropIndex !== undefined) {
      const anchor = queue[dropIndex];
      if (anchor && visibleQueue.some((task) => task.id === anchor.id)) onPlace(dragId, anchor.id, "before");
      else if (lastVisible) onPlace(dragId, lastVisible.id, "after");
    }
    endDrag();
  };

  const visibleQueue = sections.queue;
  const lastVisible = visibleQueue.at(-1);
  const nothing = Object.values(sections).every((list) => list.length === 0);

  return (
    <div className="board" tabIndex={-1} onMouseDown={(event) => { if (!(event.target as HTMLElement).closest("[data-task-id]")) onFocus(); }} onFocus={(event) => { if (!(event.target as HTMLElement).closest("[data-task-id]")) onFocus(); }}>
      <FirstTaskTip state={state} onShowInbox={onShowInbox} />
      {nothing &&
        (state.tasks.length === 0 ? (
          <div className="board-empty start">
            <p>{state.products.length ? "No tasks yet. Write the first one and the squad starts on it." : "No tasks yet. Add a product, then write a task for the squad."}</p>
            <div className="row" style={{ gap: 8 }}>
              {onAddProduct && (
                <button className={`btn ${state.products.length ? "" : "lead"}`} onClick={onAddProduct}>
                  Add a product
                </button>
              )}
              <button className={`btn ${state.products.length ? "lead" : ""}`} onClick={onNewTask} disabled={!state.products.length} title={state.products.length ? `New task (${mod}N)` : "Add a product first"}>
                New task
              </button>
            </div>
          </div>
        ) : (
          <div className="board-empty">No tasks match this product or search.</div>
        ))}

      {SECTIONS.map((section) =>
        sections[section.id].length === 0 ? null : (
          <section key={section.id} className="board-section" aria-labelledby={`section-${section.id}`}>
            <h2 className={`section-head ${section.id === "needs-you" ? "attention" : ""}`} id={`section-${section.id}`}>
              {section.id === "needs-you" && <Hand size={16} strokeWidth={2.2} aria-hidden="true" />}
              {section.title}
              <span className="n">{sections[section.id].length}</span>
            </h2>
            <div className="card-grid">
              {sections[section.id].map((task) => (
                <TaskCard key={task.id} task={task} state={state} find={find} selected={task.id === selectedId} hasDraft={Boolean(drafts[task.id])} onFocus={() => onFocus(task.id)} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ),
      )}

      {(visibleQueue.length > 0 || (queue.length === 0 && !nothing)) && (
        <section className="board-section" aria-labelledby="section-queue">
          <h2 className="section-head" id="section-queue">
            Queue
            <span className="n">{visibleQueue.length}</span>
            {visibleQueue.length > 1 && <span className="hint">Drag to reorder, or {alt}↑ and {alt}↓. The top starts first.</span>}
          </h2>
          {queue.length === 0 ? (
            <div className="board-empty">Nothing waiting. New task ({mod}N) adds one.</div>
          ) : (
            <div
              className="card-grid"
              onDragOver={onDragOverQueue}
              onDrop={onDrop}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropIndex(undefined);
              }}
            >
              {visibleQueue.map((task) => {
                const index = queue.indexOf(task);
                const drop = dragId && dragId !== task.id ? (dropIndex === index ? "before" : dropIndex === queue.indexOf(lastVisible!) + 1 && task === lastVisible ? "after" : undefined) : undefined;
                return (
                  <div key={task.id} data-queue-index={index}>
                    <TaskCard
                      task={task}
                      state={state}
                      find={find}
                      selected={task.id === selectedId} hasDraft={Boolean(drafts[task.id])} onFocus={() => onFocus(task.id)}
                      queuePosition={index}
                      startsNext={nextUp.has(task.id)}
                      onOpen={onOpen}
                      onDragStart={onDragStart}
                      onDragEnd={endDrag}
                      dragging={dragId === task.id}
                      {...(drop ? { drop } : {})}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {sections.done.length > 0 && (
        <section className="board-section" aria-label="Done">
          <button className="fold" onClick={() => onShowDone(!showDone)} aria-expanded={showDone}>
            {showDone ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            Done
            <span className="n num">{sections.done.length}</span>
          </button>
          {showDone && (
            <div className="done-list">
              {sections.done.map((task) => {
                const delivery = deliveryText(task);
                return (
                  <button key={task.id} className={`done-row ${task.state} ${task.id === selectedId ? "selected" : ""}`} data-task-id={task.id} onFocus={() => onFocus(task.id)} onClick={() => onOpen(task.id)}>
                    <span className="title">{task.title}</span>
                    <span className="when num">{finishedAgo(task, state.now)}</span>
                    <span className="sub">
                      <ProductName product={find.product(task.productId)} />
                      <span>{delivery?.text ?? STATE_LABEL[task.state]}</span>
                      {/* Worded, and away from the product's dot, so the two never read alike. */}
                      {drafts[task.id] && <span className="draft-note"><span className="draft-mark" aria-hidden="true" />Unsent message</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Once, after first run: what happens next with the first task, as it is now. Dismissed, it never comes back. */
function FirstTaskTip({ state, onShowInbox }: { state: State; onShowInbox: () => void }) {
  const tip = firstTaskTip(state);
  if (!tip) return null;
  return (
    <aside className="tip" aria-label="What happens next">
      <Lightbulb size={20} aria-hidden="true" />
      <p>{tip.text}</p>
      {tip.toInbox && (
        <button className="btn small" onClick={onShowInbox}>
          Show Needs you
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
      <button className="btn small quiet icon" aria-label="Dismiss this tip" title="Dismiss" onClick={() => sim.dismissTip()}>
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
