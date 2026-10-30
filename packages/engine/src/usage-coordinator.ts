import { recordModelCapacity, expireModelCapacity } from "@petrina/orchestrator";
import { conversationDigest } from "./participant-conversation.js";
import { ProfileSelection, type ProfileSelectionResult } from "@petrina/orchestrator";
import { UsageRecording } from "@petrina/orchestrator";
// Account reports, limit wakeups and profile/stand-in selection.
import { nextExpiry, untilWords, usableAgentTools, withLimit, type CheckId, type Id, type AgentProfile } from "@petrina/core";
import { type RepositoryContext } from "@petrina/orchestrator";
import { notReady, type RuntimeTask, type RuntimeState, type EngineOptions } from "./engine-options.js";
import type { Kernel } from "./kernel.js";
import { contractFor } from "./roles.js";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import type { UsageReader } from "@petrina/agent-runtime/usage-reader";
import { agentEnv } from "@petrina/platform/process-environment";
import { join } from "node:path";
import { CAPACITY_RETRY_DELAYS_MS, capacityWaiting, MODEL_CAPACITY_WAIT_MS } from "./usage.js";
import { type ModelAtCapacity, type UsageInfo, type UsageLimited } from "@petrina/agent-runtime/usage";
import { readinessLimitMs } from "./tool-checks.js";
type UsageHost = Pick<Kernel, "s" | "profile" | "role" | "tracking" | "activeState" | "stopped" | "schedule" | "commitNow" | "commit" | "log" | "named" | "options">;
/** A choice, or why nobody works the step yet: `readiness` when only a saved participant's uncertain tool stands in the way. */
export type Selection = ProfileSelectionResult;
export class UsageCoordinator {
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly selection: ProfileSelection;
  readonly readers = new Map<Id, UsageReader>();
  private readonly recording: UsageRecording;
  constructor(private readonly k: UsageHost) {
    this.selection = new ProfileSelection({
      current: () => k.s, activeState: () => k.activeState(), digest: text => conversationDigest(text),
      profile: id => k.profile(id), role: (id, task) => k.role(id, task), profileName: id => k.named(id),
      toolName: id => this.toolName(id), usableTools: () => this.usableTools(), onUsable: id => this.onUsable(id),
      hasToolAdapter: id => ADAPTERS[id] !== undefined,
      awayFromBuilder: role => contractFor(role).awayFromBuilder, notReady,
      now: () => Date.now(), readinessAllowanceMs: () => readinessLimitMs(k.options.toolCheckTimeoutMs),
      capacityRetryCount: () => CAPACITY_RETRY_DELAYS_MS.length, capacityWaiting,
      completedDesignAuthor: (taskId, stageId, round, roleId) => k.tracking.log.turns({ taskId, stageId, round }).filter(turn => turn.roleId === roleId && turn.end === "finished").at(-1),
      reportedReviewerTools: (taskId, stageId, round, reportedCount) => k.tracking.log.moments({ taskId, stageId, round, kinds: ["verdict"] })
        .slice(-reportedCount).flatMap(entry => { const profile = k.profile(entry.profileId ?? ""); return profile ? [profile.toolId] : []; }),
    });
    this.recording = new UsageRecording({ pool: () => this.k.s.pool,
      record: report => this.k.tracking.usageReported(report), toolName: toolId => this.toolName(toolId), wake: () => this.k.schedule(),
    });
  }

  startReaders(dataDir: string, options: EngineOptions): void {
    for (const adapter of Object.values(ADAPTERS)) {
      const usage = adapter.usageReader;
      if (!usage) continue;
      const override = options.usageCommands?.[adapter.id];
      const command = override === undefined ? options.agentCommand ? undefined : usage.command() : override;
      if (!command) continue;
      this.readers.set(adapter.id, usage.create({
        command, cwd: join(dataDir, "checks"), env: () => agentEnv(process.env),
        record: reports => { this.recordAccountUsage(adapter.id, reports); this.k.schedule(); },
        log: text => console.warn(`${new Date().toISOString()} ${text}`), changed: () => this.k.commit(),
      }));
    }
  }

