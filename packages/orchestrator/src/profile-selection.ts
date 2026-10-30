import {
  chooseWithRoom,
  headroom,
  limitOf,
  nearLimit,
  readinessGate,
  readinessOutcome,
  uncertain,
  stepKey,
  freshBuilderRethink,
  type Choice,
  type CheckId,
  type CheckStatus,
  type Id,
  type AgentProfile,
  type ReadinessRecheck,
  type ReadinessWait,
  type Role,
  type State,
  type Task,
  seatRemaining
} from "@petrina/core";
import { executionOf, type RepositoryContext } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import { participantConversation } from "./participant-conversation.js";

export interface SelectionReadiness {
  toolId: CheckId;
  profileId: Id;
  roleId: Id;
  saved: { readinessWait?: ReadinessWait };
  words: string;
  scope: RepositoryContext;
}
export type ProfileSelectionResult = Exclude<Choice, { kind: "none" }> | { kind: "none"; waiting: string; capacity?: boolean; readiness?: SelectionReadiness };
type Selection = ProfileSelectionResult;
export type SelectionState = Pick<State, "profiles" | "tools" | "pool" | "setup">;

/** Only the observations selection consumes; account readers, ACP, persistence and timers stay in the host. */
export interface ProfileSelectionHost {
  current(): SelectionState;
  digest(serialized: string): string;
  activeState(): SelectionState;
  profile(id: Id): AgentProfile | undefined;
  role(id: Id, task?: RuntimeTask): Role | undefined;
  profileName(id: Id): string;
  toolName(id: Id | undefined): string;
  usableTools(): readonly CheckId[];
  onUsable(id: Id): Id;
  hasToolAdapter(id: string): boolean;
  awayFromBuilder(role: Role): boolean | undefined;
  notReady(status: CheckStatus): boolean;
  now(): number;
  readinessAllowanceMs(): number;
  capacityRetryCount(): number;
  capacityWaiting(until: number, now: number): string;
  completedDesignAuthor(taskId: Id, stageId: Id, round: number, roleId: Id): { toolId: Id; modelRan?: string; modelAsked?: string } | undefined;
  reportedReviewerTools(taskId: Id, stageId: Id, round: number, reportedCount: number): Id[];
}

/** Actual profile/participant policy over explicit observations, with no native account or process dependency. */
export class ProfileSelection {
  private readonly legacyReviewerTools = new WeakMap<RuntimeTask, { key: string; tools: Id[] }>();
  constructor(private readonly host: ProfileSelectionHost) {}

  builderConversation(target: RuntimeTask | RepositoryContext, plannedId: Id) {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const stage = task.plan?.stages[task.stageIndex];
    if (stage?.kind !== "do") return undefined;
    const current = repository.conversation;
    const role = current?.roleId === stage.roleId && current.role ? current.role : this.host.role(stage.roleId, task);
    if (role?.result !== "build") return undefined;
    const own = repository.builderSession;
    const saved = current
      ? current.roleId === stage.roleId && current.briefed && current.step === stepKey(task) && (!current.plannedProfileId || current.plannedProfileId === plannedId) ? current : undefined
      : (task.fixing || repository.updating) && own?.stageId === stage.id && (own.plannedProfileId ?? own.profileId) === plannedId && !freshBuilderRethink(
        task as Task,
        own,
        stage.id,
        plannedId
      ) ? own : undefined;
    const planned = this.host.profile(plannedId);
    if (!saved || !planned) return undefined;
    // The saved tool/model must still be offered. Prefer the planned effort for an earlier
    // step; an active conversation already names the actual fallback profile it ran on.
    const matches = (profile: AgentProfile) => profile.toolId === saved.toolId && (profile.modelId ?? profile.model) === saved.model;
    const exact = current ? this.host.profile(current.profileId) : undefined;
    const profile = exact && matches(exact) ? exact : this.host.current().profiles.find((profile) => matches(profile) && profile.effort === planned.effort) ?? this.host.current().profiles.find(matches);
    return profile ? {
      sessionId: saved.sessionId,
      toolId: saved.toolId,
      model: saved.model,
      profile,
      saved: saved as { readinessWait?: ReadinessWait }
    } : undefined;
  }

