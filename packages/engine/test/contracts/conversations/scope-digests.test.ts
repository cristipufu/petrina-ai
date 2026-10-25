import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, designConversationScope as designProjection, reviewConversationScope as reviewProjection } from "@petrina/core";
import { designConversationScope, designDigest } from "../../../src/participant-conversation.js";
import { reviewConversationScope } from "../../../src/review-context.js";
import { promptTask } from "../../fixtures/prompt-context.js";

const sha = (serialized: string) => createHash("sha256").update(serialized).digest("hex");

it("keeps the native design scope and generic digest bound to the established SHA256 encoding", () => {
  const task = promptTask(), role = BUILT_IN_ROLES.find(role => role.result === "brief")!, profile = DEFAULT_PROFILES[0]!;
  const serialized = designProjection(task, role, profile, profile, text => text);
  expect(designConversationScope(task, role, profile, profile)).toBe(sha(serialized));
  expect(designDigest({ request: "café 🧩", profile })).toBe(sha(JSON.stringify({ request: "café 🧩", profile })));
});

it("keeps the native review scope bound to the established SHA256 encoding", () => {
  const task = promptTask(), role = BUILT_IN_ROLES.find(role => role.result === "findings")!, profile = DEFAULT_PROFILES[0]!;
  const serialized = reviewProjection(task, "review", "0", role, profile, profile, text => text);
  expect(reviewConversationScope(task, "review", "0", role, profile, profile)).toBe(sha(serialized));
});
