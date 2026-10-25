import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";
import { fingerprint, impactPlan, type CoverageMap, type ImpactRuntime } from "../../quality/impact.js";
import { coveredFiles } from "../../quality/coverage-records.js";
import { resolve } from "node:path";
const runtime: ImpactRuntime = { identity: { bun: "fixture", platform: "fixture", arch: "fixture", ci: "", browser: "" }, builtinModules: ["fs", "path", "crypto", "module"] };
const affected = (files: ReadonlyMap<string, string>, changes: readonly string[], coverage?: CoverageMap) => impactPlan(files, changes, runtime, coverage);
const fixture = () => new Map([
  ["packages/core/package.json", JSON.stringify({ devDependencies: { vitest: "4" } })],
  ["packages/core/src/a.ts", "export const a = 1"],
  ["packages/core/src/b.ts", "export const b = 2"],
  ["packages/core/src/barrel.ts", "export * from './a.js'"],
  ["packages/core/test/a.test.ts", "import { a } from '../src/barrel.js';"],
  ["packages/core/test/b.test.ts", "import { b } from '../src/b.js';"],
]);


originalDescribe("affected-test observation", () => {
it("follows transitive exports and cycles deterministically, including changed tests", () => {
    const files = fixture();
    files.set("packages/core/src/a.ts", "import './barrel.js'; export const a = 1;");
    const plan = affected(files, ["packages/core/src/a.ts"]);
    expect(plan.selected).toEqual(["packages/core/test/a.test.ts"]);
    expect(plan.mode).toBe("observation");
    expect(affected(files, ["packages/core/test/b.test.ts"]).selected).toEqual(["packages/core/test/b.test.ts"]);
    expect(affected(new Map([...files].reverse()), ["packages/core/src/a.ts"])).toEqual(plan);
  });
});

originalDescribe("affected-test observation", () => {
for (const path of ["bun.lock", "packages/core/tsconfig.json", "packages/core/test/helpers.ts", "packages/core/src/deleted.ts", "packages/core/src/new-uncovered.ts", "packages/engine/src/cli.ts"]) it(`falls back to the full suite for ${path}`, () => {
    const files = fixture();
    if (!path.includes("deleted")) files.set(path, "");
    expect(affected(files, [path]).selected).toEqual(["packages/core/test/a.test.ts", "packages/core/test/b.test.ts"]);
  });
});

originalDescribe("affected-test observation", () => {
it("includes uncertain consumers without treating computed imports as a known empty dependency", () => {
    const files = fixture();
    files.set("packages/core/test/b.test.ts", "const path = choice(); await import(path);");
    expect(affected(files, ["packages/core/src/a.ts"]).selected).toHaveLength(2);
    files.set("packages/core/test/b.test.ts", "import '../missing.js';");
    expect(affected(files, ["packages/core/src/a.ts"]).selected).toHaveLength(2);
    files.set("packages/core/test/b.test.ts", "const invalid = ;");
    expect(affected(files, ["packages/core/src/a.ts"]).selected).toHaveLength(2);
  });
});

originalDescribe("affected-test observation", () => {
it("only supplements dependencies with exact-input coverage and rejects stale maps", () => {
    const files = fixture();
    const coverage: CoverageMap = { version: 1, fingerprint: fingerprint(files, runtime.identity), tests: { "packages/core/test/b.test.ts": ["packages/core/src/a.ts"] } };
    expect(affected(files, ["packages/core/src/a.ts"], coverage).selected).toHaveLength(2);
    files.set("packages/core/src/b.ts", "export const b = 3;");
    const plan = affected(files, ["packages/core/src/a.ts"], coverage);
    expect(plan.coverage).toBe("stale");
    expect(plan.selected).toHaveLength(2);
  });
});

it("records only executed LCOV source files, preserving dynamic edges as supplemental observations", () => {
  const lcov = "SF:src/a.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:1,0\nend_of_record\n";
  expect(coveredFiles(lcov, "packages/engine", resolve("project"))).toEqual(["packages/engine/src/a.ts"]);
});
it("binds coverage to every recorded runtime fact without implicit host defaults", () => {
  const files = fixture();
  const before = fingerprint(files, runtime.identity);
  for (const key of ["bun", "platform", "arch", "ci", "browser"] as const) {
    const changed = { ...runtime.identity, [key]: `${runtime.identity[key]}-changed` };
    expect(fingerprint(files, changed)).not.toBe(before);
    expect(impactPlan(files, ["packages/core/src/a.ts"], { ...runtime, identity: changed },
      { version: 1, fingerprint: before, tests: {} }).coverage).toBe("stale");
  }
});