  choose(plannedId: Id, target?: RuntimeTask | RepositoryContext, roleId?: Id, room?: (toolId: Id, profile: AgentProfile) => boolean, reviewerKey?: string): Selection | undefined {
    const scope = target ? executionOf(target) : undefined;
    const task = scope?.task;
    const repository = scope?.work;
    // A saved screen conversation is not swapped just for being near a limit. Other members of the
    // same review group still choose from their own planned profiles.
    const screen = task?.screen?.roleId === roleId && task?.screen?.profileId === plannedId
      && (reviewerKey === undefined || !task.screen.member || task.screen.member === `review-${reviewerKey}`);
    const saved = task?.maintenance && task.maintenance.role.id === roleId ? task.maintenance.profile : undefined;
    const planned = saved ?? this.host.current().profiles.find(profile => profile.id === plannedId) ?? this.host.current().profiles.find(profile => profile.id === this.host.onUsable(plannedId));
    if (saved) {
      if (task?.maintenance?.settingsDecision && !task.maintenance.settingsDecision.choice) return {
        kind: "none",
        waiting: "Waiting for your decision about the reported agent settings"
      };
      const limit = limitOf(this.host.current().pool, saved, this.host.now());
      if (limit) return { kind: "none", waiting: "Waiting for usage on the saved maintenance profile" };
      const full = this.capacityUntil(task, saved, this.host.now());
      // A scheduled run keeps its saved profile. A full model waits and retries that profile.
      if (full) return { kind: "none", capacity: true, waiting: this.host.capacityWaiting(full, this.host.now()) };
      if (!this.host.current().tools.some(t => t.id === saved.toolId && t.status === "ready")) return {
        kind: "none",
        waiting: "The saved maintenance tool is unavailable. Check it in Agents, then resume this run."
      };
      return { kind: "planned", profile: saved, reason: "Kept the profile saved in the maintenance routine." };
    }
    if (!planned) return undefined;
    const stage = task?.plan?.stages[task.stageIndex];
    const round = task && stage ? task.rounds[stage.id] ?? 1 : 1;
    const role = roleId === undefined ? undefined : this.host.role(roleId, task);
    const contract = role && { awayFromBuilder: this.host.awayFromBuilder(role) };
    const findings = role?.result === "findings";
    // Security and port reviews follow the latest builder, including a replacement that did the port.
    const builder = task?.plan?.stages.find((stage) => this.host.role(stage.roleId, task)?.result === "build")?.profileIds[0];
    let made: {
      toolId: Id;
      modelId?: string
    } | undefined = contract?.awayFromBuilder || (!!task?.maintenance && findings) || (repository?.portReview && stage?.kind === "review-chain" && findings)
      ? (repository?.builderSession ? {
        toolId: repository!.builderSession.toolId,
        modelId: repository!.builderSession.model
      } : builder ? this.host.profile(builder) : undefined)
      : undefined;
    if (task && stage?.kind === "converge" && task.sub === 1 && (roleId === stage.reviewerRoleId || role?.result === "objections")) {
      const saved = task.designSessions?.[JSON.stringify([stage.id, "author", repository!.productId])];
      const author = saved ? undefined : this.host.completedDesignAuthor(task.id, stage.id, round, stage.roleId);
      const legacy = task.session.findLast((line) => line.from === "agent" && line.roleId === stage.roleId)?.profileId;
      made = saved ? {
        toolId: saved.toolId,
        modelId: saved.model
      } : author ? {
        toolId: author.toolId,
        modelId: author.modelRan ?? author.modelAsked
      } : this.host.profile(legacy ?? stage.profileIds[0] ?? "");
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
          legacy = this.host.reportedReviewerTools(task.id, stage.id, round, Object.keys(hunt.reported).length);
          this.legacyReviewerTools.set(task, { key: stamp, tools: legacy });
        }
      }
      peers = stage.profileIds.flatMap((id, index) => {
        if (String(index) === key) return [];
        if (legacy.length && hunt?.reported[String(index)]) return [];
        const peer = this.host.profile(hunt?.profiles?.[String(index)] ?? id);
        return peer ? [peer.toolId] : [];
      });
      peers.push(...legacy);
    }
    const state = this.host.activeState();
    const now = this.host.now();
    // A short retry is already waiting on this profile. Another free model does not take the step yet.
    const held = this.holdingForShortRetry(task, roleId, planned, now);
    if (held) return { kind: "none", capacity: true, waiting: this.host.capacityWaiting(held, now) };
    const checked = state.setup?.checks.some((check) => this.host.hasToolAdapter(check.id));
    const usable = this.host.usableTools() as Id[];
    // Usage stand-ins follow the same login checks as the plan: Ready tools first, otherwise the
    // ones we couldn't check. Before checks have run, keep the existing installed-tool selection.
    const among = (tools: readonly Id[]) => checked ? {
      ...state,
      // With no usable tool at all, let the planned tool reach its readiness guard so
      // the task gets a login/install request, rather than a misleading usage wait.
      profiles: state.profiles.filter((profile) => tools.includes(profile.toolId) || (!tools.length && profile.id === plannedId)),
      tools: state.tools.filter((tool) => tools.includes(tool.id)).map((tool) => ({ ...tool, status: "ready" as const })),
    } : state;
    let candidates = among(usable);
    const modelFull = (profile: AgentProfile) => this.capacityUntil(task, profile, now);
    // The step waits for a full model only while the account has usage. An account limit keeps its own wait and words.
    const fullOnly = (profile: AgentProfile) => limitOf(state.pool, profile, now) ? undefined : modelFull(profile);
    if (roleId !== undefined && this.host.role(roleId, task)?.result === "votes") {
      // A voter owns one actual tool's place, not a nominal profile's place. Other tools have
      // voters of their own: a model fallback stays on this tool; a usage limit waits for its place.
      // A full model stays on this tool too. Every model on it being full waits, rather than
      // giving a partner another vote. A full cap still waits the same way.
      const ready = candidates.tools.filter((tool) => tool.status === "ready");
      const onTool = candidates.profiles.filter((profile) => profile.toolId === planned.toolId);
      const open = onTool.filter((profile) => !modelFull(profile));
      if (!open.length && !limitOf(state.pool, planned, now)) {
        const until = onTool.map((profile) => modelFull(profile)).find((until) => until !== undefined) ?? modelFull(planned);
        return until
          ? { kind: "none", capacity: true, waiting: this.host.capacityWaiting(until, now) }
          : { kind: "none", waiting: "Waiting for a usable review tool" };
      }
      if (ready.length && !ready.some((tool) => tool.id === planned.toolId)) return { kind: "none", waiting: "Waiting for a usable review tool" };
      candidates = { ...candidates, profiles: open };
    } else if (candidates.profiles.some((profile) => modelFull(profile))) {
      // The full model is left out, including another effort of it. Seats and review independence
      // still decide whether another model on this tool goes first. A full tool yields to one that can work.
      candidates = { ...candidates, profiles: candidates.profiles.filter((profile) => !modelFull(profile)) };
    }
    // The same candidates as if a saved tool whose readiness is uncertain had passed: whether readiness alone stands in the way.
    const passing = (toolId: Id) => {
      const all = among([
      ...usable,
      toolId
    ]);
      return {
      ...all,
      profiles: all.profiles.filter((profile) => !modelFull(profile))
    };
    };
    const limit = this.host.readinessAllowanceMs();
    const checkOn = (toolId: Id) => state.setup?.checks.find((check) => check.id === toolId);
    // An uncertain answer that a recheck turned into Ready. A Ready tool's ordinary check that only settled says nothing more.
    const rechecked = (facts: ReadinessRecheck | undefined) => facts?.outcome === "ready" && facts.previous.status !== "ready";
    const need = (
      saved: { readinessWait?: ReadinessWait },
      profile: AgentProfile,
      words: string
    ): Selection => ({
      kind: "none",
      waiting: words,
      readiness: {
      toolId: profile.toolId as CheckId,
      profileId: profile.id,
      roleId: roleId!,
      saved,
      words,
      scope: scope!
    }
    });
    const reviewing = roleId !== undefined && ["findings", "objections", "votes"].includes(this.host.role(roleId, task)?.result ?? "");
    // A saved screen conversation is not swapped just for being near a limit. Reopen it on its tool
    // while that tool is available; a replacement still follows the current independence rules.
    if (screen) {
      const full = fullOnly(planned);
      // An agent that already has the screen retries the same profile. It does not hand the step to another model.
      if (full) return { kind: "none", capacity: true, waiting: this.host.capacityWaiting(full, now) };
      if (state.setup?.checks.some((check) => check.id === planned.toolId && this.host.notReady(check.status))) return {
        kind: "planned",
        profile: planned,
        reason: "Kept the screen conversation's profile so its tool can report the readiness problem."
      };
      const saved = chooseWithRoom(candidates, planned, now, { keep: true }, room);
      if (saved.kind === "planned") return saved;
    }
    const own = task && roleId !== undefined && roleId === stage?.roleId ? this.builderConversation(scope!, plannedId) : undefined;
    // Why a returning Builder starts fresh after its readiness decision, and that decision's evidence.
    let ownFresh: string | undefined;
    let ownReadiness: ReadinessRecheck | undefined;
    if (own && !modelFull(own.profile) && !limitOf(
      state.pool,
      own.profile,
      now
    ) && !nearLimit(
      state.pool,
      own.profile,
      now
    ) && headroom(
      state.pool,
      own.profile,
      now
    ) !== 0 && (!room || room(
      own.toolId,
      own.profile
    ))) {
      const check = checkOn(own.toolId);
      const wait = own.saved.readinessWait;
      ownReadiness = wait && readinessOutcome(check, wait, now, limit);
      const usableOwn = candidates.profiles.some((profile) => profile.id === own.profile.id) && (!checked || usable.includes(own.toolId));
      // Recovery checks are bounded by the normal tool-check timeout. Checking is temporary; let it answer before
      // replacing a healthy saved Builder with a permanent fresh start. An uncertain answer gets one bounded recheck.
      if (check?.checking || (checked && !usableOwn && uncertain(check?.status))) {
        const gate = readinessGate(check, wait, now, limit, true);
        if (gate.kind === "wait") return need(own.saved, own.profile, `Checking ${this.host.toolName(own.toolId)} before the Builder returns`);
        ownFresh = gate.reason;
      }
      if (usableOwn) {
        const ready = candidates.tools.filter((tool) => tool.status === "ready");
        if (!ready.length || ready.some((tool) => tool.id === own.toolId)) return {
          kind: own.profile.id === plannedId ? "planned" : "substitute",
          profile: own.profile,
          reason: `Returned to the Builder's existing conversation on an available profile.${rechecked(ownReadiness) ? ` ${this.host.toolName(own.toolId)} passed its readiness recheck first.` : ""}`,
          ...(ownReadiness ? { readiness: ownReadiness } : {})
        };
      }
    }
    const builderFresh = (choice: Selection): Selection => ownFresh && choice.kind !== "none" && choice.profile.toolId !== own?.toolId
      ? {
        ...choice,
        reason: `Started a fresh conversation: ${ownFresh}. ${choice.reason ?? ""}`.trim(),
        freshReason: ownFresh,
        ...(ownReadiness ? { readiness: ownReadiness } : {})
      } : choice;
    if (task?.maintenance && findings && candidates.tools.some(tool => tool.status === "ready" && tool.id !== task.maintenance!.profile.toolId)) {
      const author = task.maintenance.profile;
      candidates = {
        ...candidates,
        profiles: candidates.profiles.filter(profile => !(profile.toolId === author.toolId && profile.modelId === author.modelId && profile.effort === author.effort))
      };
    }
    const rules = {
      keep: !!screen || reviewing,
      awayFromTools: peers,
      ...(made ? { awayFrom: {
      toolId: made.toolId,
      ...(made.modelId ? { modelId: made.modelId } : {})
    } } : {})
    };
    // A model that took over and then filled up is owed its short continue, even once the planned model is free.
    // It goes first only where the planned profile itself would be kept: with usage, a seat and the review's independence.
    // Otherwise the usual choice applies, so a free tool takes the step instead of waiting for this one.
    const owed = screen ? undefined : this.replacementOwedContinue(task, roleId, planned, reviewerKey);
    if (owed && (!room || room(owed.toolId, owed))) {
      const kept = chooseWithRoom(candidates, owed, now, rules, room);
      if (kept.kind === "planned" && kept.profile.id === owed.id) return {
        kind: "substitute",
        profile: owed,
        reason: "Continued the conversation that was waiting out a full model."
      };
    }
    const participant = scope && role && !screen ? participantConversation(
      {
      profiles: this.host.current().profiles,
      digest: text => this.host.digest(text)
    },
      scope,
      role,
      planned,
      reviewerKey
    ) : undefined;
    let freshReason = participant?.reason;
    const previous = participant?.actual;
    const wait = participant?.prior?.readinessWait;
    // A recorded readiness decision stays with the saved conversation's start, including a failed reopen after Ready.
    const readiness = previous && wait ? readinessOutcome(checkOn(previous.toolId), wait, now, limit) : undefined;
    const withReadiness = (choice: Selection): Selection => readiness && choice.kind !== "none" ? { ...choice, readiness } : choice;
    // The usual choice with the saved profile treated as planned. Preserve why it rejected it,
    // whether for usage headroom or review independence.
    const rejected = (kept: Choice) => (kept.kind === "none" ? kept.waiting : kept.reason ?? "the usual selection requires a different profile")
      .replaceAll("planned profile", "saved profile").replace(/\.$/, "");
    if (participant && !freshReason && previous) {
      const standIn = previous.id !== planned.id;
      if (standIn && participant.coordinator) freshReason = "you chose this seat's profile, so it returns to your choice when available";
      else if (standIn && previous.standby) freshReason = "its saved profile is a standby profile";
      else if (standIn && previous.effort !== planned.effort) freshReason = "its saved profile has a different effort from the planned profile";
      else if (limitOf(state.pool, previous, now)) freshReason = "its saved profile is out of usage";
      else if (modelFull(previous)) freshReason = "its saved model is full";
      else if (room && !room(previous.toolId, previous)) freshReason = "its saved tool has no free agent slot";
      else {
        const check = checkOn(previous.toolId);
        const ready = candidates.profiles.some((profile) => profile.id === previous.id) && candidates.tools.some((tool) => tool.id === previous.toolId && tool.status === "ready");
        if ((standIn && check?.checking) || (checked && !ready && uncertain(check?.status))) {
          // A running check, or an uncertain answer that is all that stands in the way: the usual choice would keep
          // this conversation once its tool passes. Another restriction is never probed away.
          const kept = chooseWithRoom(ready ? candidates : passing(previous.toolId), previous, now, rules, room);
          const gate = kept.kind === "planned" && kept.profile.id === previous.id ? readinessGate(check, wait, now, limit, standIn) : undefined;
          if (gate?.kind === "wait") return need(
            participant.prior!,
            previous,
            `Checking ${this.host.toolName(previous.toolId)} before returning to its saved conversation`
          );
          freshReason = gate ? gate.reason : rejected(kept);
        } else if (!ready) {
          freshReason = `its saved tool is ${check?.status === "logged-out" ? "logged out" : check?.status === "not-installed" ? "not installed" : "not ready"}`;
        } else if (standIn) {
          const kept = chooseWithRoom(candidates, previous, now, rules, room);
          if (kept.kind === "planned" && kept.profile.id === previous.id) {
            const usual = chooseWithRoom(candidates, planned, now, rules, room);
            const recovered = usual.kind === "planned" && usual.profile.id === planned.id;
            return withReadiness({
              kind: "substitute",
              profile: previous,
              reason: `Kept its own conversation on ${this.host.profileName(previous.id)}${recovered ? ` while the planned ${this.host.profileName(planned.id)} is available` : ` for the seat planned for ${this.host.profileName(planned.id)}`}.${rechecked(readiness) ? ` ${this.host.toolName(previous.toolId)} passed its readiness recheck first.` : ""}`
            });
          }
          freshReason = rejected(kept);
        }
      }
    }
    const choice = chooseWithRoom(candidates, planned, now, rules, room);
    const full = fullOnly(planned);
    if (choice.kind === "none" && full) return { kind: "none", capacity: true, waiting: this.host.capacityWaiting(full, now) };
    if (checked && !usable.length && choice.kind === "planned") return {
      ...choice,
      reason: "No tool passed readiness checks; kept the planned profile so its tool can report the login or installation problem."
    };
    if (own && room && choice.kind !== "none" && !room(choice.profile.toolId, choice.profile)) {
      // A returning Builder must not get stuck on a full planned tool that recovered since
      // its last handoff. Try tools with seats; if none can work, keep the normal wait.
      const ready = candidates.tools.filter((tool) => tool.status === "ready");
      const seated = (ready.length ? ready : candidates.tools).filter((tool) => candidates.profiles.some(profile => profile.toolId === tool.id && room(
        tool.id,
        profile
      )));
      if (seated.length) {
        const available = {
          ...candidates,
          tools: seated.map((tool) => ({
          ...tool,
          status: "ready" as const
        })),
          profiles: candidates.profiles.filter((profile) => seated.some((tool) => tool.id === profile.toolId) && room(
          profile.toolId,
          profile
        ))
        };
        const next = chooseWithRoom(available, planned, now, rules, room);
        if (next.kind !== "none") return builderFresh(next);
      }
    }
    if (choice.kind !== "none" && participant && (participant.reason || choice.profile.id !== participant.prior?.profileId)) {
      const why = freshReason ?? "the usual selection requires a different profile";
      return withReadiness({ ...choice, reason: `Started a fresh conversation: ${why}. ${choice.reason ?? ""}`, freshReason: why });
    }
    // A planned participant returning to its own conversation after its tool passed the recheck says so.
    if (choice.kind !== "none" && rechecked(readiness) && previous && choice.profile.id === previous.id) {
      return withReadiness({
        ...choice,
        reason: [
        choice.reason,
        `${this.host.toolName(previous.toolId)} passed its readiness recheck before it returned to its saved conversation.`
      ].filter(Boolean).join(" ")
      });
    }
    return builderFresh(withReadiness(choice));
  }

  private capacityUntil(task: RuntimeTask | undefined, profile: AgentProfile, now: number): number | undefined {
    return task?.modelCapacity?.find((entry) => entry.until > now && entry.toolId === profile.toolId && entry.modelId === (profile.modelId ?? profile.model))?.until;
  }

  private replacementOwedContinue(task: RuntimeTask | undefined, roleId: Id | undefined, planned: AgentProfile, reviewerKey: string | undefined): AgentProfile | undefined {
    if (!task || roleId === undefined) return undefined;
    const votes = this.host.role(roleId, task)?.result === "votes";
    const seat = votes ? this.votePlace(task, planned.id) : reviewerKey !== undefined ? `review-${reviewerKey}` : undefined;
    const resumes = (task.capacityResume ?? []).filter((entry) => {
      if (entry.roleId !== roleId) return false;
      if (seat === undefined) return entry.member === undefined;
      return entry.member === seat || entry.member === undefined;
    });
    const owed = resumes.filter((entry) => {
      const tried = task.capacityRetries?.find((retry) => retry.roleId === entry.roleId && retry.profileId === entry.profileId && retry.member === entry.member)?.tried ?? 0;
      return tried >= 1 && tried <= this.host.capacityRetryCount();
    });
    const entry = owed.findLast((item) => item.profileId !== planned.id);
    return entry ? this.host.profile(entry.profileId) : undefined;
  }

  votePlace(task: RuntimeTask, profileId: Id): string {
    const hunt = task.hunt;
    const panel = hunt?.panel;
    const place = panel?.seats.find((seat) => seat.profileId === profileId && seatRemaining(panel, seat, task.findings, hunt!).length);
    return `vote-${place?.key ?? profileId}`;
  }

  private holdingForShortRetry(task: RuntimeTask | undefined, roleId: Id | undefined, profile: AgentProfile, now: number): number | undefined {
    if (!task || roleId === undefined) return undefined;
    let until: number | undefined;
    for (const entry of task.capacityPaused ?? []) {
      if (entry.roleId !== roleId || (entry.plannedId !== profile.id && entry.profileId !== profile.id)) continue;
      const paused = this.host.profile(entry.profileId);
      const at = paused ? this.capacityUntil(task, paused, now) : undefined;
      if (at !== undefined && (until === undefined || at < until)) until = at;
    }
    return until;
  }
}
