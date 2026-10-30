// Live projections, bounded archive ownership and revision/persistence bookkeeping.
import { finishedTask, historyPageUsage, involvesProduct, type HistoryDependency, type Id, type State, type Task, type HistoryQuery, type HistoryPage } from "@petrina/core";
import type { Kernel, RuntimeTask } from "./kernel.js";
import { settledHistoryTask } from "@petrina/storage/store";
import { executionOf, restoreRepositoryState, taskView, type RepositoryContext } from "@petrina/orchestrator";

export interface ProjectionHost {
  s: Pick<Kernel["s"], "tasks" | "inbox" | "pool">;
  store: Kernel["store"];
  boot: string;
  stopped: boolean;
  activeState: Kernel["activeState"];
  save: Kernel["save"];
  drivers: Pick<Kernel["drivers"], "has">;
  settling: Pick<Kernel["settling"], "has">;
  switching: Pick<Kernel["switching"], "has">;
  copyCleanups: Pick<Kernel["copyCleanups"], "has">;
  followsUpHeld: Kernel["followsUpHeld"];
  usageCoordinator: Pick<Kernel["usageCoordinator"], "snapshot">;
  events?: Pick<Kernel["events"], "observe" | "baseline">;
  tracking: Pick<Kernel["tracking"], "log">;
}
export class StateProjection {
  constructor(private readonly k: ProjectionHost, private readonly normalize: (task: RuntimeTask) => void) {}
  /** Explicit compatibility/debug snapshot. Production never loads all archived conversations. */
  getState = (): State => {
    this.k.activeState();
    const current = new Map<string, Task>([...this.archiveCache.values(), ...this.k.s.tasks].map((task) => [task.id, taskView(task) as Task]));
    // Shutdown closes SQLite before detached cleanup finishes. Reads used while waiting for that
    // cleanup keep the last in-memory work; stopping never loads an unbounded history snapshot.
    const tasks = this.k.stopped ? [] : this.k.store.history.all().map((task) => { const known = current.get(task.id); if (known) return known; restoreRepositoryState(task as RuntimeTask); return taskView(task as RuntimeTask); });
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
  private dependencies: { key: string; items: HistoryDependency[] } | undefined;

  changed(target?: RuntimeTask | RepositoryContext): void {
    const revision = ++this.nextTaskRevision;
    if (target) {
      const task = executionOf(target).task;
      this.dirtyTasks.add(task.id);
      this.taskRevisions.set(task.id, revision);
      // Events are recorded on the shared change path, before a batched save or retirement can hide a transition.
      this.k.events?.observe([task]);
    } else {
      this.allTasksDirty = true;
      for (const task of this.k.s.tasks) this.taskRevisions.set(task.id, revision);
      this.k.events?.observe([...this.k.s.tasks, ...this.archiveCache.values()]);
    }
  }

  private detailRevision(id: Id): string { return `${this.k.boot}:${this.taskRevisions.get(id) ?? 0}`; }

  windowState = (): State => {
    // A terminal result must be in the archive before the window stops seeing its live body.
    if (!this.k.stopped && this.k.store.history.needsUpdate(this.k.s.tasks.filter(finishedTask) as Task[])) this.k.save();
    const tasks = this.k.s.tasks.filter((task) => !finishedTask(task)).map((task) => ({ ...taskView(task), detailsOmitted: true, detailsRevision: this.detailRevision(task.id), session: [], timeline: [], journey: undefined, designSessions: undefined, reviewSessions: undefined, handedBack: undefined,
      hunt: task.hunt ? { ...task.hunt, findingChecks: undefined } : undefined,
    })) as Task[];
    const usageReads: NonNullable<State["pool"]["usageReads"]> = this.k.usageCoordinator.snapshot();
    const dependencyIds = this.k.stopped ? [] : [...new Set([...this.k.s.inbox.map((item) => item.taskId), ...this.k.s.tasks.filter((task) => !finishedTask(task)).flatMap((task) => [...(task.after ?? []), ...(task.runtimeWait?.after ?? []), ...(task.journey ?? []).flatMap((step) => step.waitsOn?.map((entry) => entry.id) ?? [])])])];
    const key = JSON.stringify([this.k.store.history.info().revision, dependencyIds]);
    // Streaming changes do not re-read archived delivery state. Keep only the current
    // dependency set, refreshing it when membership or the history revision changes.
    if (this.dependencies?.key !== key) this.dependencies = { key, items: dependencyIds.flatMap(id => {
      const item = this.k.store.history.dependency(id);
      return item ? [item] : [];
    }) };
    const dependencies = this.dependencies.items;
    const { extraValidations: _extraOwnership, ...visible } = this.k.activeState();
    return { ...visible, tasks, ...(Object.keys(usageReads).length ? { pool: { ...this.k.s.pool, usageReads } } : {}), history: { ...this.k.store.history.info(), ...(dependencies.length ? { dependencies } : {}) } };
  };

  historyPage = (request: HistoryQuery): HistoryPage => {
    if (this.k.stopped) throw new Error("The engine has stopped. Reconnect to open task history.");
    if (!this.k.stopped && this.k.store.history.needsUpdate(this.k.s.tasks.filter(finishedTask) as Task[])) this.k.save();
    const page = this.k.store.history.page(request);
    return request.includeUsage ? historyPageUsage(page, this.k.tracking.log) : page;
  };

  taskDetails = (id: Id): Task | undefined => { const task = this.task(id); return task ? { ...taskView(task), detailsRevision: this.detailRevision(id) } : undefined; };

  private readonly archiveCache = new Map<Id, RuntimeTask>();

  /** A cleanup result for an already archived task must survive immediately, even after cache eviction. */
  saveArchivedTask(task: RuntimeTask): void {
    if (this.k.stopped || this.k.s.tasks.includes(task)) return;

    this.k.store.saveArchivedTask(task as Task);
    this.dirtyTasks.delete(task.id);
  }

  forgetProductHistory(productId: Id): void {
    for (const [id, task] of this.archiveCache) if (involvesProduct(task, productId)) this.archiveCache.delete(id);
  }

  private retiredTasks(): Id[] {
    return this.k.s.tasks.filter((task) => settledHistoryTask(task as Task) && !this.k.drivers.has(task.id) && !this.k.settling.has(task.id) && !this.k.switching.has(task.id) && !this.k.copyCleanups.has(task.id) && !this.k.followsUpHeld(task.id)).map((task) => task.id);
  }

  task(id: Id, ownedCleanup = false): RuntimeTask | undefined {
    const live = this.k.s.tasks.find((task) => task.id === id);
    if (live) return live;
    const cached = this.archiveCache.get(id);
    if (cached) {
      this.archiveCache.delete(id);
      this.archiveCache.set(id, cached);
      return cached;
    }
    if (this.k.stopped && !ownedCleanup) return undefined;
    const saved = this.k.store.history.get(id) as RuntimeTask | undefined;
    if (!saved) return undefined;
    restoreRepositoryState(saved);
    this.normalize(saved);
    // If settled facts were retired, the saved body is the exact baseline before any late edit.
    this.k.events?.baseline([saved]);
    // On-demand reads stay bounded even when walking through years of finished work.
    if (this.archiveCache.size >= 16) {
      const first = this.archiveCache.keys().next().value!;
      if (this.dirtyTasks.has(first)) this.saveArchivedTask(this.archiveCache.get(first)!);
      this.archiveCache.delete(first);
    }
    this.archiveCache.set(id, saved);
    return saved;
  }

  save(all: boolean): boolean {
    const revision = this.k.store.history.info().revision;
    // A terminal transition saved without an ordinary change notification is still observed before retirement.
    this.k.events?.observe(this.k.s.tasks);
    const retired = this.retiredTasks();
    const complete = all || this.allTasksDirty;
    const changedArchive = [...this.archiveCache.values()].filter((task) => all || this.dirtyTasks.has(task.id));
    this.k.store.save(this.k.activeState(), retired, changedArchive as Task[], complete ? undefined : [...this.dirtyTasks]);
    this.allTasksDirty = false;
    this.dirtyTasks.clear();
    const ids = new Set(retired);
    this.k.s.tasks = this.k.s.tasks.filter((task) => !ids.has(task.id));
    for (const id of ids) this.taskRevisions.delete(id);
    return this.k.store.history.info().revision !== revision;
  }
}
