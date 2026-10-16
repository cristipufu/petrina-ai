import { Fragment, useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight, Compass, GitPullRequest, Hammer, ListOrdered, Map as MapIcon, Search, type LucideIcon } from "lucide-react";
import { queueOf, startsNextCount, type Column, type State, type Task } from "@petrina/core";
import { sim } from "../engine";
import type { Lookup } from "../lib";
import { ProductChip } from "./bits";
import { TaskCard, type SheetTab } from "./TaskCard";

interface ColumnSpec {
  id: Column;
  title: string;
  icon: LucideIcon;
  empty: string;
}

const COLUMN_SPECS: readonly ColumnSpec[] = [
  { id: "queue", title: "Queue", icon: ListOrdered, empty: "Nothing waiting. ⌘N adds a task." },
  { id: "planning", title: "Planning", icon: MapIcon, empty: "No plans being written" },
  { id: "designing", title: "Designing", icon: Compass, empty: "Nothing in design" },
  { id: "building", title: "Building", icon: Hammer, empty: "Nobody is building" },
  { id: "reviewing", title: "Reviewing", icon: Search, empty: "Nothing in review" },
  { id: "ready", title: "Ready", icon: GitPullRequest, empty: "Nothing to ship yet" },
];

/** Cards that need the coordinator float to the top of their column. */
const ATTENTION: Partial<Record<Task["state"], number>> = { "needs-you": 0, running: 1, waiting: 2, "pr-open": 3, paused: 4 };

interface BoardProps {
  state: State;
  find: Lookup;
  visible: (task: Task) => boolean;
  selectedId: string | undefined;
  onOpen: (taskId: string, tab?: SheetTab) => void;
}

export function Board({ state, find, visible, selectedId, onOpen }: BoardProps) {
  const [dragId, setDragId] = useState<string>();
  const [dropIndex, setDropIndex] = useState<number>();
  const [showDone, setShowDone] = useState(false);
  const done = state.tasks.filter((task) => task.column === "done" && visible(task)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));

  const queue = queueOf(state.tasks);
  const visibleQueue = queue.filter(visible);
  // The dashed line sits under whatever starts when the next slot frees (at least one task).
  const nextUp = Math.max(1, startsNextCount(state));
  const unheldBefore = (index: number) => queue.slice(0, index).filter((task) => !task.held).length;

  const onDragStart = (event: DragEvent, taskId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
    setDragId(taskId);
  };

  const onDragOverQueue = (event: DragEvent<HTMLDivElement>) => {
    if (!dragId) return;
    event.preventDefault();
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-queue-index]"));
    let index = cards.length;
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) {
        index = Number(card.dataset.queueIndex);
        break;
      }
    }
    setDropIndex(index);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (dragId !== undefined && dropIndex !== undefined) {
      const from = queue.findIndex((task) => task.id === dragId);
      sim.moveInQueue(dragId, from >= 0 && from < dropIndex ? dropIndex - 1 : dropIndex);
    }
    setDragId(undefined);
    setDropIndex(undefined);
  };

  return (
    <div className="board">
      {COLUMN_SPECS.map((spec) => {
        const Icon = spec.icon;
        if (spec.id === "queue") {
          return (
            <section key={spec.id} className="column" aria-label={spec.title}>
              <header className="column-head" title="Drag cards to reorder. The top starts first.">
                <Icon size={15} />
                {spec.title}
                <span className="n">{queue.length}</span>
              </header>
              <div
                className="column-body"
                onDragOver={onDragOverQueue}
                onDrop={onDrop}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropIndex(undefined);
                }}
              >
                {visibleQueue.length === 0 && <div className="column-empty">{spec.empty}</div>}
                {visibleQueue.map((task) => {
                  const index = queue.indexOf(task);
                  const line = !task.held && unheldBefore(index) === nextUp;
                  return (
                    <Fragment key={task.id}>
                      {line && <div className="starts-next">NEXT UP ↑</div>}
                      {dropIndex === index && dragId !== task.id && <div className="drop-line" />}
                      <div data-queue-index={index}>
                        <TaskCard
                          task={task}
                          state={state}
                          find={find}
                          selected={task.id === selectedId}
                          queuePosition={index}
                          onOpen={onOpen}
                          onDragStart={onDragStart}
                          onDragEnd={() => {
                            setDragId(undefined);
                            setDropIndex(undefined);
                          }}
                          dragging={dragId === task.id}
                        />
                      </div>
                    </Fragment>
                  );
                })}
                {dropIndex === queue.length && <div className="drop-line" />}
              </div>
            </section>
          );
        }

        const tasks = state.tasks
          .filter((task) => task.column === spec.id && task.state !== "queued" && visible(task))
          .sort((a, b) => (ATTENTION[a.state] ?? 9) - (ATTENTION[b.state] ?? 9) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
        const ready = spec.id === "ready";

        return (
          <section key={spec.id} className="column" aria-label={spec.title}>
            <header className="column-head">
              <Icon size={15} />
              {spec.title}
              <span className="n">{tasks.length}</span>
            </header>
            <div className="column-body">
              {tasks.length === 0 && <div className="column-empty">{spec.empty}</div>}
              {tasks.map((task) => (
                <TaskCard key={task.id} task={task} state={state} find={find} selected={task.id === selectedId} onOpen={onOpen} />
              ))}
              {ready && done.length > 0 && (
                <>
                  <button className="done-toggle" onClick={() => setShowDone((on) => !on)} aria-expanded={showDone}>
                    {showDone ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Done · {done.length}
                  </button>
                  {showDone &&
                    done.map((task) => (
                      <div key={task.id} className={`done-row ${task.state}`} onClick={() => onOpen(task.id)} role="button" tabIndex={0}>
                        <span className={`dot ${task.state === "done" ? "done" : ""}`} />
                        <span className="title">{task.title}</span>
                        <ProductChip product={find.product(task.productId)} />
                      </div>
                    ))}
                </>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
