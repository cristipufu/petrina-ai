// Completed tasks live outside the live snapshot. The board only reads the small current state;
// history uses an index for its next page and reads a conversation only when it is opened.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { EVIDENCE_STEP_LIMIT, EVIDENCE_TASK_LIMIT, type CheckEvidenceTask } from "./related-check-evidence.js";
import { blocksDependents, combineReviewStats, productHistory, taskProductIds, withoutProduct, finishedTask, historyStatus, historyAt, historyCursor, historyItem, readHistoryCursor, reviewStats, subtractReviewStats, HISTORY, type HistoryDependency, type HistoryMetadata, type HistoryPage, type HistoryQuery, type Id, type ReviewStats, type StepRecord, type Task } from "@petrina/core";

interface Rollup { total: number; done: number; cancelled: number; shared?: number; blocked?: number; reviews: ReviewStats }
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
      steps TEXT NOT NULL, roles TEXT NOT NULL, final_status TEXT NOT NULL DEFAULT 'marked-done'
    )`);
    db.transaction(() => {
      const columns = db.query<{ name: string }, []>("PRAGMA table_info(task_history)").all();
      if (!columns.some(column => column.name === "final_status")) {
        db.run("ALTER TABLE task_history ADD COLUMN final_status TEXT NOT NULL DEFAULT 'marked-done'");
        // One schema upgrade, in bounded pages of card summaries; never deserialize task bodies.
        const read = db.query<{ id: string; item: string }, [string]>("SELECT id, item FROM task_history WHERE id > ? ORDER BY id LIMIT 256");
        const write = db.query("UPDATE task_history SET final_status = ? WHERE id = ?");
        let after = "";
        for (;;) {
          const rows = read.all(after);
          if (!rows.length) break;
          for (const row of rows) write.run(historyStatus(JSON.parse(row.item)), row.id);
          after = rows.at(-1)!.id;
        }
      }
      db.run("CREATE INDEX IF NOT EXISTS task_history_status_newest ON task_history(final_status, finished_at DESC, id DESC)");
    }).immediate();
    db.run("CREATE INDEX IF NOT EXISTS task_history_newest ON task_history(finished_at DESC, id DESC)");
    db.run("CREATE INDEX IF NOT EXISTS task_history_product_newest ON task_history(product_id, finished_at DESC, id DESC)");
    db.run("CREATE INDEX IF NOT EXISTS task_history_routine_newest ON task_history(json_extract(body, '$.maintenance.routineId'), finished_at DESC, id DESC) WHERE json_extract(body, '$.maintenance.routineId') IS NOT NULL");
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
    const indexed = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_history_products'").get();
    db.transaction(() => {
      db.run("CREATE TABLE IF NOT EXISTS task_history_products (task_id TEXT NOT NULL, product_id TEXT NOT NULL, finished_at INTEGER NOT NULL, PRIMARY KEY(task_id, product_id))");
      db.run("CREATE INDEX IF NOT EXISTS task_history_membership_newest ON task_history_products(product_id, finished_at DESC, task_id DESC)");
      if (!indexed) this.migrateMemberships();
    }).immediate();
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
      const item = historyItem(task);
      const old = this.db.query<{ rowid: number; product_id: string; state: string; title: string; body: string; reviews: string; steps: string; roles: string }, [string]>("SELECT rowid, product_id, state, title, body, reviews, steps, roles FROM task_history WHERE id = ?").get(task.id);
      this.rememberShape(task);
      if (old?.body === body) continue;
      const priorTask = old ? JSON.parse(old.body) as Task : undefined;
      const priorProducts = old ? this.memberships(task.id) : [];
      const products = taskProductIds(task);
      const reviews = reviewStats([task]);
      const steps = JSON.stringify(task.steps ?? []);
      const roles = JSON.stringify([...new Set((task.plan?.stages ?? []).flatMap((stage) => [stage.roleId, stage.reviewerRoleId, ...(stage.roleIds ?? [])]).filter((id): id is string => !!id))]);
      this.db.query(`INSERT INTO task_history(id, product_id, title, finished_at, state, client_id, item, body, reviews, steps, roles, final_status)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        product_id=excluded.product_id, title=excluded.title, finished_at=excluded.finished_at, state=excluded.state,
        client_id=excluded.client_id, item=excluded.item, body=excluded.body, reviews=excluded.reviews, steps=excluded.steps, roles=excluded.roles, final_status=excluded.final_status`)
        .run(task.id, task.productId, task.title, historyAt(task), task.state, task.clientId ?? null, JSON.stringify(item), body, JSON.stringify(reviews), steps, roles, historyStatus(item));
      const rowid = old?.rowid ?? this.db.query<{ rowid: number }, [string]>("SELECT rowid FROM task_history WHERE id = ?").get(task.id)!.rowid;
      if (!old || old.title !== task.title) {
        if (old) this.db.query("DELETE FROM task_history_search WHERE rowid = ?").run(rowid);
        this.db.query("INSERT INTO task_history_search(rowid, title) VALUES(?, ?)").run(rowid, task.title);
      }
      this.db.query("DELETE FROM task_history_products WHERE task_id = ?").run(task.id);
      for (const productId of products) this.db.query("INSERT INTO task_history_products(task_id, product_id, finished_at) VALUES(?, ?, ?)").run(task.id, productId, historyAt(task));
      if (old) for (const scope of new Set(["", ...priorProducts])) {
        const rollup = this.rollups.get(scope) ?? emptyRollup();
        rollup.total -= 1;
        rollup.shared = (rollup.shared ?? 0) - Number(priorProducts.length > 1);
        if (scope) rollup.blocked = (rollup.blocked ?? 0) - productHistory([priorTask!], scope).unfinished;
        if (old.state === "done") rollup.done -= 1; else rollup.cancelled -= 1;
        rollup.reviews = subtractReviewStats(rollup.reviews, JSON.parse(old.reviews) as ReviewStats);
        this.rollups.set(scope, rollup);
        changedScopes.add(scope);
      }
      for (const scope of new Set(["", ...products])) {
        const rollup = this.rollups.get(scope) ?? emptyRollup();
        rollup.total += 1;
        rollup.shared = (rollup.shared ?? 0) + Number(products.length > 1);
        if (scope) rollup.blocked = (rollup.blocked ?? 0) + productHistory([task], scope).unfinished;
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

  /** Bounded product seek and a restricted projection: never return archived prompts or reports. */
  checkEvidence(productId: Id): CheckEvidenceTask[] {
    const tail = (field: string, limit: number) => `json((SELECT json_group_array(json(value)) FROM
      (SELECT value FROM json_each(step.value, '$.${field}') WHERE json_extract(value, '$.productId') = recent.scoped_product
        ORDER BY CAST(key AS INTEGER) DESC LIMIT ${limit})))`;
    const rows = this.db.query<{ id: string; state: Task["state"]; held: number; journey: string; delivery: string | null }, [string, number, string, string]>(`
      WITH recent AS (SELECT h.id, h.state, h.body, p.product_id AS scoped_product FROM task_history_products p JOIN task_history h ON h.id = p.task_id
        WHERE p.product_id = ? ORDER BY p.finished_at DESC, p.task_id DESC LIMIT ?)
      SELECT id, state, json_extract(body, '$.held') AS held,
        (SELECT json_group_array(json_object('id', json_extract(step.value, '$.id'), 'kind', json_extract(step.value, '$.kind'),
          'startedAt', json_extract(step.value, '$.startedAt'), 'endedAt', json_extract(step.value, '$.endedAt'), 'end', json_extract(step.value, '$.end'),
          'productChecks', ${tail("productChecks", 32)}, 'checkAttempts', ${tail("checkAttempts", 8)},
          'checkRepairs', ${tail("checkRepairs", 8)}, 'checkReviews', ${tail("checkReviews", 8)},
          'buildVersions', json((SELECT json_group_object(key, value) FROM json_each(step.value, '$.buildVersions') WHERE key = recent.scoped_product)),
          'buildProductId', CASE WHEN json_extract(step.value, '$.buildProductId') = recent.scoped_product THEN recent.scoped_product END))
          FROM (SELECT value FROM json_each(recent.body, '$.journey') ORDER BY CAST(key AS INTEGER) DESC LIMIT ${EVIDENCE_STEP_LIMIT}) step) AS journey,
        COALESCE((SELECT json_extract(value, '$.confirmedDelivery') FROM json_each(body, '$.repositories') WHERE json_extract(value, '$.productId') = ?),
          CASE WHEN json_extract(body, '$.repository.productId') = ? THEN json_extract(body, '$.repository.confirmedDelivery') END) AS delivery
      FROM recent`).all(productId, EVIDENCE_TASK_LIMIT, productId, productId);
    return rows.map((row) => ({ id: row.id, state: row.state, held: !!row.held,
      journey: (JSON.parse(row.journey) as CheckEvidenceTask["journey"]).slice().reverse(),
      ...(row.delivery ? { delivery: JSON.parse(row.delivery) } : {}) }));
  }

  item(id: Id): HistoryPage["items"][number] | undefined {
    const row = this.db.query<{ item: string }, [string]>("SELECT item FROM task_history WHERE id = ?").get(id);
    return row ? JSON.parse(row.item) as HistoryPage["items"][number] : undefined;
  }

  /** Dependency decisions need delivery state, never the archived conversation or check output. */
  dependency(id: Id): HistoryDependency | undefined {
    const row = this.db.query<{ item: string; repositories: string }, [string]>(`SELECT item,
      (SELECT json_group_array(json_object('pr', json_extract(value, '$.pr'),
        'shipping', json_object('step', json_extract(value, '$.shipping.step')),
        'localUpdate', json_extract(value, '$.localUpdate'),
        'landingAccepted', json_extract(value, '$.landingAccepted')))
        FROM json_each(task_history.body, '$.repositories')) AS repositories
      FROM task_history WHERE id = ?`).get(id);
    if (!row) return;
    const item = JSON.parse(row.item) as HistoryPage["items"][number];
    const repositories = JSON.parse(row.repositories) as Task["repositories"];
    return { ...item, blocksDependents: blocksDependents({ state: item.state, repositories }) };
  }

  /** Finished tasks for one product, read before that product's history is removed. */
  taskIds(productId: Id): Id[] {
    return this.db.query<{ id: string }, [string]>("SELECT task_id AS id FROM task_history_products WHERE product_id = ?").all(productId).map((row) => row.id);
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
    type Removal = { task_id: string; finished_at: number; state: string; reviews: string; shared: number };
    let before: { at: number; id: Id } | undefined;
    let changed = false;
    for (;;) {
      // The membership index bounds each read even for a product with years of history. Shared
      // tasks need their body to preserve the other products; exclusive tasks need only counters.
      const rows: Removal[] = this.db.query<Removal, SQLQueryBindings[]>(`SELECT p.task_id, p.finished_at, h.state, h.reviews,
        EXISTS(SELECT 1 FROM task_history_products other WHERE other.task_id = p.task_id AND other.product_id != p.product_id) AS shared
        FROM task_history_products p JOIN task_history h ON h.id = p.task_id
        WHERE p.product_id = ? ${before ? "AND (p.finished_at, p.task_id) < (?, ?)" : ""}
        ORDER BY p.finished_at DESC, p.task_id DESC LIMIT 100`).all(productId, ...(before ? [before.at, before.id] : []));
      if (!rows.length) break;
      const last = rows.at(-1)!;
      before = { at: last.finished_at, id: last.task_id };
      const exclusive: Id[] = [];
      for (const row of rows) {
        if (row.shared) {
          const retained = withoutProduct(this.get(row.task_id)!, productId)!;
          this.put([retained]);
          continue;
        }
        const reviews = JSON.parse(row.reviews) as ReviewStats;
        // Every exclusive task contributes once globally and once to this product. Its blocked
        // count is cleared with the removed product below; no task body is needed to work it out.
        for (const scope of ["", productId]) {
          const rollup = this.rollups.get(scope)!;
          rollup.total -= 1;
          if (row.state === "done") rollup.done -= 1; else rollup.cancelled -= 1;
          rollup.reviews = subtractReviewStats(rollup.reviews, reviews);
        }
        exclusive.push(row.task_id);
        this.shapes.delete(row.task_id);
      }
      if (exclusive.length) {
        const parameters = exclusive.map(() => "?").join(", ");
        this.db.query(`DELETE FROM task_history_search WHERE rowid IN (SELECT rowid FROM task_history WHERE id IN (${parameters}))`).run(...exclusive);
        for (const table of ["task_history_roles", "task_history_steps", "task_history_products"]) this.db.query(`DELETE FROM ${table} WHERE task_id IN (${parameters})`).run(...exclusive);
        this.db.query(`DELETE FROM task_history WHERE id IN (${parameters})`).run(...exclusive);
      }
      changed = true;
    }
    if (!changed) return;
    this.rollups.set(productId, emptyRollup());
    for (const [scope, rollup] of this.rollups) this.db.query("INSERT INTO task_history_rollups(scope, body) VALUES(?, ?) ON CONFLICT(scope) DO UPDATE SET body=excluded.body").run(scope, JSON.stringify(rollup));
    this.db.run("UPDATE task_history_revision SET revision = revision + 1 WHERE one = 1");
    this.revision += 1;
    this.readSteps();
    this.metadata = undefined;
  }

  page(request: HistoryQuery): HistoryPage {
    const size = Math.max(1, Math.min(100, Math.floor(Number.isFinite(request.limit) ? request.limit! : 24)));
    const args: SQLQueryBindings[] = [];
    const where: string[] = [];
    const membership = request.productId && !request.routineId && !request.status;
    const from = membership ? "task_history_products p JOIN task_history h ON h.id = p.task_id" : "task_history h";
    const order = membership ? "p.finished_at, p.task_id" : "h.finished_at, h.id";
    if (request.productId) { where.push(membership ? "p.product_id = ?" : "EXISTS (SELECT 1 FROM task_history_products p WHERE p.task_id = h.id AND p.product_id = ?)"); args.push(request.productId); }
    if (request.routineId) { where.push("json_extract(h.body, '$.maintenance.routineId') = ?"); args.push(request.routineId); }
    if (request.status) { where.push("h.final_status = ?"); args.push(request.status); }
    if (request.taskId) { where.push("h.id = ?"); args.push(request.taskId); }
    if (request.states) { where.push(`h.state IN (${request.states.map(() => "?").join(",")})`); args.push(...request.states); }
    if (request.held !== undefined) { where.push("json_extract(h.body, '$.held') = ?"); args.push(Number(request.held)); }
    // Quoted prefix terms keep punctuation from becoming FTS syntax and use its inverted index.
    const terms = (request.query ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
    const search = terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(" AND ");
    if (search) { where.push("h.rowid IN (SELECT rowid FROM task_history_search WHERE task_history_search MATCH ?)"); args.push(search); }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = search || request.status || request.routineId || request.taskId || request.states || request.held !== undefined
      ? this.db.query<{ total: number }, SQLQueryBindings[]>(`SELECT count(*) AS total FROM ${from} ${filter}`).get(...args)!.total
      : (this.rollups.get(request.productId ?? "")?.total ?? 0);
    if (request.cursor) {
      const cursor = readHistoryCursor(request.cursor);
      where.push(`(${order}) < (?, ?)` );
      args.push(cursor.at, cursor.id);
    }
    args.push(size + 1);
    const rows = this.db.query<{ item: string }, SQLQueryBindings[]>(`SELECT h.item FROM ${from} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order.split(", ").map((field) => `${field} DESC`).join(", ")} LIMIT ?`).all(...args);
    const items = rows.slice(0, size).map((row) => {
      const item = JSON.parse(row.item) as HistoryPage["items"][number];
      // Older summaries lack this flag. Read only their compact delivery evidence, never bodies.
      return item.blocksDependents === undefined ? this.dependency(item.id)! : item;
    });
    return { items, total, ...(rows.length > size && items.length ? { nextCursor: historyCursor(items.at(-1)!) } : {}) };
  }

  info(): HistoryMetadata {
    if (this.metadata) return this.metadata;
    const total = this.rollups.get("") ?? emptyRollup();
    const products = [...this.rollups].filter(([scope, row]) => !!scope && row.total > 0);
    this.metadata = {
      revision: this.revision, total: total.total,
      products: products.map(([productId, row]) => ({ productId, done: row.done, cancelled: row.cancelled, shared: row.shared ?? 0, blocked: row.blocked ?? 0 })),
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

  private memberships(id: Id): string[] {
    return this.db.query<{ product_id: string }, [string]>("SELECT product_id FROM task_history_products WHERE task_id = ?").all(id).map((row) => row.product_id);
  }

  /** One-time migration streams old records; live updates and paging still use only the index. */
  private migrateMemberships(): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM task_history_rollups");
      for (const row of this.db.query<{ body: string; reviews: string }, []>("SELECT body, reviews FROM task_history").iterate()) {
        const task = JSON.parse(row.body) as Task;
        const products = taskProductIds(task);
        const reviews = JSON.parse(row.reviews) as ReviewStats;
        for (const productId of products) this.db.query("INSERT INTO task_history_products(task_id, product_id, finished_at) VALUES(?, ?, ?)").run(task.id, productId, historyAt(task));
        const item = historyItem(task);
        this.db.query("UPDATE task_history SET item = ?, final_status = ? WHERE id = ?").run(JSON.stringify(item), historyStatus(item), task.id);
        for (const scope of new Set(["", ...products])) {
          const rollup = this.rollups.get(scope) ?? emptyRollup();
          rollup.total += 1;
          if (task.state === "done") rollup.done += 1; else rollup.cancelled += 1;
          rollup.shared = (rollup.shared ?? 0) + Number(products.length > 1);
          if (scope) rollup.blocked = (rollup.blocked ?? 0) + productHistory([task], scope).unfinished;
          rollup.reviews = combineReviewStats(rollup.reviews, reviews);
          this.rollups.set(scope, rollup);
        }
      }
      for (const [scope, rollup] of this.rollups) this.db.query("INSERT INTO task_history_rollups(scope, body) VALUES(?, ?)").run(scope, JSON.stringify(rollup));
    }).immediate();
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