  snapshot() {
    return Object.fromEntries([...this.readers].flatMap(([id, reader]) => {
      const status = reader.snapshot();
      return status ? [[id, status]] : [];
    }));
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>(); this.closing = done.promise;
    void done.promise.catch(() => undefined);
    clearTimeout(this.timer);
    const stops = [...this.readers.values()].map(reader => {
      try { return reader.stop(); } catch (error) { return Promise.reject(error); }
    });
    void Promise.allSettled(stops).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Account reader cleanup was not confirmed");
    }).then(done.resolve, done.reject);
    return done.promise;
  }
  private toolName(toolId: Id | undefined): string {
    return this.k.s.tools.find((tool) => tool.id === toolId)?.name ?? ADAPTERS[toolId ?? ""]?.name ?? toolId ?? "the tool";
  }

  /** The agent tools the squad uses now: Ready ones, or if none is, those Petrina couldn't check. */
  usableTools(): CheckId[] {
    if (!this.k.s.setup?.checks.some((check) => ADAPTERS[check.id] !== undefined)) {
      const installed = this.k.s.tools.filter((tool) => tool.status === "ready").map((tool) => tool.id as CheckId);
      if (installed.length) return installed;
    }
    return usableAgentTools(this.k.s.setup?.checks);
  }

  /** The same kind of profile on a tool the squad can use. Unchanged when its tool is usable, or when none is. */
  onUsable(profileId: Id): Id {
    const profile = this.k.s.profiles.find(profile => profile.id === profileId && !profile.standby);
    const usable = this.usableTools();
    if (profile && (!usable.length || usable.includes(profile.toolId as CheckId))) return profileId;
    const others = this.k.s.profiles.filter(entry => !entry.standby && (!usable.length || usable.includes(entry.toolId as CheckId)));
    return (others.find((entry) => entry.effort === profile?.effort) ?? others[0])?.id ?? this.k.s.profiles.find(entry => !entry.standby)?.id ?? profileId;
  }

  /** Only Builders return to an earlier step conversation; an interrupted turn keeps its own. */
  builderConversation(target: RuntimeTask | RepositoryContext, plannedId: Id) { return this.selection.builderConversation(target, plannedId); }
  choose(plannedId: Id, target?: RuntimeTask | RepositoryContext, roleId?: Id, room?: (toolId: Id, profile: AgentProfile) => boolean, reviewerKey?: string): Selection | undefined {
    return this.selection.choose(plannedId, target, roleId, room, reviewerKey);
  }

  /**
   * A tool said how much of a limit is used: kept as the latest for that tool and kind of limit. A report that
   * says the tool is out keeps new agents off it until it resets, whether or not a turn fails on it (Codex's own
   * count comes from outside any turn).
   */
  recordUsage(info: UsageInfo): void {
    this.recording.record(info, Date.now());
    if (info.toolId === "claude-code" || info.status === "rejected" && !info.overage) this.armLimitTimer();
    this.k.commit();
  }

  /** A successful complete account snapshot reconciles only observations actually returned by the account. */
  recordAccountUsage(toolId: Id, reports: readonly UsageInfo[]): void {
    if (!this.recording.account(toolId, reports, Date.now())) return;
    this.armLimitTimer();
    this.k.commit();
  }

  /**
   * An agent on this tool is starting, or the engine is (no tool): refresh the account
   * usage that the installed tool can report. The read runs on its own; nothing waits for it.
   */
  readUsage(toolId?: Id, gap?: number): void {
    if (this.closing) return;
    for (const [id, reader] of this.readers) {
      if (toolId !== undefined && id !== toolId) continue;
      if (this.k.s.tools.some(tool => tool.id === id && tool.status === "ready")) void reader.refresh(gap ?? ADAPTERS[id]?.usageReader?.startGapMs ?? 5 * 60_000);
    }
  }

  /** A turn ended because its tool ran out: who is out and until when is kept, and the task's timeline says so. */
  recordLimit(task: RuntimeTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    this.k.tracking.limitHit(task, roleId, profileId, error);
    this.k.s.pool.limited = withLimit(this.k.s.pool.limited, { toolId: error.toolId, source: error.source, ...(error.model ? { model: error.model } : {}), ...(error.retry ? { retry: true } : {}), until: error.until, reason: error.reason, at: Date.now() }) as RuntimeState["pool"]["limited"];
    const outcome = error.retry ? `could not continue (${error.reason}); retry after ${untilWords(error.until, Date.now())}` : `ran out of usage (${error.reason}), until ${untilWords(error.until, Date.now())}`;
    this.k.log(task, "warn", `${this.k.role(roleId, task)?.name ?? roleId} on ${this.k.named(profileId)} ${outcome}`, roleId, profileId);
    this.armLimitTimer();
    this.k.commitNow();
  }

  /**
   * The selected model is full for this task only. Usage meters are left unchanged.
   * Every effort of that model stays out of this task until the short retry.
   */
  recordModelCapacity(task: RuntimeTask, roleId: Id, profileId: Id, error: ModelAtCapacity, waitMs = MODEL_CAPACITY_WAIT_MS): void {
    const now = Date.now();
    recordModelCapacity(task, profileId, error, waitMs, now);
    this.k.log(task, "warn", `${this.k.role(roleId, task)?.name ?? roleId} on ${this.k.named(profileId)} stopped because the selected model is at capacity`, roleId, profileId);
    this.armLimitTimer();
    this.k.commitNow();
  }

  /** Limits whose time has passed are dropped, including a task's full-model retry. True when any was. */
  expireLimits(): boolean {
    const now = Date.now();
    let changed = false;
    const before = this.k.s.pool.limited?.length ?? 0;
    if (before) {
      const kept = this.k.s.pool.limited!.filter((limit) => limit.until > now);
      if (kept.length !== before) {
        changed = true;
        if (kept.length) this.k.s.pool.limited = kept;
        else delete this.k.s.pool.limited;
      }
    }
    for (const task of this.k.s.tasks) {
      if (expireModelCapacity(task, now)) changed = true;
    }
    return changed;
  }

  /** The scheduler runs again when the first limit, or the first full-model retry, ends. */
  armLimitTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    const times = [nextExpiry(this.k.s.pool, now)];
    for (const task of this.k.s.tasks) for (const entry of task.modelCapacity ?? []) if (entry.until > now) times.push(entry.until);
    const pending = times.filter((time): time is number => time !== undefined);
    const at = pending.length ? Math.min(...pending) : undefined;
    if (at === undefined || this.k.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.k.stopped) this.k.schedule();
    }, Math.min(at - Date.now() + 50, 2 ** 31 - 1));
  }
}
