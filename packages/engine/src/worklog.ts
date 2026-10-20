// The work log in SQLite, next to the engine's state: one row per agent turn, one row per
// model per turn, one row per notable moment, and the permanent list of every product.
// Kept forever. Only numbers, names and ids go in; the app never receives it in bulk.

import type { Database } from "bun:sqlite";
import {
  emptyTally,
  sameReading,
  USAGE_HISTORY_MS,
  type Id,
  type MomentFilter,
  type ProductRecord,
  type Tally,
  type TokenCounts,
  type TokenLine,
  type TurnFilter,
  type UsageHistoryFilter,
  type UsageReport,
  type WorkLogReader,
  type WorkMoment,
  type WorkTurn,
} from "@petrina/core";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS work_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS work_turns (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_title TEXT NOT NULL,
    stage_kind TEXT NOT NULL,
    round INTEGER NOT NULL,
    fixing INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    model_asked TEXT,
    model_asked_name TEXT,
    effort_asked TEXT,
    model_ran TEXT,
    model_ran_name TEXT,
    effort_ran TEXT,
    model_changed_to TEXT,
    effort_changed_to TEXT,
    session_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    at INTEGER NOT NULL,
    end_kind TEXT,
    main_only INTEGER NOT NULL DEFAULT 0,
    helpers INTEGER NOT NULL DEFAULT 0,
    work_ms INTEGER,
    input INTEGER,
    cache_read INTEGER,
    cache_write INTEGER,
    output INTEGER,
    reasoning INTEGER,
    total INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS work_turns_task ON work_turns (task_id)",
  "CREATE INDEX IF NOT EXISTS work_turns_stage_round ON work_turns (task_id, stage_id, round)",
  "CREATE INDEX IF NOT EXISTS work_turns_at ON work_turns (at)",
  "CREATE INDEX IF NOT EXISTS work_turns_product ON work_turns (product_id, at)",
  `CREATE TABLE IF NOT EXISTS work_tokens (
    turn_id TEXT NOT NULL,
    model TEXT NOT NULL,
    changed INTEGER NOT NULL DEFAULT 0,
    input INTEGER,
    cache_read INTEGER,
    cache_write INTEGER,
    output INTEGER,
    reasoning INTEGER,
    total INTEGER,
    PRIMARY KEY (turn_id, model)
  )`,
  `CREATE TABLE IF NOT EXISTS work_moments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    task_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    data TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS work_moments_at ON work_moments (at)",
  "CREATE INDEX IF NOT EXISTS work_moments_task ON work_moments (task_id, kind)",
  "CREATE TABLE IF NOT EXISTS products_ever (id TEXT PRIMARY KEY, name TEXT, repo TEXT, added_at INTEGER, removed_at INTEGER)",
  // Readings of the tools' usage limits: the last thirty days, one row per change of reading.
  `CREATE TABLE IF NOT EXISTS usage_readings (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    utilization REAL,
    window_minutes INTEGER,
    name TEXT,
    resets_at INTEGER,
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS usage_readings_at ON usage_readings (at)",
  "CREATE INDEX IF NOT EXISTS usage_readings_limit ON usage_readings (tool_id, kind, model, at)",
];

interface ReadingRow {
  tool_id: string;
  kind: string;
  model: string;
  status: string;
  utilization: number | null;
  window_minutes: number | null;
  name: string | null;
  resets_at: number | null;
  at: number;
}

function readingOf(row: ReadingRow): UsageReport {
  return {
    toolId: row.tool_id,
    kind: row.kind,
    ...(row.model ? { model: row.model } : {}),
    status: row.status as UsageReport["status"],
    ...opt("utilization", row.utilization),
    ...opt("windowMinutes", row.window_minutes),
    ...opt("name", row.name),
    ...opt("resetsAt", row.resets_at),
    at: row.at,
  };
}

interface TurnRow {
  id: string;
  task_id: string;
  product_id: string;
  stage_id: string;
  stage_title: string;
  stage_kind: string;
  round: number;
  fixing: number;
  role_id: string;
  tool_id: string;
  profile_id: string;
  model_asked: string | null;
  model_asked_name: string | null;
  effort_asked: string | null;
  model_ran: string | null;
  model_ran_name: string | null;
  effort_ran: string | null;
  model_changed_to: string | null;
  effort_changed_to: string | null;
  session_id: string;
  reason: string;
  started_at: number;
  ended_at: number | null;
  end_kind: string | null;
  main_only: number;
  helpers: number;
  work_ms: number | null;
  input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
}

type CountRow = Pick<TurnRow, "input" | "cache_read" | "cache_write" | "output" | "reasoning" | "total">;
type MomentRow = { id: string; at: number; kind: string; task_id: string; product_id: string; data: string };

function momentOf(row: MomentRow): WorkMoment {
  return { ...(JSON.parse(row.data) as object), id: row.id, at: row.at, kind: row.kind as WorkMoment["kind"], taskId: row.task_id, productId: row.product_id };
}

const opt = <K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> => (value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>));

