import { expect, it } from "vitest";
import { messageDeliveryText, messageRemovable, messageRemovalText } from "../src/message-delivery.js";
import type { QueuedMessage } from "../src/model.js";

it("keeps acceptance distinct from hearing, including another reviewer still waiting", () => {
  const message: QueuedMessage = { id: "m", at: 1, text: "Keep the guest view", recipients: { first: true, second: false, third: false }, deliveries: { first: { state: "applied" }, second: { state: "accepted", toolId: "grok" }, third: { state: "waiting" } } };
  expect(messageDeliveryText(message)).toContain("Heard by 1 of 3 agents");
  expect(messageDeliveryText(message)).toContain("Accepted by 1 agent’s tool");
  const both: QueuedMessage = { id: "both", at: 1, text: "Check both views", recipients: { first: false, second: false }, deliveries: { first: { state: "accepted" }, second: { state: "accepted" } } };
  expect(messageDeliveryText(both)).toContain("Accepted by 2 agents’ tools");
  expect(messageRemovable(message)).toBe(false);
  expect(messageRemovalText(message)).toContain("already received");
  const heardOnly: QueuedMessage = { id: "m", at: 1, text: "Check both views", recipients: { "review-0": true, "review-1": false } };
  expect(messageRemovalText(heardOnly)).toContain("already received");
  expect(messageRemovable(heardOnly)).toBe(false);
});

it("never treats an uncertain send as removable or heard", () => {
  for (const state of ["sending", "accepted", "unconfirmed"] as const) {
    const message: QueuedMessage = { id: "m", at: 1, text: "Keep the guest view", deliveries: { main: { state } } };
    expect(messageRemovable(message)).toBe(false);
    expect(messageRemovalText(message)).toContain("delivery record must stay visible");
    expect(messageDeliveryText(message)).not.toContain("Heard");
  }
});

it("explains unsupported and explicit waiting without claiming acceptance", () => {
  const message: QueuedMessage = { id: "m", at: 1, text: "Keep the guest view", mode: "queue" };
  expect(messageDeliveryText(message)).toBe("Waiting until the turn finishes");
  message.deliveries = { main: { state: "waiting", reason: "unsupported", toolId: "antigravity" } };
  expect(messageDeliveryText(message)).toContain("cannot take live guidance");
  expect(messageRemovable(message)).toBe(true);
  expect(messageRemovalText(message)).toBeUndefined();
});

it("does not call a coordinator's decision to continue proof of hearing", () => {
  const message: QueuedMessage = { id: "m", at: 1, text: "Keep the guest view", recipients: { first: true, second: false }, deliveries: { first: { state: "skipped" }, second: { state: "waiting" } } };
  expect(messageDeliveryText(message)).toContain("Continued without confirmed delivery");
  expect(messageDeliveryText(message)).not.toContain("Heard");
  expect(messageRemovalText(message)).not.toContain("already received");
  expect(messageRemovable(message)).toBe(false);
});
