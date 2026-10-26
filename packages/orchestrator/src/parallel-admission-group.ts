import { runtimeWaitHolds, pickStarts, slotUses, routeMessages, finishMessageGroup, type ActiveAgent, type AgentProfile, type DeepMutable, type Id } from "@petrina/core";
import type { ParallelAdmissionHost, ParallelAdmissionDependencies, ParallelAdmissionRequest, ParallelSeatSelection as SeatSelection } from "./ports/parallel-admission.js";
import type { SelectionReadiness as ReadinessNeed } from "./profile-selection.js";

type AdmissionWait = ReturnType<ParallelAdmissionDependencies["errors"]["waitingFor"]>;

/** The actual reviewer/voter reservation and settlement state machine, independent of copy and provider adapters. */
export class ParallelAdmissionGroup {
  private readonly ownership: ParallelAdmissionDependencies["ownership"];
  private readonly catalog: ParallelAdmissionDependencies["catalog"];
  private readonly readiness: ParallelAdmissionDependencies["readiness"];
  private readonly errors: ParallelAdmissionDependencies["errors"];
  constructor(private readonly host: ParallelAdmissionHost, dependencies: ParallelAdmissionDependencies) {
    this.ownership = dependencies.ownership;
    this.catalog = dependencies.catalog;
    this.readiness = dependencies.readiness;
    this.errors = dependencies.errors;
  }