function countsOf(row: CountRow): TokenCounts {
  return { ...opt("input", row.input), ...opt("cacheRead", row.cache_read), ...opt("cacheWrite", row.cache_write), ...opt("output", row.output), ...opt("reasoning", row.reasoning), ...opt("total", row.total) };
}

function turnOf(row: TurnRow): WorkTurn {
  const tokens = countsOf(row);
  return {
    id: row.id,
    taskId: row.task_id,
    productId: row.product_id,
    stageId: row.stage_id,
    stageTitle: row.stage_title,
    stageKind: row.stage_kind as WorkTurn["stageKind"],
    round: row.round,
    fixing: row.fixing === 1,
    roleId: row.role_id,
    toolId: row.tool_id,
    profileId: row.profile_id,
    ...opt("modelAsked", row.model_asked),
    ...opt("modelAskedName", row.model_asked_name),
    ...opt("effortAsked", row.effort_asked),
    ...opt("modelRan", row.model_ran),
    ...opt("modelRanName", row.model_ran_name),
    ...opt("effortRan", row.effort_ran),
    ...opt("modelChangedTo", row.model_changed_to),
    ...opt("effortChangedTo", row.effort_changed_to),
    sessionId: row.session_id,
    reason: row.reason as WorkTurn["reason"],
    startedAt: row.started_at,
    ...opt("endedAt", row.ended_at),
    ...opt("end", row.end_kind as WorkTurn["end"] | null),
    mainOnly: row.main_only === 1,
    helpers: row.helpers,
    ...opt("workMs", row.work_ms),
    ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
  };
}

const num = (value: number | undefined) => (value === undefined ? null : value);

function where(filter: TurnFilter, alias = "", moments = false): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (filter.taskId !== undefined) parts.push(`${alias}task_id = ?`), params.push(filter.taskId);
  if (filter.productId !== undefined) parts.push(`${alias}product_id = ?`), params.push(filter.productId);
  if (filter.stageId !== undefined) parts.push(moments ? "json_extract(data, '$.stageId') = ?" : `${alias}stage_id = ?`), params.push(filter.stageId);
  if (filter.round !== undefined) parts.push(moments ? "json_extract(data, '$.round') = ?" : `${alias}round = ?`), params.push(filter.round);
  if (filter.from !== undefined) parts.push(`${alias}at >= ?`), params.push(filter.from);
  if (filter.to !== undefined) parts.push(`${alias}at < ?`), params.push(filter.to);
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

/** The engine's work log. Every write is synchronous, so nothing is lost between two turns. */
export class WorkLog implements WorkLogReader {
  private closed = false;
  private retryKeys?: string[];

