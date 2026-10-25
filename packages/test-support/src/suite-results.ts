import type { SuiteResult, WorkspaceEvidence } from "./suite-coordinator.js";

export type ExecutionRecord = { id: string; workspaces: readonly string[] } & (
  { code: number | null; ms: number; error?: string } | { notRun: string });
export type WorkspaceRecord = ({ executionId: string } & WorkspaceEvidence & { missedFailures?: readonly string[] })
  | { executionId: string; workspace: string; notRun: string };

/** Record elapsed time once per actual execution; package observations point to it. */
export function suiteRecords(results: readonly SuiteResult[], selected: readonly string[]): { executions: ExecutionRecord[]; results: WorkspaceRecord[] } {
  return {
    executions: results.map(execution => "code" in execution
      ? { id: execution.id, workspaces: execution.workspaces.map(work => work.workspace), code: execution.code, ms: execution.ms, ...(execution.error ? { error: execution.error } : {}) }
      : { id: execution.id, workspaces: execution.workspaceNames, notRun: execution.notRun }),
    results: results.flatMap(execution => "code" in execution
      ? execution.workspaces.map(work => ({ ...work, executionId: execution.id, ...(work.failures ? { missedFailures: work.failures.filter(file => !selected.includes(file)) } : {}) }))
      : execution.workspaceNames.map(workspace => ({ workspace, executionId: execution.id, notRun: execution.notRun }))),
  };
}

/** Plain status only: full diagnostics remain in the runner's output and evidence. */
export function workspaceOutcome(work: WorkspaceRecord, execution: ExecutionRecord): string {
  if ("notRun" in work) return `not run, because ${work.notRun}`;
  if (!("code" in execution)) return `not run, because ${execution.notRun}`;
  const failures = work.failures?.length ? `; failing files: ${work.failures.slice(0, 5).join(", ")}${work.failures.length > 5 ? ` and ${work.failures.length - 5} more` : ""}` : "";
  if (execution.code === null) return `incomplete: its execution exit was not reported${failures}`;
  if (work.error || execution.error || !work.reportComplete || !work.counts) return execution.code !== 0
    ? `failed${failures || "; no failing test file could be attributed"}` : `incomplete: its execution or structured results were unavailable${failures}`;
  if (work.counts.failed || work.failures?.length) return execution.code === 0
    ? `incomplete: it exited successfully but its structured results report failures${failures}` : `failed${failures}`;
  return "passed";
}
