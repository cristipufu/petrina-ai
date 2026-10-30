// Live projections, bounded archive ownership and revision/persistence bookkeeping.
import {
  captureTaskDetailsBase,
  diffTaskDetails,
  finishedTask,
  historyPageUsage,
  involvesProduct,
  type HistoryDependency,
  type Id,
  type State,
  type Task,
  type TaskDetailsBase,
  type TaskDetailsUpdate,
  type HistoryQuery,
  type HistoryPage
} from "@petrina/core";
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
    const tasks = this.k.stopped ? [] : this.k.store.history.all().map((task) => {
      const known = current.get(task.id);
      if (known) return known;
      restoreRepositoryState(task as RuntimeTask);
      return taskView(task as RuntimeTask);
    });
    const ids = new Set(tasks.map((task) => task.id));
    tasks.push(...[...current.values()].filter((task) => !ids.has(task.id)));
    const { history: _history, ...state } = this.k.activeState();
    return { ...state, tasks };
  };

  /** A bounded live update: all completed tasks are represented by archive totals, never bodies. */
  private readonly taskRevisions = new Map<Id, number>();
  private readonly taskCheckedAt = new Map<Id, number>();
  private readonly taskSignatures = new Map<Id, string>();
  private readonly dirtyTasks = new Set<Id>();
  private allTasksDirty = true;
  private nextTaskRevision = 0;
  private pendingGlobalCheck = 0;
  private dependencies: { key: string; items: HistoryDependency[] } | undefined;

  changed(target?: RuntimeTask | RepositoryContext): void {
    const revision = ++this.nextTaskRevision;
    if (target) {
      const task = executionOf(target).task;
      this.dirtyTasks.add(task.id);
      this.taskRevisions.set(task.id, revision);
      this.taskSignatures.delete(task.id);
      // Events are recorded on the shared change path, before a batched save or retirement can hide a transition.
      this.k.events?.observe([task]);
    } else {
      this.allTasksDirty = true;
      this.pendingGlobalCheck = revision;
      this.k.events?.observe([...this.k.s.tasks, ...this.archiveCache.values()]);
    }
  }

  private summaryWithoutRevision(task: RuntimeTask): Task {
    return {
      ...taskView(task),
      detailsOmitted: true,
      detailsRevision: "",
      session: [],
      timeline: [],
      journey: undefined,
      designSessions: undefined,
      reviewSessions: undefined,
      handedBack: undefined,
      hunt: task.hunt ? { ...task.hunt, findingChecks: undefined } : undefined,
    } as Task;
  }

  private signatureOf(task: RuntimeTask, summary: Task = this.summaryWithoutRevision(task)): string {
    const summaryHash = String(Bun.hash(JSON.stringify(summary)));
    let sessionParts = `${task.session.length}`;
    for (const line of task.session) {
      sessionParts += `|${line.id}:${line.at}:${line.from}:${String(Bun.hash(line.text))}:${line.roleId ?? ""}:${line.profileId ?? ""}:${line.productId ?? ""}:${line.coordinatorMessageId ?? ""}:${line.step ?? ""}:${line.toolInvocationId ?? ""}:${line.inputIndex ?? ""}:${line.images ? JSON.stringify(line.images) : ""}`;
    }
    const sessionHash = String(Bun.hash(sessionParts));
    const omittedHash = String(
      Bun.hash(
        JSON.stringify([
          task.timeline,
          task.journey,
          task.designSessions,
          task.reviewSessions,
          task.handedBack,
          task.hunt?.findingChecks,
        ]),
      ),
    );
    return `${summaryHash}:${sessionHash}:${omittedHash}`;
  }

  private resolveRevision(task: RuntimeTask, summary?: Task): string {
    if (
      this.k.s.tasks.includes(task)
      && ((this.taskCheckedAt.get(task.id) ?? -1) < this.pendingGlobalCheck || !this.taskSignatures.has(task.id))
    ) {
      const signature = this.signatureOf(task, summary);
      const previous = this.taskSignatures.get(task.id);
      this.taskSignatures.set(task.id, signature);
      this.taskCheckedAt.set(task.id, this.pendingGlobalCheck);
      if (previous !== undefined && previous !== signature) {
        this.taskRevisions.set(task.id, ++this.nextTaskRevision);
      } else if (!this.taskRevisions.has(task.id)) {
        this.taskRevisions.set(task.id, ++this.nextTaskRevision);
      }
    }
    return `${this.k.boot}:${this.taskRevisions.get(task.id) ?? 0}`;
  }

  windowState = (): State => {
    // A terminal result must be in the archive before the window stops seeing its live body.
    if (!this.k.stopped && this.k.store.history.needsUpdate(this.k.s.tasks.filter(finishedTask) as Task[])) this.k.save();
    const tasks = this.k.s.tasks
      .filter((task) => !finishedTask(task))
      .map((task) => {
        const summary = this.summaryWithoutRevision(task);
        return { ...summary, detailsRevision: this.resolveRevision(task, summary) };
      });
    const usageReads: NonNullable<State["pool"]["usageReads"]> = this.k.usageCoordinator.snapshot();
    const dependencyIds = this.k.stopped ? [] : [...new Set([
      ...this.k.s.inbox.map((item) => item.taskId),
      ...this.k.s.tasks.filter((task) => !finishedTask(task)).flatMap((task) => [
      ...(task.after ?? []),
      ...(task.runtimeWait?.after ?? []),
      ...(task.journey ?? []).flatMap((step) => step.waitsOn?.map((entry) => entry.id) ?? [])
    ])
    ])];
    const key = JSON.stringify([this.k.store.history.info().revision, dependencyIds]);
    // Streaming changes do not re-read archived delivery state. Keep only the current
    // dependency set, refreshing it when membership or the history revision changes.
    if (this.dependencies?.key !== key) this.dependencies = { key, items: dependencyIds.flatMap(id => {
      const item = this.k.store.history.dependency(id);
      return item ? [item] : [];
    }) };
    const dependencies = this.dependencies.items;
    const { extraValidations: _extraOwnership, ...visible } = this.k.activeState();
    return {
      ...visible,
      tasks,
      ...(Object.keys(usageReads).length ? { pool: {
      ...this.k.s.pool,
      usageReads
    } } : {}),
      history: {
      ...this.k.store.history.info(),
      ...(dependencies.length ? { dependencies } : {})
    }
    };
  };

  historyPage = (request: HistoryQuery): HistoryPage => {
    if (this.k.stopped) throw new Error("The engine has stopped. Reconnect to open task history.");
    if (!this.k.stopped && this.k.store.history.needsUpdate(this.k.s.tasks.filter(finishedTask) as Task[])) this.k.save();
    const page = this.k.store.history.page(request);
    return request.includeUsage ? historyPageUsage(page, this.k.tracking.log) : page;
  };

  taskDetails = (id: Id): Task | undefined => {
    const task = this.task(id);
    if (!task) {
      this.detailBases.delete(id);
      return undefined;
    }
    const projected: Task = {
      ...taskView(task),
      detailsRevision: this.resolveRevision(task),
    };
    if (this.k.s.tasks.includes(task)) this.rememberDetailBase(id, captureTaskDetailsBase(projected));
    return projected;
  };

  taskDetailsDelta = (id: Id, sinceRevision: string): TaskDetailsUpdate | undefined => {
    const task = this.task(id);
    if (!task) {
      this.detailBases.delete(id);
      return undefined;
    }
    const revision = this.resolveRevision(task);
    const isLive = this.k.s.tasks.includes(task);
    const base = this.detailBases.get(id);
    if (isLive && base && base.detailsRevision === sinceRevision && revision === sinceRevision) {
      return { kind: "unchanged", detailsRevision: revision };
    }
    const projected: Task = {
      ...taskView(task),
      detailsRevision: revision,
    };
    if (!isLive || !base || base.detailsRevision !== sinceRevision) {
      if (isLive) this.rememberDetailBase(id, captureTaskDetailsBase(projected));
      return { kind: "full", task: projected };
    }
    const { update, nextBase } = diffTaskDetails(base, projected);
    this.rememberDetailBase(id, nextBase);
    return update;
  };

  private readonly detailBases = new Map<Id, TaskDetailsBase>();

  private rememberDetailBase(id: Id, base: TaskDetailsBase): void {
    this.detailBases.delete(id);
    if (this.detailBases.size >= 8) {
      const oldest = this.detailBases.keys().next().value;
      if (oldest !== undefined) this.detailBases.delete(oldest);
    }
    this.detailBases.set(id, base);
  }

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
    for (const id of ids) {
      this.taskRevisions.delete(id);
      this.taskCheckedAt.delete(id);
      this.taskSignatures.delete(id);
      this.detailBases.delete(id);
    }
    return this.k.store.history.info().revision !== revision;
  }
}
