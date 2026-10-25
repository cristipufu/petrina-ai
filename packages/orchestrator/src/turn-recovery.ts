import { pauseClock, resumeClock, startClock, type AgentProfile, type Id } from "@petrina/core";
import { repositoryView } from "./repository-context.js";
import { ModelCapacity, sameCapacityModel } from "./model-capacity.js";
import type { CapacityRefusal, UsageRefusal, MainRecoveryRequest, MemberRecoveryRequest, TurnRecoveryErrors, TurnRecoveryHost } from "./turn-recovery-ports.js";

/** Actual main and member retry loops; native attempts retain transport, repositories and recording boundaries. */
export class TurnRecovery {
  constructor(private readonly host: TurnRecoveryHost, private readonly errors: TurnRecoveryErrors, readonly capacity: ModelCapacity) {}
  async main<T>(request: MainRecoveryRequest<T>): Promise<T> {
    const { scope, roleId, plannedId, signal } = request;
    const { task } = scope;
    let stopped: { profileId: Id; error: UsageRefusal | CapacityRefusal; at: number } | undefined;
    for (;;) {
      if (this.host.admissionsClosed(task)) throw this.errors.usageWait(this.host.admissionWait(task));
      // A screen request keeps the profile whose conversation asked, even if its planned tool is free again.
      const wanted = task.screen?.roleId === roleId ? task.screen.profileId : plannedId;
      const room = request.room ?? ((toolId: Id, profile: AgentProfile) => !this.host.slotWait(task, profile, toolId));
      const choice = this.host.catalog.choose({ profileId: wanted, roleId, reviewerKey: request.reviewerKey }, scope, room)!;
      if (choice.kind === "none" && choice.readiness && !stopped) {
        // Only a saved participant's uncertain tool stands in the way. A step holding its place keeps it for the
        // bounded decision and chooses again; otherwise the check starts or is joined and the task waits as usual.
        if (!request.member && this.host.readiness.hold(task, choice.readiness)) {
          const kept = await this.host.readiness.resolveHeld(choice.readiness, signal);
          if (signal.aborted) throw this.errors.aborted();
          if (!kept) throw this.errors.usageWait(this.host.admissionWait(task));
          if (this.host.sourceRefreshDue(task)) throw this.errors.sourceRefresh();
          continue;
        }
        if (!this.host.admissionsClosed(task)) void this.host.readiness.resolve(choice.readiness);
      }
      if (choice.kind === "none") {
        // A full model, with nothing else to take the step, retries the same conversation. It is not a usage limit,
        // unless the account is out as well: then the wait is that limit's.
        if ((stopped && this.errors.capacity(stopped.error))) {
          this.capacity.prepare(scope, roleId, stopped.profileId, stopped.error, request.member);
          this.host.waitForUsage(task, choice.waiting);
          throw this.errors.waiting(choice.waiting);
        }
        // Stopped by a limit and waiting for the reset: the step's next attempt is a retry.
        if (stopped) this.host.owesRetry(scope, roleId, plannedId);
        this.host.waitForUsage(task, choice.waiting);
        throw this.errors.usageWait(choice.waiting);
      }
      const { profile } = choice;
      // The same model, including another effort of it, cannot take over from itself.
      if ((stopped && this.errors.capacity(stopped.error)) && (stopped.profileId === profile.id || sameCapacityModel(stopped.error, profile))) {
        this.capacity.prepare(scope, roleId, stopped.profileId, stopped.error, request.member);
        const words = this.capacity.words(scope, stopped.profileId);
        this.host.waitForUsage(task, words);
        throw this.errors.capacityWait(words);
      }
      // The tool said it was out while running something it should not have limited: the step cannot go on.
      if (stopped?.profileId === profile.id) throw stopped.error;
      // Every actual tool qualifies, including an internal errand before a reviewer, and a handoff
      // to another model on the same tool. The task's old seat is the one being replaced.
      const wait = request.room
        ? room(profile.toolId, profile) ? undefined : `Waiting for a free ${this.host.toolName(profile.toolId)} slot`
        : this.host.slotWait(task, profile, profile.toolId);
      if (wait) {
        if (stopped && !(this.errors.capacity(stopped.error))) this.host.owesRetry(scope, roleId, plannedId);
        this.host.waitForUsage(task, wait);
        throw this.errors.usageWait(wait);
      }
      this.host.attempt(scope, roleId, plannedId, profile, stopped !== undefined);
      request.used?.(profile.id);
      // Said where the coordinator will see it: a security review that could not stay off the builder's tool.
      this.host.beforeMainAttempt(scope, roleId, profile);
      try {
        return await request.attempt(profile, choice);
      } catch (error) {
        if (signal.aborted) throw error;
        if (this.host.discardUnavailable(scope, roleId, error, request.reviewerKey)) continue;
        if (this.errors.capacity(error)) {
          // Keep the conversation and the work. The same model gets a few short continues before anyone else takes the step.
          // An agent that already has the screen keeps it: this is not a usage limit, and it does not give the screen up.
          this.host.keepWords(scope, roleId, profile.id, request.reviewerKey, error);
          if (this.capacity.defer(scope, roleId, profile.id, error, plannedId, request.member)) {
            const words = this.capacity.words(scope, profile.id);
            this.host.waitForUsage(task, words);
            throw this.errors.capacityWait(words);
          }
          stopped = { profileId: profile.id, error, at: this.host.now() };
          continue;
        }
        if (!(this.errors.usage(error))) throw error;
        this.host.keepWords(scope, roleId, profile.id, request.reviewerKey, error);
        this.host.recordLimit(task, roleId, profile.id, error);
        if (task.screen?.granted && task.screen.profileId === profile.id) {
          this.host.owesRetry(scope, roleId, plannedId);
          this.host.waitForScreen(task);
          throw this.errors.screenWait();
        }
        stopped = { profileId: profile.id, error, at: this.host.now() };
      }
    }

  }
  async member<T>(request: MemberRecoveryRequest<T>): Promise<T> {
    const { scope, roleId, plannedId, signal } = request;
    const { task } = scope;
    if (signal.aborted) throw this.errors.aborted();
    const key = request.key ?? `${roleId}:${plannedId}`;
    let role = task.hunt?.roles?.[key];
    // Out of usage: a stand-in looks at the change instead, told what the first one had said. With none, the
    // group (not this agent) makes the task wait: the others carry on, and this one is left for later.
    let stopped: { profileId: Id; error: UsageRefusal | CapacityRefusal; at: number } | undefined;
    // The group already reserved `seat` (the card shows it). Choosing again after that reservation sees a
    // full pool and would start the first full stand-in instead, so the first attempt uses the reserved profile.
    let first = true;
    // Partners of one step share the read the group just did. A usage replacement is another attempt and reads again.
    let refresh = request.refresh !== false;
    for (;;) {
      if (!first && this.host.admissionsClosed(task)) throw this.errors.usageWait(this.host.admissionWait(task));
      const accepted = first && request.seat ? this.host.catalog.profile(request.seat) : undefined;
      first = false;
      let profile: AgentProfile;
      // The reserved seat's words belong to its first attempt. Every later choice replaces both, even with none,
      // so a stand-in never repeats why the first start was fresh.
      let selectionReason = request.selectionReason;
      let freshReason = request.freshReason;
      let readiness = request.readiness;
      if (accepted) profile = accepted;
      else {
        const choice = this.host.catalog.choose({ profileId: plannedId, roleId, reviewerKey: request.reviewerKey }, scope, request.room);
        if (!choice) throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
        if (choice.kind === "none") {
          // A member adds no place for a readiness check: the check starts or is joined, and the group waits as usual.
          if (choice.readiness && !this.host.admissionsClosed(task)) void this.host.readiness.resolve(choice.readiness);
          // The group waits. A full model is not a usage limit: peers finish, and this seat stays for the same profile.
          // When the account is out as well, the wait is that limit's.
          if ((stopped && this.errors.capacity(stopped.error))) {
            this.capacity.prepare(scope, roleId, stopped.profileId, stopped.error, request.member);
            throw this.errors.waiting(choice.waiting);
          }
          // The group waits, and this agent is started again after: that attempt is a retry.
          if (stopped) this.host.owesRetry(scope, roleId, plannedId);
          throw this.errors.usageWait(choice.waiting);
        }
        profile = choice.profile;
        selectionReason = choice.reason;
        freshReason = choice.freshReason;
        readiness = choice.readiness;
      }
      if ((stopped && this.errors.capacity(stopped.error)) && (stopped.profileId === profile.id || sameCapacityModel(stopped.error, profile))) {
        this.capacity.prepare(scope, roleId, stopped.profileId, stopped.error, request.member);
        throw this.errors.capacityWait(this.capacity.words(scope, stopped.profileId));
      }
      // Every new choice, including after a failed cross-round reopen, must fit this member's seat.
      if (!accepted && request.room && !request.roomCheck(profile.toolId, profile)) {
        const tool = this.host.toolName(profile.toolId);
        if (stopped && !(this.errors.capacity(stopped.error))) this.host.owesRetry(scope, roleId, plannedId);
        throw this.errors.usageWait(`Waiting for a free ${tool} slot`);
      }
      if (stopped && stopped.profileId === profile.id) throw stopped.error;
      this.host.attempt(scope, roleId, plannedId, profile, stopped !== undefined);
      if (!role) {
        role = structuredClone(this.host.catalog.role(roleId, task)!);
        if (task.hunt) {
          task.hunt.roles = { ...task.hunt.roles, [key]: role };
          this.host.checkpoint(scope);
        }
      }
      request.used?.(profile.id);
      const previous = task.hunt?.work?.[key];
      const work = {
        ...previous,
        attempts: previous?.attempts ?? 0,
        clock: previous?.clock ? resumeClock(previous.clock, this.host.now()) : startClock(repositoryView(scope), roleId, this.host.now()),
      };
      delete work.waiting;
      task.hunt!.work = { ...task.hunt!.work, [key]: work };
      const active = [task.agent, ...(task.helpers ?? [])].find((agent) => agent?.reviewKey === key);
      if (active) active.profileId = profile.id;
      this.host.showReviewWork(task);
      this.host.checkpoint(scope);
      const since = this.host.now();
      try {
        return await request.attempt(role, profile, { key, refresh, plannedId, selectionReason, freshReason, readiness, ...(stopped ? { took: { profileId: stopped.profileId, at: stopped.at, ...(this.errors.capacity(stopped.error) ? { refusal: "the selected model is at capacity" } : stopped.error.retry ? { refusal: stopped.error.reason } : {}) } } : {}) });
      } catch (error) {
        if (signal.aborted) throw error;
        if (this.host.discardUnavailable(scope, roleId, error, request.reviewerKey)) continue;
        if (this.errors.capacity(error)) {
          refresh = true;
          work.clock = pauseClock(work.clock, this.host.now());
          // This member stopped working: a peer's retry no longer says the others continue.
          this.host.showReviewWork(task);
          this.host.keepWords(scope, roleId, profile.id, request.reviewerKey, error);
          // Peers keep working. The group waits only once this member's short retries, or its stand-in, are exhausted.
          if (this.capacity.defer(scope, roleId, profile.id, error, plannedId, request.member)) throw this.errors.capacityWait(this.capacity.words(scope, profile.id));
          stopped = { profileId: profile.id, error, at: since };
          continue;
        }
        if (!(this.errors.usage(error))) throw error;
        refresh = true;
        // This member has stopped, even while its peers keep working. A stand-in resumes its clock.
        work.clock = pauseClock(work.clock, this.host.now());
        this.host.showReviewWork(task);
        this.host.keepWords(scope, roleId, profile.id, request.reviewerKey, error);
        this.host.recordLimit(task, roleId, profile.id, error);
        stopped = { profileId: profile.id, error, at: since };
      }
    }
  }

}
