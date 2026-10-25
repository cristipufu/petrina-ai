// Paged Analytics reads, tied to their first page. That page fixes one evaluation time, and a product read keeps
// a private copy of the live allowance readings it used. Every continuation rebuilds the complete report from
// those inputs and verifies it against the first page before returning text: passing time and later account
// refreshes cannot interrupt a read, and a meaningful change is reported rather than spliced in. Holds are
// engine-wide and bounded whatever the number of callers, and end with the engine.
import { randomBytes } from "node:crypto";
import type { UsagePeriod, UsageReport } from "@petrina/core";
import type { Result } from "./coordination.js";
import type { Engine } from "./engine.js";
import { cursor, fingerprint } from "./evidence-read.js";
import { ACCOUNT_ON_PAGE_MS } from "./tracking.js";

import { AnalyticsHolds, ANALYTICS_HOLD_MS, type AnalyticsHold } from "@petrina/core";
export { AnalyticsHolds, ANALYTICS_HOLDS, ANALYTICS_HOLD_BYTES, ANALYTICS_HOLD_MS, type AnalyticsHold } from "@petrina/core";

interface Scope {
  taskId?: string;
  productId?: string;
  period: UsagePeriod;
}
/** A continuation. Task usage depends on neither time nor live readings, so it needs no hold. */
interface Reference {
  asOf: number;
  key: string;
  at: number;
  hold?: string;
  run?: string;
}


const stores = new WeakMap<Engine, AnalyticsHolds>();
/** Shared by every request to this engine, from the terminal and from connected agents alike. */
export const analyticsHolds = (engine: Engine): AnalyticsHolds => stores.get(engine) ?? stores.set(engine, new AnalyticsHolds()).get(engine)!;

const AGAIN = "Read it again from the beginning for current data.";
const OTHER_READ = `This continuation belongs to a different analytics read. Use the same task, product and period as its first page, or ${AGAIN.toLowerCase()}`;
const HOLD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function readAnalytics(e: Engine, a: { taskId?: string; productId?: string; period: UsagePeriod; cursor?: string; limit: number }): Result {
  const scope: Scope = { ...(a.taskId ? { taskId: a.taskId } : {}), ...(a.productId ? { productId: a.productId } : {}), period: a.period };
  const ref = a.cursor === undefined ? undefined : decode(a.cursor);
  if (ref === null) return { outcome: "invalid", message: `This analytics continuation is malformed or unsupported. ${AGAIN}` };
  const asOf = ref ? { asOf: ref.asOf } : {};
  if (a.taskId && !e.taskDetails(a.taskId)) return { outcome: "missing", message: "That task does not exist.", ...asOf };
  if (a.productId && !e.s.products.some((product) => product.id === a.productId)) return { outcome: "missing", message: "That product does not exist.", ...asOf };
  return ref ? next(e, scope, ref, a.limit) : first(e, scope, a.limit);
}

function first(e: Engine, scope: Scope, limit: number): Result {
  // As the window's page does: ask for fresh account usage. This read keeps the readings it uses now.
  if (!scope.taskId) e.readUsage(undefined, ACCOUNT_ON_PAGE_MS);
  const asOf = Date.now();
  const live = scope.taskId ? undefined : Object.freeze(structuredClone(e.activeState().pool.usage ?? []).map((report) => Object.freeze(report)));
  const source = report(e, scope, asOf, live);
  const key = identity(scope, asOf, source);
  if (!live || source.length <= limit) return page(source, 0, limit, asOf, { key });
  const hold: AnalyticsHold = { id: randomBytes(9).toString("base64url"), scope, asOf, live, key, total: source.length, bytes: 0 };
  hold.bytes = Buffer.byteLength(JSON.stringify(hold));
  if (!analyticsHolds(e).keep(hold, asOf))
    return { outcome: "unavailable", reason: "too-large", message: "The live allowance readings behind this report are too large to hold between pages, so it cannot be read in pages. Nothing was shortened or substituted.", asOf, total: source.length };
  return page(source, 0, limit, asOf, { key, hold: hold.id, run: e.boot });
}

