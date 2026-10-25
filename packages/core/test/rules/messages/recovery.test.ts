import { expect, it } from "vitest";
import { recoverMessages, routeMessages, takeMessages, type MessageRecoveryState, type MessagePromptState } from "../../../src/coordinator-message-state.js";

it("keeps older saved reviewer receipts after their transcript bubble is pruned", () => {
  const task = { queued: [{ id: "older-message", at: 1, text: "Keep the guest view", recipients: { first: true, second: false } }], session: [] } as unknown as MessageRecoveryState & MessagePromptState;
  recoverMessages(task);
  routeMessages(task, ["second"]);
  expect(takeMessages(task, "first")).toEqual([]);
  const batch = takeMessages(task, "second");
  expect(batch).toHaveLength(1);
  expect(batch[0]!.firstDelivery).toBe(false);
  expect(task.queued[0]!.recipients?.first).toBe(true);
});

it("restarts an ordinary prompt without resending it or freezing a live acceptance", () => {
  const task = {
    queued: [
      { id: "reserved", at: 1, text: "Still waiting", recipients: { main: false }, deliveries: { main: { state: "sending", via: "prompt" } } },
      { id: "handed", at: 2, text: "Already in the prompt", recipients: { main: false }, deliveries: { main: { state: "sending", via: "prompt", sessionId: "session-1" } } },
      { id: "live", at: 3, text: "Maybe accepted", recipients: { main: false }, deliveries: { main: { state: "sending", via: "live", sessionId: "session-1", toolId: "codex" } } },
      { id: "accepted-live", at: 4, text: "Accepted into the turn", recipients: { main: false }, deliveries: { main: { state: "accepted", via: "live", sessionId: "session-1" } } },
    ],
    session: [],
    journey: [{ agentInputs: [{ updates: [{ delivery: "sending", messageId: "live" }] }] }],
  } as unknown as MessageRecoveryState & MessagePromptState;
  recoverMessages(task);
  expect(task.queued[0]!.deliveries?.main).toBeUndefined();
  expect(task.queued[0]!.recipients?.main).toBe(false);
  expect(task.queued[1]!.deliveries?.main?.state).toBe("applied");
  expect(task.queued[1]!.recipients?.main).toBe(true);
  expect(task.queued[2]!.deliveries?.main).toMatchObject({ state: "unconfirmed", reason: "unknown", toolId: "codex" });
  expect(task.queued[3]!.deliveries?.main).toMatchObject({ state: "accepted", reason: "unknown" });
  expect(task.journey![0]!.agentInputs![0]!.updates![0]!.delivery).toBe("unconfirmed");
  // The reserved note can go out again. The handed one is not repeated, and the live one blocks anything after it.
  expect(takeMessages(task).map((message) => message.id)).toEqual(["reserved"]);
  expect(takeMessages(task)).toEqual([]);
});
