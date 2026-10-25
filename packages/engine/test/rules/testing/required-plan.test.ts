import { expect, it } from "bun:test";
import { NATIVE_SCOPE, PRELIMINARY, REQUIRED_EXECUTIONS, nativeScriptProblems } from "../../quality/required-plan.js";
import { TEST_WORKSPACES } from "../../quality/workspaces.js";

const manifests = () => new Map(Object.entries({
  "packages/engine": "bun ../test-support/src/run.ts",
  "packages/test-support": "bun src/run.ts",
  "packages/storage": "bun ../test-support/src/run.ts",
  "packages/platform": "bun ../test-support/src/run.ts",
  "packages/agent-runtime": "bun ../test-support/src/run.ts",
  "packages/repositories": "bun ../test-support/src/run.ts",
}).map(([workspace, test]) => [`${workspace}/package.json`, JSON.stringify({ scripts: { test } })]));

it("runs every native package in one execution after all independent Vitest prerequisites", () => {
  expect(PRELIMINARY.map(workspace => workspace.path)).toEqual(["packages/core", "apps/desktop", "packages/orchestrator"]);
  expect(REQUIRED_EXECUTIONS).toHaveLength(4);
  expect(REQUIRED_EXECUTIONS.flatMap(execution => execution.workspaces)).toEqual(TEST_WORKSPACES.map(workspace => workspace.path));
  expect(REQUIRED_EXECUTIONS.at(-1)).toEqual({ id: "native", workspaces: NATIVE_SCOPE.workspaces, requires: ["packages/core", "apps/desktop", "packages/orchestrator"] });
  expect(NATIVE_SCOPE.cwd).toBe("packages/engine");
  expect(nativeScriptProblems(manifests())).toEqual([]);
});

for (const body of [undefined, "{", '{}', '{"scripts":{"test":"bun prepare.ts && bun test"}}',
  '{"scripts":{"test":"bun ../test-support/src/run.ts","pretest":"bun setup.ts"}}',
  '{"scripts":{"test":"bun ../test-support/src/run.ts","posttest":"bun teardown.ts"}}']) it(`refuses a missing or changed package command rather than bypassing it: ${body}`, () => {
  const files = manifests();
  if (body === undefined) files.delete("packages/storage/package.json"); else files.set("packages/storage/package.json", body);
  const errors = nativeScriptProblems(files);
  expect(errors).toHaveLength(1); expect(errors[0]).toContain("packages/storage/package.json");
});

it("refuses a package-specific Bun configuration instead of applying the engine's settings to it", () => {
  const files = manifests(); files.set("packages/storage/bunfig.toml", "[test]");
  expect(nativeScriptProblems(files)).toEqual([expect.stringContaining("package-specific configuration must not be silently bypassed")]);
});
