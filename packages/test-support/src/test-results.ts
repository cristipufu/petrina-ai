import { isAbsolute, join, relative, resolve } from "node:path";
import { SaxesParser } from "saxes";
import type { SuiteCounts } from "./suite-coordinator.js";

export interface TestResults extends SuiteCounts {
  files: string[];
  failures: string[];
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
}
export interface WorkspaceTestResults extends TestResults {
  workspace: string;
}
export interface TestReportScope {
  root: string;
  cwd: string;
  runner: "bun" | "vitest";
  workspaces: readonly string[];
}
export interface ExecutionTestResults {
  total: TestResults;
  workspaces: WorkspaceTestResults[];
}

const count = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label} count`);
  }
  return value;
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Incomplete structured test result");
  }
  return value as Record<string, unknown>;
};

/** Parse the installed runners' complete structured outcomes, never terminal labels or an XML fragment. */
export function testResults(body: string, workspace: string, runner: "bun" | "vitest", root: string): TestResults {
  return executionTestResults(body, { root, cwd: join(root, workspace), runner, workspaces: [workspace] }).total;
}

/** Parse one actual execution once and attribute each case to its registered workspace. */
export function executionTestResults(
  body: string,
  { root, cwd, runner, workspaces }: TestReportScope,
): ExecutionTestResults {
  const invalidWorkspace = workspaces.some(
    (workspace) =>
      workspace.includes("\\") ||
      workspace.includes(":") ||
      workspace.split("/").some((part) => !part || part === "." || part === ".."),
  );
  if (!workspaces.length || new Set(workspaces).size !== workspaces.length || invalidWorkspace) {
    throw new Error("Invalid required workspace identities");
  }
  const empty = (): TestResults => ({ files: [], failures: [], tests: 0, passed: 0, failed: 0, skipped: 0 });
  const groups = workspaces.map((workspace) => ({ workspace, ...empty() }));
  const groupFor = (file: string) => {
    const matches = groups.filter((group) => file.startsWith(`${group.workspace}/`));
    if (matches.length !== 1) throw new Error(`Test file is outside a unique required workspace: ${file}`);
    return matches[0]!;
  };
  const normalize = (file: unknown): string => {
    if (typeof file !== "string" || !file) throw new Error("Missing test file identity");
    const path = relative(root, isAbsolute(file) ? file : resolve(cwd, file)).replaceAll("\\", "/");
    groupFor(path);
    return path;
  };
  const result = empty();
  if (runner === "vitest") {
    const report = record(JSON.parse(body));
    if (!Array.isArray(report.testResults) || !report.testResults.length) {
      throw new Error("Missing Vitest file outcomes");
    }
    if (typeof report.success !== "boolean") throw new Error("Missing Vitest completion status");
    let todos = 0;
    for (const entry of report.testResults) {
      const file = record(entry);
      const path = normalize(file.name);
      const group = groupFor(path);
      if (result.files.includes(path)) throw new Error(`Duplicate Vitest file outcome: ${path}`);
      if ((file.status !== "passed" && file.status !== "failed") || !Array.isArray(file.assertionResults)) {
        throw new Error(`Incomplete Vitest file outcome: ${path}`);
      }
      result.files.push(path);
      group.files.push(path);
      if (file.status === "failed") {
        result.failures.push(path);
        group.failures.push(path);
      }
      if (!file.assertionResults.length && file.status !== "failed") {
        throw new Error(`No test cases reported for ${path}`);
      }
      for (const assertion of file.assertionResults) {
        const { status } = record(assertion);
        if (status === "passed") {
          result.passed++;
          group.passed++;
        } else if (status === "failed") {
          result.failed++;
          group.failed++;
          if (file.status !== "failed") throw new Error(`Contradictory Vitest file outcome: ${path}`);
        } else if (status === "skipped" || status === "todo") {
          result.skipped++;
          group.skipped++;
          if (status === "todo") todos++;
        } else {
          throw new Error(`Unfinished or unknown Vitest test outcome: ${String(status)}`);
        }
        result.tests++;
        group.tests++;
      }
    }
    const expectedSummary = [
      ["numTotalTests", result.tests],
      ["numPassedTests", result.passed],
      ["numFailedTests", result.failed],
      ["numPendingTests", result.skipped - todos],
      ["numTodoTests", todos],
    ] as const;
    for (const [key, actual] of expectedSummary) {
      if (count(report[key], `Vitest ${key}`) !== actual) throw new Error(`Inconsistent Vitest ${key}`);
    }
    const suites = count(report.numTotalTestSuites, "Vitest suites");
    const failedSuites = count(report.numFailedTestSuites, "Vitest failed suites");
    const passedSuites = count(report.numPassedTestSuites, "Vitest passed suites");
    const pendingSuites = count(report.numPendingTestSuites, "Vitest pending suites");
    if (suites < result.files.length || suites !== passedSuites + failedSuites + pendingSuites) {
      throw new Error("Inconsistent Vitest suite counts");
    }
    if (failedSuites > 0 && !result.failures.length) {
      throw new Error("Vitest failed without attributable file outcomes");
    }
    if (report.success !== (result.failures.length === 0)) {
      throw new Error("Contradictory Vitest completion status");
    }
  } else {
    type Totals = { tests: number; failed: number; skipped: number };
    type Suite = { file?: string; declared: Totals; actual: Totals };
    const stack: Suite[] = [];
    let current: { failed: boolean; skipped: boolean } | undefined;
    let rootSeen = false;
    const elements: string[] = [];
    const totals = (): Totals => ({ tests: 0, failed: 0, skipped: 0 });
    const number = (attributes: Record<string, string>, name: string, optional = false): number => {
      const value = attributes[name];
      if (value === undefined && optional) return 0;
      if (value === undefined || !/^\d+$/.test(value)) throw new Error(`Missing or invalid Bun ${name} count`);
      return count(Number(value), `Bun ${name}`);
    };
    const parser = new SaxesParser({ xmlns: false });
    parser.on("doctype", () => {
      throw new Error("A test report must not contain a document type");
    });
    parser.on("opentag", ({ name, attributes }) => {
      const parent = elements.at(-1);
      if (!parent && name !== "testsuites") throw new Error("Missing Bun report root");
      elements.push(name);
      if (name === "testsuites" || name === "testsuite") {
        const invalidParent =
          name === "testsuites" ? rootSeen || stack.length > 0 : parent !== "testsuites" && parent !== "testsuite";
        if (current || invalidParent) throw new Error("Invalid Bun suite structure");
        if (name === "testsuites") rootSeen = true;
        const file = name === "testsuite" ? normalize(attributes.file) : undefined;
        if (file && stack.at(-1)?.file && file !== stack.at(-1)!.file) {
          throw new Error("Nested Bun suite changes its file identity");
        }
        if (file && !result.files.includes(file)) {
          result.files.push(file);
          groupFor(file).files.push(file);
        }
        stack.push({
          file,
          declared: {
            tests: number(attributes, "tests"),
            failed: number(attributes, "failures") + number(attributes, "errors", true),
            skipped: number(attributes, "skipped", true),
          },
          actual: totals(),
        });
      } else if (name === "testcase") {
        if (current || parent !== "testsuite" || !stack.at(-1)?.file) {
          throw new Error("Bun test case has no enclosing file");
        }
        if (attributes.file && normalize(attributes.file) !== stack.at(-1)!.file) {
          throw new Error("Bun test case contradicts its file identity");
        }
        current = { failed: false, skipped: false };
      } else if (name === "failure" || name === "error" || name === "skipped") {
        if (!current || parent !== "testcase") throw new Error("Bun test outcome has no case");
        if (name === "skipped") current.skipped = true;
        else current.failed = true;
      }
    });
    parser.on("closetag", ({ name }) => {
      elements.pop();
      if (name === "testcase") {
        if (!current || (current.failed && current.skipped)) {
          throw new Error("Contradictory Bun test case outcome");
        }
        const group = groupFor(stack.at(-1)!.file!);
        group.tests++;
        if (current.failed) group.failed++;
        else if (current.skipped) group.skipped++;
        else group.passed++;
        const actual = stack.at(-1)!.actual;
        actual.tests++;
        if (current.failed) actual.failed++;
        if (current.skipped) actual.skipped++;
        current = undefined;
      } else if (name === "testsuite" || name === "testsuites") {
        const suite = stack.pop()!;
        const mismatched = Object.keys(suite.declared).some(
          (key) => suite.declared[key as keyof Totals] !== suite.actual[key as keyof Totals],
        );
        if (mismatched) throw new Error(`Inconsistent Bun suite counts: ${suite.file ?? "total"}`);
        if (suite.file && suite.actual.failed) {
          result.failures.push(suite.file);
          groupFor(suite.file).failures.push(suite.file);
        }
        if (suite.file && !suite.actual.tests) throw new Error(`No test cases reported for ${suite.file}`);
        const parent = stack.at(-1);
        if (parent) {
          for (const key of ["tests", "failed", "skipped"] as const) parent.actual[key] += suite.actual[key];
        } else {
          result.tests = suite.actual.tests;
          result.failed = suite.actual.failed;
          result.skipped = suite.actual.skipped;
          result.passed = result.tests - result.failed - result.skipped;
        }
      }
    });
    parser.write(body).close();
    if (!rootSeen || !result.files.length) throw new Error("Missing Bun file outcomes");
  }
  for (const group of groups) {
    if (!group.files.length) throw new Error(`Missing test file outcomes for ${group.workspace}`);
    if (!group.passed && !group.failures.length) {
      throw new Error(`No test cases executed in ${group.workspace}; skipped tests cannot establish a pass`);
    }
    group.files.sort();
    group.failures = [...new Set(group.failures)].sort();
  }
  for (const field of ["tests", "passed", "failed", "skipped"] as const) {
    if (groups.reduce((sum, group) => sum + group[field], 0) !== result[field]) {
      throw new Error(`Inconsistent execution ${field} count`);
    }
  }
  result.files.sort();
  result.failures = [...new Set(result.failures)].sort();
  return { total: result, workspaces: groups };
}

/** A readable report is insufficient if a runner silently left out a required file. */
export function requireFiles(result: TestResults, expected: readonly string[]): void {
  const actual = new Set(result.files);
  const wanted = new Set(expected);
  const missing = expected.filter((file) => !actual.has(file));
  const unexpected = result.files.filter((file) => !wanted.has(file));
  if (missing.length || unexpected.length) {
    const missingDetail = missing.length ? `; missing: ${missing.join(", ")}` : "";
    const unexpectedDetail = unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : "";
    throw new Error(`Incomplete test file manifest${missingDetail}${unexpectedDetail}`);
  }
}
