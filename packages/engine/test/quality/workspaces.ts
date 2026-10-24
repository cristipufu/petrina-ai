/** One registry for test discovery, package aliases and required workspace execution. */
export const TEST_WORKSPACES = [
  { path: "packages/core", name: "@petrina/core", entry: "src/index.ts", runner: "vitest", phase: "quick" },
  { path: "apps/desktop", name: "@petrina/desktop", runner: "vitest", phase: "quick" },
  { path: "packages/orchestrator", name: "@petrina/orchestrator", entry: "src/index.ts", runner: "vitest", phase: "quick" },
  { path: "packages/engine", name: "@petrina/engine", entry: "src/index.ts", runner: "bun", phase: "engine" },
] as const;