  async run({ scope, members, signal: parentSignal, status, workspaces }: ParallelAdmissionRequest): Promise<void> {
    const task = scope.task;
    const stop = new AbortController();
    const signal = AbortSignal.any([parentSignal, stop.signal]);
    const pending = [...members];
    const accepted = new Set<string>();
    const running = new Map<string, { agent: ActiveAgent; done: Promise<void> }>();
    const yielded = new Set<string>();
    // Members whose saved conversation waits for its tool's bounded readiness decision: the group stays open until
    // each settles, and later members keep their order behind it.
    const deciding = new Map<string, { need: ReadinessNeed; done: Promise<void> }>();
    // Members waiting out a full model beside working peers. Each keeps its own wait, so one that rejoined
    // and reported never leaves the task waiting after everyone has reported.
    const paused = new Set<string>();
    const waits = new Map<string, AdmissionWait>();
    // Members whose working copies exist: a member coming back reuses its own.
    const made = new Set<string>();
    let failed = false, failure: unknown;
    let closing = false;
    let wake: (() => void) | undefined;
    const wait = (key: string, waiting: AdmissionWait) => {
      waits.delete(key);
      waits.set(key, waiting);
    };
    // A full model's wait wins over a usage wait, as the latest one recorded.
    const noOne = () => [...waits.values()].findLast((entry) => entry.capacity) ?? waits.values().next().value;
    // A member stopped by a full model waits aside, whatever its next start waits for: the model, a free seat for the
    // model that takes over, or its account. The usual choice then decides when it can start again.
    const asideFor = (key: string, waiting: AdmissionWait) => waiting.capacity || !!task.capacityRetries?.some((entry) => entry.member === key);
    const show = () => {
      if (signal.aborted) return;
      this.host.selectScreen(task);
      if (task.screen?.member) scope.work.conversation ??= task.hunt?.screenTurns?.[task.screen.member]?.conversation;
      const agents = [...running.entries()].filter(([key]) => !yielded.has(key)).sort(([a], [b]) => Number(b === task.screen?.member) - Number(a === task.screen?.member)).map(([, entry]) => entry.agent);
      const [waitingOn, decision] = [...deciding.entries()][0] ?? [];
      if (agents.length) {
        task.holdsSlot = true;
        task.agent = agents[0]!;
      } else if (task.screen || runtimeWaitHolds(task)) {
        // A screen wait or prerequisite hold releases the group's last place. Ordinary cleanup keeps it.
        task.holdsSlot = false;
        delete task.agent;
      } else if (decision && task.holdsSlot && !this.readiness.charge(task, decision.need, members.find((member) => member.key === waitingOn)?.reviewKey)) {
        // The last working reviewer finished during a readiness decision. Its one main place stays with the group,
        // charged to the waiting reviewer's saved tool; where that tool has no room, the place is let go.
        task.holdsSlot = false;
        delete task.agent;
      }
      if (agents.length > 1) task.helpers = agents.slice(1);
      else delete task.helpers;
      const held = !agents.length && runtimeWaitHolds(task);
      task.state = this.host.state().inbox.some((item) => item.taskId === task.id && item.blocking) ? "needs-you" : held || task.screen && !task.screen.granted ? "waiting" : "running";
      if (held && task.state === "waiting") task.statusLine = this.host.admissionWait(task);
      else if (task.state === "running") task.statusLine = !agents.length && decision ? decision.need.words : status(running.size, pending.length);
      this.host.showReviewWork(task);
      this.host.syncScreen();
    };
    // A handoff replaces this member's seat; its working peers still count against every cap.
    const roomFor = (key: string) => (toolId: Id, profile: AgentProfile) => {
      const member = members.find(member => member.key === key);
      if (member && this.catalog.role(member.roleId)?.result === "votes" && this.catalog.profile(member.profileId)?.toolId !== toolId) return false;
      const state = this.host.activeState();
      let uses = slotUses(state);
      const agent = running.get(key)?.agent;
      if (agent) {
        const own = uses.findIndex((use) => use.taskId === task.id && use.profileId === agent.profileId && use.roleId === agent.roleId);
        uses = uses.filter((_, index) => index !== own);
      } else if (!running.size) uses = uses.filter((use) => use.taskId !== task.id);
      return pickStarts({ candidates: [{ ...profile, taskId: task.id, toolId }], inUse: uses, pool: state.pool, now: state.now }).length > 0;
    };
    // The screen member's step ends with its result. Peers still working or waiting out a full model keep their own
    // retry counts and conversations to continue.
    const finishScreenStep = (key: string) => {
      const peers = <T extends { member?: string }>(entries: T[] | undefined) => entries?.filter((entry) => entry.member !== undefined && entry.member !== key) ?? [];
      const resume = peers(task.capacityResume), retries = peers(task.capacityRetries), waiting = peers(task.capacityPaused);
      this.host.finishStep(task);
      if (resume.length) task.capacityResume = resume;
      if (retries.length) task.capacityRetries = retries;
      if (waiting.length) task.capacityPaused = waiting;
    };
    const startMember = (member: (typeof members)[number], copy: string, room: (toolId: Id, profile: AgentProfile) => boolean, seat: Id, continuing: boolean, selection?: SeatSelection) => {
      yielded.delete(member.key);
      paused.delete(member.key);
      waits.delete(member.key);
      const agent: DeepMutable<ActiveAgent> = { roleId: member.roleId, profileId: seat, since: this.host.now(), step: 0, reviewKey: member.reviewKey };
      let completed = false;
      const used = (profileId: Id) => {
        agent.profileId = profileId;
        if (member.reviewerKey !== undefined) this.host.rememberReviewer(task, member.reviewerKey, profileId);
        show();
        this.host.checkpoint();
      };
      // A screen continuation or a member back from a full model works in the copies it already has.
      const reuse = continuing || made.has(member.key);
      const done = Promise.resolve()
        .then(async () => {
          const prepared = await workspaces.prepare(member, copy, continuing, reuse);
          made.add(member.key);
          prepared.activate();
          try { await member.work(copy, room, seat, used, agent, continuing, signal, selection); }
          finally { prepared.finish(); }
        })
        .then(() => {
          completed = true;
          if (task.hunt?.screenTurns) delete task.hunt.screenTurns[member.key];
        })
        .catch((error: unknown) => {
          // Usage and capacity waits keep the missing seat; partners finish and keep their ballots.
          const problem = this.errors.classify(error);
          if (problem.kind === "usage") {
            const waiting = { error: problem.error, words: problem.words, capacity: problem.capacity };
            wait(member.key, waiting);
            // A full model waits aside to rejoin. A member that holds the screen keeps its own path.
            if (asideFor(member.key, waiting) && !continuing && task.screen?.member !== member.key) paused.add(member.key);
          } else if (problem.kind !== "screen") {
            if (!failed) { failed = true; failure = error; }
            // Stop question and permission waits too, so cleanup cannot wait on a dead peer.
            stop.abort();
          }
        })
        .finally(() => {
          running.delete(member.key);
          // Release and expose the next peer together, after its result is saved. No other task
          // can take the screen in between while learnings or other result handling awaits I/O.
          if ((!signal.aborted || completed) && !failed && task.screen?.member === member.key && !task.hunt?.screenTurns?.[member.key]) finishScreenStep(member.key);
          show();
          this.host.changed();
          wake?.();
          // Peers and queued tasks may use the seats that actually came free.
          if (!failed) this.host.schedule();
        });
      running.set(member.key, { agent, done });
      show();
      // Saving the profile notifies listeners, which may change permissions and schedule again.
      // Expose its reservation first so that reentrant scheduling counts every seat and cannot admit it twice.
      if (member.reviewerKey !== undefined) this.host.rememberReviewer(task, member.reviewerKey, seat);
    };
    const continueScreen = () => {
      if (signal.aborted || failed || this.host.admissionsClosed(task) || this.host.sourceRefreshDue(task)) return;
      const member = members.find((entry) => entry.key === task.screen?.member);
      const saved = member && task.hunt?.screenTurns?.[member.key];
      if (!member || !saved || running.has(member.key)) return;
      const index = pending.findIndex((entry) => entry.key === member.key);
      if (index >= 0) pending.splice(index, 1);
      scope.work.conversation ??= saved.conversation;
      startMember(member, saved.copy, roomFor(member.key), task.agent?.profileId ?? saved.conversation.profileId, true);
    };
    // Nobody starts or comes back while admission is closed for this task, a peer owns or waits
    // for the screen, or the group is ending. The same rule covers model returns and readiness probes.
    const mayStart = () => !closing && !failed && !signal.aborted && !this.host.admissionsClosed(task) && !this.host.sourceRefreshDue(task) && !task.screen && !Object.keys(task.hunt?.screenTurns ?? {}).length;
    /** Who would start for this member now, by the usual choice, or why it waits and whether only its saved tool's readiness stands in the way. */
    const admission = (member: (typeof members)[number]) => {
      const room = roomFor(member.key);
      const choice = this.catalog.choose({ profileId: member.profileId, roleId: member.roleId, ...(member.reviewerKey !== undefined ? { reviewerKey: member.reviewerKey } : {}) }, task, room);
      if (choice?.kind === "none") return { room, waiting: this.errors.waitingFor(choice.waiting), readiness: choice.readiness };
      const seat = choice?.profile.id ?? member.profileId;
      const selection: SeatSelection | undefined = choice ? { ...(choice.reason ? { selectionReason: choice.reason } : {}), ...(choice.freshReason ? { freshReason: choice.freshReason } : {}), ...(choice.readiness ? { readiness: choice.readiness } : {}) } : undefined;
      return { room, seat, profile: this.catalog.profile(seat)!, selection };
    };
    /**
     * A member set aside, by the usual choice: who would start for it now, or why it still waits. Its saved tool's
     * readiness recheck starts or is joined meanwhile, without a place and without waiting for working peers.
     */
    const due = (member: (typeof members)[number]) => {
      const next = admission(member);
      if (next.waiting) {
        wait(member.key, next.waiting);
        if (next.readiness) void this.readiness.resolve(next.readiness);
      }
      return next;
    };
    /**
     * Members whose own wait ended come back in their stable order, each only into a free seat, at most `limit`.
     * A member's reservation is visible before anything is saved, so a schedule during its start cannot admit it twice.
     */
    const rejoin = (limit = Infinity) => {
      for (const member of members) {
        if (limit <= 0 || !mayStart()) return;
        if (!paused.has(member.key) || running.has(member.key)) continue;
        const next = due(member);
        if (next.waiting) continue;
        if (!next.room(next.profile.toolId, next.profile)) continue;
        startMember(member, workspaces.reference(member.key), next.room, next.seat, false, next.selection);
        limit -= 1;
      }
    };
    const start = () => {
      while (pending.length && mayStart()) {
        const member = pending[0]!;
        // Its decision is still open: no peer is moved ahead of it.
        if (deciding.has(member.key)) break;
        const next = admission(member);
        if (next.readiness && this.readiness.open(next.readiness)) {
          // The group owns this member's decision: the check starts or is joined now, without waiting for working
          // peers, and the member stays pending without a place of its own until the check answers or its limit passes.
          // Places are settled first: with no peer working, the group's main place moves to the saved tool.
          const decision = { need: next.readiness, done: Promise.resolve() };
          deciding.set(member.key, decision);
          show();
          decision.done = this.readiness.resolveHeld(next.readiness, signal, () => {
            // A hold ends only the group's admission decision, never the shared tool check or
            // a peer already working. Reconcile those owners before the driver frees a place.
            show();
            return !task.holdsSlot;
          }).then(() => {
            deciding.delete(member.key);
            wake?.();
          });
          break;
        }
        if (next.waiting) {
          pending.shift();
          wait(member.key, next.waiting);
          // A full model waits aside too, and joins its peers once that wait ends.
          if (asideFor(member.key, next.waiting)) paused.add(member.key);
          continue;
        }
        if (!next.room(next.profile.toolId, next.profile)) break;
        pending.shift();
        startMember(member, workspaces.reference(member.key), next.room, next.seat, false, next.selection);
      }
      rejoin();
      this.host.changed();
    };
    this.ownership.groups.set(task.id, {
      continue: continueScreen,
      running: (key) => running.has(key),
      yield: (key) => { yielded.add(key); show(); },
      recipients: () => members.filter((member) => !accepted.has(member.key)).map((member) => member.key),
      finished: (key) => { accepted.add(key); },
      // The scheduler weighs a member whose wait ended against other work in progress, then brings it back.
      returning: () => mayStart() ? members.flatMap((member) => {
        if (!paused.has(member.key) || running.has(member.key)) return [];
        const next = due(member);
        return next.waiting ? [] : [{ ...next.profile, taskId: task.id, toolId: next.profile.toolId }];
      }) : [],
      rejoin: () => rejoin(1),
    });
    routeMessages(task, members.map((member) => member.key));
    let groupFailure: { error: unknown } | undefined;
    try {
      if (task.screen?.member) continueScreen();
      else start();
      while (running.size || deciding.size) {
        // A member reopened while its peers work, or a settled readiness decision, must also be able to wake this group.
        await Promise.race([...running.values()].map((entry) => entry.done).concat([...deciding.values()].map((entry) => entry.done), new Promise<void>((resolve) => { wake = resolve; })));
        if (failed || signal.aborted) break;
        start();
      }
      // Every peer has finished: a member still waiting stays with the task's wait, not this group.
      closing = true;
      if (failed) throw failure;
      // Readiness can settle after a wait ended. Unwind and clean the old copies before catch-up;
      // returning normally would let runReview treat this unopened group as finished.
      if (!signal.aborted && this.host.sourceRefreshDue(task)) throw this.errors.sourceRefresh();
      const waiting = noOne();
      if (!signal.aborted && !waiting?.capacity && Object.keys(task.hunt?.screenTurns ?? {}).length) {
        show();
        this.host.checkpoint();
        throw this.errors.screenWait();
      }
      // Admitted members keep their reports. Missing seats remain on this same group after release.
      if (pending.length && this.host.admissionsClosed(task)) {
        const words = this.host.admissionWait(task);
        this.host.waitForUsage(task, words);
        throw this.errors.usage(words);
      }
      // The rest looked at the change and reported; the ones left wait, and the driver starts them again after.
      // A required seat waits even when a partner already voted.
      if (waiting) {
        this.host.waitForUsage(task, waiting.words);
        throw waiting.error;
      }
      if (!signal.aborted && !this.host.draining() && !pending.length) finishMessageGroup(task, members.map((member) => member.key));
    } catch (error) {
      groupFailure = { error };
      throw error;
    } finally {
      closing = true;
      this.ownership.groups.delete(task.id);
      const errors: unknown[] = [];
      try { workspaces.stopHelpers(); } catch (error) { errors.push(error); }
      if (failed || signal.aborted) try { workspaces.closeTaskRun(); } catch (error) { errors.push(error); }
      await Promise.allSettled([...running.values()].map((entry) => entry.done));
      delete task.helpers;
      // A member who yielded the screen released its seat before its process exited.
      try { await workspaces.releasedStops(); } catch (error) { errors.push(error); }
      if (!errors.length) {
        const readOnly = members.every((member) => !this.catalog.role(member.roleId)?.canEdit);
        try { await workspaces.finish(readOnly); } catch (error) { errors.push(error); }
      }
      if (errors.length) {
        if (groupFailure) throw new AggregateError([groupFailure.error, ...errors], "The review group failed and its cleanup was not confirmed");
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, "The review group could not confirm all cleanup");
      }
    }
  }
}
