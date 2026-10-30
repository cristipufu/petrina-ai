import {
  nextExpiry,
  untilWords,
  usableAgentTools,
  withLimit,
  type AgentProfile,
  type CheckId,
  type DeepMutable,
  type Id,
  type Pool,
  type State,
  type UsageLimit,
} from "@petrina/core";
import { expireModelCapacity } from "./model-capacity.js";
import type { RuntimeTask } from "./model.js";

export interface LimitRefusal {
  readonly toolId: Id;
  readonly source: UsageLimit["source"];
  readonly model?: string;
  readonly retry?: boolean;
  readonly until: number;
  readonly reason: string;
}

export interface UsagePolicyHost {
  pool(): DeepMutable<Pool>;
  tasks(): readonly RuntimeTask[];
  profiles(): readonly AgentProfile[];
  tools(): State["tools"];
  setupChecks(): NonNullable<State["setup"]>["checks"] | undefined;
  hasToolAdapter(toolId: Id): boolean;
}

/** Portable usable-tool resolution, limit expiry, and wakeup deadline calculation. */
export class UsagePolicy {
  constructor(private readonly host: UsagePolicyHost) {}

  /** The agent tools the squad uses now: Ready ones, or if none is, those Petrina couldn't check. */
  usableTools(): CheckId[] {
    const checks = this.host.setupChecks();
    if (!checks?.some((check) => this.host.hasToolAdapter(check.id))) {
      const installed = this.host
        .tools()
        .filter((tool) => tool.status === "ready")
        .map((tool) => tool.id as CheckId);
      if (installed.length) {
        return installed;
      }
    }
    return usableAgentTools(checks);
  }

  /** The same kind of profile on a tool the squad can use. Unchanged when its tool is usable, or when none is. */
  onUsable(profileId: Id): Id {
    const profiles = this.host.profiles();
    const profile = profiles.find((entry) => entry.id === profileId && !entry.standby);
    const usable = this.usableTools();
    if (profile && (!usable.length || usable.includes(profile.toolId as CheckId))) {
      return profileId;
    }
    const others = profiles.filter(
      (entry) => !entry.standby && (!usable.length || usable.includes(entry.toolId as CheckId)),
    );
    return (
      (others.find((entry) => entry.effort === profile?.effort) ?? others[0])?.id
      ?? profiles.find((entry) => !entry.standby)?.id
      ?? profileId
    );
  }

  /** Record a turn limit refusal on the pool and return the plain-language timeline message. */
  recordLimitHit(error: LimitRefusal, roleLabel: string, profileLabel: string, now: number): string {
    const pool = this.host.pool();
    pool.limited = withLimit(pool.limited, {
      toolId: error.toolId,
      source: error.source,
      ...(error.model ? { model: error.model } : {}),
      ...(error.retry ? { retry: true } : {}),
      until: error.until,
      reason: error.reason,
      at: now,
    }) as DeepMutable<Pool>["limited"];
    const outcome = error.retry
      ? `could not continue (${error.reason}); retry after ${untilWords(error.until, now)}`
      : `ran out of usage (${error.reason}), until ${untilWords(error.until, now)}`;
    return `${roleLabel} on ${profileLabel} ${outcome}`;
  }

  /** Limits whose time has passed are dropped, including a task's full-model retry. True when any was. */
  expireLimits(now: number): boolean {
    const pool = this.host.pool();
    let changed = false;
    const before = pool.limited?.length ?? 0;
    if (before) {
      const kept = pool.limited!.filter((limit) => limit.until > now);
      if (kept.length !== before) {
        changed = true;
        if (kept.length) {
          pool.limited = kept;
        } else {
          delete pool.limited;
        }
      }
    }
    for (const task of this.host.tasks()) {
      if (expireModelCapacity(task, now)) {
        changed = true;
      }
    }
    return changed;
  }

  /** Earliest timestamp (> now) when any pool usage limit or task model-capacity retry ends. */
  nextLimitWakeAt(now: number): number | undefined {
    const times = [nextExpiry(this.host.pool(), now)];
    for (const task of this.host.tasks()) {
      for (const entry of task.modelCapacity ?? []) {
        if (entry.until > now) {
          times.push(entry.until);
        }
      }
    }
    const pending = times.filter((time): time is number => time !== undefined);
    return pending.length ? Math.min(...pending) : undefined;
  }
}
