// Account reports, limit wakeups and profile/stand-in selection.
import { chooseWithRoom, claudeWindow, currentReport, headroom, kindWords, limitOf, nearLimit, nextExpiry, UNKNOWN_LIMIT_MS, untilWords, usableAgentTools, withLimit, withReport, type Choice, type CheckId, type Id, type AgentProfile, type Task, type UsageReport } from "@petrina/core";
import { executionOf, type RepositoryContext } from "./repository-context.js";
import { notReady, stepKey, type Kernel, type MTask, type MState, type EngineOptions } from "./kernel.js";
import { contractFor, stepBack } from "./roles.js";
import { ADAPTERS } from "./tools.js";
import type { UsageReader } from "./usage-reader.js";
import { agentEnv } from "./env.js";
import { participantConversation } from "./participant-conversation.js";
import { join } from "node:path";
import { CAPACITY_RETRY_DELAYS_MS, capacityWaiting, MODEL_CAPACITY_WAIT_MS, type ModelAtCapacity, type UsageInfo, type UsageLimited } from "./usage.js";
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
      const full = this.capacityUntil(task, saved, Date.now());
      // A scheduled run keeps its saved profile. A full model waits and retries that profile.
      if (full) return { kind: "none", waiting: capacityWaiting(full, Date.now()) };
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
    const now = Date.now();
    // A short retry is already waiting on this profile. Another free model does not take the step yet.
    const held = this.holdingForShortRetry(task, roleId, planned, now);
    if (held) return { kind: "none", waiting: capacityWaiting(held, now) };
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
    const modelFull = (profile: AgentProfile) => this.capacityUntil(task, profile, now);
    // The step waits for a full model only while the account has usage. An account limit keeps its own wait and words.
    const fullOnly = (profile: AgentProfile) => limitOf(state.pool, profile, now) ? undefined : modelFull(profile);
    if (roleId !== undefined && this.k.role(roleId, task)?.result === "votes") {
      // A voter owns one actual tool's place, not a nominal profile's place. Other tools have
      // voters of their own: a model fallback stays on this tool; a usage limit drops its place.
      // A full model stays on this tool too. Every model on it being full waits, rather than
      // giving a partner another vote. A full cap still waits the same way.
      const ready = candidates.tools.filter((tool) => tool.status === "ready");
      const onTool = candidates.profiles.filter((profile) => profile.toolId === planned.toolId);
      const open = onTool.filter((profile) => !modelFull(profile));
      if (!open.length && !limitOf(state.pool, planned, now)) {
        const until = onTool.map((profile) => modelFull(profile)).find((until) => until !== undefined) ?? modelFull(planned);
        return until ? { kind: "none", waiting: capacityWaiting(until, now) } : { kind: "none", waiting: "Waiting for a usable review tool" };
      }
      if (ready.length && !ready.some((tool) => tool.id === planned.toolId)) return { kind: "none", waiting: "Waiting for a usable review tool" };
      candidates = { ...candidates, profiles: open };
    } else if (candidates.profiles.some((profile) => modelFull(profile))) {
      // The full model is left out, including another effort of it. Seats and review independence
      // still decide whether another model on this tool goes first. A full tool yields to one that can work.
      candidates = { ...candidates, profiles: candidates.profiles.filter((profile) => !modelFull(profile)) };
    }
    const reviewing = roleId !== undefined && ["findings", "objections", "votes"].includes(this.k.role(roleId, task)?.result ?? "");
    // A saved screen conversation is not swapped just for being near a limit. Reopen it on its tool
    // while that tool is available; a replacement still follows the current independence rules.
    if (screen) {
      const full = fullOnly(planned);
      // An agent that already has the screen retries the same profile. It does not hand the step to another model.
      if (full) return { kind: "none", waiting: capacityWaiting(full, now) };
      if (state.setup?.checks.some((check) => check.id === planned.toolId && notReady(check.status))) return { kind: "planned", profile: planned, reason: "Kept the screen conversation's profile so its tool can report the readiness problem." };
      const saved = chooseWithRoom(candidates, planned, now, { keep: true }, room);
      if (saved.kind === "planned") return saved;
    }
    const own = task && roleId !== undefined && roleId === stage?.roleId ? this.builderConversation(scope!, plannedId) : undefined;
    if (own && !modelFull(own.profile) && !limitOf(state.pool, own.profile, now) && !nearLimit(state.pool, own.profile, now) && headroom(state.pool, own.profile, now) !== 0 && (!room || room(own.toolId, own.profile))) {
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
    // A model that took over and then filled up is owed its short continue, even once the planned model is free.
    // It goes first only where the planned profile itself would be kept: with usage, a seat and the review's independence.
    // Otherwise the usual choice applies, so a free tool takes the step instead of waiting for this one.
    const owed = screen ? undefined : this.replacementOwedContinue(task, roleId, planned, reviewerKey);
    if (owed && (!room || room(owed.toolId, owed))) {
      const kept = chooseWithRoom(candidates, owed, now, rules, room);
      if (kept.kind === "planned" && kept.profile.id === owed.id) return { kind: "substitute", profile: owed, reason: "Continued the conversation that was waiting out a full model." };
    }
    const participant = scope && role && !screen ? participantConversation(this.k, scope, role, planned, reviewerKey) : undefined;
    let freshReason = participant?.reason;
    const previous = participant?.actual;
    if (participant && !freshReason && previous) {
      const standIn = previous.id !== planned.id;
      if (standIn && participant.coordinator) freshReason = "you chose this seat's profile, so it returns to your choice when available";
      else if (standIn && previous.standby) freshReason = "its saved profile is a standby profile";
      else if (standIn && previous.effort !== planned.effort) freshReason = "its saved profile has a different effort from the planned profile";
      else if (limitOf(state.pool, previous, now)) freshReason = "its saved profile is out of usage";
      else if (modelFull(previous)) freshReason = "its saved model is full";
      else if (room && !room(previous.toolId, previous)) freshReason = "its saved tool has no free agent slot";
      else {
        const check = state.setup?.checks.find((check) => check.id === previous.toolId);
        if (standIn && check?.checking) return { kind: "none", waiting: `Checking ${this.toolName(previous.toolId)} before returning to its saved conversation` };
        if (!candidates.profiles.some((profile) => profile.id === previous.id) || !candidates.tools.some((tool) => tool.id === previous.toolId && tool.status === "ready")) {
          freshReason = `its saved tool is ${check?.status === "logged-out" ? "logged out" : "not ready"}`;
        } else if (standIn) {
          const kept = chooseWithRoom(candidates, previous, now, rules, room);
          if (kept.kind === "planned" && kept.profile.id === previous.id) {
            const usual = chooseWithRoom(candidates, planned, now, rules, room);
            const recovered = usual.kind === "planned" && usual.profile.id === planned.id;
            return { kind: "substitute", profile: previous, reason: `Kept its own conversation on ${this.k.named(previous.id)}${recovered ? ` while the planned ${this.k.named(planned.id)} is available` : ` for the seat planned for ${this.k.named(planned.id)}`}.` };
          }
          // The saved profile is treated as planned for this check. Preserve why the usual
          // choice rejected it, whether for usage headroom or review independence.
          freshReason = (kept.kind === "none" ? kept.waiting : kept.reason ?? "the usual selection requires a different profile")
            .replaceAll("planned profile", "saved profile").replace(/\.$/, "");
        }
      }
    }
    const choice = chooseWithRoom(candidates, planned, now, rules, room);
    const full = fullOnly(planned);
    if (choice.kind === "none" && full) return { kind: "none", waiting: capacityWaiting(full, now) };
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
    return choice.kind !== "none" && participant && (participant.reason || choice.profile.id !== participant.prior.profileId)
      ? { ...choice, reason: `Started a fresh conversation: ${freshReason ?? "the usual selection requires a different profile"}. ${choice.reason ?? ""}` }
      : choice;
  }

  /**
   * A tool said how much of a limit is used: kept as the latest for that tool and kind of limit. A report that
   * says the tool is out keeps new agents off it until it resets, whether or not a turn fails on it (Codex's own
   * count comes from outside any turn).
   */
  recordUsage(info: UsageInfo): void {
    if (info.toolId === "claude-code") this.reconcileClaude([info], Date.now());
    else this.noteUsage(info, Date.now());
    if (info.toolId === "claude-code" || info.status === "rejected" && !info.overage) this.armLimitTimer();
    this.k.commit();
  }

  /** A successful complete account snapshot replaces quotas and blocks from the previous subscription. */
  recordAccountUsage(toolId: Id, reports: readonly UsageInfo[]): void {
    // Empty or mismatched data cannot establish that an old restriction ended.
    if (!reports.length || reports.some(report => report.toolId !== toolId)) return;
    if (toolId === "claude-code") {
      // A partial native response establishes only its reported windows.
      const complete = reports.some(report => report.claudeAccountComplete);
      this.reconcileClaude(reports, Date.now(), complete);
      this.armLimitTimer();
      this.k.commit();
      return;
    }
    const previous = (this.k.s.pool.usage ?? []).filter(report => report.toolId === toolId);
    this.k.s.pool.usage = (this.k.s.pool.usage ?? []).filter(report => report.toolId !== toolId);
    // Only retire blocks created by the reports being replaced (same scope and report time).
    // A turn-only refusal can have its own cooldown despite an available account balance.
    this.k.s.pool.limited = (this.k.s.pool.limited ?? []).filter(limit => limit.toolId !== toolId || limit.source === "refusal" || limit.retry || !previous.some(report =>
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
    this.restrictUsage(report, now);
  }

  /** Reconcile Claude's alternative allowances before any shared scheduling or Analytics reading. */
  private reconcileClaude(infos: readonly UsageInfo[], now: number, complete = false): void {
    const pool = this.k.s.pool;
    const before = pool.limited ?? [];
    const previous = (pool.usage ?? []).filter(report => report.toolId === "claude-code");
    const previousWindows = previous.map(report => claudeWindow(report));
    // Retire only report-derived blocks. Old saved state has no source, so require its exact
    // report time, scope and reason; a real refusal has an independent lifetime.
    // The old failed-turn path stamped synthetic extra-usage blocks later than their notice.
    // This exact reason came only from that obsolete mapping, including its former migration.
    pool.limited = (pool.limited ?? []).filter(limit => limit.toolId !== "claude-code" || limit.reason !== "Claude Code's extra usage limit")
      .filter(limit => limit.toolId !== "claude-code" || limit.source === "refusal" || limit.retry || !(limit.source === "report" || previous.some(report =>
      report.status === "rejected" && !report.overage && report.at === limit.at && (report.model ?? "") === (limit.model ?? "") && limit.reason === `Claude Code's ${kindWords(report.kind, report.windowMinutes, report.name)} limit`)))
      .map(limit => limit.toolId === "claude-code" && limit.source === undefined ? { ...limit, source: "refusal" as const } : limit);
    pool.usage = (pool.usage ?? []).filter(report => report.toolId !== "claude-code" || !complete && report.kind !== "overage")
      .reduce<UsageReport[]>((reports, report) => withReport(reports, report.toolId === "claude-code" ? claudeWindow(report) : report), []);
    for (const raw of infos) {
      const info = claudeWindow(raw);
      if (info.claudeOverage) {
        if (info.claudeOverage === "unavailable") {
          for (const report of pool.usage) {
            if (report.toolId !== "claude-code" || report.status !== "rejected" || !report.overage || !currentReport(report, now)) continue;
            report.overage = false;
            this.k.tracking.usageReported({ ...report, at: now });
          }
        }
        continue;
      }
      const older = previousWindows.findLast(report => report.kind === info.kind && (report.model ?? "") === (info.model ?? "") && currentReport(report, now));
      // Missing live percentages/reset times are not new readings. Keep known fields only for
      // the same status and window; a new reset or changed status starts a new reading.
      const sameWindow = older?.status === info.status && (info.resetsAt === undefined || older.resetsAt === info.resetsAt);
      const report = { ...(sameWindow ? older : {}), ...info, at: now };
      delete report.claudeAccountComplete;
      pool.usage = withReport(pool.usage, report);
      this.k.tracking.usageReported(report);
    }
    // Rebuild from the windows still current, using their original report times for unknown
    // resets. Paid-only notices cannot extend a cooldown or hold included quota past its reset.
    for (const report of pool.usage) if (report.toolId === "claude-code" && currentReport(report, now)) this.restrictUsage(report, now);
    if (before.some(limit => limit.toolId === "claude-code" && limit.until > now && !(pool.limited ?? []).some(next => next.toolId === limit.toolId && (next.model ?? "") === (limit.model ?? "") && next.until > now))) this.k.schedule();
  }

  private restrictUsage(info: UsageReport, now: number): void {
    // Not when the tool goes on with usage paid beyond the plan: the window is spent, the usage line says so, and
    // the balancer prefers tools with room, but the agents keep working.
    if (info.status === "rejected" && !info.overage) {
      const until = info.resetsAt && info.resetsAt > now ? info.resetsAt : (info.toolId === "claude-code" ? info.at : now) + UNKNOWN_LIMIT_MS;
      this.k.s.pool.limited = withLimit(this.k.s.pool.limited, { toolId: info.toolId, source: "report", ...(info.model ? { model: info.model } : {}), until, reason: `${this.toolName(info.toolId)}'s ${kindWords(info.kind, info.windowMinutes, info.name)} limit`, at: info.at }) as MState["pool"]["limited"];
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

  /** When this task learned that this profile's model is full, if that still holds. */
  private capacityUntil(task: MTask | undefined, profile: AgentProfile, now: number): number | undefined {
    return task?.modelCapacity?.find((entry) => entry.until > now && entry.toolId === profile.toolId && entry.modelId === (profile.modelId ?? profile.model))?.until;
  }

  /**
   * A replacement's saved conversation still owes a short continue. The pause record is gone once the wait ends,
   * so this is what keeps a replacement from being dropped when the originally planned model is free again.
   * The planned profile's own conversation needs nothing here: the usual choice keeps the planned profile.
   * One reviewer or voter does not pick up another's conversation.
   */
  private replacementOwedContinue(task: MTask | undefined, roleId: Id | undefined, planned: AgentProfile, reviewerKey: string | undefined): AgentProfile | undefined {
    if (!task || roleId === undefined) return undefined;
    const votes = this.k.role(roleId, task)?.result === "votes";
    const seat = votes ? `vote-${planned.id}` : reviewerKey !== undefined ? `review-${reviewerKey}` : undefined;
    const resumes = (task.capacityResume ?? []).filter((entry) => {
      if (entry.roleId !== roleId) return false;
      if (seat === undefined) return entry.member === undefined;
      return entry.member === seat || entry.member === undefined;
    });
    const owed = resumes.filter((entry) => {
      const tried = task.capacityRetries?.find((retry) => retry.roleId === entry.roleId && retry.profileId === entry.profileId && retry.member === entry.member)?.tried ?? 0;
      return tried >= 1 && tried <= CAPACITY_RETRY_DELAYS_MS.length;
    });
    const entry = owed.findLast((item) => item.profileId !== planned.id);
    return entry ? this.k.profile(entry.profileId) : undefined;
  }

  /**
   * The short same-conversation retry is still waiting, so this step keeps its profile.
   * A replacement holds the profile the step was planned for, and its own wait, not the first model's.
   */
  private holdingForShortRetry(task: MTask | undefined, roleId: Id | undefined, profile: AgentProfile, now: number): number | undefined {
    if (!task || roleId === undefined) return undefined;
    let until: number | undefined;
    for (const entry of task.capacityPaused ?? []) {
      if (entry.roleId !== roleId || (entry.plannedId !== profile.id && entry.profileId !== profile.id)) continue;
      const paused = this.k.profile(entry.profileId);
      const at = paused ? this.capacityUntil(task, paused, now) : undefined;
      if (at !== undefined && (until === undefined || at < until)) until = at;
    }
    return until;
  }

  /** A turn ended because its tool ran out: who is out and until when is kept, and the task's timeline says so. */
  recordLimit(task: MTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    this.k.tracking.limitHit(task, roleId, profileId, error);
    this.k.s.pool.limited = withLimit(this.k.s.pool.limited, { toolId: error.toolId, source: error.source, ...(error.model ? { model: error.model } : {}), ...(error.retry ? { retry: true } : {}), until: error.until, reason: error.reason, at: Date.now() }) as MState["pool"]["limited"];
    const outcome = error.retry ? `could not continue (${error.reason}); retry after ${untilWords(error.until, Date.now())}` : `ran out of usage (${error.reason}), until ${untilWords(error.until, Date.now())}`;
    this.k.log(task, "warn", `${this.k.role(roleId, task)?.name ?? roleId} on ${this.k.named(profileId)} ${outcome}`, roleId, profileId);
    this.armLimitTimer();
    this.k.commitNow();
  }

  /**
   * The selected model is full for this task only. Usage meters are left unchanged.
   * Every effort of that model stays out of this task until the short retry.
   */
  recordModelCapacity(task: MTask, roleId: Id, profileId: Id, error: ModelAtCapacity, waitMs = MODEL_CAPACITY_WAIT_MS): void {
    const now = Date.now();
    const until = now + waitMs;
    const next = { toolId: error.toolId, modelId: error.modelId, profileId, until };
    const kept = (task.modelCapacity ?? []).filter((entry) => entry.until > now && !(entry.toolId === next.toolId && entry.modelId === next.modelId));
    task.modelCapacity = [...kept, next];
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
      if (task.modelCapacity?.length) {
        const kept = task.modelCapacity.filter((entry) => entry.until > now);
        if (kept.length !== task.modelCapacity.length) {
          changed = true;
          if (kept.length) task.modelCapacity = kept;
          else delete task.modelCapacity;
        }
      }
      if (!task.capacityPaused?.length) continue;
      const active = new Set((task.modelCapacity ?? []).map((entry) => `${entry.toolId}\0${entry.modelId}`));
      const paused = task.capacityPaused.filter((entry) => active.has(`${entry.toolId}\0${entry.modelId}`));
      if (paused.length === task.capacityPaused.length) continue;
      changed = true;
      if (paused.length) task.capacityPaused = paused;
      else delete task.capacityPaused;
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
