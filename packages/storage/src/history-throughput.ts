// Bounded archive projection for throughput analytics.
// Reads precomputed compact `throughput` records via product/time indexes without loading conversations,
// and projects legacy pre-column rows inside SQLite without deserializing `session` or check `output`.

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { throughputTaskRecord, type Id, type Task, type ThroughputTaskRecord } from "@petrina/core";

function repoExpr(src: string): string {
  return `json_object(
    'productId', json_extract(${src}, '$.productId'),
    'delivery', json_extract(${src}, '$.delivery'),
    'removed', json(CASE WHEN json_extract(${src}, '$.removed') THEN 'true' END),
    'nothingToPublish', json(CASE WHEN json_extract(${src}, '$.nothingToPublish') THEN 'true' END),
    'cleanup', json_extract(${src}, '$.cleanup'),
    'landingAccepted', json_extract(${src}, '$.landingAccepted'),
    'companion', json_extract(${src}, '$.companion'),
    'pr', json(CASE WHEN json_extract(${src}, '$.pr') IS NOT NULL THEN json_object(
      'state', json_extract(${src}, '$.pr.state'),
      'openedAt', json_extract(${src}, '$.pr.openedAt')
    ) END),
    'release', json(CASE WHEN json_extract(${src}, '$.release') IS NOT NULL THEN json_object('ok', 1) END),
    'landed', json(CASE WHEN json_extract(${src}, '$.landed') IS NOT NULL THEN json_object('ok', 1) END),
    'confirmedDelivery', json(CASE WHEN json_extract(${src}, '$.confirmedDelivery') IS NOT NULL THEN json_object(
      'at', json_extract(${src}, '$.confirmedDelivery.at')
    ) END),
    'localUpdate', json(CASE WHEN json_extract(${src}, '$.localUpdate') IS NOT NULL THEN json_object(
      'pushed', json(CASE WHEN json_extract(${src}, '$.localUpdate.pushed') THEN 'true' ELSE 'false' END)
    ) END),
    'shipping', json(CASE WHEN json_extract(${src}, '$.shipping') IS NOT NULL THEN json_object(
      'step', json_extract(${src}, '$.shipping.step'),
      'carriedOver', json_extract(${src}, '$.shipping.carriedOver')
    ) END),
    'builderSession', json(CASE WHEN json_extract(${src}, '$.builderSession.readinessWait') IS NOT NULL THEN json_object(
      'readinessWait', json_extract(${src}, '$.builderSession.readinessWait')
    ) END)
  )`;
}

