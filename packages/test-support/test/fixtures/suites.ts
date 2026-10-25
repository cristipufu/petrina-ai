import type { ExecutionEvidence, SuiteExecution } from "../../src/suite-coordinator.js";

export const suiteSource = { revision: "commit/tree", fingerprint: "source-inputs" };
export const suitePlan: readonly SuiteExecution[] = [
  { id: "core", workspaces: ["packages/core"] },
  { id: "desktop", workspaces: ["apps/desktop"] },
  { id: "native", workspaces: ["packages/engine", "packages/storage"], requires: ["core", "desktop"] },
];
export function successfulSuite(execution: SuiteExecution): ExecutionEvidence {
  return { code: 0, ms: 25, workspaces: execution.workspaces.map(workspace => ({ workspace, counts: { tests: 2, passed: 2, failed: 0, skipped: 0 }, failures: [], reportComplete: true })) };
}
