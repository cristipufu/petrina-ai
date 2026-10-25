import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { requireFiles, testResults } from "../../../src/test-results.js";

const root = resolve("controlled-reports");
const xml = '<testsuites tests="3" failures="0" skipped="2"><testsuite file="test/a.test.ts" tests="3" failures="0" skipped="2"><testcase /><testsuite file="test/a.test.ts" tests="2" failures="0" skipped="2"><testcase><skipped /></testcase><testcase><skipped message="TODO" /></testcase></testsuite></testsuite></testsuites>';
const vitest = () => ({ success: true, numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 3, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1, testResults: [{ name: resolve(root, "packages/core/test/a.test.ts"), status: "passed", assertionResults: [{ status: "passed" }, { status: "skipped" }, { status: "todo" }] }] });

it("counts nested Bun suites once and retains explicit skips without claiming they ran", () => {
  const result = testResults(xml, "packages/engine", "bun", root);
  expect(result).toEqual({ files: ["packages/engine/test/a.test.ts"], failures: [], tests: 3, passed: 1, failed: 0, skipped: 2 });
  expect(() => requireFiles(result, ["packages/engine/test/a.test.ts"])).not.toThrow();
  expect(() => requireFiles(result, ["packages/engine/test/a.test.ts", "packages/engine/test/absent.test.ts"])).toThrow("missing: packages/engine/test/absent.test.ts");
  expect(() => requireFiles(result, [])).toThrow("unexpected: packages/engine/test/a.test.ts");
});

for (const [name, body] of [
  ["truncated root", xml.slice(0, -5)],
  ["incorrect root total", xml.replace('tests="3"', 'tests="4"')],
  ["incorrect nested total", xml.replace('tests="2"', 'tests="1"')],
  ["a fake failure count", xml.replace('failures="0"', 'failures="1"')],
  ["a missing count", xml.replace(' tests="3"', '')],
  ["a fractional count", xml.replace('tests="3"', 'tests="3.5"')],
  ["invalid XML entity", xml.replace('test/a.test.ts', 'test/a&bogus;.test.ts')],
  ["wrong root", `<wrapper>${xml}</wrapper>`],
  ["a test outside its suite", xml.replace('<testcase />', '<wrapper><testcase /></wrapper>')],
  ["a different case identity", xml.replace('<testcase />', '<testcase file="test/other.test.ts" />')],
  ["an escaping file path", xml.replaceAll('test/a.test.ts', '../other.test.ts')],
  ["contradictory case outcomes", xml.replace('<testcase />', '<testcase><skipped /><failure /></testcase>')],
  ["a document type", `<!DOCTYPE testsuites>${xml}`],
] as const) it(`rejects ${name} in a Bun report`, () => {
  expect(() => testResults(body, "packages/engine", "bun", root)).toThrow();
});

it("parses numeric XML entities and ignores report markup inside diagnostic CDATA", () => {
  const body = '<testsuites tests="1" failures="1"><testsuite file="test/a&#38;b.test.ts" tests="1" failures="1"><testcase><failure><![CDATA[<testsuite file="test/imaginary.test.ts" tests="1" failures="0"><testcase /></testsuite>]]></failure></testcase></testsuite></testsuites>';
  expect(testResults(body, "packages/engine", "bun", root)).toEqual({ files: ["packages/engine/test/a&b.test.ts"], failures: ["packages/engine/test/a&b.test.ts"], tests: 1, passed: 0, failed: 1, skipped: 0 });
});

it("distinguishes Vitest's explicit skip and todo from passed cases", () => {
  expect(testResults(JSON.stringify(vitest()), "packages/core", "vitest", root)).toEqual({ files: ["packages/core/test/a.test.ts"], failures: [], tests: 3, passed: 1, failed: 0, skipped: 2 });
});

for (const [name, change] of [
  ["missing completion", (value: Record<string, unknown>) => { delete value.success; }],
  ["inconsistent case total", (value: Record<string, unknown>) => { value.numTotalTests = 4; }],
  ["negative count", (value: Record<string, unknown>) => { value.numPassedTests = -1; }],
  ["inconsistent suite counts", (value: Record<string, unknown>) => { value.numTotalTestSuites = 2; }],
  ["unattributed failed suite", (value: Record<string, unknown>) => { value.numPassedTestSuites = 0; value.numFailedTestSuites = 1; }],
  ["a duplicate file", (value: Record<string, unknown>) => { (value.testResults as unknown[]).push((value.testResults as unknown[])[0]); }],
  ["a running case", (value: Record<string, unknown>) => { (value.testResults as ReturnType<typeof vitest>["testResults"])[0]!.assertionResults[0]!.status = "pending"; }],
  ["a failed case in a passing file", (value: Record<string, unknown>) => { (value.testResults as ReturnType<typeof vitest>["testResults"])[0]!.assertionResults[0]!.status = "failed"; }],
  ["a passing result claiming failure", (value: Record<string, unknown>) => { value.success = false; }],
  ["missing cases", (value: Record<string, unknown>) => { (value.testResults as ReturnType<typeof vitest>["testResults"])[0]!.assertionResults = []; }],
] as const) it(`rejects ${name} in a Vitest report`, () => {
  const value = vitest(); change(value);
  expect(() => testResults(JSON.stringify(value), "packages/core", "vitest", root)).toThrow();
});

it("never treats an entirely skipped suite as a successful execution", () => {
  const body = '<testsuites tests="1" failures="0" skipped="1"><testsuite file="test/a.test.ts" tests="1" failures="0" skipped="1"><testcase><skipped /></testcase></testsuite></testsuites>';
  expect(() => testResults(body, "packages/engine", "bun", root)).toThrow("No test cases executed");
  const value = vitest();
  value.testResults[0]!.assertionResults[0]!.status = "skipped";
  value.numPassedTests = 0; value.numPendingTests = 2;
  expect(() => testResults(JSON.stringify(value), "packages/core", "vitest", root)).toThrow("No test cases executed");
});