function next(e: Engine, scope: Scope, ref: Reference, limit: number): Result {
  const asOf = { asOf: ref.asOf };
  let live: readonly UsageReport[] | undefined;
  let key = ref.key;
  if (scope.taskId ? ref.hold : !ref.hold) return { outcome: "invalid", message: OTHER_READ, ...asOf };
  if (ref.hold) {
    if (ref.run !== e.boot) return { outcome: "unavailable", reason: "engine-restarted", message: `The engine restarted after this read began, so the allowance readings it used are gone. No current data is substituted. ${AGAIN}`, ...asOf };
    const now = Date.now();
    if (now >= ref.asOf + ANALYTICS_HOLD_MS) return { outcome: "unavailable", reason: "expired", message: `This paged read expired ten minutes after its first page. No current data is substituted. ${AGAIN}`, ...asOf };
    const hold = analyticsHolds(e).get(ref.hold, now);
    if (!hold) return { outcome: "unavailable", reason: "evicted", message: `This read's held allowance readings were released early to keep holds within their limits. No current data is substituted. ${AGAIN}`, ...asOf };
    // The reference contradicts the read it names: its time is not trusted.
    if (hold.asOf !== ref.asOf || hold.key !== ref.key) return { outcome: "invalid", message: `This continuation does not match the read it names. ${AGAIN}` };
    if (hold.scope.taskId !== scope.taskId || hold.scope.productId !== scope.productId || hold.scope.period !== scope.period)
      return { outcome: "invalid", message: OTHER_READ, ...asOf };
    if (ref.at >= hold.total) return { outcome: "invalid", message: "This continuation position is outside the report.", ...asOf };
    live = hold.live;
    key = hold.key;
  }
  const source = report(e, scope, ref.asOf, live);
  if (identity(scope, ref.asOf, source) !== key)
    return { outcome: "changed", message: `This analytics evidence changed after its first page: recorded usage, saved allowance readings or task details differ. No text from a different report is returned. ${AGAIN}`, ...asOf };
  if (ref.at >= source.length) return { outcome: "invalid", message: "This continuation position is outside the report.", ...asOf };
  return page(source, ref.at, limit, ref.asOf, { key, ...(ref.hold ? { hold: ref.hold, run: ref.run } : {}) });
}

function report(e: Engine, scope: Scope, asOf: number, live: readonly UsageReport[] | undefined): string {
  const view = e.tracking.usageAt(scope.taskId ? { view: "task", taskId: scope.taskId } : { view: "analytics", period: scope.period, ...(scope.productId ? { productId: scope.productId } : {}) }, asOf, live);
  return JSON.stringify(view, null, 2);
}

const identity = (scope: Scope, asOf: number, source: string) => fingerprint(["analytics.inspect", scope.taskId, scope.productId, scope.period, asOf, source]);

function page(source: string, at: number, limit: number, asOf: number, ref: Omit<Reference, "asOf" | "at">): Result {
  const end = at + limit;
  const more = end < source.length;
  return {
    outcome: "completed",
    text: source.slice(at, end),
    offset: at,
    total: source.length,
    shortened: more,
    asOf,
    ...(more ? { next: cursor({ v: 1, asOf, ...ref, at: end }), ...(ref.hold ? { expiresAt: asOf + ANALYTICS_HOLD_MS } : {}) } : {}),
  };
}

/** Null: malformed or unsupported, including references from before reads kept their time. */
function decode(raw: string): Reference | null {
  try {
    const data = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((name) => !["v", "asOf", "key", "at", "hold", "run"].includes(name))) return null;
    const { v, asOf, key, at, hold, run } = data;
    if (v !== 1 || !Number.isSafeInteger(asOf) || asOf <= 0 || asOf > Date.now() || typeof key !== "string" || !/^[0-9a-f]{24}$/.test(key) || !Number.isSafeInteger(at) || at < 1) return null;
    if ((hold === undefined) !== (run === undefined)) return null;
    if (hold !== undefined && !(typeof hold === "string" && HOLD_ID.test(hold) && typeof run === "string" && HOLD_ID.test(run))) return null;
    return { asOf, key, at, ...(hold !== undefined ? { hold, run } : {}) };
  } catch {
    return null;
  }
}