const STEP_SQL = `json_object(
  'id', json_extract(step.value, '$.id'),
  'legacy', json(CASE WHEN json_extract(step.value, '$.legacy') THEN 'true' END),
  'kind', json_extract(step.value, '$.kind'),
  'stageId', json_extract(step.value, '$.stageId'),
  'round', COALESCE(json_extract(step.value, '$.round'), 1),
  'sub', COALESCE(json_extract(step.value, '$.sub'), 0),
  'roleId', json_extract(step.value, '$.roleId'),
  'fixing', json(CASE WHEN json_extract(step.value, '$.fixing') THEN 'true' END),
  'findingIds', json_extract(step.value, '$.findingIds'),
  'update', json(CASE WHEN json_extract(step.value, '$.update') THEN 'true' END),
  'port', json(CASE WHEN json_extract(step.value, '$.port') THEN 'true' END),
  'call', json(CASE WHEN json_extract(step.value, '$.call') THEN 'true' END),
  'work', json_extract(step.value, '$.work'),
  'waitsFor', json_extract(step.value, '$.waitsFor'),
  'startedAt', json_extract(step.value, '$.startedAt'),
  'endedAt', json_extract(step.value, '$.endedAt'),
  'end', json_extract(step.value, '$.end'),
  'outcome', json_extract(step.value, '$.outcome'),
  'reason', json_extract(step.value, '$.reason'),
  'tone', json_extract(step.value, '$.tone'),
  'trigger', json_extract(step.value, '$.trigger'),
  'builderReturn', json_extract(step.value, '$.builderReturn'),
  'buildProductId', json_extract(step.value, '$.buildProductId'),
  'checkRepairs', json(CASE WHEN json_type(step.value, '$.checkRepairs') = 'array' THEN
    (SELECT json_group_array(1) FROM json_each(step.value, '$.checkRepairs')) END),
  'result', json(CASE WHEN json_extract(step.value, '$.result.findingChanges.reopened') IS NOT NULL THEN
    json_object('findingChanges', json_object('reopened', json_extract(step.value, '$.result.findingChanges.reopened'))) END),
  'acceptanceChecks', json(CASE WHEN json_type(step.value, '$.acceptanceChecks') = 'array' THEN
    (SELECT json_group_array(json_object('result', json_extract(ac.value, '$.result'))) FROM json_each(step.value, '$.acceptanceChecks') ac) END),
  'proofChecks', json(CASE WHEN json_type(step.value, '$.proofChecks') = 'array' THEN
    (SELECT json_group_array(json_object('result', json_extract(pc.value, '$.result'))) FROM json_each(step.value, '$.proofChecks') pc) END),
  'asks', json(CASE WHEN json_type(step.value, '$.asks') = 'array' THEN
    (SELECT json_group_array(json_object(
      'id', json_extract(a.value, '$.id'),
      'kind', json_extract(a.value, '$.kind'),
      'at', json_extract(a.value, '$.at'),
      'endedAt', json_extract(a.value, '$.endedAt')
    )) FROM json_each(step.value, '$.asks') a) END),
  'agentInputs', json(CASE WHEN json_type(step.value, '$.agentInputs') = 'array' THEN
    (SELECT json_group_array(json_object(
      'at', json_extract(ai.value, '$.at'),
      'readiness', json_extract(ai.value, '$.readiness')
    )) FROM json_each(step.value, '$.agentInputs') ai WHERE json_extract(ai.value, '$.readiness') IS NOT NULL) END),
  'reuses', json_extract(step.value, '$.reuses'),
  'checkReasons', json_extract(step.value, '$.checkReasons'),
  'productChecks', json(CASE WHEN json_type(step.value, '$.productChecks') = 'array' THEN
    (SELECT json_group_array(json_object(
      'id', json_extract(c.value, '$.id'),
      'productId', json_extract(c.value, '$.productId'),
      'attemptId', json_extract(c.value, '$.attemptId'),
      'result', json_extract(c.value, '$.result'),
      'queuedAt', json_extract(c.value, '$.queuedAt'),
      'startedAt', json_extract(c.value, '$.startedAt'),
      'endedAt', json_extract(c.value, '$.endedAt'),
      'reusedAt', json_extract(c.value, '$.reusedAt'),
      'run', json(CASE WHEN json_type(c.value, '$.run') = 'object' THEN
        json_remove(json_extract(c.value, '$.run'), '$.output')
      END)
    )) FROM json_each(step.value, '$.productChecks') c) END),
  'checkSetups', json(CASE WHEN json_type(step.value, '$.checkSetups') = 'array' THEN
    (SELECT json_group_array(json_object(
      'id', json_extract(cs.value, '$.id'),
      'productId', json_extract(cs.value, '$.productId'),
      'queuedAt', json_extract(cs.value, '$.queuedAt'),
      'startedAt', json_extract(cs.value, '$.startedAt'),
      'endedAt', json_extract(cs.value, '$.endedAt'),
      'lifecycle', json_extract(cs.value, '$.lifecycle'),
      'observationFailure', json_extract(cs.value, '$.observationFailure'),
      'results', json(CASE WHEN json_type(cs.value, '$.results') = 'array' THEN
        (SELECT json_group_array(json_object('run', json_object(
          'ok', json(CASE WHEN json_extract(r.value, '$.run.ok') THEN 'true' ELSE 'false' END)
        ))) FROM json_each(cs.value, '$.results') r) END)
    )) FROM json_each(step.value, '$.checkSetups') cs) END),
  'extraValidations', json(CASE WHEN json_type(step.value, '$.extraValidations') = 'array' THEN
    (SELECT json_group_array(json_object(
      'id', json_extract(ev.value, '$.id'),
      'taskId', json_extract(ev.value, '$.taskId'),
      'productId', json_extract(ev.value, '$.productId'),
      'state', json_extract(ev.value, '$.state'),
      'result', json_extract(ev.value, '$.result'),
      'queuedAt', json_extract(ev.value, '$.queuedAt'),
      'startedAt', json_extract(ev.value, '$.startedAt'),
      'endedAt', json_extract(ev.value, '$.endedAt')
    )) FROM json_each(step.value, '$.extraValidations') ev) END)
)`;

