import type { SuiteExecution } from "@petrina/test-support/suite-coordinator";
import { NATIVE, NATIVE_SCOPE, PRELIMINARY } from "./required-plan.js";
import { isTest, workspaceOf } from "./test-paths.js";

function selectionOwners(selected: readonly string[], available: readonly string[]) {
  const known = new Set(available);
  if (new Set(selected).size !== selected.length || selected.some(file => !known.has(file) || !isTest(file) || !workspaceOf(file))) {
    throw new Error("Affected feedback needs unique, registered test files from the current manifest");
  }
  return new Set(selected.map(workspaceOf));
}

/** Vitest's CLI filters match substrings. Its short workspace suites keep their exact normal configuration. */
export function feedbackFiles(requested: readonly string[], available: readonly string[]): string[] {
  const owners = selectionOwners(requested, available);
  const whole = new Set<string>(PRELIMINARY.filter(work => owners.has(work.path)).map(work => work.path));
  return available.filter(file => requested.includes(file) || whole.has(workspaceOf(file)!)).sort();
}

/** Feedback never replaces the complete required execution plan. */
export function feedbackPlan(selected: readonly string[], available: readonly string[]): readonly SuiteExecution[] {
  const owners = selectionOwners(selected, available);
  const preliminary = PRELIMINARY.filter(work => owners.has(work.path)).map(work => ({ id: work.path, workspaces: [work.path] }));
  const native = NATIVE.filter(work => owners.has(work.path)).map(work => work.path);
  return [...preliminary, ...(native.length ? [{ id: NATIVE_SCOPE.id, workspaces: native, requires: preliminary.map(work => work.id) }] : [])];
}
