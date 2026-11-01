import { WaitClock as CoreWaitClock } from "@petrina/core";
// The work log in SQLite, next to the engine's state: one row per agent turn, one row per
// model per turn, one row per notable moment, and the permanent list of every product.
// Kept forever. Only numbers, names and ids go in; the app never receives it in bulk.

import type { Database } from "bun:sqlite";
import {
  sameReading,
  USAGE_HISTORY_MS,
  type Id,
  type MomentFilter,
  type ProductRecord,
  type Tally,
  type TaskTally,
  type TokenLine,
  type TurnFilter,
  type UsageHistoryFilter,
  type UsageReport,
  type WorkLogReader,
  type WorkMoment,
  type WorkTurn,
} from "@petrina/core";
import {
  lineOf,
  momentOf,
  num,
  productOf,
  readingOf,
  tallyOfRow,
  TALLY_COLUMNS,
  turnOf,
  where,
  WORKLOG_SCHEMA,
  type LineRow,
  type MomentRow,
  type ProductRow,
  type ReadingRow,
  type TurnRow,
} from "./worklog-schema.js";

/** The engine's work log. Every write is synchronous, so nothing is lost between two turns. */
export class WorkLog implements WorkLogReader {
  private closed = false;
  private retryKeys?: string[];

  constructor(private readonly db: Database) {
    db.transaction(() => {
      for (const statement of WORKLOG_SCHEMA) db.run(statement);
      const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(work_turns)").all().map(row => row.name));
      for (const column of ["journey_id", "agent_run_id", "agent_seat"]) if (!columns.has(column)) db.run(`ALTER TABLE work_turns ADD COLUMN ${column} TEXT`);
      const readingColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(usage_readings)").all().map(row => row.name));
      if (!readingColumns.has("overage")) db.run("ALTER TABLE usage_readings ADD COLUMN overage INTEGER");
    }).immediate();
  }

  close(): void {
    this.closed = true;
  }

  // ── Tracking ───────────────────────────────────────────────────────────

