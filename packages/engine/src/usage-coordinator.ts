// Account-reader lifecycle and host timers; portable usage policy, recording and profile selection live in @petrina/orchestrator.

import { join } from "node:path";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import type { ModelAtCapacity, UsageInfo, UsageLimited } from "@petrina/agent-runtime/usage";
import type { UsageReader } from "@petrina/agent-runtime/usage-reader";
import type { AgentProfile, CheckId, Id, Role, State, Task, UsageReport } from "@petrina/core";
import {
  ProfileSelection,
  recordModelCapacity,
  UsagePolicy,
  UsageRecording,
  type ProfileSelectionResult,
  type RepositoryContext,
} from "@petrina/orchestrator";
import { agentEnv } from "@petrina/platform/process-environment";
import { notReady, type EngineOptions, type RuntimeState, type RuntimeTask } from "./engine-options.js";
import { conversationDigest } from "./participant-conversation.js";
import { contractFor } from "./roles.js";
import { readinessLimitMs } from "./tool-checks.js";
import { CAPACITY_RETRY_DELAYS_MS, capacityWaiting, MODEL_CAPACITY_WAIT_MS } from "./usage.js";

/** A choice, or why nobody works the step yet: `readiness` when only a saved participant's uncertain tool stands in the way. */
export type Selection = ProfileSelectionResult;

export interface UsageCoordinatorHost {
  state(): RuntimeState;
  activeState(): State;
  stopped(): boolean;
  toolCheckTimeoutMs(): number | undefined;
  profile(id: Id): AgentProfile | undefined;
  role(id: Id, task?: RuntimeTask): Role | undefined;
  profileName(id: Id): string;
  completedDesignAuthor(taskId: Id, stageId: Id, round: number, roleId: Id): { toolId: Id } | undefined;
  reportedReviewerTools(taskId: Id, stageId: Id, round: number, reportedCount: number): Id[];
  recordUsageReport(report: UsageReport): void;
  recordLimitHit(task: RuntimeTask, roleId: Id, profileId: Id, error: UsageLimited): void;
  note(task: RuntimeTask, tone: Task["timeline"][number]["tone"], text: string, roleId: Id, profileId: Id): void;
  schedule(): void;
  changed(): void;
  checkpoint(): void;
}

export class UsageCoordinator {
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly policy: UsagePolicy;
  private readonly selection: ProfileSelection;
  private readonly recording: UsageRecording;
  readonly readers = new Map<Id, UsageReader>();

  constructor(private readonly host: UsageCoordinatorHost) {
    this.policy = new UsagePolicy({
      pool: () => host.state().pool,
      tasks: () => host.state().tasks,
      profiles: () => host.state().profiles,
      tools: () => host.state().tools,
      setupChecks: () => host.state().setup?.checks,
      hasToolAdapter: (id) => ADAPTERS[id] !== undefined,
    });
    this.selection = new ProfileSelection({
      current: () => host.state(),
      activeState: () => host.activeState(),
      digest: (text) => conversationDigest(text),
      profile: (id) => host.profile(id),
      role: (id, task) => host.role(id, task),
      profileName: (id) => host.profileName(id),
      toolName: (id) => this.toolName(id),
      usableTools: () => this.usableTools(),
      onUsable: (id) => this.onUsable(id),
      hasToolAdapter: (id) => ADAPTERS[id] !== undefined,
      awayFromBuilder: (role) => contractFor(role).awayFromBuilder,
      notReady,
      now: () => Date.now(),
      readinessAllowanceMs: () => readinessLimitMs(host.toolCheckTimeoutMs()),
      capacityRetryCount: () => CAPACITY_RETRY_DELAYS_MS.length,
      capacityWaiting,
      completedDesignAuthor: (taskId, stageId, round, roleId) =>
        host.completedDesignAuthor(taskId, stageId, round, roleId),
      reportedReviewerTools: (taskId, stageId, round, reportedCount) =>
        host.reportedReviewerTools(taskId, stageId, round, reportedCount),
    });
    this.recording = new UsageRecording({
      pool: () => host.state().pool,
      record: (report) => host.recordUsageReport(report),
      toolName: (toolId) => this.toolName(toolId),
      reconcilesAllowanceWindows: (toolId) => ADAPTERS[toolId]?.reconcilesAllowanceWindows === true,
      wake: () => host.schedule(),
    });
  }

