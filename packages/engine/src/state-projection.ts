// Live projections, bounded archive ownership and revision/persistence bookkeeping.
import { finishedTask, involvesProduct, type Id, type State, type Task, type HistoryQuery, type HistoryPage } from "@petrina/core";
import type { Kernel, MTask } from "./kernel.js";
import { settledHistoryTask } from "./store.js";
import { executionOf, restoreRepositoryState, taskView, type RepositoryContext } from "./repository-context.js";

type ProjectionHost = Pick<Kernel, "s" | "store" | "boot" | "stopped" | "activeState" | "save" | "drivers" | "settling" | "switching" | "copyCleanups" | "followsUpHeld" | "usageCoordinator">;
export class StateProjection {
  constructor(private readonly k: ProjectionHost, private readonly normalize: (task: MTask) => void) {}
  /** Explicit compatibility/debug snapshot. Production never loads all archived conversations. */
  getState = (): State => {
    this.k.activeState();
    const current = new Map<string, Task>([...this.archiveCache.values(), ...this.k.s.tasks].map((task) => [task.id, taskView(task) as Task]));
    // Shutdown closes SQLite before detached cleanup finishes. Reads used while waiting for that
    // cleanup keep the last in-memory work; stopping never loads an unbounded history snapshot.
    const tasks = this.k.stopped ? [] : this.k.store.history.all().map((task) => { const known = current.get(task.id); if (known) return known; restoreRepositoryState(task as MTask); return taskView(task as MTask); });
    const ids = new Set(tasks.map((task) => task.id));
    tasks.push(...[...current.values()].filter((task) => !ids.has(task.id)));
    const { history: _history, ...state } = this.k.activeState();
    return { ...state, tasks };
  };

  /** A bounded live update: all completed tasks are represented by archive totals, never bodies. */
  private readonly taskRevisions = new Map<Id, number>();
  private readonly dirtyTasks = new Set<Id>();
  private allTasksDirty = true;
  private nextTaskRevision = 0;

  changed(target?: MTask | RepositoryContext): void {
    const revision = ++this.nextTaskRevision;
    if (target) {
      const task = executionOf(target).task;
      this.dirtyTasks.add(task.id);
      this.taskRevisions.set(task.id, revision);
    } else {
      this.allTasksDirty = true;
      for (const task of this.k.s.tasks) this.taskRevisions.set(task.id, revision);
    }
  }

  private detailRevision(id: Id): string { return `${this.k.boot}:${this.taskRevisions.get(id) ?? 0}`; }

  windowState = (): State => {
    // A terminal result must be in the archive before the window stops seeing its live body.
    if (!this.k.stopped && this.k.store.history.needsUpdate(this.k.s.tasks.filter(finishedTask) as Task[])) this.k.save();
    const tasks = this.k.s.tasks.filter((task) => !finishedTask(task)).map((task) => ({ ...taskView(task), detailsOmitted: true, detailsRevision: this.detailRevision(task.id), session: [], timeline: [], journey: undefined, designSessions: undefined, reviewSessions: undefined, handedBack: undefined })) as Task[];
    const usageReads: NonNullable<State["pool"]["usageReads"]> = this.k.usageCoordinator.snapshot();
    const dependencies = this.k.stopped ? [] : [...new Set([...this.k.s.inbox.map((item) => item.taskId), ...this.k.s.tasks.filter((task) => !finishedTask(task)).flatMap((task) => [...(task.after ?? []), ...(task.journey ?? []).flatMap((step) => step.waitsOn?.map((entry) => entry.id) ?? [])])])].flatMap((id) => {
      const item = this.k.store.history.item(id);
      return item ? [item] : [];
    });
    return { ...this.k.activeState(), tasks, ...(Object.keys(usageReads).length ? { pool: { ...this.k.s.pool, usageReads } } : {}), history: { ...this.k.store.history.info(), ...(dependencies.length ? { dependencies } : {}) } };
  };

  historyPage = (request: HistoryQuery): HistoryPage => {
    if (this.k.stopped) throw new Error("The engine has stopped. Reconnect to open task history.");
    if (!this.k.stopped && this.k.store.history.needsUpdate(this.k.s.tasks.filter(finishedTask) as Task[])) this.k.save();
    return this.k.store.history.page(request);
  };

  taskDetails = (id: Id): Task | undefined => { const task = this.task(id); return task ? taskView(task) : undefined; };

  private readonly archiveCache = new Map<Id, MTask>();

  /** A cleanup result for an already archived task must survive immediately, even after cache eviction. */
  saveArchivedTask(task: MTask): void {
    if (this.k.stopped || this.k.s.tasks.includes(task)) return;

    this.k.store.save(this.k.activeState(), this.retiredTasks(), [task as Task]);
  }

  forgetProductHistory(productId: Id): void {
    for (const [id, task] of this.archiveCache) if (involvesProduct(task, productId)) this.archiveCache.delete(id);
  }

  private retiredTasks(): Id[] {
    return this.k.s.tasks.filter((task) => settledHistoryTask(task as Task) && !this.k.drivers.has(task.id) && !this.k.settling.has(task.id) && !this.k.switching.has(task.id) && !this.k.copyCleanups.has(task.id) && !this.k.followsUpHeld(task.id)).map((task) => task.id);
  }

  task(id: Id): MTask | undefined {
    const live = this.k.s.tasks.find((task) => task.id === id);
    if (live) return live;
    const cached = this.archiveCache.get(id);
    if (cached) {
      this.archiveCache.delete(id);
      this.archiveCache.set(id, cached);
      return cached;
    }
    if (this.k.stopped) return undefined;
    const saved = this.k.store.history.get(id) as MTask | undefined;
    if (!saved) return undefined;
    restoreRepositoryState(saved);
    this.normalize(saved);
    // On-demand reads stay bounded even when walking through years of finished work.
    if (this.archiveCache.size >= 16) {
      this.k.store.save(this.k.activeState(), this.retiredTasks(), [...this.archiveCache.values()] as Task[]);
      this.archiveCache.delete(this.archiveCache.keys().next().value!);
    }
    this.archiveCache.set(id, saved);
    return saved;
  }

  save(all: boolean): boolean {
    const revision = this.k.store.history.info().revision;
    const retired = this.retiredTasks();
    const complete = all || this.allTasksDirty;
    const changedArchive = [...this.archiveCache.values()].filter((task) => complete || this.dirtyTasks.has(task.id));
    this.k.store.save(this.k.activeState(), retired, changedArchive as Task[], complete ? undefined : [...this.dirtyTasks]);
    this.allTasksDirty = false;
    this.dirtyTasks.clear();
    const ids = new Set(retired);
    this.k.s.tasks = this.k.s.tasks.filter((task) => !ids.has(task.id));
    for (const id of ids) this.taskRevisions.delete(id);
    return this.k.store.history.info().revision !== revision;
  }
}