const FALLBACK_TASK_SQL = `json_object(
  'id', h.id,
  'title', h.title,
  'productId', h.product_id,
  'state', h.state,
  'column', COALESCE(json_extract(h.body, '$.column'), 'done'),
  'held', json(CASE WHEN json_extract(h.body, '$.held') THEN 'true' ELSE 'false' END),
  'holdsSlot', json(CASE WHEN json_extract(h.body, '$.holdsSlot') THEN 'true' ELSE 'false' END),
  'createdAt', json_extract(h.body, '$.createdAt'),
  'startedAt', json_extract(h.body, '$.startedAt'),
  'finishedAt', json_extract(h.body, '$.finishedAt'),
  'combinedInto', json_extract(h.body, '$.combinedInto'),
  'sentBack', json_extract(h.body, '$.sentBack'),
  'after', json_extract(h.body, '$.after'),
  'statusLine', COALESCE(json_extract(h.body, '$.statusLine'), ''),
  'checkActivity', json_extract(h.body, '$.checkActivity'),
  'runtimeWait', json_extract(h.body, '$.runtimeWait'),
  'modelCapacity', json_extract(h.body, '$.modelCapacity'),
  'capacityPaused', json_extract(h.body, '$.capacityPaused'),
  'maintenance', json(CASE WHEN json_extract(h.body, '$.maintenance.noProductChanges') THEN
    json_object('noProductChanges', json('true')) END),
  'agent', json(CASE WHEN json_extract(h.body, '$.agent') IS NOT NULL THEN '{}' END),
  'helpers', json(CASE WHEN json_type(h.body, '$.helpers') = 'array' THEN
    (SELECT json_group_array(1) FROM json_each(h.body, '$.helpers')) END),
  'plan', json(CASE WHEN json_type(h.body, '$.plan.stages') = 'array' THEN
    json_object('stages', json((SELECT json_group_array(json_object(
      'id', json_extract(s.value, '$.id'),
      'kind', json_extract(s.value, '$.kind'),
      'roleId', json_extract(s.value, '$.roleId')
    )) FROM json_each(h.body, '$.plan.stages') s))) END),
  'workRows', json(CASE WHEN json_type(h.body, '$.workRows') = 'array' THEN
    (SELECT json_group_array(json_object(
      'choice', json_object('productId', json_extract(wr.value, '$.choice.productId'))
    )) FROM json_each(h.body, '$.workRows') wr) END),
  'delivery', COALESCE(json_extract(h.body, '$.delivery'), 'local'),
  'nothingToPublish', json(CASE WHEN json_extract(h.body, '$.nothingToPublish') THEN 'true' END),
  'cleanup', json_extract(h.body, '$.cleanup'),
  'landingAccepted', json_extract(h.body, '$.landingAccepted'),
  'companion', json_extract(h.body, '$.companion'),
  'pr', json(CASE WHEN json_extract(h.body, '$.pr') IS NOT NULL THEN json_object(
    'state', json_extract(h.body, '$.pr.state'),
    'openedAt', json_extract(h.body, '$.pr.openedAt')
  ) END),
  'release', json(CASE WHEN json_extract(h.body, '$.release') IS NOT NULL THEN json_object('ok', 1) END),
  'landed', json(CASE WHEN json_extract(h.body, '$.landed') IS NOT NULL THEN json_object('ok', 1) END),
  'confirmedDelivery', json(CASE WHEN json_extract(h.body, '$.confirmedDelivery') IS NOT NULL THEN json_object(
    'at', json_extract(h.body, '$.confirmedDelivery.at')
  ) END),
  'localUpdate', json(CASE WHEN json_extract(h.body, '$.localUpdate') IS NOT NULL THEN json_object(
    'pushed', json(CASE WHEN json_extract(h.body, '$.localUpdate.pushed') THEN 'true' ELSE 'false' END)
  ) END),
  'shipping', json(CASE WHEN json_extract(h.body, '$.shipping') IS NOT NULL THEN json_object(
    'step', json_extract(h.body, '$.shipping.step'),
    'carriedOver', json_extract(h.body, '$.shipping.carriedOver')
  ) END),
  'repository', json(CASE WHEN json_extract(h.body, '$.repository') IS NOT NULL THEN
    ${repoExpr("json_extract(h.body, '$.repository')")} END),
  'repositories', json(CASE WHEN json_type(h.body, '$.repositories') = 'array' THEN
    (SELECT json_group_array(${repoExpr("repo.value")}) FROM json_each(h.body, '$.repositories') repo) END),
  'journey', json(CASE WHEN json_type(h.body, '$.journey') = 'array' THEN
    (SELECT json_group_array(${STEP_SQL}) FROM json_each(h.body, '$.journey') step) ELSE '[]' END)
)`;

