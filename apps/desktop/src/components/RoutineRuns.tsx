import { ArrowLeft, History as HistoryIcon } from "lucide-react";
import { queueOf, type State, type Task } from "@petrina/core";
import { followLink, routeHref } from "../routes";
import type { Lookup } from "../lib";
import { History, type HistoryPosition, type useHistoryPage } from "./History";
import { TaskCard } from "./TaskCard";

export function RoutineRuns({ id, state, product, find, current, history, position, onPosition, onBack, onOpen, hrefFor, drafts }: {
  id: string; state: State; product: string; find: Lookup; current: readonly Task[];
  history: ReturnType<typeof useHistoryPage>; position?: HistoryPosition; onPosition: (position: HistoryPosition) => void;
  onBack: () => void; onOpen: (id: string) => void; hrefFor: (id: string) => string; drafts: Readonly<Record<string, boolean>>;
}) {
  const routine = state.routines?.find(routine => routine.id === id);
  const queue = queueOf(state.tasks);
  return <section className="routine-runs page" aria-labelledby="routine-runs-title">
    <header className="routine-runs-header">
      <a className="btn quiet" href={routeHref({ view: "routines", product })} onClick={event => followLink(event, onBack)}><ArrowLeft size={16} aria-hidden="true" />All routines</a>
      <h1 id="routine-runs-title"><HistoryIcon size={22} aria-hidden="true" />{routine?.name ?? "Removed routine"}</h1>
      <p className="quiet-text">Every task created by this routine.{!routine && " The routine is no longer saved; its recorded runs are still available."}</p>
    </header>
    <section aria-labelledby="routine-current-title">
      <h2 className="section-title" id="routine-current-title">Current runs <span className="quiet-text num">{current.length}</span></h2>
      {current.length ? <div className="grid">{current.map(task => <TaskCard key={task.id} task={task} state={state} find={find} selected={false} queuePosition={task.state === "queued" ? queue.indexOf(task) : undefined} hasDraft={Boolean(drafts[task.id])} onFocus={() => {}} onOpen={onOpen} />)}</div> : <p className="note">No queued or active runs.</p>}
    </section>
    <section aria-labelledby="routine-finished-title">
      <h2 className="section-title" id="routine-finished-title">Finished runs</h2>
      <History {...history} position={position} onPosition={onPosition} find={find} onFocus={() => {}} onOpen={onOpen} hrefFor={hrefFor} drafts={drafts} />
    </section>
  </section>;
}
