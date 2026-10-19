import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { copyNoLongerNeeded, displayTask, finishedTask, type Id, type State, type Task } from "@petrina/core";
import { TaskHistory } from "./history-store.js";

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

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    this.history = new TaskHistory(this.db);
    this.db.run("CREATE TABLE IF NOT EXISTS coordination_handled_items (id TEXT PRIMARY KEY)");
  }

  /** Explicit compatibility/debug read, including archived conversations. Production uses loadActive. */
  load(): State | undefined {
    return this.db.transaction(() => {
      const state = this.readSnapshot();
      if (!state) return undefined;
      const live = new Set(state.tasks.map((task) => task.id));
      return { ...state, tasks: [...state.tasks, ...this.history.all().filter((task) => !live.has(task.id))] };
    })();
  }

  private readSnapshot(): State | undefined {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get("state");
    if (!row) return undefined;
    try { return JSON.parse(row.value) as State; } catch { return undefined; }
  }

  loadActive(normalize?: (state: State) => void): State | undefined {
    const state = this.readSnapshot();
    if (!state) return undefined;
    normalize?.(state);
    // Old installs saved all completed bodies in this one value. Move them and the new current
    // snapshot in the same transaction: interruption never leaves a task in neither place.
    // A write failure must propagate, never turn a valid saved install into an empty one.
    const retire = state.tasks.filter(settledHistoryTask).map((task) => task.id);
    if (state.tasks.some(finishedTask)) this.save(state, retire);
    const omit = new Set(retire);
    return { ...state, tasks: state.tasks.filter((task) => !omit.has(task.id)) };
  }

  save(state: State, retired: readonly Id[] = state.tasks.filter(settledHistoryTask).map((task) => task.id), changedArchive: readonly Task[] = []): void {
    const omit = new Set(retired);
    const { history: _history, ...current } = state;
    try {
      this.db.transaction(() => {
        this.history.put([...state.tasks.filter(finishedTask), ...changedArchive]);
        this.db.query("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run("state", JSON.stringify({ ...current, tasks: state.tasks.filter((task) => !omit.has(task.id)) }), Date.now());
      }).immediate();
    } catch (error) {
      this.history.reloadMetadata();
      throw error;
    }
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

  close(): void {
    this.db.close();
  }
}