type ThroughputRow = { id: string; throughput: string | null; fallback: string | null };

export function ensureThroughputColumn(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(task_history)").all();
  if (!columns.some((col) => col.name === "throughput")) {
    db.run("ALTER TABLE task_history ADD COLUMN throughput TEXT");
  }
}

function stripNulls(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(stripNulls).filter((item) => item !== undefined);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = stripNulls(entry);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

function decodeRow(row: ThroughputRow): ThroughputTaskRecord {
  if (row.throughput !== null) return JSON.parse(row.throughput) as ThroughputTaskRecord;
  return throughputTaskRecord(stripNulls(JSON.parse(row.fallback!)) as Task);
}

export function queryThroughputTasks(
  db: Database,
  filter: { from: number; productId?: Id; taskIds?: readonly Id[] },
): ThroughputTaskRecord[] {
  const selectCols = `h.id, h.throughput, CASE WHEN h.throughput IS NULL THEN ${FALLBACK_TASK_SQL} END AS fallback`;
  const rows: ThroughputRow[] = filter.productId
    ? db
        .query<ThroughputRow, [string, number]>(
          `SELECT ${selectCols}
           FROM task_history_products p JOIN task_history h ON h.id = p.task_id
           WHERE p.product_id = ? AND p.finished_at >= ?
           ORDER BY p.finished_at DESC, p.task_id DESC`,
        )
        .all(filter.productId, filter.from)
    : db
        .query<ThroughputRow, [number]>(
          `SELECT ${selectCols}
           FROM task_history h
           WHERE h.finished_at >= ?
           ORDER BY h.finished_at DESC, h.id DESC`,
        )
        .all(filter.from);

  const seen = new Set(rows.map((row) => row.id));
  const out = rows.map(decodeRow);

  const missingIds = (filter.taskIds ?? []).filter((id) => !seen.has(id));
  for (let start = 0; start < missingIds.length; start += 100) {
    const chunk = missingIds.slice(start, start + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    const extraSql = filter.productId
      ? `SELECT ${selectCols} FROM task_history h
         WHERE h.id IN (${placeholders})
           AND EXISTS (SELECT 1 FROM task_history_products p WHERE p.task_id = h.id AND p.product_id = ?)`
      : `SELECT ${selectCols} FROM task_history h WHERE h.id IN (${placeholders})`;
    const args: SQLQueryBindings[] = filter.productId ? [...chunk, filter.productId] : [...chunk];
    for (const row of db.query<ThroughputRow, SQLQueryBindings[]>(extraSql).all(...args)) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        out.push(decodeRow(row));
      }
    }
  }
  return out;
}
