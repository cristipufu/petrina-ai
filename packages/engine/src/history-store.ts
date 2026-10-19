// Completed tasks live outside the live snapshot. The board only reads the small current state;
// history uses an index for its next page and reads a conversation only when it is opened.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { combineReviewStats, finishedTask, historyAt, historyCursor, historyItem, readHistoryCursor, reviewStats, subtractReviewStats, HISTORY, type HistoryMetadata, type HistoryPage, type HistoryQuery, type Id, type ReviewStats, type StepRecord, type Task } from "@petrina/core";

interface Rollup { total: number; done: number; cancelled: number; reviews: ReviewStats }
const emptyRollup = (): Rollup => ({ total: 0, done: 0, cancelled: 0, reviews: reviewStats([]) });

export class TaskHistory {
  private revision = 0;
  private readonly rollups = new Map<string, Rollup>();
  private recentSteps: StepRecord[] = [];
  private metadata: HistoryMetadata | undefined;
  private readonly shapes = new Map<Id, string>();

  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, title TEXT NOT NULL, finished_at INTEGER NOT NULL,
      state TEXT NOT NULL, client_id TEXT, item TEXT NOT NULL, body TEXT NOT NULL, reviews TEXT NOT NULL,
      steps TEXT NOT NULL, roles TEXT NOT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS task_history_newest ON task_history(finished_at DESC, id DESC)");
    db.run("CREATE INDEX IF NOT EXISTS task_history_product_newest ON task_history(product_id, finished_at DESC, id DESC)");
    db.run("CREATE INDEX IF NOT EXISTS task_history_client ON task_history(client_id) WHERE client_id IS NOT NULL");
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS task_history_search USING fts5(title)");
    db.run("CREATE TABLE IF NOT EXISTS task_history_rollups (scope TEXT PRIMARY KEY, body TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS task_history_revision (one INTEGER PRIMARY KEY CHECK(one = 1), revision INTEGER NOT NULL)");
    db.run("INSERT OR IGNORE INTO task_history_revision(one, revision) VALUES(1, 0)");
    db.run("CREATE TABLE IF NOT EXISTS task_history_steps (task_id TEXT NOT NULL, position INTEGER NOT NULL, role_id TEXT NOT NULL, repeat INTEGER NOT NULL, worked INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(task_id, position))");
    db.run("CREATE INDEX IF NOT EXISTS task_history_step_kind ON task_history_steps(role_id, repeat, at DESC, task_id, position)");
    db.run("CREATE TABLE IF NOT EXISTS task_history_step_kinds (role_id TEXT NOT NULL, repeat INTEGER NOT NULL, PRIMARY KEY(role_id, repeat))");
    db.run("CREATE TABLE IF NOT EXISTS task_history_roles (task_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY(task_id, role_id))");
    db.run("CREATE INDEX IF NOT EXISTS task_history_role ON task_history_roles(role_id)");
    this.reloadMetadata();
  }

  /** Called inside the snapshot's transaction, so a terminal result and its removal are atomic. */
  put(tasks: readonly Task[]): boolean {
    let changed = false;
    let timingChanged = false;
    const changedScopes = new Set<string>();
    for (const task of tasks) {
      if (!finishedTask(task)) continue;
      const body = JSON.stringify(task);
      const old = this.db.query<{ rowid: number; product_id: string; state: string; title: string; body: string; reviews: string; steps: string; roles: string }, [string]>("SELECT rowid, product_id, state, title, body, reviews, steps, roles FROM task_history WHERE id = ?").get(task.id);
      this.rememberShape(task);
      if (old?.body === body) continue;
      const reviews = reviewStats([task]);
      const steps = JSON.stringify(task.steps ?? []);
      const roles = JSON.stringify([...new Set((task.plan?.stages ?? []).flatMap((stage) => [stage.roleId, stage.reviewerRoleId, ...(stage.roleIds ?? [])]).filter((id): id is string => !!id))]);
      this.db.query(`INSERT INTO task_history(id, product_id, title, finished_at, state, client_id, item, body, reviews, steps, roles)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        product_id=excluded.product_id, title=excluded.title, finished_at=excluded.finished_at, state=excluded.state,
        client_id=excluded.client_id, item=excluded.item, body=excluded.body, reviews=excluded.reviews, steps=excluded.steps, roles=excluded.roles`)
        .run(task.id, task.productId, task.title, historyAt(task), task.state, task.clientId ?? null, JSON.stringify(historyItem(task)), body, JSON.stringify(reviews), steps, roles);
      const rowid = old?.rowid ?? this.db.query<{ rowid: number }, [string]>("SELECT rowid FROM task_history WHERE id = ?").get(task.id)!.rowid;
      if (!old || old.title !== task.title) {
        if (old) this.db.query("DELETE FROM task_history_search WHERE rowid = ?").run(rowid);
        this.db.query("INSERT INTO task_history_search(rowid, title) VALUES(?, ?)").run(rowid, task.title);
      }
      if (old) for (const scope of new Set(["", old.product_id])) {
        const rollup = this.rollups.get(scope) ?? emptyRollup();
        rollup.total -= 1;
        if (old.state === "done") rollup.done -= 1; else rollup.cancelled -= 1;
        rollup.reviews = subtractReviewStats(rollup.reviews, JSON.parse(old.reviews) as ReviewStats);
        this.rollups.set(scope, rollup);
        changedScopes.add(scope);
      }
      for (const scope of new Set(["", task.productId])) {
        const rollup = this.rollups.get(scope) ?? emptyRollup();
        rollup.total += 1;
        if (task.state === "done") rollup.done += 1; else rollup.cancelled += 1;
        rollup.reviews = combineReviewStats(rollup.reviews, reviews);
        this.rollups.set(scope, rollup);
        changedScopes.add(scope);
      }
      if (!old || old.steps !== steps) {
        this.db.query("DELETE FROM task_history_steps WHERE task_id = ?").run(task.id);
        for (const [index, record] of (task.steps ?? []).entries()) {
          this.db.query("INSERT INTO task_history_steps(task_id, position, role_id, repeat, worked, at) VALUES(?, ?, ?, ?, ?, ?)").run(task.id, index, record.roleId, Number(record.repeat), record.worked, record.at);
          this.db.query("INSERT OR IGNORE INTO task_history_step_kinds(role_id, repeat) VALUES(?, ?)").run(record.roleId, Number(record.repeat));
        }
        timingChanged = true;
      }
      if (!old || old.roles !== roles) {
        this.db.query("DELETE FROM task_history_roles WHERE task_id = ?").run(task.id);
        for (const role of JSON.parse(roles) as string[]) this.db.query("INSERT INTO task_history_roles(task_id, role_id) VALUES(?, ?)").run(task.id, role);
      }
      changed = true;
    }
    if (changed) {
      for (const scope of changedScopes) this.db.query("INSERT INTO task_history_rollups(scope, body) VALUES(?, ?) ON CONFLICT(scope) DO UPDATE SET body=excluded.body").run(scope, JSON.stringify(this.rollups.get(scope)!));
      this.db.run("UPDATE task_history_revision SET revision = revision + 1 WHERE one = 1");
      this.revision += 1;
      if (timingChanged) this.readSteps();
      this.metadata = undefined;
    }
    return changed;
  }

  get(id: Id): Task | undefined {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM task_history WHERE id = ?").get(id);
    return row ? JSON.parse(row.body) as Task : undefined;
  }

  item(id: Id): HistoryPage["items"][number] | undefined {
    const row = this.db.query<{ item: string }, [string]>("SELECT item FROM task_history WHERE id = ?").get(id);
    return row ? JSON.parse(row.item) as HistoryPage["items"][number] : undefined;
  }

  /** Finished tasks for one product, read before that product's history is removed. */
  taskIds(productId: Id): Id[] {
    return this.db.query<{ id: string }, [string]>("SELECT id FROM task_history WHERE product_id = ?").all(productId).map((row) => row.id);
  }

  title(id: Id): string | undefined {
    return this.db.query<{ title: string }, [string]>("SELECT title FROM task_history WHERE id = ?").get(id)?.title;
  }

  /** Only the first start of tracking needs this old-work marker, streamed without task bodies. */
  *earlierWork(): Generator<{ id: Id; productId: Id }> {
    for (const row of this.db.query<{ id: string; product_id: string }, []>("SELECT id, product_id FROM task_history WHERE json_extract(body, '$.startedAt') IS NOT NULL").iterate()) yield { id: row.id, productId: row.product_id };
  }

  /** Only the fields affecting visible totals/cards: conversations and output need no repeated scan. */
  needsUpdate(tasks: readonly Task[]): boolean {
    return tasks.some((task) => {
      const shape = this.shapes.get(task.id);
      if (shape !== undefined) return shape !== this.shape(task);
      const old = this.get(task.id);
      if (!old) return true;
      this.rememberShape(old);
      return this.shapes.get(task.id) !== this.shape(task);
    });
  }

  /** Explicit compatibility/debug read. Normal engine and window updates never call this. */
  all(): Task[] {
    return this.db.query<{ body: string }, []>("SELECT body FROM task_history ORDER BY finished_at DESC, id DESC").all().map((row) => JSON.parse(row.body) as Task);
  }

  has(id: Id): boolean {
    return !!this.db.query("SELECT 1 FROM task_history WHERE id = ?").get(id);
  }

  byClient(clientId: Id): Id | undefined {
    return this.db.query<{ id: string }, [string]>("SELECT id FROM task_history WHERE client_id = ? LIMIT 1").get(clientId)?.id;
  }

  usesRole(roleId: Id): boolean {
    return !!this.db.query("SELECT 1 FROM task_history_roles WHERE role_id = ? LIMIT 1").get(roleId);
  }

  /** Product removal already asks before discarding its finished task history. */
  removeProduct(productId: Id): void {
    const product = this.rollups.get(productId);
    if (!product) return;
    const total = this.rollups.get("") ?? emptyRollup();
    total.total -= product.total;
    total.done -= product.done;
    total.cancelled -= product.cancelled;
    total.reviews = subtractReviewStats(total.reviews, product.reviews);
    this.rollups.set("", total);
    this.rollups.delete(productId);
    this.db.query("DELETE FROM task_history_search WHERE rowid IN (SELECT rowid FROM task_history WHERE product_id = ?)").run(productId);
    this.db.query("DELETE FROM task_history_roles WHERE task_id IN (SELECT id FROM task_history WHERE product_id = ?)").run(productId);
    this.db.query("DELETE FROM task_history_steps WHERE task_id IN (SELECT id FROM task_history WHERE product_id = ?)").run(productId);
    this.db.query("DELETE FROM task_history WHERE product_id = ?").run(productId);
    this.db.query("DELETE FROM task_history_rollups WHERE scope = ?").run(productId);
    this.db.query("INSERT INTO task_history_rollups(scope, body) VALUES('', ?) ON CONFLICT(scope) DO UPDATE SET body=excluded.body").run(JSON.stringify(total));
    this.db.run("UPDATE task_history_revision SET revision = revision + 1 WHERE one = 1");
    this.revision += 1;
    this.readSteps();
    this.metadata = undefined;
  }

  page(request: HistoryQuery): HistoryPage {
    const size = Math.max(1, Math.min(100, Math.floor(Number.isFinite(request.limit) ? request.limit! : 24)));
    const args: SQLQueryBindings[] = [];
    const where: string[] = [];
    if (request.productId) { where.push("h.product_id = ?"); args.push(request.productId); }
    // Quoted prefix terms keep punctuation from becoming FTS syntax and use its inverted index.
    const terms = (request.query ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
    const search = terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(" AND ");
    if (search) { where.push("h.rowid IN (SELECT rowid FROM task_history_search WHERE task_history_search MATCH ?)"); args.push(search); }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = search
      ? this.db.query<{ total: number }, SQLQueryBindings[]>(`SELECT count(*) AS total FROM task_history h ${filter}`).get(...args)!.total
      : (this.rollups.get(request.productId ?? "")?.total ?? 0);
    if (request.cursor) {
      const cursor = readHistoryCursor(request.cursor);
      where.push("(h.finished_at, h.id) < (?, ?)");
      args.push(cursor.at, cursor.id);
    }
    args.push(size + 1);
    const rows = this.db.query<{ item: string }, SQLQueryBindings[]>(`SELECT h.item FROM task_history h ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY h.finished_at DESC, h.id DESC LIMIT ?`).all(...args);
    const items = rows.slice(0, size).map((row) => JSON.parse(row.item) as HistoryPage["items"][number]);
    return { items, total, ...(rows.length > size && items.length ? { nextCursor: historyCursor(items.at(-1)!) } : {}) };
  }

  info(): HistoryMetadata {
    if (this.metadata) return this.metadata;
    const total = this.rollups.get("") ?? emptyRollup();
    const products = [...this.rollups].filter(([scope, row]) => !!scope && row.total > 0);
    this.metadata = {
      revision: this.revision, total: total.total,
      products: products.map(([productId, row]) => ({ productId, done: row.done, cancelled: row.cancelled })),
      reviews: total.reviews, reviewsByProduct: Object.fromEntries(products.map(([productId, row]) => [productId, row.reviews])),
      steps: this.recentSteps,
    };
    return this.metadata;
  }

  /** Restore the in-memory rollups after an interrupted transaction, or once when opening. */
  reloadMetadata(): void {
    this.shapes.clear();
    this.rollups.clear();
    for (const row of this.db.query<{ scope: string; body: string }, []>("SELECT scope, body FROM task_history_rollups").all()) this.rollups.set(row.scope, JSON.parse(row.body) as Rollup);
    this.revision = this.db.query<{ revision: number }, []>("SELECT revision FROM task_history_revision WHERE one = 1").get()!.revision;
    this.readSteps();
    this.metadata = undefined;
  }

  private shape(task: Task): string {
    return JSON.stringify([historyItem(task), task.findings, task.plan, task.rounds, task.sentBack, task.stageIndex, task.steps]);
  }

  private rememberShape(task: Task): void {
    this.shapes.delete(task.id);
    this.shapes.set(task.id, this.shape(task));
    if (this.shapes.size > 64) this.shapes.delete(this.shapes.keys().next().value!);
  }

  /** One indexed seek per role/pass, never a window function scanning the whole archive. */
  private readSteps(): void {
    this.recentSteps = [];
    for (const kind of this.db.query<{ role_id: string; repeat: number }, []>("SELECT role_id, repeat FROM task_history_step_kinds").all()) {
      const rows = this.db.query<{ role_id: string; repeat: number; worked: number; at: number }, [string, number, number]>("SELECT role_id, repeat, worked, at FROM task_history_steps WHERE role_id = ? AND repeat = ? ORDER BY at DESC, task_id DESC, position DESC LIMIT ?").all(kind.role_id, kind.repeat, HISTORY);
      this.recentSteps.push(...rows.map((row) => ({ roleId: row.role_id, repeat: !!row.repeat, worked: row.worked, at: row.at })));
    }
  }
}