  startReaders(dataDir: string, options: EngineOptions): void {
    for (const adapter of Object.values(ADAPTERS)) {
      const usage = adapter.usageReader;
      if (!usage) {
        continue;
      }
      const override = options.usageCommands?.[adapter.id];
      const command = override === undefined ? (options.agentCommand ? undefined : usage.command()) : override;
      if (!command) {
        continue;
      }
      this.readers.set(
        adapter.id,
        usage.create({
          command,
          cwd: join(dataDir, "checks"),
          env: () => agentEnv(process.env),
          record: (reports) => {
            this.recordAccountUsage(adapter.id, reports);
            this.host.schedule();
          },
          log: (text) => console.warn(`${new Date().toISOString()} ${text}`),
          changed: () => this.host.changed(),
        }),
      );
    }
  }

  snapshot() {
    return Object.fromEntries(
      [...this.readers].flatMap(([id, reader]) => {
        const status = reader.snapshot();
        return status ? [[id, status]] : [];
      }),
    );
  }

  stop(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    void done.promise.catch(() => undefined);
    clearTimeout(this.timer);
    const stops = [...this.readers.values()].map((reader) => {
      try {
        return reader.stop();
      } catch (error) {
        return Promise.reject(error);
      }
    });
    void Promise.allSettled(stops)
      .then((results) => {
        const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length) {
          throw new AggregateError(errors, "Account reader cleanup was not confirmed");
        }
      })
      .then(done.resolve, done.reject);
    return done.promise;
  }

  private toolName(toolId: Id | undefined): string {
    return (
      this.host.state().tools.find((tool) => tool.id === toolId)?.name
      ?? ADAPTERS[toolId ?? ""]?.name
      ?? toolId
      ?? "the tool"
    );
  }

  usableTools(): CheckId[] {
    return this.policy.usableTools();
  }

  onUsable(profileId: Id): Id {
    return this.policy.onUsable(profileId);
  }

  builderConversation(target: RuntimeTask | RepositoryContext, plannedId: Id) {
    return this.selection.builderConversation(target, plannedId);
  }

  choose(
    plannedId: Id,
    target?: RuntimeTask | RepositoryContext,
    roleId?: Id,
    room?: (toolId: Id, profile: AgentProfile) => boolean,
    reviewerKey?: string,
  ): Selection | undefined {
    return this.selection.choose(plannedId, target, roleId, room, reviewerKey);
  }

  recordUsage(info: UsageInfo): void {
    this.recording.record(info, Date.now());
    if (info.toolId === "claude-code" || (info.status === "rejected" && !info.overage)) {
      this.armLimitTimer();
    }
    this.host.changed();
  }

  recordAccountUsage(toolId: Id, reports: readonly UsageInfo[]): void {
    if (!this.recording.account(toolId, reports, Date.now())) {
      return;
    }
    this.armLimitTimer();
    this.host.changed();
  }

  readUsage(toolId?: Id, gap?: number): void {
    if (this.closing) {
      return;
    }
    for (const [id, reader] of this.readers) {
      if (toolId !== undefined && id !== toolId) {
        continue;
      }
      if (this.host.state().tools.some((tool) => tool.id === id && tool.status === "ready")) {
        void reader.refresh(gap ?? ADAPTERS[id]?.usageReader?.startGapMs ?? 5 * 60_000);
      }
    }
  }

  recordLimit(task: RuntimeTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    this.host.recordLimitHit(task, roleId, profileId, error);
    const now = Date.now();
    const text = this.policy.recordLimitHit(
      error,
      this.host.role(roleId, task)?.name ?? roleId,
      this.host.profileName(profileId),
      now,
    );
    this.host.note(task, "warn", text, roleId, profileId);
    this.armLimitTimer();
    this.host.checkpoint();
  }

  recordModelCapacity(
    task: RuntimeTask,
    roleId: Id,
    profileId: Id,
    error: ModelAtCapacity,
    waitMs = MODEL_CAPACITY_WAIT_MS,
  ): void {
    const now = Date.now();
    recordModelCapacity(task, profileId, error, waitMs, now);
    this.host.note(
      task,
      "warn",
      `${this.host.role(roleId, task)?.name ?? roleId} on ${this.host.profileName(profileId)} stopped because the selected model is at capacity`,
      roleId,
      profileId,
    );
    this.armLimitTimer();
    this.host.checkpoint();
  }

  expireLimits(): boolean {
    return this.policy.expireLimits(Date.now());
  }

  armLimitTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    const at = this.policy.nextLimitWakeAt(now);
    if (at === undefined || this.host.stopped()) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.host.stopped()) {
        this.host.schedule();
      }
    }, Math.min(at - Date.now() + 50, 2 ** 31 - 1));
  }
}
