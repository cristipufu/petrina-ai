import type { UsageReport } from "./model.js";
import type { UsagePeriod } from "./analytics.js";

/** Holds across one engine: whichever limit is reached first evicts the oldest. */
export const ANALYTICS_HOLDS = { entries: 64, bytes: 1024 * 1024 };
/** One read's retained inputs. Larger ones make the paged read unavailable; nothing is shortened to fit. */
export const ANALYTICS_HOLD_BYTES = 64 * 1024;
/** Counted from the first page; continuations do not extend it. */
export const ANALYTICS_HOLD_MS = 10 * 60_000;

interface Scope {
  taskId?: string;
  productId?: string;
  period: UsagePeriod;
}
export interface AnalyticsHold {
  id: string;
  scope: Scope;
  asOf: number;
  live: readonly UsageReport[];
  /** The complete serialized report's identity, with its scope and time. */
  key: string;
  total: number;
  bytes: number;
}
export class AnalyticsHolds {
  private readonly holds = new Map<string, AnalyticsHold>();
  private bytes = 0;
  constructor(private readonly limits = { ...ANALYTICS_HOLDS, hold: ANALYTICS_HOLD_BYTES, ms: ANALYTICS_HOLD_MS }) {}

  get size(): number {
    return this.holds.size;
  }
  get retainedBytes(): number {
    return this.bytes;
  }

  /** False when the inputs exceed one hold's limit. */
  keep(hold: AnalyticsHold, now: number): boolean {
    this.sweep(now);
    if (hold.bytes > Math.min(this.limits.hold, this.limits.bytes)) return false;
    this.holds.set(hold.id, hold);
    this.bytes += hold.bytes;
    for (const oldest of this.holds.values()) {
      if (this.holds.size <= this.limits.entries && this.bytes <= this.limits.bytes) break;
      this.drop(oldest);
    }
    return true;
  }

  get(id: string, now: number): AnalyticsHold | undefined {
    this.sweep(now);
    return this.holds.get(id);
  }

  private sweep(now: number): void {
    for (const hold of this.holds.values()) if (now >= hold.asOf + this.limits.ms) this.drop(hold);
  }

  private drop(hold: AnalyticsHold): void {
    this.holds.delete(hold.id);
    this.bytes -= hold.bytes;
  }
}
