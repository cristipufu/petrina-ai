import { expect, it } from "bun:test";
import { feedbackFiles, feedbackPlan } from "../../quality/feedback-plan.js";
import { REQUIRED_EXECUTIONS } from "../../quality/required-plan.js";

const core = "packages/core/test/rules/tasks/example.test.ts";
const desktop = "apps/desktop/test/presentation/tasks/example.test.tsx";
const engine = "packages/engine/test/contracts/tasks/example.test.ts";
const runtime = "packages/agent-runtime/test/contracts/agents/example.test.ts";
const files = [core, desktop, engine, runtime];

it("expands short Vitest suites while keeping native feedback file-specific", () => {
  const sibling = "packages/core/test/rules/tasks/example.test.tsx";
  const nested = "packages/core/test/rules/tasks/nested/example.test.ts";
  const nativePeer = "packages/engine/test/contracts/tasks/example.test.tsx";
  expect(feedbackFiles([core, engine], [...files, sibling, nested, nativePeer])).toEqual([core, sibling, nested, engine]);
  expect(feedbackFiles([engine], [...files, nativePeer])).toEqual([engine]);
  expect(feedbackFiles([], files)).toEqual([]);
});

it("runs only selected owners, with one native execution behind selected preliminary suites", () => {
  expect(feedbackPlan([runtime, core, engine], files)).toEqual([
    { id: "packages/core", workspaces: ["packages/core"] },
    { id: "native", workspaces: ["packages/agent-runtime", "packages/engine"], requires: ["packages/core"] },
  ]);
  expect(feedbackPlan([desktop], files)).toEqual([{ id: "apps/desktop", workspaces: ["apps/desktop"] }]);
  expect(feedbackPlan([engine], files)).toEqual([{ id: "native", workspaces: ["packages/engine"], requires: [] }]);
  // The complete delivery plan retains every required workspace independently of selection.
  expect(REQUIRED_EXECUTIONS.at(-1)!.workspaces).toHaveLength(6);
});

it("records no work without manufacturing a passing execution", () => {
  expect(feedbackPlan([], files)).toEqual([]);
});

for (const selected of [[core, core], ["packages/core/test/missing.test.ts"], ["packages/core/src/model.ts"], ["outside/test/example.test.ts"]]) {
  it(`rejects invalid feedback identities: ${selected.join(", ")}`, () => {
    expect(() => feedbackPlan(selected, [...files, "packages/core/src/model.ts", "outside/test/example.test.ts"])).toThrow("unique, registered test files");
  });
}
