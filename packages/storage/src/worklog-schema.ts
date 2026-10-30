import {
  emptyTally,
  type Tally,
  type TokenCounts,
  type TurnFilter,
  type UsageReport,
  type WorkMoment,
  type WorkTurn,
} from "@petrina/core";

// The SQL equivalent of core's addTurn, shared by task and product totals.
export const TALLY_COLUMNS = `
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
          SUM(total IS NOT NULL AND output IS NOT NULL) AS hasOutput`;

export function tallyOfRow(row: Record<string, unknown>): Tally {
  const tally = emptyTally();
  for (const key of Object.keys(tally) as (keyof Tally)[]) tally[key] = Number(row[key] ?? 0);
  return tally;
}

export const WORKLOG_SCHEMA = [
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
  "CREATE INDEX IF NOT EXISTS work_moments_stage_starts ON work_moments (task_id, json_extract(data, '$.stageId')) WHERE kind = 'stage-start'",
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

export interface ReadingRow {
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

export const opt = <K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> => (value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>));

export const num = (value: number | undefined): number | null => (value === undefined ? null : value);

export function readingOf(row: ReadingRow): UsageReport {
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

export interface TurnRow {
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
  journey_id: string | null;
  agent_run_id: string | null;
  agent_seat: string | null;
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

export type CountRow = Pick<TurnRow, "input" | "cache_read" | "cache_write" | "output" | "reasoning" | "total">;
export type MomentRow = { id: string; at: number; kind: string; task_id: string; product_id: string; data: string };

export function momentOf(row: MomentRow): WorkMoment {
  return {
    ...(JSON.parse(row.data) as object),
    id: row.id,
    at: row.at,
    kind: row.kind as WorkMoment["kind"],
    taskId: row.task_id,
    productId: row.product_id,
  };
}

export function countsOf(row: CountRow): TokenCounts {
  return {
    ...opt("input", row.input),
    ...opt("cacheRead", row.cache_read),
    ...opt("cacheWrite", row.cache_write),
    ...opt("output", row.output),
    ...opt("reasoning", row.reasoning),
    ...opt("total", row.total),
  };
}

export function turnOf(row: TurnRow): WorkTurn {
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
    ...opt("journeyId", row.journey_id),
    ...opt("agentRunId", row.agent_run_id),
    ...opt("agentSeat", row.agent_seat),
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

export function where(filter: TurnFilter, alias = "", moments = false): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (filter.taskId !== undefined) {
    parts.push(`${alias}task_id = ?`);
    params.push(filter.taskId);
  }
  if (filter.productId !== undefined) {
    parts.push(`${alias}product_id = ?`);
    params.push(filter.productId);
  }
  if (filter.stageId !== undefined) {
    parts.push(moments ? "json_extract(data, '$.stageId') = ?" : `${alias}stage_id = ?`);
    params.push(filter.stageId);
  }
  if (filter.round !== undefined) {
    parts.push(moments ? "json_extract(data, '$.round') = ?" : `${alias}round = ?`);
    params.push(filter.round);
  }
  if (filter.from !== undefined) {
    parts.push(`${alias}at >= ?`);
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    parts.push(`${alias}at < ?`);
    params.push(filter.to);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}
