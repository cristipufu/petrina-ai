import { expect, it } from "vitest";
import { BUILT_IN_ROLES, DEFAULT_PROFILES as ENGINE_PROFILES, type Role, type Task } from "../../../src/index.js";
import { reviewConversationScope as projectReviewScope } from "../../../src/conversation-scope.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";
// Test the exact projection, not a substitute SHA256 implementation. Native integrity contracts keep real digests.
const reviewConversationScope = (task: Task, stage: string, seat: string, role: Role, planned: unknown, actual: unknown) => projectReviewScope(task, stage, seat, role, planned, actual, serialized => serialized);

it("invalidates only a changed reviewer identity or scope, while permitting a new patch in the same scope", () => {
  const task = taskFixture(stateFixture()), role = BUILT_IN_ROLES.find((role) => role.id === "code-reviewer")!, profile = ENGINE_PROFILES[0]!;
  const key = (t = task, r = role, p = profile, seat = "0") => reviewConversationScope(t, "review", seat, r, profile, p);
  expect(key({ ...task, reviewedSha: "a new reviewed patch" })).toBe(key());
  expect(key({ ...task, description: "Changed request" })).not.toBe(key());
  expect(key(task, { ...role, instructions: "Changed review rules" })).not.toBe(key());
  expect(key(task, role, { ...profile, effort: "low" })).not.toBe(key());
  expect(key(task, role, profile, "1")).not.toBe(key());
});

for (const shared of [false, true]) it(`keeps moving bases out of the ${shared ? "multi" : "single"}-product identity while retaining approved choices`, () => {
  const demo = taskFixture(stateFixture());
  const source: NonNullable<Task["source"]> = { product: { id: "p", name: "Product", repo: "local/product", path: "/clone" }, start: { kind: "default", branch: "main" }, destination: { mode: "local", repo: "local/product", branch: "main", kind: "branch" }, confirmed: true, initialSha: "initial" };
  const work = { productId: "p", worktree: "/copy", source, delivery: "local" as const, baseSha: "original", completedStages: [] };
  const stage = { id: "review", kind: "review-chain" as const, title: "Independent review", roleId: "code-reviewer", profileIds: ["sol-high"] };
  const task = { ...demo, productId: "p", worktree: "/copy", source, baseSha: "original", repositories: shared ? [work, { ...work, productId: "companion", worktree: "/companion" }] : undefined, plan: { rationale: "Review", plannerProfileId: "sol-high", stages: [stage] } };
  const role = BUILT_IN_ROLES.find((role) => role.id === "code-reviewer")!, profile = ENGINE_PROFILES[0]!;
  const key = (value = task) => reviewConversationScope(value, "review", "0", role, profile, profile);
  expect(key({ ...task, baseSha: "advanced", repositories: task.repositories?.map((work) => ({ ...work, baseSha: "advanced" })) })).toBe(key());
  expect(key({ ...task, source: { ...source, start: { kind: "branch", branch: "main" } } })).not.toBe(key());
  expect(key({ ...task, worktree: "/new-copy" })).not.toBe(key());
  expect(key({ ...task, plan: { ...task.plan, stages: [{ ...stage, title: "Changed assignment" }] } })).not.toBe(key());
  const port = { from: "old", head: "reviewed", onto: "new", files: ["greeting.txt"] };
  expect(reviewConversationScope({ ...task, portReview: port }, "review", "0", role, profile, profile)).not.toBe(key());
  expect(reviewConversationScope({ ...task, updating: port }, "review", "0", role, profile, profile)).not.toBe(key());
  expect(reviewConversationScope(task, "review", "0", role, { ...profile, effort: "low" }, profile)).not.toBe(key());
  if (task.repositories) {
    expect(key({ ...task, repositories: task.repositories.slice(0, 1) })).not.toBe(key());
    for (const change of [{ worktree: "/different-companion" }, { source: { ...source, initialSha: "changed-approved-source" } }, { portReview: port }]) {
      expect(key({ ...task, repositories: task.repositories.map((work, index) => index ? { ...work, ...change } : work) })).not.toBe(key());
    }
  }
});
