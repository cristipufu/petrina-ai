import { posix } from "node:path";
import type { SuiteExecution } from "@petrina/test-support/suite-coordinator";
import { TEST_WORKSPACES } from "./workspaces.js";

export const PRELIMINARY = TEST_WORKSPACES.filter((workspace) => workspace.runner === "vitest");
export const NATIVE = TEST_WORKSPACES.filter((workspace) => workspace.runner === "bun");
export const NATIVE_SCOPE = {
  id: "native",
  cwd: "packages/engine",
  workspaces: NATIVE.map((workspace) => workspace.path),
};

export const REQUIRED_EXECUTIONS: readonly SuiteExecution[] = [
  ...PRELIMINARY.map((workspace) => ({ id: workspace.path, workspaces: [workspace.path] })),
  {
    id: NATIVE_SCOPE.id,
    workspaces: NATIVE_SCOPE.workspaces,
    requires: PRELIMINARY.map((workspace) => workspace.path),
  },
];

/** A shared execution may not silently bypass a package's custom preparation or runner. */
export function nativeScriptProblems(files: ReadonlyMap<string, string>): string[] {
  return NATIVE.flatMap((workspace) => {
    const file = `${workspace.path}/package.json`;
    const runner = posix.relative(workspace.path, "packages/test-support/src/run.ts");
    if (files.has(`${workspace.path}/bunfig.toml`)) {
      return [
        `${workspace.path}/bunfig.toml: shared native tests require common runner configuration; package-specific configuration must not be silently bypassed`,
      ];
    }
    try {
      const manifest = JSON.parse(files.get(file) ?? "null");
      if (manifest?.scripts?.test !== `bun ${runner}`) {
        return [
          `${file}: the shared native suite requires test to use bun ${runner}; declare preparation explicitly before changing the runner`,
        ];
      }
      if (manifest.scripts.pretest !== undefined || manifest.scripts.posttest !== undefined) {
        return [
          `${file}: declare preparation and teardown explicitly before the shared execution instead of pretest or posttest`,
        ];
      }
      return [];
    } catch {
      return [`${file}: cannot inspect the native test command`];
    }
  });
}
