import { createHash } from "node:crypto";
import { roleForTask, withLimit, type CheckId, type ConversationNote } from "@petrina/core";
import { DesignConversations, ModelCapacity, TurnRecovery, discardParticipant, executionFor, recordDesignAnswers, recordDesignBrief, recordDesignObjections, type TurnRecoveryHost } from "@petrina/orchestrator";
import { profileSelectionFixture } from "../../../orchestrator/test/fixtures/profile-selection.js";
import { BriefResult, ObjectionsResult, contractFor } from "../../src/roles.js";
import { participantInputFixture, UnavailableInputParticipant } from "./participant-input.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { ReleaseEvents } from "../release-events.js";
import { waitForProgress } from "@petrina/test-support/progress-wait";

class ObservedRefusal extends Error {
  readonly source = "refusal" as const;
  readonly reason = "The supplied reviewer reached its usage limit";
  constructor(readonly toolId: string, readonly until: number) { super("The supplied reviewer reached its usage limit"); }
}

/** Actual design-return/selection/recovery/input owners. The fixture enters declared design phases, without simulating convergence or native transport. */
export function designInputPolicy(standIn?: "author" | "reviewer", replaceReviewer = false, holdFirstReviewer = false) {
  const f = profileSelectionFixture(), { state, task, profile } = f, scope = executionFor(task);
  state.pool.paused = false; state.pool.limit = 3; state.pool.toolCaps = {};
  state.setup!.checks = state.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
  f.host.awayFromBuilder = role => contractFor(role).awayFromBuilder;
  task.title = "Agree on the greeting"; task.description = "ORIGINAL-DESIGN-REQUEST: keep it welcoming.";
  Object.assign(scope.work, { worktree: "scripted:design-product", branch: "main", base: "main", baseSha: "declared:design-base" });
  const stage = { id: "design", title: "Design", kind: "converge" as const, roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 };
  task.plan = { rationale: "Only design participant input policy", plannerProfileId: "sol-high", stages: [stage] };
  task.stageIndex = 0; task.sub = 0; task.rounds.design = 1;
  if (standIn) state.pool.limited = [{ toolId: standIn === "author" ? "claude-code" : "codex", until: f.now() + 3_600_000, reason: "Declared initial usage observation" }];
  let refused = false, reviewerHeld = false;
  const releases = new ReleaseEvents();
  const agents = new ScriptedAgents(async (prompt, signal) => {
    if (prompt.result === "brief") {
      const revised = prompt.text.includes("## Objections so far");
      const ids = [...prompt.text.matchAll(/^- \[([^\]]+)\]/gm)].map(match => match[1]!);
      return scriptedResult({ summary: "A greeting file.", forUsers: ["People see a greeting"], areas: [revised ? "Greeting, visible to everyone after the review" : "Greeting"], acceptance: ["A greeting file exists"], risks: [],
        answers: ids.map(id => ({ id, status: "accepted", byCall: false, answer: "Added it to the brief." })) });
    }
    if (prompt.result !== "objections") throw new Error(`Unexpected design participant: ${prompt.result}`);
    if (holdFirstReviewer && task.rounds.design === 1) { reviewerHeld = true; await releases.wait("first-reviewer", signal); }
    if (replaceReviewer && !refused && prompt.profileId === "sol-xhigh") { refused = true; throw new ObservedRefusal(prompt.toolId, f.now() + 3_600_000); }
    return scriptedResult({ objections: prompt.text.includes("Objections so far") ? [] : [{ text: "Explain who sees the greeting.", blocking: true }] });
  });
  const input = participantInputFixture({ dataDir: "scripted:design-data", s: state,
    role: (id, current) => roleForTask(state.roles, id, current), productOf: bound => state.products.find(product => product.id === bound.work.productId), store: { history: { checkEvidence: () => [] } },
  }, f.now, agents);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  let actualConversation: ConversationNote | undefined;
  const conversations = new DesignConversations({ profile, profiles: () => state.profiles, role: id => roleForTask(state.roles, id, task), digest: hash,
    conversation: () => actualConversation,
    contextIntact: async context => !!context && input.packets.has(context.file) && hash(input.packets.get(context.file)!) === context.digest,
    unavailable: reason => new UnavailableInputParticipant(reason),
  });
  // The selector and conversation owner consume the same identity digest, as in the native binding.
  f.host.digest = hash;
  const unexpected = (): never => { throw new Error("Unexpected design participant policy effect"); };
  const recoveryHost: TurnRecoveryHost = {
    now: f.now, catalog: { profile, role: (id, current) => roleForTask(state.roles, id, current), choose: (request, bound, room) => f.selection.choose(request.profileId, bound, request.roleId, room, request.reviewerKey) },
    readiness: { hold: unexpected, resolve: unexpected, resolveHeld: unexpected }, admissionsClosed: () => false, admissionWait: unexpected, sourceRefreshDue: () => false,
    slotWait: () => undefined, toolName: id => state.tools.find(tool => tool.id === id)?.name ?? id, attempt() {}, owesRetry: unexpected,
    keepWords: (_bound, _id, _profile, _seat, error) => { if (error.said || error.streamed) throw new Error("No partial provider words are declared"); }, waitForUsage: unexpected,
    recordLimit: (_task, _role, _profile, error) => { state.pool.limited = withLimit(state.pool.limited, { toolId: error.toolId, source: error.source, until: error.until, reason: error.reason, at: f.now() }); },
    waitForScreen: unexpected,
    discardUnavailable(bound, id, error) { return error instanceof UnavailableInputParticipant && discardParticipant(bound, roleForTask(state.roles, id, bound.task)!, error.message); },
    beforeMainAttempt() {}, showReviewWork() {}, checkpoint() {},
  };
  const recovery = new TurnRecovery(recoveryHost, {
    capacity: (_error): _error is never => false, usage: (error): error is ObservedRefusal => error instanceof ObservedRefusal,
    waiting: unexpected, usageWait: unexpected, capacityWait: unexpected, aborted: unexpected, sourceRefresh: unexpected, screenWait: unexpected,
  }, new ModelCapacity({ profile, now: f.now, record: unexpected, words: unexpected }));
  let sequence = 0;
  async function phase(side: "author" | "reviewer", round: number) {
    task.sub = side === "author" ? 0 : 1; task.rounds.design = round;
    const roleId = side === "author" ? stage.roleId : stage.reviewerRoleId;
    const plannedId = (side === "author" ? stage.profileIds : stage.reviewerProfileIds)[0]!;
    const participant = conversations.participant(scope, stage, side, roleId, plannedId);
    const sent = await recovery.main({ scope, roleId, plannedId, signal: input.signal, used: participant.used,
      attempt: (actual, selected) => input.perform(scope, roleForTask(state.roles, roleId, task)!, actual, plannedId, {
        designContext: true, resume: participant.resume, selectionReason: selected.reason, freshReason: selected.freshReason,
      }),
    });
    // This is the actual returned input owner's note, never a constructed session receipt.
    actualConversation = sent.note;
    if (side === "author") {
      const result = BriefResult.parse(sent.value);
      recordDesignBrief(task, result, []); recordDesignAnswers(task, result.answers); participant.remember();
    } else {
      participant.remember(); recordDesignObjections(task, ObjectionsResult.parse(sent.value), sent.note.profileId, round, () => `objection-${++sequence}`);
    }
    return sent;
  }
  return { ...f, scope, stage, input, conversations, phase,
    first: () => input.run(async () => { await phase("author", 1); await phase("reviewer", 1); }),
    firstHeld: async () => {
      const operation = input.run(async () => { await phase("author", 1); await phase("reviewer", 1); });
      await waitForProgress(() => reviewerHeld, "the actual first reviewer prompt", 5000, { during: operation }, {
        now: () => Date.now(), slow: () => 1,
        arm: (fire, ms) => { const timer = setTimeout(fire, ms); return () => clearTimeout(timer); },
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      });
      return { operation };
    },
    releaseReviewer: () => releases.release("first-reviewer"),
    second: () => input.run(async () => { await phase("author", 2); await phase("reviewer", 2); return task; }),
    close: () => input.close(),
  };
}