  constructor(private readonly db: Database) {
    for (const statement of SCHEMA) db.run(statement);
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
          model_asked, model_asked_name, effort_asked, model_ran, model_ran_name, effort_ran, session_id, reason, started_at, at, main_only, helpers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
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
      const insert = this.db.query(
        `INSERT INTO work_tokens (turn_id, model, changed, input, cache_read, cache_write, output, reasoning, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(turn_id, model) DO UPDATE SET input = excluded.input, cache_read = excluded.cache_read, cache_write = excluded.cache_write, output = excluded.output, reasoning = excluded.reasoning, total = excluded.total`,
      );
      for (const line of lines) insert.run(turnId, line.model, line.changed ? 1 : 0, num(line.input), num(line.cacheRead), num(line.cacheWrite), num(line.output), num(line.reasoning), num(line.total));
    })();
  }

  addMoment(moment: WorkMoment): void {
    if (this.closed) return;
    const { id, at, kind, taskId, productId, ...rest } = moment;
    this.db.query("INSERT INTO work_moments (id, at, kind, task_id, product_id, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(id, at, kind, taskId, productId, JSON.stringify(rest));
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
        .query("INSERT INTO usage_readings (tool_id, kind, model, status, utilization, window_minutes, name, resets_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(report.toolId, report.kind, report.model ?? "", report.status, num(report.utilization), num(report.windowMinutes), report.name ?? null, num(report.resetsAt), report.at);
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
    return this.db.query<{ n: number }, [string, string]>("SELECT (SELECT COUNT(*) FROM work_turns WHERE task_id = ?) + (SELECT COUNT(*) FROM work_moments WHERE task_id = ?) AS n").get(id, id)!.n > 0;
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
    return this.moments({ taskId, kinds: ["stage-start"] }).filter((moment) => moment.stageId === stageId).length;
  }

  stageWork(taskId: Id, stageId: Id, since: number): number {
    return this.db.query<{ ms: number | null }, [string, string, number]>("SELECT SUM(work_ms) AS ms FROM work_turns WHERE task_id = ? AND stage_id = ? AND started_at >= ?").get(taskId, stageId, since)!.ms ?? 0;
  }

  // ── Reading ────────────────────────────────────────────────────────────

  turns(filter: TurnFilter): WorkTurn[] {
    const { sql, params } = where(filter);
    return this.db.query<TurnRow, (string | number)[]>(`SELECT * FROM work_turns ${sql} ORDER BY started_at`).all(...params).map(turnOf);
  }

  lines(filter: TurnFilter): TokenLine[] {
    const { sql, params } = where(filter, "t.");
    return this.db
      .query<CountRow & { turn_id: string; model: string; changed: number }, (string | number)[]>(`SELECT k.* FROM work_tokens k JOIN work_turns t ON t.id = k.turn_id ${sql}`)
      .all(...params)
      .map((row) => ({ turnId: row.turn_id, model: row.model, ...(row.changed ? { changed: true } : {}), ...countsOf(row) }));
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
        `SELECT product_id,
          COUNT(*) AS turns,
          SUM(total IS NOT NULL) AS reported,
          SUM(total IS NULL AND end_kind != 'lost') AS noTokens,
          SUM(end_kind = 'lost') AS lost,
          COALESCE(SUM(total), 0) AS tokens,
          SUM(work_ms IS NOT NULL) AS timed,
          COALESCE(SUM(work_ms), 0) AS workMs,
          COALESCE(SUM(CASE WHEN total IS NOT NULL THEN input END), 0) AS input,
          COALESCE(SUM(CASE WHEN total IS NOT NULL THEN cache_read END), 0) AS cacheRead,
          COALESCE(SUM(CASE WHEN total IS NOT NULL THEN cache_write END), 0) AS cacheWrite,
          COALESCE(SUM(CASE WHEN total IS NOT NULL THEN output END), 0) AS output,
          SUM(total IS NOT NULL AND input IS NOT NULL) AS hasInput,
          SUM(total IS NOT NULL AND cache_read IS NOT NULL) AS hasCacheRead,
          SUM(total IS NOT NULL AND cache_write IS NOT NULL) AS hasCacheWrite,
          SUM(total IS NOT NULL AND output IS NOT NULL) AS hasOutput
         FROM work_turns WHERE end_kind IS NOT NULL GROUP BY product_id`,
      )
      .all();
    const tallies = new Map<Id, Tally>();
    for (const row of rows) {
      const tally = emptyTally();
      for (const key of Object.keys(tally) as (keyof Tally)[]) tally[key] = Number(row[key] ?? 0);
      tallies.set(row.product_id, tally);
    }
    return tallies;
  }

  untracked(): Map<Id, Id> {
    const rows = this.db.query<{ task_id: string; product_id: string }, []>("SELECT task_id, product_id FROM work_moments WHERE kind = 'untracked'").all();
    return new Map(rows.map((row) => [row.task_id, row.product_id]));
  }

  products(): ProductRecord[] {
    return this.db
      .query<{ id: string; name: string | null; repo: string | null; added_at: number | null; removed_at: number | null }, []>("SELECT * FROM products_ever")
      .all()
      .map((row) => ({ id: row.id, ...opt("name", row.name), ...opt("repo", row.repo), ...opt("addedAt", row.added_at), ...opt("removedAt", row.removed_at) }));
  }
}

/**
 * How long an agent has spent waiting for the coordinator's permission answers, so it can be left out
 * of its working time. Each agent has its own, so one agent's wait never shortens another's time.
 * Waits that overlap (an agent asking twice at once) count once.
 */
export class WaitClock {
  private readonly open = new Map<Id, { count: number; since: number }>();
  private readonly closed = new Map<Id, number>();

  start(taskId: Id, now = Date.now()): void {
    const entry = this.open.get(taskId);
    if (entry) entry.count += 1;
    else this.open.set(taskId, { count: 1, since: now });
  }

  stop(taskId: Id, now = Date.now()): void {
    const entry = this.open.get(taskId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.open.delete(taskId);
    this.closed.set(taskId, (this.closed.get(taskId) ?? 0) + Math.max(0, now - entry.since));
  }

  /** The task's waiting so far, a wait still open included. */
  of(taskId: Id, now = Date.now()): number {
    const entry = this.open.get(taskId);
    return (this.closed.get(taskId) ?? 0) + (entry ? Math.max(0, now - entry.since) : 0);
  }
}
