import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { copyNoLongerNeeded, displayTask, finishedTask, type ExtraValidation, type Id, type State, type Task, type TimelineEntry } from "@petrina/core";
import { TaskHistory } from "./history-store.js";
import { logSqlExecutions, SqlExecutionLog } from "./sql-log.js";

/** A stopped/finished task still involved in delivery or removing its copy stays in runtime state. */
export function settledHistoryTask(task: Task): boolean {
  task = displayTask(task);
  if (!copyNoLongerNeeded(task) || task.driving || task.shipping?.step !== undefined || task.shipping?.carriedOver) return false;
  if (task.repositories) return [...task.repositories, ...(task.excludedRepositories ?? [])].every((work) => {
    if (work.shipping?.step !== undefined || work.shipping?.carriedOver || work.localUpdate?.pushed === false || work.cleanup?.foreignPullRequest) return false;
    return !(work.worktree || work.preparingCopy) || (work.cleanup?.removedAt !== undefined && work.cleanup.reviewCopiesRemovedAt !== undefined);
  });
  if (task.worktree || (task.state === "cancelled" && task.startedAt !== undefined)) return task.cleanup?.removedAt !== undefined && task.cleanup.reviewCopiesRemovedAt !== undefined;
  return true;
}

/** The engine's state, kept in SQLite so tasks survive a restart. */
export class Store {
  private readonly db: Database;
  readonly history: TaskHistory;
  private activeIds: Set<Id>;

