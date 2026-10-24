import { isAbsolute, join, relative } from "node:path";
import { SaxesParser } from "saxes";

export interface TestResults {
  files: string[];
  failures: string[];
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
}

const count = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} count`);
  return value;
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Incomplete structured test result");
  return value as Record<string, unknown>;
};

/** Parse the installed runners' complete structured outcomes, never terminal labels or an XML fragment. */
export function testResults(body: string, workspace: string, runner: "bun" | "vitest", root: string): TestResults {
  const normalize = (file: unknown): string => {
    if (typeof file !== "string" || !file) throw new Error("Missing test file identity");
    const path = (isAbsolute(file) ? relative(root, file) : join(workspace, file)).replaceAll("\\", "/");
    if (!path.startsWith(`${workspace}/`)) throw new Error(`Test file is outside ${workspace}: ${path}`);
    return path;
  };
  const result: TestResults = { files: [], failures: [], tests: 0, passed: 0, failed: 0, skipped: 0 };
  if (runner === "vitest") {
    const report = record(JSON.parse(body));
    if (!Array.isArray(report.testResults) || !report.testResults.length) throw new Error("Missing Vitest file outcomes");
    if (typeof report.success !== "boolean") throw new Error("Missing Vitest completion status");
    let todos = 0;
    for (const entry of report.testResults) {
      const file = record(entry), path = normalize(file.name);
      if (result.files.includes(path)) throw new Error(`Duplicate Vitest file outcome: ${path}`);
      if (file.status !== "passed" && file.status !== "failed" || !Array.isArray(file.assertionResults)) throw new Error(`Incomplete Vitest file outcome: ${path}`);
      result.files.push(path);
      if (file.status === "failed") result.failures.push(path);
      if (!file.assertionResults.length && file.status !== "failed") throw new Error(`No test cases reported for ${path}`);
      for (const assertion of file.assertionResults) {
        const { status } = record(assertion);
        if (status === "passed") result.passed++;
        else if (status === "failed") {
          result.failed++;
          if (file.status !== "failed") throw new Error(`Contradictory Vitest file outcome: ${path}`);
        } else if (status === "skipped" || status === "todo") { result.skipped++; if (status === "todo") todos++; }
        else throw new Error(`Unfinished or unknown Vitest test outcome: ${String(status)}`);
        result.tests++;
      }
    }
    for (const [key, actual] of [["numTotalTests", result.tests], ["numPassedTests", result.passed], ["numFailedTests", result.failed], ["numPendingTests", result.skipped - todos], ["numTodoTests", todos]] as const) {
      if (count(report[key], `Vitest ${key}`) !== actual) throw new Error(`Inconsistent Vitest ${key}`);
    }
    const suites = count(report.numTotalTestSuites, "Vitest suites"), failedSuites = count(report.numFailedTestSuites, "Vitest failed suites");
    if (suites < result.files.length || suites !== count(report.numPassedTestSuites, "Vitest passed suites") + failedSuites + count(report.numPendingTestSuites, "Vitest pending suites")) throw new Error("Inconsistent Vitest suite counts");
    if (failedSuites > 0 && !result.failures.length) throw new Error("Vitest failed without attributable file outcomes");
    if (report.success !== (result.failures.length === 0)) throw new Error("Contradictory Vitest completion status");
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
    parser.on("doctype", () => { throw new Error("A test report must not contain a document type"); });
    parser.on("opentag", ({ name, attributes }) => {
      const parent = elements.at(-1);
      if (!parent && name !== "testsuites") throw new Error("Missing Bun report root");
      elements.push(name);
      if (name === "testsuites" || name === "testsuite") {
        if (current || (name === "testsuites" ? rootSeen || stack.length > 0 : parent !== "testsuites" && parent !== "testsuite")) throw new Error("Invalid Bun suite structure");
        if (name === "testsuites") rootSeen = true;
        const file = name === "testsuite" ? normalize(attributes.file) : undefined;
        if (file && !result.files.includes(file)) result.files.push(file);
        stack.push({ file, declared: { tests: number(attributes, "tests"), failed: number(attributes, "failures") + number(attributes, "errors", true), skipped: number(attributes, "skipped", true) }, actual: totals() });
      } else if (name === "testcase") {
        if (current || parent !== "testsuite" || !stack.at(-1)?.file) throw new Error("Bun test case has no enclosing file");
        if (attributes.file && normalize(attributes.file) !== stack.at(-1)!.file) throw new Error("Bun test case contradicts its file identity");
        current = { failed: false, skipped: false };
      } else if (name === "failure" || name === "error" || name === "skipped") {
        if (!current || parent !== "testcase") throw new Error("Bun test outcome has no case");
        if (name === "skipped") current.skipped = true; else current.failed = true;
      }
    });
    parser.on("closetag", ({ name }) => {
      elements.pop();
      if (name === "testcase") {
        if (!current || current.failed && current.skipped) throw new Error("Contradictory Bun test case outcome");
        const actual = stack.at(-1)!.actual;
        actual.tests++;
        if (current.failed) actual.failed++;
        if (current.skipped) actual.skipped++;
        current = undefined;
      } else if (name === "testsuite" || name === "testsuites") {
        const suite = stack.pop()!;
        if (Object.keys(suite.declared).some(key => suite.declared[key as keyof Totals] !== suite.actual[key as keyof Totals])) throw new Error(`Inconsistent Bun suite counts: ${suite.file ?? "total"}`);
        if (suite.file && suite.actual.failed) result.failures.push(suite.file);
        if (suite.file && !suite.actual.tests) throw new Error(`No test cases reported for ${suite.file}`);
        const parent = stack.at(-1);
        if (parent) for (const key of ["tests", "failed", "skipped"] as const) parent.actual[key] += suite.actual[key];
        else {
          result.tests = suite.actual.tests; result.failed = suite.actual.failed; result.skipped = suite.actual.skipped;
          result.passed = result.tests - result.failed - result.skipped;
        }
      }
    });
    parser.write(body).close();
    if (!rootSeen || !result.files.length) throw new Error("Missing Bun file outcomes");
  }
  if (!result.passed && !result.failures.length) throw new Error("No test cases executed; skipped tests cannot establish a pass");
  result.files.sort(); result.failures = [...new Set(result.failures)].sort();
  return result;
}

/** A readable report is insufficient if a runner silently left out a required file. */
export function requireFiles(result: TestResults, expected: readonly string[]): void {
  const actual = new Set(result.files), wanted = new Set(expected);
  const missing = expected.filter(file => !actual.has(file)), unexpected = result.files.filter(file => !wanted.has(file));
  if (missing.length || unexpected.length) throw new Error(`Incomplete test file manifest${missing.length ? `; missing: ${missing.join(", ")}` : ""}${unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""}`);
}
