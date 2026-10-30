/** One registry for test discovery, package aliases and required workspace execution. */
export const TEST_WORKSPACES = [
  { path: "packages/core", name: "@petrina/core", entry: "src/index.ts", subpaths: true, runner: "vitest" },
  { path: "apps/desktop", name: "@petrina/desktop", runner: "vitest" },
  { path: "packages/orchestrator", name: "@petrina/orchestrator", entry: "src/index.ts", subpaths: true, runner: "vitest" },
  { path: "packages/test-support", name: "@petrina/test-support", entry: "src/index.ts", subpaths: true, runner: "bun" },
  { path: "packages/storage", name: "@petrina/storage", entry: "src/index.ts", subpaths: true, runner: "bun" },
  { path: "packages/platform", name: "@petrina/platform", entry: "src/index.ts", subpaths: true, runner: "bun" },
  { path: "packages/agent-runtime", name: "@petrina/agent-runtime", entry: "src/index.ts", subpaths: true, runner: "bun" },
  { path: "packages/repositories", name: "@petrina/repositories", entry: "src/index.ts", subpaths: true, runner: "bun" },
  { path: "packages/engine", name: "@petrina/engine", entry: "src/index.ts", runner: "bun" },
] as const;
