import { type AgentProfile, type BuilderContext, type CheckId, type ConversationNote } from "@petrina/core";
import { ReviewConversations, reviewBaseUpdates } from "../../src/review-conversations.js";
import { discardParticipant, participantConversation } from "../../src/participant-conversation.js";
import { rememberReviewProfile } from "../../src/review-members.js";
import { TurnRecovery } from "../../src/turn-recovery.js";
import { ModelCapacity } from "../../src/model-capacity.js";
import type { TurnRecoveryHost } from "../../src/turn-recovery-ports.js";
import type { ReviewBaseEffects } from "../../src/ports/review-conversations.js";
import { sourceConflictFixture } from "./source-conflicts.js";

class UnavailableParticipant extends Error {}

/** Real conversation, selection and conflict owners; packet/Git answers are explicit consumed observations. */
export function reviewConversationsFixture(single = false, shared = false) {
  const f = sourceConflictFixture(shared), { task, scope, scheduler } = f;
  const stage = task.plan!.stages[1]!;
  stage.profileIds = single ? ["opus-high"] : ["opus-high", "sol-high"];
  task.description = "ORIGINAL-REVIEW-REQUEST";
  task.brief = { summary: "ORIGINAL-DESIGN-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] };
  task.rounds.review = 1;
  scheduler.state.setup!.checks = scheduler.state.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
  const contexts: { context: BuilderContext | undefined; intact: boolean }[] = [];
  const ancestries: { key: string; value: boolean }[] = [];
  const files: { key: string; value: readonly string[] }[] = [];
  const counts: { key: string; value: string }[] = [];
  const reads: string[] = [], checkpoints: typeof task[] = [];
  const key = (...parts: string[]) => JSON.stringify(parts);
  function take<T>(queue: { key: string; value: T }[], expected: string): T {
    reads.push(expected);
    const next = queue.shift();
    if (!next || next.key !== expected) throw new Error(`Unexpected review observation: ${expected}; next: ${next?.key}`);
    return next.value;
  }
  const effects: ReviewBaseEffects = {
    contains: async (bound, base, before) => take(ancestries, key("contains", bound.work.productId, base, before)),
    changedFiles: async (bound, from, to) => take(files, key("files", bound.work.productId, from, to)),
    count: async (bound, before, base) => take(counts, key("count", bound.work.productId, before, base)),
  };
  const conversations = new ReviewConversations({
    profiles: () => scheduler.state.profiles, profile: scheduler.catalog.profile,
    digest: text => scheduler.selection.host.digest(text),
    checkpoint: () => { checkpoints.push(structuredClone(task)); }, unavailable: reason => new UnavailableParticipant(reason),
  }, {
    async contextIntact(context) {
      reads.push("context:" + context?.file);
      const next = contexts.shift();
      if (!next || JSON.stringify(next.context) !== JSON.stringify(context)) throw new Error("Unexpected saved packet observation");
      return next.intact;
    },
    baseUpdates: (bound, bases, heads) => reviewBaseUpdates(bound, bases, heads, effects),
  });
  const role = scheduler.catalog.role(stage.roleId, task)!;
  const seats = () => stage.profileIds.map((_, index) => String(index));
  const participant = (seat: string) => conversations.participant(scope, stage, seat, stage.profileIds[Number(seat)]!);
  const prior = (seat: string) => participantConversation({ profiles: scheduler.state.profiles, digest: text => scheduler.selection.host.digest(text) }, scope, role, scheduler.catalog.profile(stage.profileIds[Number(seat)]!)!, seat);
  const choose = (seat: string) => {
    const choice = scheduler.selection.selection.choose(stage.profileIds[Number(seat)]!, scope, role.id, () => true, seat);
    if (!choice || choice.kind === "none") throw new Error(choice?.waiting ?? "No supplied reviewer");
    return choice;
  };
  const note = (seat: string, actual: AgentProfile): ConversationNote => ({
    step: `review:${task.rounds.review}:${seat}`, roleId: role.id, profileId: actual.id, toolId: actual.toolId,
    model: actual.modelId ?? actual.model, sessionId: `supplied:session:${seat}:${task.rounds.review}`, startedAt: scheduler.clock.now(),
    context: { scope: `supplied:context:${seat}`, file: `supplied:packet:${seat}`, digest: `supplied:digest:${seat}`, hashes: {} },
  });
  const round = (number: number) => {
    task.stageIndex = 1; task.rounds.review = number;
    task.hunt = { stageId: stage.id, round: number, reported: {}, profiles: {}, findings: 0,
      input: { file: "supplied:review-packet", digest: "supplied:packet-digest", heads: Object.fromEntries(f.scopes().map(bound => [bound.work.productId, `supplied:head:${bound.work.productId}:${number}`])) } };
  };
  const unexpected = (): never => { throw new Error("Unexpected review-return recovery effect"); };
  const discarded: { seat: string | undefined; reason: string }[] = [];
  const attempts: string[] = [];
  const recoveryHost: TurnRecoveryHost = {
    now: scheduler.clock.now, catalog: {
      profile: scheduler.catalog.profile, role: scheduler.catalog.role,
      choose: (request, bound, room) => scheduler.selection.selection.choose(request.profileId, bound, request.roleId, room, request.reviewerKey),
    },
    readiness: { hold: unexpected, resolve: unexpected, resolveHeld: unexpected },
    admissionsClosed: () => false, admissionWait: unexpected, sourceRefreshDue: () => false,
    slotWait: unexpected, toolName: unexpected, owesRetry: unexpected, keepWords: unexpected,
    waitForUsage: unexpected, recordLimit: unexpected, waitForScreen: unexpected,
    attempt(_bound, _roleId, _plannedId, profile) { attempts.push(profile.id); },
    discardUnavailable(bound, roleId, error, seat) {
      if (!(error instanceof UnavailableParticipant)) return false;
      const role = scheduler.catalog.role(roleId, bound.task)!;
      const dropped = discardParticipant(bound, role, error.message, seat);
      if (dropped) discarded.push({ seat, reason: error.message });
      return dropped;
    },
    beforeMainAttempt: unexpected, showReviewWork() {}, checkpoint: () => { checkpoints.push(structuredClone(task)); },
  };
  const recovery = new TurnRecovery(recoveryHost, {
    capacity: (_error): _error is never => false, usage: (_error): _error is never => false,
    waiting: unexpected, usageWait: unexpected, capacityWait: unexpected, aborted: unexpected, sourceRefresh: unexpected, screenWait: unexpected,
  }, new ModelCapacity({ profile: scheduler.catalog.profile, now: scheduler.clock.now, record: unexpected, words: unexpected }));
  round(1);
  return { ...f, stage, role, seats, conversations, effects, contexts, ancestries, files, counts, reads, checkpoints, key, prior, choose, participant, note, round, discarded, attempts,
    returnSeat(seat: string) {
      // Publish the operation to the shared lifetime before selection or any supplied observation starts.
      const operation = Promise.resolve().then(() => recovery.member({
        scope, roleId: role.id, plannedId: stage.profileIds[Number(seat)]!, signal: f.signal,
        key: `review-${seat}`, member: `review-${seat}`, reviewerKey: seat, roomCheck: unexpected,
        async attempt(actualRole, profile, selected) {
          const returning = await participant(seat).resume(profile, actualRole);
          return { profile, selected, returning };
        },
      }));
      scheduler.host.trackWork(operation.then(() => {}));
      return operation;
    },
    record(seat: string) {
      const choice = choose(seat), completed = note(seat, choice.profile);
      participant(seat).started(); participant(seat).completed(completed, choice.profile, role);
      rememberReviewProfile(task, seat, choice.profile.id);
      return { choice, completed };
    },
    observeReturn(seat: string, { intact = true, contains = true, count = "1\n" } = {}) {
      const saved = task.reviewSessions![stage.id]![seat]!;
      contexts.push({ context: saved.context, intact });
      if (!intact) return;
      for (const bound of f.scopes()) {
        const owner = bound.work.productId, before = saved.bases![owner]!, base = bound.work.baseSha!, head = task.hunt!.input!.heads[owner]!;
        if (before === base) continue;
        ancestries.push({ key: key("contains", owner, base, before), value: contains });
        if (!contains) break;
        files.push({ key: key("files", owner, before, base), value: ["main-only.txt", "overlap.txt"] }, { key: key("files", owner, base, head), value: ["task-only.txt", "overlap.txt"] });
        counts.push({ key: key("count", owner, before, base), value: count });
      }
    },
    remaining: () => contexts.length + ancestries.length + files.length + counts.length,
  };
}