  constructor(path: string, options: { debugSql?: boolean } = {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    // Offline status reads can recover the WAL before a replacement opens it. Give that
    // short recovery the same bounded allowance as lifecycle receipts, before touching it.
    try {
      this.db.run("PRAGMA busy_timeout = 3000");
      if (options.debugSql) logSqlExecutions(this.db, new SqlExecutionLog(dirname(path)));
      // Journal selection precedes the transaction; SQLite cannot change it inside one.
      this.db.run("PRAGMA journal_mode = WAL");
      const initialized = this.db.transaction(() => {
        this.db.run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        this.db.run("CREATE TABLE IF NOT EXISTS active_tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
        const history = new TaskHistory(this.db);
        this.db.run("CREATE TABLE IF NOT EXISTS coordination_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)");
        this.db.run("CREATE TABLE IF NOT EXISTS coordination_handled_items (id TEXT PRIMARY KEY)");
        return { history, activeIds: this.readActiveIds() };
      }).immediate();
      this.history = initialized.history;
      this.activeIds = initialized.activeIds;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Explicit compatibility/debug read, including archived conversations. Production uses loadActive. */
  load(): State | undefined {
    return this.db.transaction(() => {
      const snapshot = this.readSnapshot();
      if (!snapshot) return undefined;
      const { state } = snapshot;
      const live = new Set(state.tasks.map((task) => task.id));
      return { ...state, tasks: [...state.tasks, ...this.history.all().filter((task) => !live.has(task.id))] };
    })();
  }

  private readSnapshot(): { state: State; split: boolean } | undefined {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get("state");
    if (!row) return undefined;
    let saved: State & { taskIds?: Id[] };
    try { saved = JSON.parse(row.value); } catch { return undefined; }
    if (!saved.taskIds) return { state: saved, split: false };
    const rows = new Map(this.db.query<{ id: string; body: string }, []>("SELECT id, body FROM active_tasks").all().map((row) => [row.id, row.body]));
    const { taskIds, ...state } = saved;
    return {
      split: true,
      state: {
        ...state,
        tasks: taskIds.map((id) => {
          const body = rows.get(id);
          if (!body) throw new Error("A saved task is missing. Keep this data folder for recovery.");
          return JSON.parse(body) as Task;
        }),
      },
    };
  }

  loadActive(normalize?: (state: State) => void): State | undefined {
    const snapshot = this.readSnapshot();
    if (!snapshot) return undefined;
    const { state, split } = snapshot;
    normalize?.(state);
    // Old installs saved all completed bodies in this one value. Move them and the new current
    // snapshot in the same transaction: interruption never leaves a task in neither place.
    // A write failure must propagate, never turn a valid saved install into an empty one.
    const retire = state.tasks.filter(settledHistoryTask).map((task) => task.id);
    if (state.tasks.some(finishedTask) || !split) this.save(state, retire);
    const omit = new Set(retire);
    return { ...state, tasks: state.tasks.filter((task) => !omit.has(task.id)) };
  }

  save(state: State, retired: readonly Id[] = state.tasks.filter(settledHistoryTask).map((task) => task.id), changedArchive: readonly Task[] = [], changedActive?: readonly Id[]): void {
    const omit = new Set(retired);
    const dirty = changedActive ? new Set(changedActive) : undefined;
    const { history: _history, ...current } = state;
    const active = state.tasks.filter((task) => !omit.has(task.id));
    const ids = new Set(active.map((task) => task.id));
    try {
      this.db.transaction(() => {
        this.history.put([...state.tasks.filter((task) => finishedTask(task) && (!dirty || dirty.has(task.id) || omit.has(task.id))), ...changedArchive]);
        for (const task of active) if (!dirty || dirty.has(task.id) || !this.activeIds.has(task.id)) {
          this.db.query("INSERT INTO active_tasks(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE body IS NOT excluded.body").run(task.id, JSON.stringify(task));
        }
        for (const id of this.activeIds) if (!ids.has(id)) this.db.query("DELETE FROM active_tasks WHERE id=?").run(id);
        this.db.query("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE kv.value IS NOT excluded.value").run("state", JSON.stringify({ ...current, tasks: [], taskIds: active.map((task) => task.id) }), Date.now());
      }).immediate();
      this.activeIds = ids;
    } catch (error) {
      this.history.reloadMetadata();
      this.activeIds = this.readActiveIds();
      throw error;
    }
  }

  /** Persist one edited archive without retiring or rewriting any live task. */
  saveArchivedTask(task: Task): void {
    try {
      this.db.transaction(() => this.history.put([task])).immediate();
    } catch (error) {
      this.history.reloadMetadata();
      throw error;
    }
  }

  /** Late owned cleanup cannot checkpoint other tasks' post-shutdown mutations or clocks. */
  saveExtraValidationOwnership(records: State["extraValidations"], sequence: number): void {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'state'").get();
    if (!row) throw new Error("The saved shutdown state is unavailable for extra validation cleanup.");
    const saved = JSON.parse(row.value) as State;
    this.db.query("UPDATE kv SET value = ? WHERE key = 'state'").run(JSON.stringify({ ...saved,
      extraValidations: records, seq: Math.max(saved.seq, sequence) }));
  }

  /** Atomically merge this run's evidence and ownership into the shutdown snapshot, including an uncached archive. */
  saveExtraValidationEvidence(record: ExtraValidation, line: TimelineEntry, timelineLimit: number, records: State["extraValidations"], sequence: number): void {
    try {
      this.db.transaction(() => {
        const active = this.db.query<{ body: string }, [string]>("SELECT body FROM active_tasks WHERE id = ?").get(record.taskId);
        const task = active ? JSON.parse(active.body) as Task : this.history.get(record.taskId);
        if (!task) throw new Error("The saved task is unavailable for extra validation cleanup.");
        const updated: Task = { ...task,
          journey: task.journey?.map(node => node.id !== record.nodeId ? node : { ...node,
            extraValidations: [...(node.extraValidations ?? []).filter(run => run.id !== record.id), record] }),
          timeline: [...task.timeline.filter(entry => entry.id !== line.id), line].slice(-timelineLimit) };
        if (active) this.db.query("UPDATE active_tasks SET body = ? WHERE id = ?").run(JSON.stringify(updated), task.id);
        if (!active || finishedTask(task)) this.history.put([updated]);
        this.saveExtraValidationOwnership(records, sequence);
      }).immediate();
    } catch (error) { this.history.reloadMetadata(); throw error; }
  }

  /** The product and its finished history disappear together with the approved current snapshot. */
  removeProduct(productId: Id, state: State, recordRemoval?: () => void): void {
    try {
      this.db.transaction(() => {
        this.history.removeProduct(productId);
        recordRemoval?.();
        this.save(state);
      }).immediate();
    } catch (error) {
      this.history.reloadMetadata();
      this.activeIds = this.readActiveIds();
      throw error;
    }
  }

  /** The same database holds the work log, in its own tables. */
  handled(id: string): boolean {
    return !!this.db.query("SELECT id FROM coordination_handled_items WHERE id = ?").get(id);
  }

  noteHandled(ids: readonly string[]): void {
    for (const id of ids) this.db.query("INSERT OR IGNORE INTO coordination_handled_items VALUES (?)").run(id);
  }

  get database(): Database {
    return this.db;
  }

  private readActiveIds(): Set<Id> {
    return new Set(this.db.query<{ id: string }, []>("SELECT id FROM active_tasks").all().map((row) => row.id));
  }

  close(): void {
    this.db.close();
  }
}
