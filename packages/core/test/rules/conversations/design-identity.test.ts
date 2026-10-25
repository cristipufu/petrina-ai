import { expect, it } from "vitest";
import { BUILT_IN_ROLES, DEFAULT_PROFILES as ENGINE_PROFILES, type Task } from "../../../src/index.js";
import { designConversationScope as projectDesignScope } from "../../../src/conversation-scope.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";
// Test the exact projection, not a substitute SHA256 implementation. Native integrity contracts keep real digests.

const designConversationScope = (task: Task, role: unknown, planned: unknown, actual: unknown) => projectDesignScope(task, role, planned, actual, serialized => serialized);
it("invalidates a design return when its role, planned or actual profile, request or source changes", () => {
  const task = taskFixture(stateFixture());
  const role = BUILT_IN_ROLES.find((entry) => entry.id === "architect")!;
  const planned = ENGINE_PROFILES[0]!;
  const original = designConversationScope(task, role, planned, planned);
  expect(designConversationScope(JSON.parse(JSON.stringify(task)), { ...role }, { ...planned }, { ...planned })).toBe(original);
  for (const value of [
    designConversationScope(task, { ...role, instructions: "A revised role" }, planned, planned),
    designConversationScope(task, role, { ...planned, effort: "low" }, planned),
    designConversationScope(task, role, planned, { ...planned, modelId: "another-model" }),
    designConversationScope({ ...task, baseSha: "new-source" }, role, planned, planned),
    designConversationScope({ ...task, description: "A revised request" }, role, planned, planned),
    designConversationScope({ ...task, productId: "another-product" }, role, planned, planned),
  ]) expect(value).not.toBe(original);
});
