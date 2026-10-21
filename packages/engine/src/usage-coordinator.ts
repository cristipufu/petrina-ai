// Account reports, limit wakeups and profile/stand-in selection.
import { chooseWithRoom, headroom, kindWords, limitOf, nearLimit, nextExpiry, UNKNOWN_LIMIT_MS, untilWords, usableAgentTools, withLimit, withReport, type Choice, type CheckId, type Id, type AgentProfile, type Task } from "@petrina/core";
import { executionOf, type RepositoryContext } from "./repository-context.js";
import { notReady, stepKey, type Kernel, type MTask, type MState, type EngineOptions } from "./kernel.js";
import { contractFor, stepBack } from "./roles.js";
import { ADAPTERS } from "./tools.js";
import type { UsageReader } from "./usage-reader.js";
import { agentEnv } from "./env.js";
import { join } from "node:path";
import type { UsageInfo, UsageLimited } from "./usage.js";
type UsageHost = Pick<Kernel, "s" | "profile" | "role" | "tracking" | "activeState" | "stopped" | "schedule" | "commitNow" | "commit" | "log" | "named">;
export class UsageCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly legacyReviewerTools = new WeakMap<MTask, { key: string; tools: Id[] }>();
  readonly readers = new Map<Id, UsageReader>();
  constructor(private readonly k: UsageHost) {}

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
  stop(): void { clearTimeout(this.timer); for (const reader of this.readers.values()) reader.stop(); }
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

  /** Only Builders return to an earlier step's conversation; an interrupted Builder keeps its current one. */
  builderConversation(target: MTask | RepositoryContext, plannedId: Id) {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const stage = task.plan?.stages[task.stageIndex];
    if (stage?.kind !== "do") return undefined;
    const current = repository.conversation;
    const role = current?.roleId === stage.roleId && current.role ? current.role : this.k.role(stage.roleId, task);
    if (role?.result !== "build") return undefined;
    const own = repository.builderSession;
    const saved = current
      ? current.roleId === stage.roleId && current.briefed && current.step === stepKey(task) && (!current.plannedProfileId || current.plannedProfileId === plannedId) ? current : undefined
      : (task.fixing || repository.updating) && own?.stageId === stage.id && (own.plannedProfileId ?? own.profileId) === plannedId && !(task.fixing && stepBack(task as Task)) ? own : undefined;
    const planned = this.k.profile(plannedId);
    if (!saved || !planned) return undefined;
    // The saved tool/model must still be offered. Prefer the planned effort for an earlier
    // step; an active conversation already names the actual fallback profile it ran on.
    const matches = (profile: AgentProfile) => profile.toolId === saved.toolId && (profile.modelId ?? profile.model) === saved.model;
    const exact = current ? this.k.profile(current.profileId) : undefined;
    const profile = exact && matches(exact) ? exact : this.k.s.profiles.find((profile) => matches(profile) && profile.effort === planned.effort) ?? this.k.s.profiles.find(matches);
    return profile ? { sessionId: saved.sessionId, toolId: saved.toolId, model: saved.model, profile } : undefined;
  }

  /**
   * Who works a step planned for this profile right now: the planned one, or a stand-in while its tool or
   * model is out of usage. `room` is whether that tool can take a seat now. A stand-in whose tool is full
   * yields to another tool that has one, so a cap kept for a tool that is out does not idle a pool slot.
   */
  choose(plannedId: Id, target?: MTask | RepositoryContext, roleId?: Id, room?: (toolId: Id, profile: AgentProfile) => boolean, reviewerKey?: string): Choice | undefined {
    const scope = target ? executionOf(target) : undefined;
    const task = scope?.task;
    const repository = scope?.work;
    // A saved screen conversation is not swapped just for being near a limit. Other members of the
    // same review group still choose from their own planned profiles.
    const screen = task?.screen?.roleId === roleId && task?.screen?.profileId === plannedId
      && (reviewerKey === undefined || !task.screen.member || task.screen.member === `review-${reviewerKey}`);
    const saved = task?.maintenance && task.maintenance.role.id === roleId ? task.maintenance.profile : undefined;
    const planned = saved ?? this.k.s.profiles.find(profile => profile.id === plannedId) ?? this.k.s.profiles.find(profile => profile.id === this.onUsable(plannedId));
    if (saved) {
      if (task?.maintenance?.settingsDecision && !task.maintenance.settingsDecision.choice) return { kind: "none", waiting: "Waiting for your decision about the reported agent settings" };
      const limit = limitOf(this.k.s.pool, saved, Date.now());
      if (limit) return { kind: "none", waiting: "Waiting for usage on the saved maintenance profile" };
      if (!this.k.s.tools.some(t => t.id === saved.toolId && t.status === "ready")) return { kind: "none", waiting: "The saved maintenance tool is unavailable. Check it in Agents, then resume this run." };
      return { kind: "planned", profile: saved, reason: "Kept the profile saved in the maintenance routine." };
    }
    if (!planned) return undefined;
    const stage = task?.plan?.stages[task.stageIndex];
    const round = task && stage ? task.rounds[stage.id] ?? 1 : 1;
    const role = roleId === undefined ? undefined : this.k.role(roleId, task);
    const contract = role && contractFor(role);
    const findings = role?.result === "findings";
    // Security and port reviews follow the latest builder, including a replacement that did the port.
    const builder = task?.plan?.stages.find((stage) => this.k.role(stage.roleId, task)?.result === "build")?.profileIds[0];
    let made: { toolId: Id; modelId?: string } | undefined = contract?.awayFromBuilder || (!!task?.maintenance && findings) || (repository?.portReview && stage?.kind === "review-chain" && findings)
      ? (repository?.builderSession ? { toolId: repository!.builderSession.toolId, modelId: repository!.builderSession.model } : builder ? this.k.profile(builder) : undefined)
      : undefined;
    if (task && stage?.kind === "converge" && task.sub === 1 && roleId === (stage.reviewerRoleId ?? "design-reviewer")) {
      const saved = task.designSessions?.[JSON.stringify([stage.id, "author", repository!.productId])];
      const author = saved ? undefined : this.k.tracking.log.turns({ taskId: task.id, stageId: stage.id, round }).filter((turn) => turn.roleId === stage.roleId && turn.end === "finished").at(-1);
      const legacy = task.session.findLast((line) => line.from === "agent" && line.roleId === stage.roleId)?.profileId;
      made = saved ? { toolId: saved.toolId, modelId: saved.model } : author ? { toolId: author.toolId, modelId: author.modelRan ?? author.modelAsked } : this.k.profile(legacy ?? stage.profileIds[0] ?? "");
    }
    let peers: Id[] = [];
    if (task && stage?.kind === "review-chain" && findings && !repository?.portReview) {
      const hunt = task.hunt?.stageId === stage.id && task.hunt.round === round ? task.hunt : undefined;
      const key = reviewerKey ?? String(stage.profileIds.indexOf(plannedId));
      // Older rounds saved reports without the profiles at their positions. Their latest verdicts
      // name the actual reviewers; replace the reported positions' planned tools with those tools.
      let legacy: Id[] = [];
      if (hunt && Object.keys(hunt.reported).some((key) => !hunt.profiles?.[key])) {
        const stamp = JSON.stringify([stage.id, round, Object.keys(hunt.reported).sort()]);
        const cached = this.legacyReviewerTools.get(task);
        if (cached?.key === stamp) legacy = cached.tools;
        else {
          legacy = this.k.tracking.log.moments({ taskId: task.id, stageId: stage.id, round, kinds: ["verdict"] })
            .slice(-Object.keys(hunt.reported).length)
            .flatMap((entry) => { const profile = this.k.profile(entry.profileId ?? ""); return profile ? [profile.toolId] : []; });
          this.legacyReviewerTools.set(task, { key: stamp, tools: legacy });
        }
      }
      peers = stage.profileIds.flatMap((id, index) => {
        if (String(index) === key) return [];
        if (legacy.length && hunt?.reported[String(index)]) return [];
        const peer = this.k.profile(hunt?.profiles?.[String(index)] ?? id);
        return peer ? [peer.toolId] : [];
      });
      peers.push(...legacy);
    }
    const state = this.k.activeState();
    const checked = state.setup?.checks.some((check) => ADAPTERS[check.id] !== undefined);
    const usable = this.usableTools() as Id[];
    // Usage stand-ins follow the same login checks as the plan: Ready tools first, otherwise the
    // ones we couldn't check. Before checks have run, keep the existing installed-tool selection.
    let candidates = checked ? {
      ...state,
      // With no usable tool at all, let the planned tool reach its readiness guard so
      // the task gets a login/install request, rather than a misleading usage wait.
      profiles: state.profiles.filter((profile) => usable.includes(profile.toolId) || (!usable.length && profile.id === plannedId)),
      tools: state.tools.filter((tool) => usable.includes(tool.id)).map((tool) => ({ ...tool, status: "ready" as const })),
    } : state;
    if (roleId !== undefined && this.k.role(roleId, task)?.result === "votes") {
      // A voter owns one actual tool's place, not a nominal profile's place. Other tools have
      // voters of their own: a model fallback stays on this tool; a usage limit drops its place.
      // A full cap still waits, rather than giving a partner another vote.
      const ready = candidates.tools.filter((tool) => tool.status === "ready");
      if ((ready.length && !ready.some((tool) => tool.id === planned.toolId)) || !candidates.profiles.some((profile) => profile.toolId === planned.toolId)) return { kind: "none", waiting: "Waiting for a usable review tool" };
      candidates = { ...candidates, profiles: candidates.profiles.filter((profile) => profile.toolId === planned.toolId) };
    }
    const reviewing = roleId !== undefined && ["findings", "objections", "votes"].includes(this.k.role(roleId, task)?.result ?? "");
    const now = Date.now();
    // A saved screen conversation is not swapped just for being near a limit. Reopen it on its tool
    // while that tool is available; a replacement still follows the current independence rules.
    if (screen) {
      if (state.setup?.checks.some((check) => check.id === planned.toolId && notReady(check.status))) return { kind: "planned", profile: planned, reason: "Kept the screen conversation's profile so its tool can report the readiness problem." };
      const saved = chooseWithRoom(candidates, planned, now, { keep: true }, room);
      if (saved.kind === "planned") return saved;
    }
    const own = task && roleId !== undefined && roleId === stage?.roleId ? this.builderConversation(scope!, plannedId) : undefined;
    if (own && !limitOf(state.pool, own.profile, now) && !nearLimit(state.pool, own.profile, now) && headroom(state.pool, own.profile, now) !== 0 && (!room || room(own.toolId, own.profile))) {
      const check = state.setup?.checks.find((check) => check.id === own.toolId);
      // Recovery checks are bounded by the normal tool-check timeout. Checking is temporary;
      // let it answer before replacing a healthy saved Builder with a permanent fresh start.
      if (check?.checking) return { kind: "none", waiting: `Checking ${this.toolName(own.toolId)} before the Builder returns` };
      if (candidates.profiles.some((profile) => profile.id === own.profile.id) && (!checked || usable.includes(own.toolId))) {
        const ready = candidates.tools.filter((tool) => tool.status === "ready");
        if (!ready.length || ready.some((tool) => tool.id === own.toolId)) return { kind: own.profile.id === plannedId ? "planned" : "substitute", profile: own.profile, reason: "Returned to the Builder's existing conversation on an available profile." };
      }
    }
    if (task?.maintenance && findings && candidates.tools.some(tool => tool.status === "ready" && tool.id !== task.maintenance!.profile.toolId)) {
      const author = task.maintenance.profile;
      candidates = { ...candidates, profiles: candidates.profiles.filter(profile => !(profile.toolId === author.toolId && profile.modelId === author.modelId && profile.effort === author.effort)) };
    }
    const rules = { keep: !!screen || reviewing, awayFromTools: peers, ...(made ? { awayFrom: { toolId: made.toolId, ...(made.modelId ? { modelId: made.modelId } : {}) } } : {}) };
    const choice = chooseWithRoom(candidates, planned, now, rules, room);
    if (checked && !usable.length && choice.kind === "planned") return { ...choice, reason: "No tool passed readiness checks; kept the planned profile so its tool can report the login or installation problem." };
    if (own && room && choice.kind !== "none" && !room(choice.profile.toolId, choice.profile)) {
      // A returning Builder must not get stuck on a full planned tool that recovered since
      // its last handoff. Try tools with seats; if none can work, keep the normal wait.
      const ready = candidates.tools.filter((tool) => tool.status === "ready");
      const seated = (ready.length ? ready : candidates.tools).filter((tool) => candidates.profiles.some(profile => profile.toolId === tool.id && room(tool.id, profile)));
      if (seated.length) {
        const available = { ...candidates, tools: seated.map((tool) => ({ ...tool, status: "ready" as const })), profiles: candidates.profiles.filter((profile) => seated.some((tool) => tool.id === profile.toolId) && room(profile.toolId, profile)) };
        const next = chooseWithRoom(available, planned, now, rules, room);
        if (next.kind !== "none") return next;
      }
    }
    return choice;
  }

  /**
   * A tool said how much of a limit is used: kept as the latest for that tool and kind of limit. A report that
   * says the tool is out keeps new agents off it until it resets, whether or not a turn fails on it (Codex's own
   * count comes from outside any turn).
   */
  recordUsage(info: UsageInfo): void {
    this.noteUsage(info, Date.now());
    if (info.status === "rejected" && !info.overage) this.armLimitTimer();
    this.k.commit();
  }

  /** A successful complete account snapshot replaces quotas and blocks from the previous subscription. */
  recordAccountUsage(toolId: Id, reports: readonly UsageInfo[]): void {
    // Empty or mismatched data cannot establish that an old restriction ended.
    if (!reports.length || reports.some(report => report.toolId !== toolId)) return;
    const previous = (this.k.s.pool.usage ?? []).filter(report => report.toolId === toolId);
    this.k.s.pool.usage = (this.k.s.pool.usage ?? []).filter(report => report.toolId !== toolId);
    // Only retire blocks created by the reports being replaced (same scope and report time).
    // A turn-only refusal can have its own cooldown despite an available account balance.
    this.k.s.pool.limited = (this.k.s.pool.limited ?? []).filter(limit => limit.toolId !== toolId || limit.retry || !previous.some(report =>
      report.status === "rejected" && !report.overage && report.at === limit.at && (report.model ?? "") === (limit.model ?? "")));
    const now = Date.now();
    for (const report of reports) this.noteUsage(report, now);
    this.armLimitTimer();
    this.k.commit();
  }

  private noteUsage(info: UsageInfo, now: number): void {
    const report = { ...info, at: now };
    this.k.s.pool.usage = withReport(this.k.s.pool.usage, report) as MState["pool"]["usage"];
    this.k.tracking.usageReported(report);
    // Not when the tool goes on with usage paid beyond the plan: the window is spent, the usage line says so, and
    // the balancer prefers tools with room, but the agents keep working.
    if (info.status === "rejected" && !info.overage) {
      const until = info.resetsAt && info.resetsAt > now ? info.resetsAt : now + UNKNOWN_LIMIT_MS;
      this.k.s.pool.limited = withLimit(this.k.s.pool.limited, { toolId: info.toolId, ...(info.model ? { model: info.model } : {}), until, reason: `${this.toolName(info.toolId)}'s ${kindWords(info.kind, info.windowMinutes, info.name)} limit`, at: now }) as MState["pool"]["limited"];
    }
  }

  /**
   * An agent on this tool is starting, or the engine is (no tool): refresh the account
   * usage that the installed tool can report. The read runs on its own; nothing waits for it.
   */
  readUsage(toolId?: Id, gap?: number): void {
    for (const [id, reader] of this.readers) {
      if (toolId !== undefined && id !== toolId) continue;
      if (this.k.s.tools.some(tool => tool.id === id && tool.status === "ready")) void reader.refresh(gap ?? ADAPTERS[id]?.usageReader?.startGapMs ?? 5 * 60_000);
    }
  }

  /** A turn ended because its tool ran out: who is out and until when is kept, and the task's timeline says so. */
  recordLimit(task: MTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    this.k.tracking.limitHit(task, roleId, profileId, error);
    this.k.s.pool.limited = withLimit(this.k.s.pool.limited, { toolId: error.toolId, ...(error.model ? { model: error.model } : {}), ...(error.retry ? { retry: true } : {}), until: error.until, reason: error.reason, at: Date.now() }) as MState["pool"]["limited"];
    const outcome = error.retry ? `could not continue (${error.reason}); retry after ${untilWords(error.until, Date.now())}` : `ran out of usage (${error.reason}), until ${untilWords(error.until, Date.now())}`;
    this.k.log(task, "warn", `${this.k.role(roleId, task)?.name ?? roleId} on ${this.k.named(profileId)} ${outcome}`, roleId, profileId);
    this.armLimitTimer();
    this.k.commitNow();
  }

  /** Limits whose time has passed are dropped. True when any was. */
  expireLimits(): boolean {
    const before = this.k.s.pool.limited?.length ?? 0;
    if (!before) return false;
    const now = Date.now();
    const kept = this.k.s.pool.limited!.filter((limit) => limit.until > now);
    if (kept.length === before) return false;
    if (kept.length) this.k.s.pool.limited = kept;
    else delete this.k.s.pool.limited;
    return true;
  }

  /** The scheduler runs again when the first limit in force ends: tasks waiting for usage start by themselves. */
  armLimitTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const at = nextExpiry(this.k.s.pool, Date.now());
    if (at === undefined || this.k.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.k.stopped) this.k.schedule();
    }, Math.min(at - Date.now() + 50, 2 ** 31 - 1));
  }
}