  private meta(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM work_meta WHERE key = ?").get(key)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO work_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** When Petrina started keeping track: set once, on the first start with a work log. */
  ensureSince(now: number): { since: number; fresh: boolean } {
    const saved = Number(this.meta("since"));
    if (Number.isFinite(saved) && saved > 0) return { since: saved, fresh: false };
    this.setMeta("since", String(now));
    return { since: now, fresh: true };
  }

  since(): number {
    return Number(this.meta("since")) || Date.now();
  }

  /** Steps a usage limit stopped, whose next attempt is a retry: kept here, so a restart while they wait keeps them. */
  owedRetries(): string[] {
    // Stopping: the database may already be gone, and nothing is owed any more.
    if (this.closed) return [];
    if (this.retryKeys) return [...this.retryKeys];
    try {
      const saved = JSON.parse(this.meta("owed-retries") ?? "[]") as unknown;
      this.retryKeys = Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : [];
      return [...this.retryKeys];
    } catch {
      return [];
    }
  }

  setOwedRetries(keys: readonly string[]): void {
    if (this.closed) return;
    this.setMeta("owed-retries", JSON.stringify(keys));
    this.retryKeys = [...keys];
  }

  /** Turns left unfinished when Petrina stopped: their time and tokens are unknown. */
  markLost(): number {
    return this.db.run("UPDATE work_turns SET end_kind = 'lost', work_ms = NULL, at = started_at WHERE end_kind IS NULL").changes;
  }

  // ── Writing ────────────────────────────────────────────────────────────

  startTurn(turn: WorkTurn): void {
    if (this.closed) return;
    this.db
      .query(
        `INSERT INTO work_turns (id, task_id, product_id, stage_id, stage_title, stage_kind, round, fixing, role_id, tool_id, profile_id,
          model_asked, model_asked_name, effort_asked, model_ran, model_ran_name, effort_ran, session_id, reason, started_at, at, journey_id, agent_run_id, agent_seat, main_only, helpers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        turn.id,
        turn.taskId,
        turn.productId,
        turn.stageId,
        turn.stageTitle,
        turn.stageKind,
        turn.round,
        turn.fixing ? 1 : 0,
        turn.roleId,
        turn.toolId,
        turn.profileId,
        turn.modelAsked ?? null,
        turn.modelAskedName ?? null,
        turn.effortAsked ?? null,
        turn.modelRan ?? null,
        turn.modelRanName ?? null,
        turn.effortRan ?? null,
        turn.sessionId,
        turn.reason,
        turn.startedAt,
        turn.startedAt,
        turn.journeyId ?? null,
        turn.agentRunId ?? null,
        turn.agentSeat ?? null,
      );
  }

  endTurn(turnId: Id, update: Required<Pick<WorkTurn, "end" | "endedAt" | "mainOnly" | "helpers">> & Pick<WorkTurn, "workMs" | "tokens" | "modelChangedTo" | "effortChangedTo" | "modelRan">, lines: readonly Omit<TokenLine, "turnId">[]): void {
    if (this.closed) return;
    const tokens = update.tokens ?? {};
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE work_turns SET end_kind = ?, ended_at = ?, at = ?, work_ms = ?, main_only = ?, helpers = ?, model_changed_to = ?, effort_changed_to = ?,
            input = ?, cache_read = ?, cache_write = ?, output = ?, reasoning = ?, total = ?, model_ran = COALESCE(?, model_ran) WHERE id = ?`,
        )
        .run(
          update.end,
          update.endedAt,
          update.endedAt,
          num(update.workMs),
          update.mainOnly ? 1 : 0,
          update.helpers,
          update.modelChangedTo ?? null,
          update.effortChangedTo ?? null,
          num(tokens.input),
          num(tokens.cacheRead),
          num(tokens.cacheWrite),
          num(tokens.output),
          num(tokens.reasoning),
          num(tokens.total),
          update.modelRan ?? null,
          turnId,
        );
      this.db.query("DELETE FROM work_tokens WHERE turn_id = ?").run(turnId);
      const insert = this.db.query(
        `INSERT INTO work_tokens (turn_id, model, changed, input, cache_read, cache_write, output, reasoning, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(turn_id, model) DO UPDATE SET input = excluded.input, cache_read = excluded.cache_read, cache_write = excluded.cache_write, output = excluded.output, reasoning = excluded.reasoning, total = excluded.total`,
      );
      for (const line of lines) insert.run(
        turnId,
        line.model,
        line.changed ? 1 : 0,
        num(line.input),
        num(line.cacheRead),
        num(line.cacheWrite),
        num(line.output),
        num(line.reasoning),
        num(line.total)
      );
    })();
  }

  addMoment(moment: WorkMoment): void {
    if (this.closed) return;
    const { id, at, kind, taskId, productId, ...rest } = moment;
    this.db.query("INSERT INTO work_moments (id, at, kind, task_id, product_id, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(
      id,
      at,
      kind,
      taskId,
      productId,
      JSON.stringify(rest)
    );
  }

  markUntracked(taskId: Id, productId: Id, at: number): void {
    this.addMoment({ id: `untracked:${taskId}`, at, kind: "untracked", taskId, productId });
  }

  /** Add or update a product's permanent entry. An entry is never deleted. */
  recordProduct(record: ProductRecord): void {
    if (this.closed) return;
    this.db
      .query(
        `INSERT INTO products_ever (id, name, repo, added_at, removed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name), repo = COALESCE(excluded.repo, repo), added_at = COALESCE(added_at, excluded.added_at), removed_at = COALESCE(excluded.removed_at, removed_at)`,
      )
      .run(record.id, record.name ?? null, record.repo ?? null, record.addedAt ?? null, record.removedAt ?? null);
  }

  // ── Usage limits over time ─────────────────────────────────────────────

  /**
   * A tool said how much of a limit is used. Kept for thirty days; a reading identical to the latest
   * one of its limit is not written again, so a tool repeating itself on every turn leaves one row.
   * True when a row was written.
   */
  recordUsage(report: UsageReport): boolean {
    if (this.closed) return false;
    const cutoff = report.at - USAGE_HISTORY_MS;
    const latest = this.db
      .query<ReadingRow, [string, string, string]>("SELECT * FROM usage_readings WHERE tool_id = ? AND kind = ? AND model = ? ORDER BY at DESC, seq DESC LIMIT 1")
      .get(report.toolId, report.kind, report.model ?? "");
    if (latest && latest.at >= cutoff && sameReading(readingOf(latest), report)) return false;
    return this.db.transaction(() => {
      this.db.query("DELETE FROM usage_readings WHERE at < ?").run(cutoff);
      this.db
        .query("INSERT INTO usage_readings (tool_id, kind, model, status, utilization, window_minutes, name, resets_at, overage, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          report.toolId,
          report.kind,
          report.model ?? "",
          report.status,
          num(report.utilization),
          num(report.windowMinutes),
          report.name ?? null,
          num(report.resetsAt),
          report.overage === undefined ? null : report.overage ? 1 : 0,
          report.at,
        );
      return true;
    })();
  }

  usageHistory(filter: UsageHistoryFilter): UsageReport[] {
    const parts: string[] = [];
    const params: number[] = [];
    if (filter.from !== undefined) parts.push("at >= ?"), params.push(filter.from);
    if (filter.to !== undefined) parts.push("at < ?"), params.push(filter.to);
    const sql = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
    return this.db.query<ReadingRow, number[]>(`SELECT * FROM usage_readings ${sql} ORDER BY at, seq`).all(...params).map(readingOf);
  }

  // ── Ids that are never handed out again ─────────────────────────────────

  productIdTaken(id: Id): boolean {
    return (
      this.db.query<{ n: number }, [string, string, string]>(
        "SELECT (SELECT COUNT(*) FROM products_ever WHERE id = ?) + (SELECT COUNT(*) FROM work_turns WHERE product_id = ?) + (SELECT COUNT(*) FROM work_moments WHERE product_id = ?) AS n",
      ).get(id, id, id)!.n > 0
    );
  }

  knowsProduct(id: Id): boolean {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM products_ever WHERE id = ?").get(id)!.n > 0;
  }

  taskIdTaken(id: Id): boolean {
    return this.db.query<{ n: number }, [string, string]>("SELECT (SELECT COUNT(*) FROM work_turns WHERE task_id = ?) + (SELECT COUNT(*) FROM work_moments WHERE task_id = ?) AS n").get(
      id,
      id
    )!.n > 0;
  }

  /** The highest `task-N` number in the log, so ids keep counting up even if the state is lost. */
  highestTaskNumber(): number {
    return this.db.query<{ n: number | null }, []>(`SELECT MAX(n) AS n FROM (
      SELECT MAX(CAST(substr(task_id, 6) AS INTEGER)) AS n FROM work_turns WHERE task_id GLOB 'task-[0-9]*' AND substr(task_id, 6) NOT GLOB '*[^0-9]*'
      UNION ALL
      SELECT MAX(CAST(substr(task_id, 6) AS INTEGER)) AS n FROM work_moments WHERE task_id GLOB 'task-[0-9]*' AND substr(task_id, 6) NOT GLOB '*[^0-9]*'
    )`).get()!.n ?? 0;
  }

  // ── Stages ─────────────────────────────────────────────────────────────

  /** The task's stage that started and hasn't ended, if any. */
  openStage(taskId: Id): WorkMoment | undefined {
    const row = this.db
      .query<{ id: string; at: number; kind: string; task_id: string; product_id: string; data: string }, [string]>(
        "SELECT id, at, kind, task_id, product_id, data FROM work_moments WHERE task_id = ? AND kind IN ('stage-start', 'stage-end') ORDER BY seq DESC LIMIT 1",
      )
      .get(taskId);
    if (!row || row.kind !== "stage-start") return undefined;
    return { ...(JSON.parse(row.data) as object), id: row.id, at: row.at, kind: "stage-start", taskId: row.task_id, productId: row.product_id };
  }

  stageRuns(taskId: Id, stageId: Id): number {
    return this.db.query<{ count: number }, [string, string]>("SELECT COUNT(*) AS count FROM work_moments WHERE task_id = ? AND json_extract(data, '$.stageId') = ? AND kind = 'stage-start'").get(
      taskId,
      stageId
    )!.count;
  }

  stageWork(taskId: Id, stageId: Id, since: number): number {
    return this.db.query<{ ms: number | null }, [string, string, number]>("SELECT SUM(work_ms) AS ms FROM work_turns WHERE task_id = ? AND stage_id = ? AND started_at >= ?").get(
      taskId,
      stageId,
      since
    )!.ms ?? 0;
  }

  // ── Reading ────────────────────────────────────────────────────────────

  turns(filter: TurnFilter): WorkTurn[] {
    const { sql, params } = where(filter);
    return this.db.query<TurnRow, (string | number)[]>(`SELECT * FROM work_turns ${sql} ORDER BY started_at`).all(...params).map(turnOf);
  }

  lines(filter: TurnFilter): TokenLine[] {
    const { sql, params } = where(filter, "t.");
    return this.db
      .query<LineRow, (string | number)[]>(`SELECT k.* FROM work_tokens k JOIN work_turns t ON t.id = k.turn_id ${sql}`)
      .all(...params)
      .map(lineOf);
  }

  moments(filter: MomentFilter): WorkMoment[] {
    const { sql, params } = where(filter, "", true);
    const kinds = filter.kinds?.length ? `${sql ? " AND" : "WHERE"} kind IN (${filter.kinds.map(() => "?").join(", ")})` : "";
    return this.db
      .query<MomentRow, (string | number)[]>(`SELECT id, at, kind, task_id, product_id, data FROM work_moments ${sql}${kinds} ORDER BY seq`)
      .all(...params, ...(filter.kinds ?? []))
      .map(momentOf);
  }

  /** Find the original request directly, even after pause or restart removed its inbox item. */
  moment(id: Id): WorkMoment | undefined {
    const row = this.db.query<MomentRow, [string]>("SELECT id, at, kind, task_id, product_id, data FROM work_moments WHERE id = ?").get(id);
    return row ? momentOf(row) : undefined;
  }

  /** All-time sums per product, added up by SQLite so a year of turns stays fast. */
  productTallies(): Map<Id, Tally> {
    const rows = this.db
      .query<Record<string, number> & { product_id: string }, []>(
        `SELECT product_id, ${TALLY_COLUMNS}
         FROM work_turns WHERE end_kind IS NOT NULL GROUP BY product_id`,
      )
      .all();
    return new Map(rows.map(row => [row.product_id, tallyOfRow(row)]));
  }

  taskTallies(taskIds: readonly Id[]): Map<Id, TaskTally> {
    if (!taskIds.length) return new Map();
    // Aggregate only the page's tasks; even a long task yields one row. The marker lookup
    // uses the task/kind index and never reads moment data or archived task bodies.
    const ids = [...new Set(taskIds)];
    const rows = this.db.query<Record<string, unknown> & { id: string; untracked: number }, string[]>(`
      WITH requested(task_id) AS (VALUES ${ids.map(() => "(?)").join(", ")}),
      tallies AS (
        SELECT task_id, ${TALLY_COLUMNS} FROM work_turns
        WHERE task_id IN (SELECT task_id FROM requested) AND end_kind IS NOT NULL GROUP BY task_id
      )
      SELECT requested.task_id AS id, tallies.*,
        EXISTS (SELECT 1 FROM work_moments m WHERE m.task_id = requested.task_id AND m.kind = 'untracked') AS untracked
      FROM requested LEFT JOIN tallies USING (task_id)
    `).all(...ids);
    return new Map(rows.map(row => [row.id, { tally: tallyOfRow(row), untracked: !!row.untracked }]));
  }

  untracked(): Map<Id, Id> {
    const rows = this.db.query<{ task_id: string; product_id: string }, []>("SELECT task_id, product_id FROM work_moments WHERE kind = 'untracked'").all();
    return new Map(rows.map((row) => [row.task_id, row.product_id]));
  }

  products(): ProductRecord[] {
    return this.db
      .query<ProductRow, []>("SELECT * FROM products_ever")
      .all()
      .map(productOf);
  }
}

/** Native clock defaults stay at the persistence/runtime boundary. */
export class WaitClock extends CoreWaitClock {
  override start(taskId: Id, now = Date.now()): void { super.start(taskId, now); }
  override stop(taskId: Id, now = Date.now()): void { super.stop(taskId, now); }
  override of(taskId: Id, now = Date.now()): number { return super.of(taskId, now); }
}
