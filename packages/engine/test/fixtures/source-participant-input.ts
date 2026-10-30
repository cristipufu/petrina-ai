import { createHash } from "node:crypto";
import { ReviewConversations, reviewBaseUpdates } from "@petrina/orchestrator";
import { finishTaskStep, WorkflowObserver, type WorkflowEventDraft } from "@petrina/core";
import { reviewConversationsFixture } from "../../../orchestrator/test/fixtures/review-conversations.js";
import type { ScriptedAgents } from "../scripted-agents.js";
import { participantInputFixture, UnavailableInputParticipant } from "./participant-input.js";

/** Real selection/conversation/source owners and real portable input/session producers. */
export function sourceParticipantInput(single = false, agents?: ScriptedAgents) {
  const f = reviewConversationsFixture(single), { scheduler, scope, task } = f;
  const now = () => ++scheduler.clock.at;
  const host = { dataDir: "scripted:source-input", s: scheduler.state,
    role: scheduler.catalog.role, productOf: () => scheduler.state.products[0],
    store: { history: { checkEvidence: () => [] } } };
  const input = participantInputFixture(host, now, agents);
  const conversations = new ReviewConversations({
    profiles: () => scheduler.state.profiles, profile: scheduler.catalog.profile,
    digest: scheduler.selection.host.digest, checkpoint: () => f.host.checkpoint(),
    unavailable: reason => new UnavailableInputParticipant(reason),
  }, {
    async contextIntact(context) {
      const body = context && input.packets.get(context.file);
      return !!context && body !== undefined && createHash("sha256").update(body).digest("hex") === context.digest;
    },
    baseUpdates: (bound, bases, heads) => reviewBaseUpdates(bound, bases, heads, f.effects),
  });
  const observer = new WorkflowObserver(), events: WorkflowEventDraft[] = [];
  const context = () => ({ ...scheduler.state, now: now() });
  observer.baseline(task, context());
  const observe = () => { events.push(...observer.observe(task, context())); };
  async function seat(key: string, given?: NonNullable<Parameters<typeof input.perform>[4]>["given"]) {
    const selected = f.choose(key), participant = conversations.participant(scope, f.stage, key, f.stage.profileIds[Number(key)]!);
    const result = await input.perform(scope, f.role, selected.profile, f.stage.profileIds[Number(key)]!, {
      reviewerKey: key, selectionReason: selected.reason, freshReason: selected.freshReason,
      resume: participant.resume, started: participant.started, completed: participant.completed, given,
    });
    observe(); return result;
  }
  async function round(number: number) {
    f.round(number); const replies = [];
    for (const key of f.seats()) {
      replies.push(await seat(key));
    }
    finishTaskStep(task, scope.work, now()); observe(); return replies;
  }
  return { ...f, conversations, input, now, events, observe, seat, round,
    async close() { await input.close(); await f.close(); },
  };
}
