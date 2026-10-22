import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { fingerprint, impactPlan, type CoverageMap } from "./quality/impact.js";
import { conventions } from "./quality/repository.js";
import { sourceFacts } from "./quality/source.js";
import { failedFiles } from "./quality/results.js";
import { coveredFiles } from "./quality/coverage.js";

const fixture = () => new Map([
  ["packages/core/package.json", JSON.stringify({ devDependencies: { vitest: "4" } })],
  ["packages/core/src/a.ts", "export const a = 1"],
  ["packages/core/src/b.ts", "export const b = 2"],
  ["packages/core/src/barrel.ts", "export * from './a.js'"],
  ["packages/core/test/a.test.ts", "import { a } from '../src/barrel.js';"],
  ["packages/core/test/b.test.ts", "import { b } from '../src/b.js';"],
]);

describe("affected-test observation", () => {
  it("follows transitive exports and cycles deterministically, including changed tests", () => {
    const files = fixture();
    files.set("packages/core/src/a.ts", "import './barrel.js'; export const a = 1;");
    const plan = impactPlan(files, ["packages/core/src/a.ts"]);
    expect(plan.selected).toEqual(["packages/core/test/a.test.ts"]);
    expect(plan.mode).toBe("observation");
    expect(impactPlan(files, ["packages/core/test/b.test.ts"]).selected).toEqual(["packages/core/test/b.test.ts"]);
    expect(impactPlan(new Map([...files].reverse()), ["packages/core/src/a.ts"])).toEqual(plan);
  });
  for (const path of ["bun.lock", "packages/core/tsconfig.json", "packages/core/test/helpers.ts", "packages/core/src/deleted.ts", "packages/core/src/new-uncovered.ts", "packages/engine/src/cli.ts"]) it(`falls back to the full suite for ${path}`, () => {
    const files = fixture();
    if (!path.includes("deleted")) files.set(path, "");
    expect(impactPlan(files, [path]).selected).toEqual(["packages/core/test/a.test.ts", "packages/core/test/b.test.ts"]);
  });
  it("includes uncertain consumers without treating computed imports as a known empty dependency", () => {
    const files = fixture();
    files.set("packages/core/test/b.test.ts", "const path = choice(); await import(path);");
    expect(impactPlan(files, ["packages/core/src/a.ts"]).selected).toHaveLength(2);
    files.set("packages/core/test/b.test.ts", "import '../missing.js';");
    expect(impactPlan(files, ["packages/core/src/a.ts"]).selected).toHaveLength(2);
    files.set("packages/core/test/b.test.ts", "const invalid = ;");
    expect(impactPlan(files, ["packages/core/src/a.ts"]).selected).toHaveLength(2);
  });
  it("only supplements dependencies with exact-input coverage and rejects stale maps", () => {
    const files = fixture();
    const coverage: CoverageMap = { version: 1, fingerprint: fingerprint(files), tests: { "packages/core/test/b.test.ts": ["packages/core/src/a.ts"] } };
    expect(impactPlan(files, ["packages/core/src/a.ts"], coverage).selected).toHaveLength(2);
    files.set("packages/core/src/b.ts", "export const b = 3;");
    const plan = impactPlan(files, ["packages/core/src/a.ts"], coverage);
    expect(plan.coverage).toBe("stale");
    expect(plan.selected).toHaveLength(2);
  });
});

it("parses TypeScript/TSX imports and ignores mentions of forbidden patterns in prose", () => {
  expect(sourceFacts("const id = <T>(x: T) => x; import('node:fs')", "a.ts").uncertain).toBe(false);
  expect(sourceFacts("import View from './View'; const node = <View />", "a.tsx").imports[0]!.path).toBe("./View");
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `// expect(p).rejects.toThrow();\nconst prose = 'import { Engine } from "../src/engine.js"';`]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `import { Engine as Alias } from '../src/engine.js'; expect(p).rejects.toThrow();`]]))).toHaveLength(2);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `import type { Engine } from '../src/engine.js'; import { recordDisputes } from '../src/engine.js';`]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `await import('../src/engine.js');`]]))).toHaveLength(1);
  expect(conventions(new Map([["packages/engine/test/re-export.ts", `export * from '../src/engine.js';`]]))).toHaveLength(1);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `it.only('example', () => {});`]]))).toHaveLength(1);
  expect(conventions(new Map([["apps/desktop/test/a.test.tsx", `import { test as check } from 'vitest'; check.concurrent.each([]).only('example', () => {});`]]))).toHaveLength(1);
});

it("attributes failures to structured runner outcomes, including XML escaping and failed setup", () => {
  const root = resolve("test-project");
  expect(failedFiles(JSON.stringify({ testResults: [{ name: resolve(root, "packages/core/test/a.test.ts"), status: "failed" }, { name: resolve(root, "packages/core/test/b.test.ts"), status: "passed" }] }), "packages/core", "vitest", root)).toEqual(["packages/core/test/a.test.ts"]);
  const xml = '<testsuites tests="2"><testsuite file="test/a&amp;b.test.ts" failures="1" errors="0"><testcase /></testsuite><testsuite file="test/pass.test.ts" failures="0"><testcase /></testsuite></testsuites>';
  expect(failedFiles(xml, "packages/engine", "bun", root)).toEqual(["packages/engine/test/a&b.test.ts"]);
  expect(() => failedFiles("<testsuites />", "packages/engine", "bun", root)).toThrow("Missing");
  expect(() => failedFiles("{}", "packages/core", "vitest", root)).toThrow("Missing");
  expect(failedFiles(xml.replace('</testsuites>', '<testsuite file="test/a&amp;b.test.ts" failures="1"><testcase /></testsuite></testsuites>'), "packages/engine", "bun", root)).toEqual(["packages/engine/test/a&b.test.ts"]);
});

it("records only executed LCOV source files, preserving dynamic edges as supplemental observations", () => {
  const lcov = "SF:src/a.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:1,0\nend_of_record\n";
  expect(coveredFiles(lcov, "packages/engine", resolve("project"))).toEqual(["packages/engine/src/a.ts"]);
});
