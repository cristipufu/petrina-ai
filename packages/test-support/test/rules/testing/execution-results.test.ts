import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { executionTestResults, requireFiles, type TestReportScope } from "../../../src/test-results.js";
import { engineFile, engineReport, executionReport, reportRoot, reportWorkspaces, skippedStorageReport, storageFile } from "../../fixtures/reports.js";

const scope: TestReportScope = { root: reportRoot, cwd: resolve(reportRoot, "packages/engine"), runner: "bun", workspaces: reportWorkspaces };

it("parses one shared report once, assigning nested cases and mixed path spellings to exactly one workspace", () => {
  const result = executionTestResults(executionReport, scope);
  expect(result.total).toEqual({ files: [engineFile, storageFile], failures: [storageFile], tests: 4, passed: 2, failed: 1, skipped: 1 });
  expect(result.workspaces).toEqual([
    { workspace: "packages/engine", files: [engineFile], failures: [], tests: 2, passed: 1, failed: 0, skipped: 1 },
    { workspace: "packages/storage", files: [storageFile], failures: [storageFile], tests: 2, passed: 1, failed: 1, skipped: 0 },
  ]);
  for (const group of result.workspaces) expect(() => requireFiles(group, [group.workspace === "packages/engine" ? engineFile : storageFile])).not.toThrow();
  expect(() => requireFiles(result.total, [engineFile, storageFile, "packages/storage/test/absent.test.ts"])).toThrow("absent.test.ts");
});

it("does not manufacture a package outcome when only its peer ran", () => {
  const body = `<testsuites tests="2" failures="0" skipped="1">${engineReport}</testsuites>`;
  expect(() => executionTestResults(body, scope)).toThrow("Missing test file outcomes for packages/storage");
});

it("rejects a skipped-only package even when another package genuinely passed", () => {
  const body = `<testsuites tests="4" failures="0" skipped="3">${engineReport}${skippedStorageReport}</testsuites>`;
  expect(() => executionTestResults(body, scope)).toThrow("No test cases executed in packages/storage");
});

it("rejects files outside the registered packages instead of assigning them to the execution's working directory", () => {
  expect(() => executionTestResults(executionReport, { ...scope, workspaces: ["packages/engine"] })).toThrow("unique required workspace");
});

it("refuses a nested suite that changes file identity instead of double-attributing its child", () => {
  const body = executionReport.replace('<testsuite file="test/a.test.ts" tests="1"', '<testsuite file="../storage/test/b.test.ts" tests="1"');
  expect(() => executionTestResults(body, scope)).toThrow("Nested Bun suite changes its file identity");
});

it("rejects a third package with no outcomes and ambiguous overlapping scopes", () => {
  expect(() => executionTestResults(executionReport, { ...scope, workspaces: [...reportWorkspaces, "packages/other"] })).toThrow("Missing test file outcomes for packages/other");
  expect(() => executionTestResults(executionReport, { ...scope, workspaces: [...reportWorkspaces, "packages"] })).toThrow("unique required workspace");
});

for (const workspaces of [[], [""], ["packages/engine", "packages/engine"], ["../engine"], ["./packages/engine"], ["/packages/engine"], ["packages//engine"], ["C:/packages/engine"], ["packages\\engine"]]) it(`rejects invalid required scope ${JSON.stringify(workspaces)}`, () => {
  expect(() => executionTestResults(executionReport, { ...scope, workspaces })).toThrow("Invalid required workspace identities");
});

it("attributes Vitest file failures and case counts independently while validating its global totals", () => {
  const body = JSON.stringify({ success: false, numTotalTestSuites: 2, numPassedTestSuites: 1, numFailedTestSuites: 1, numPendingTestSuites: 0,
    numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0,
    testResults: [
      { name: resolve(reportRoot, engineFile), status: "passed", assertionResults: [{ status: "passed" }] },
      { name: resolve(reportRoot, storageFile), status: "failed", assertionResults: [{ status: "failed" }] },
    ] });
  const result = executionTestResults(body, { ...scope, runner: "vitest" });
  expect(result.total).toMatchObject({ tests: 2, passed: 1, failed: 1, skipped: 0, failures: [storageFile] });
  expect(result.workspaces.map(({ tests, passed, failed, skipped }) => ({ tests, passed, failed, skipped }))).toEqual([
    { tests: 1, passed: 1, failed: 0, skipped: 0 }, { tests: 1, passed: 0, failed: 1, skipped: 0 },
  ]);
});
