import { beginAgentStep, endAgentStep, finishTaskStep, roleForTask, slotWait, type AgentProfile, type CheckId } from "@petrina/core";
import { ModelCapacity, ReviewConversations, TurnRecovery, discardParticipant, executionFor, rememberReviewProfile, reviewBaseUpdates, type TurnRecoveryHost } from "@petrina/orchestrator";
import { profileSelectionFixture } from "../../../orchestrator/test/fixtures/profile-selection.js";
import { contractFor } from "../../src/roles.js";
import { participantInputFixture, UnavailableInputParticipant } from "./participant-input.js";

/** Production selection/recovery/conversation/input owners. Only prior task data, packet storage and external sessions are scripted. */
export function reviewerInputPolicy(pair = false, requestedRole = "code-reviewer") {
  const f = profileSelectionFixture(), { state, task, profile } = f, scope = executionFor(task);
  state.pool.paused = false; state.pool.limit = 3; state.pool.toolCaps = { codex: 1, grok: 1 };
  state.setup!.checks = state.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
  if (requestedRole === "added") state.roles.push({ ...state.roles.find(role => role.result === "findings")!, id: "added-reviewer", name: "Added reviewer" });
  const roleId = requestedRole === "added" ? "added-reviewer" : requestedRole;
  const role = roleForTask(state.roles, roleId, task)!;
  f.host.awayFromBuilder = role => contractFor(role).awayFromBuilder;
  state.profiles.push({ ...profile("astra-xhigh")!, id: "astra-high", effort: "high" });
  task.description = "ORIGINAL-SEAT-REQUEST";
  task.brief = { summary: "UNCHANGED-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] };
  Object.assign(scope.work, { worktree: "scripted:product", branch: "main", baseSha: "declared:initial-base", base: "main", report: { summary: "First report", changes: [] } });
  const stage = { id: "review", title: "Review the greeting", kind: "review-chain" as const, roleId, profileIds: pair ? ["opus-high", "sol-high"] : ["opus-high"] };
  task.plan = { rationale: "Only participant input policy", plannerProfileId: "sol-high", stages: [stage] }; task.stageIndex = 0;
  const world = participantInputFixture({ dataDir: "scripted:data", s: state, role: (id, current) => roleForTask(state.roles, id, current),
    productOf: bound => state.products.find(product => product.id === bound.work.productId), store: { history: { checkEvidence: () => [] } },
  }, f.now);
  let ancestry = true;
  let advancedBase = false;
  const reasons: string[] = [];
  const conversations = new ReviewConversations({ profiles: () => state.profiles, profile, digest: f.host.digest, checkpoint() {}, unavailable: text => new UnavailableInputParticipant(text) }, {
    async contextIntact(context) {
      const body = context && world.packets.get(context.file);
      return body !== undefined;
    },
    baseUpdates: (bound, bases) => reviewBaseUpdates(bound, bases, { [bound.work.productId]: "declared:review-head" }, {
      contains: async () => ancestry,
      changedFiles: async () => {
        if (!advancedBase) throw new Error("No advanced-base comparison is declared");
        return ["REVIEW.md", "overlap.txt"];
      },
      count: async () => {
        if (!advancedBase) throw new Error("No advanced-base count is declared");
        return "1";
      },
    }),
  });
  const room = (toolId: string, actual: AgentProfile) => !slotWait(state, { ...actual, taskId: task.id, toolId });
  const unexpected = (): never => { throw new Error("Unexpected reviewer policy effect"); };
  const recoveryHost: TurnRecoveryHost = {
    now: f.now, catalog: { profile, role: (id, current) => roleForTask(state.roles, id, current),
      choose: (request, bound, fits) => f.selection.choose(request.profileId, bound, request.roleId, fits, request.reviewerKey),
    },
    readiness: { hold: unexpected, resolve: unexpected, resolveHeld: unexpected },
    admissionsClosed: () => false, admissionWait: unexpected, sourceRefreshDue: () => false, slotWait: unexpected,
    toolName: id => state.tools.find(tool => tool.id === id)?.name ?? id,
    attempt() {}, owesRetry: unexpected, keepWords: unexpected, waitForUsage: unexpected, recordLimit: unexpected, waitForScreen: unexpected,
    discardUnavailable(bound, id, error, seat) {
      if (!(error instanceof UnavailableInputParticipant)) return false;
      const discarded = discardParticipant(bound, roleForTask(state.roles, id, bound.task)!, error.message, seat, text => {
        world.statuses.push({ roleId: id, profileId: "", text });
      });
      if (discarded) reasons.push(error.message);
      return discarded;
    }, beforeMainAttempt: unexpected, showReviewWork() {}, checkpoint() {},
  };
  const recovery = new TurnRecovery(recoveryHost, {
    capacity: (_error): _error is never => false, usage: (_error): _error is never => false,
    waiting: text => new Error(text), usageWait: text => new Error(text), capacityWait: unexpected, aborted: unexpected, sourceRefresh: unexpected, screenWait: unexpected,
  }, new ModelCapacity({ profile, now: f.now, record: unexpected, words: unexpected }));
  async function seatRaw(seat: string) {
    const plannedId = stage.profileIds[Number(seat)]!;
    return recovery.member({ scope, roleId, plannedId, signal: world.signal, reviewerKey: seat, member: `review-${seat}`, key: `review-${seat}`, room, roomCheck: room,
      attempt: async (actualRole, actual, selected) => {
        const continuation = conversations.participant(scope, stage, seat, plannedId);
        const sent = await world.perform(scope, actualRole, actual, plannedId, { ...continuation, reviewerKey: seat, selectionReason: selected.selectionReason, freshReason: selected.freshReason });
        rememberReviewProfile(task, seat, actual.id);
        return sent.input;
      },
    });
  }
  async function roundRaw(number: number) {
    task.stageIndex = 0; task.rounds.review = number;
    task.hunt = { stageId: stage.id, round: number, reported: {}, profiles: {} };
    const results = await Promise.allSettled(stage.profileIds.map((_, index) => seatRaw(String(index))));
    const error = results.find(result => result.status === "rejected"); if (error?.status === "rejected") throw error.reason;
    endAgentStep(task, { outcome: "Reviewed", reason: "Controlled round completed" }, f.now());
    finishTaskStep(task, scope.work, f.now());
    return task.journey!.at(-1)!.agentInputs!;
  }
  return { ...f, scope, stage, role, world, conversations, reasons, room,
    choose: (seat = "0", wantedRole = roleId) => f.selection.choose(stage.profileIds[Number(seat)]!, scope, wantedRole, room, seat),
    round: (number: number) => world.run(() => roundRaw(number)),
    roundFailure: (number: number) => world.run(async () => { try { await roundRaw(number); } catch (error) { return error; } throw new Error("Expected round failure"); }),
    seat: (seat: string) => world.run(() => seatRaw(seat)),
    first: () => world.run(async () => {
      state.pool.limited = [{ toolId: "claude-code", until: f.now() + 3_600_000, reason: "Declared account limit" }, ...(pair ? [{ toolId: "codex", model: "sol", until: f.now() + 3_600_000, reason: "Declared model limit" }] : [])];
      await roundRaw(1); const saved = structuredClone(task.reviewSessions![stage.id]!); state.pool.limited = [];
      task.rounds.review = 2; delete task.hunt; scope.work.report!.summary = "CHANGED-BUILDER-REPORT"; return saved;
    }),
    replaceBase() { scope.work.baseSha = "declared:diverged-base"; ancestry = false; },
    advanceMain() { advancedBase = true; scope.work.baseSha = "declared:advanced-base"; },
    begin() { beginAgentStep(task, roleId, stage.profileIds[0]!, f.now(), state.roles, undefined, scope.work); },
    close: () => world.close(),
  };
}
