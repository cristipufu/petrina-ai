import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { fingerprint, impactPlan, type CoverageMap } from "./quality/impact.js";
import { conventions } from "./quality/conventions.js";
import { sourceFacts } from "./quality/source.js";
import { testResults } from "@petrina/test-support/test-results";
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
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `import type { Engine } from '../src/engine.js'; import { recordDisputes } from '@petrina/core';`]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `await import('../src/engine.js');`]]))).toHaveLength(1);
  expect(conventions(new Map([["packages/engine/test/re-export.ts", `export * from '../src/engine.js';`]]))).toHaveLength(1);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `import { runChecks as run } from '../src/checks.js';`]]))).toHaveLength(1);
  for (const code of [
    `import { EngineClient as Client } from '../src/engine-client.js';`,
    `export * from '../src/engine-client.js';`,
    `await import('../src/engine-client.js');`,
  ]) expect(conventions(new Map([["packages/engine/test/a.test.ts", code]]))).toEqual([expect.stringContaining("import EngineClient from test/client")]);
  expect(conventions(new Map([["packages/engine/test/client.ts", `import { EngineClient } from '../src/engine-client.js';`]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `import type { EngineClient } from '../src/engine-client.js'; import { defaultHome } from '../src/engine-client.js';`]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `import { commandText } from '../src/checks.js'; import type { CheckProgress } from '../src/checks.js';`]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/fixtures.ts", `import { runChecks } from '../src/checks.js';`]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", `it.only('example', () => {});`]]))).toHaveLength(1);
  expect(conventions(new Map([["apps/desktop/test/a.test.tsx", `import { test as check } from 'vitest'; check.concurrent.each([]).only('example', () => {});`]]))).toHaveLength(1);
});

it("keeps fixture import guards effective for package aliases, extensionless paths and nested tests", () => {
  for (const path of ["@petrina/engine", "../src/engine", "../src/index", "../src/./engine.ts", "../src/../src/index.js"]) {
    for (const code of [`import { Engine as Alias } from '${path}';`, `export * from '${path}';`, `await import('${path}');`]) {
      expect(conventions(new Map([["packages/engine/test/a.test.ts", code]]))).toEqual([expect.stringContaining("import Engine from the isolated")]);
    }
  }
  for (const [name, path, message] of [["EngineClient", "engine-client", "import EngineClient from test/client"], ["runChecks", "checks", "import runChecks from test/fixtures"]]) {
    for (const suffix of ["", ".ts", ".js"]) {
      expect(conventions(new Map([["packages/engine/test/nested/a.test.ts", `import { ${name} as aliased } from '../../src/${path}${suffix}';`]]))).toEqual([expect.stringContaining(message!)]);
    }
  }
  expect(conventions(new Map([["packages/engine/test/nested/a.test.ts", "import { Engine } from '../engine';"]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", "import type { Engine } from '@petrina/engine'; import { parseResult } from '@petrina/engine';"]]))).toEqual([]);
  expect(conventions(new Map([["packages/engine/test/a.test.ts", "import { Engine } from '../../core/src/engine.ts';"]]))).toEqual([]);
});

describe("test programs and the waits on them", () => {
  const found = (source: string, file = "packages/engine/test/a.test.ts") => conventions(new Map([[file, source]])).map((error) => error.slice(file.length + 1));
  const fixtures = `import { expect, it } from "bun:test"; import { git, makeWorld, runCommand } from "./fixtures.js"; import { rejectionOf } from "@petrina/test-support/rejections";\n`;

  it("applies Bun assertion rules to every native workspace and accepts the shared rejection helper", () => {
    for (const file of ["packages/storage/test/contracts/sqlite/calls.test.ts", "packages/test-support/test/contracts/processes/calls.test.ts", "packages/platform/test/contracts/processes/calls.test.ts"]) {
      expect(found('await expect(work()).rejects.toThrow();', file)).toEqual([expect.stringContaining("do not use Bun's promise matchers")]);
      expect(found('import { rejectionOf } from "@petrina/test-support/rejections";\nasync function check() { await rejectionOf(work()); }', file)).toEqual([]);
    }
  });

  it("recognizes the shared command-failure collector only through its actual fixture import", () => {
    const fixture = `import { runCommand } from "@petrina/test-support/commands";\n`;
    const collector = `import { failureOf as failed } from "../../fixtures/command-failure.js";\n`;
    expect(found(fixture + collector + `await failed(runCommand(args));`)).toEqual([]);
    expect(found(fixture + collector + `failed(runCommand(args));`)).toContainEqual(expect.stringMatching(/await failed/));
    for (const imported of [
      `import { failureOf as failed } from "./unrelated.js";`,
      `import type { failureOf as failed } from "../../fixtures/command-failure.js";`,
      `import { type failureOf as failed } from "../../fixtures/command-failure.js";`,
    ]) expect(found(fixture + imported + `\nawait failed(runCommand(args));`)).toContainEqual(expect.stringMatching(/await runCommand/));
  });

  it("keeps engine shutdown owned through cleanup and restart, including optional and computed calls", () => {
    for (const source of [
      `engine.shutdown();`, `engine?.shutdown();`, `engine["shutdown"]();`,
      `afterAll(() => { engine.shutdown(); });`, `engines.forEach(engine => engine.shutdown());`,
    ]) expect(found(source)).toContainEqual(expect.stringContaining("await shutdown"));
    for (const source of [
      `await engine.shutdown();`, `await engine?.shutdown();`, `afterAll(() => engine.shutdown());`,
      `const stopping = engine.shutdown(); await stopping;`,
      `await Promise.all(engines.map(engine => engine.shutdown()));`,
    ]) expect(found(source)).toEqual([]);
  });

  it("recognizes an awaited completeAll import without accepting unawaited, unrelated or shadowed collectors", () => {
    const imported = `import { completeAll as settle } from "../src/parallel.js";\n`;
    expect(found(imported + `await settle(engines.map(engine => engine.shutdown()));`)).toEqual([]);
    expect(found(imported + `settle(engines.map(engine => engine.shutdown()));`)).toContainEqual(expect.stringContaining("await shutdown"));
    expect(found(`import { settle } from "./other.js"; await settle(engines.map(engine => engine.shutdown()));`)).toContainEqual(expect.stringContaining("await shutdown"));
    expect(found(imported + `async function wrong(settle) { await settle(engines.map(engine => engine.shutdown())); }`)).toContainEqual(expect.stringContaining("await shutdown"));
    expect(found(imported + `const stops = engines.map(engine => engine.shutdown()); await settle(stops);`)).toEqual([]);
  });

  it("rejects synchronous child calls under any name, and leaves file reads, prose and child-program text alone", () => {
    for (const source of [
      `import { execFileSync } from "node:child_process"; execFileSync("git", ["status"]);`,
      `import { spawnSync as run } from "child_process"; run("git");`,
      `import { spawnSync } from "bun"; spawnSync(["git", "status"]);`,
      `import { spawnSync as run } from "bun"; run(["git", "status"]);`,
      `import * as processes from "node:child_process"; processes.execSync("git status");`,
      `const { execFileSync } = require("node:child_process");`,
      `Bun.spawnSync(["git", "status"]);`,
      `const sync = Bun.spawnSync; sync(["git"]);`,
      `const { spawnSync } = Bun;`,
    ]) expect(found(source)).toEqual([expect.stringMatching(/^1: run test programs with runCommand or git from @petrina\/test-support\/commands/)]);
    expect(found(`import { spawnSync } from "node:child_process";`, "apps/desktop/test/a.test.tsx")).toHaveLength(1);
    expect(found([
      `import { readFileSync } from "node:fs"; import { execFile, spawn } from "node:child_process";`,
      `// Bun.spawnSync and execFileSync would hold the worker.`,
      `const script = "Bun.spawnSync(['git', 'rev-parse', 'HEAD'])"; const child = \`require("node:child_process").execFileSync("git")\`;`,
      `import { spawn as start } from "bun"; start(["git"]);`,
      `readFileSync("README.md"); Bun.spawn(["git"]); spawn("git"); execFile("git", [], () => {});`,
    ].join("\n"))).toEqual([]);
  });

  it("rejects ignored and asserted work from the fixtures' helpers, their aliases and local wrappers", () => {
    for (const body of [
      `git(repo, "add", ".");`,
      `void git(repo, "add", ".");`,
      `expect(git(repo, "rev-parse", "HEAD")).toBe("abc");`,
      `expect(() => git(repo, "push")).not.toThrow();`,
      `const sha = git(repo, "rev-parse", "HEAD"); expect(sha).toBeDefined();`,
      `const heads = repos.map((repo) => git(repo, "rev-parse", "HEAD"));`,
      `repos.forEach((repo) => git(repo, "fetch"));`,
      `const world = { made: makeWorld("x") };`,
      `const label = \`at \${runCommand(["git", "--version"])}\`;`,
    ]) expect(found(`${fixtures}it("x", async () => { ${body} });`)).toEqual([expect.stringMatching(/^2: await (git|makeWorld|runCommand)\(…\), return it or collect it/)]);
    for (const module of ["@petrina/test-support", "@petrina/test-support/repositories", "../../../src/repositories.js"]) {
      expect(found(`import { makeProduct as prepare } from "${module}";\nprepare(root);`)).toEqual([expect.stringMatching(/^2: await prepare/)]);
      expect(found(`import { makeProduct as prepare } from "${module}";\nawait prepare(root);`)).toEqual([]);
    }
    expect(found(`import { waitForFile as ready } from "@petrina/test-support/fixtures";\nready(marker, { during: work });`)).toContainEqual(expect.stringMatching(/await ready/));
    expect(found(`import { waitForFile as ready } from "@petrina/test-support/fixtures";\nawait ready(marker, { during: work });`)).toEqual([]);
    expect(found(`import { git as run } from "./support.js";\nrun(repo, "add", ".");`)).toHaveLength(1);
    expect(found(`import { git } from "@petrina/test-support/commands";\nconst alias = git;\nalias(repo, "add", ".");`)).toEqual([expect.stringMatching(/^3: await alias/)]);
    expect(found(`${fixtures}const head = (repo: string) => git(repo, "rev-parse", "HEAD");\nasync function commit(repo: string) { await git(repo, "commit", "-qm", "x"); }\nit("x", async () => { expect(head(repo)).toBe("abc"); commit(repo); });`))
      .toEqual([expect.stringMatching(/^4: await commit/), expect.stringMatching(/^4: await head/)]);
    expect(found(`${fixtures}it("x", async () => { engine.subscribe(async () => { await git(repo, "rev-parse", "HEAD"); }); w.setGitHub(async (github) => { github.offline = true; }); });`))
      .toEqual([expect.stringMatching(/^2: keep this callback synchronous/), expect.stringMatching(/^2: keep this callback synchronous/)]);
  });

  it("rejects work handed to callers that never wait, wrappers of any shape and values used before their wait", () => {
    for (const body of [
      `engine.subscribe(() => git(repo, "rev-parse", "HEAD"));`,
      `w.setGitHub((github) => remoteRef(w.remote, "refs/heads/main"));`,
      `const p = git(repo, "rev-parse", "HEAD"); expect(p).toBe("abc"); await p;`,
      `const p = git(repo, "status"); const list = [p];`,
      `Promise.all([git(repo, "fetch"), git(repo, "status")]);`,
      `repos.forEach((repo) => { return git(repo, "fetch"); });`,
      `engine.subscribe(() => { return git(repo, "rev-parse", "HEAD"); });`,
    ]) expect(found(`import { expect, it } from "bun:test"; import { git, remoteRef } from "./support.js";\nit("x", async () => { ${body} });`)).toContainEqual(expect.stringMatching(/^2: await (git|remoteRef)/));
    expect(found(`${fixtures}it("x", async () => { repos.map(async (repo) => { await git(repo, "fetch"); }); });`)).toEqual([expect.stringMatching(/^2: await map/)]);
    for (const body of [
      `expect(repos.some(async (repo) => (await git(repo, "status")) === "")).toBe(true);`,
      `repos.filter(async (repo) => (await git(repo, "status")) === "");`,
      `repos.forEach(async (repo) => { await git(repo, "fetch"); });`,
      `expect(async () => { await git(repo, "push"); }).not.toThrow();`,
    ]) expect(found(`${fixtures}it("x", async () => { ${body} });`)).toContainEqual(expect.stringMatching(/^2: keep this callback synchronous/));
    expect(found(`${fixtures}async function heads(repos: string[]) { return Promise.all(repos.map((repo) => git(repo, "rev-parse", "HEAD"))); }
async function ready(repo: string) { await waitFor(async () => (await git(repo, "status")) === "", "a clean copy"); }
async function changed() { engine.getState(); }
it("x", async () => { heads(repos); ready(repo); engine.subscribe(changed); });`)).toEqual([expect.stringMatching(/^5: await heads/), expect.stringMatching(/^5: await ready/), expect.stringMatching(/^5: keep this callback synchronous/)]);
  });

  it("allows work that is awaited, returned, collected or handed to a helper that waits for it", () => {
    expect(found(`${fixtures}async function failureOf(work: Promise<unknown>) { return rejectionOf(work); }
const head = (repo: string) => git(repo, "rev-parse", "HEAD");
it("x", async () => {
  expect(await git(repo, "rev-parse", "HEAD")).toBe(await head(repo));
  const [one, two] = await Promise.all([git(repo, "status"), makeWorld("y")]);
  const heads = await Promise.all(repos.map((repo) => git(repo, "rev-parse", "HEAD")));
  const pending = runCommand(["git", "fetch"]); setTimeout(() => stop.abort(), 10); await failureOf(pending);
  await rejectionOf(git(repo, "push")); await failureOf(runCommand(["missing"]));
  expect((await git(repo, "log").then((text) => text.split("\\n"))).length).toBe(1);
  await waitFor(async () => (await git(repo, "status")) === "", "a clean copy");
});
it("returns its work", () => git(repo, "fetch"));
beforeAll(async () => { await makeWorld("z"); });
let cached: Promise<unknown> | undefined;
const once = () => (cached ??= makeWorld("cached"));
it("keeps work for later", async () => {
  const later = repo ? git(repo, "fetch") : undefined; seen.set(repo, later); await later;
  void git(repo, "gc").catch(() => undefined); await once();
  const pending = repos.map((repo) => git(repo, "fetch")); await Promise.all(pending);
  const each = repos.map(async (repo) => { await git(repo, "status"); }); await each[0]; await Promise.all(each);
  const maybe = repo ? git(repo, "fetch") : undefined; if (maybe !== undefined) await maybe;
  const handled = git(repo, "status"); handled.catch(() => undefined); await handled;
  background(repo);
});
function background(repo: string) { void git(repo, "fetch").catch(() => undefined); }`)).toEqual([]);
  });

  it("does not follow work through object properties or callbacks given to other APIs", () => {
    // These limits are why controlled regressions and review remain necessary.
    expect(found(`${fixtures}const f = { head: () => git(repo, "rev-parse", "HEAD") };\nit("x", async () => { expect(f.head()).toBe("abc"); });`)).toEqual([]);
    expect(found(`${fixtures}it("x", async () => { engine.onIdle(async () => { await git(repo, "status"); }); });`)).toEqual([]);
    expect(found(`import type { World } from "./support.js";\nfunction git(repo: string) { return repo; }\ngit("local, not the fixture's");`)).toEqual([]);
    // A name bound twice in a file is not followed, so an unrelated value of the same name is never mistaken for work.
    expect(found(`${fixtures}async function settled() { await git(repo, "status"); }\nit("x", () => { const settled = () => true; expect(settled()).toBe(true); });`)).toEqual([]);
    // Other workspaces' tests are checked for blocking calls only.
    expect(found(`import { git } from "../src/commands.js";\ngit("a");`, "packages/core/test/a.test.ts")).toEqual([]);
  });
});

it("attributes failures to structured runner outcomes, including XML escaping and failed setup", () => {
  const root = resolve("test-project");
  expect(testResults(JSON.stringify({ success: false, numTotalTestSuites: 2, numPassedTestSuites: 1, numFailedTestSuites: 1, numPendingTestSuites: 0, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ name: resolve(root, "packages/core/test/a.test.ts"), status: "failed", assertionResults: [] }, { name: resolve(root, "packages/core/test/b.test.ts"), status: "passed", assertionResults: [{ status: "passed" }] }] }), "packages/core", "vitest", root).failures).toEqual(["packages/core/test/a.test.ts"]);
  const xml = '<testsuites tests="2" failures="1"><testsuite file="test/a&amp;b.test.ts" tests="1" failures="1" errors="0"><testcase><failure /></testcase></testsuite><testsuite file="test/pass.test.ts" tests="1" failures="0"><testcase /></testsuite></testsuites>';
  expect(testResults(xml, "packages/engine", "bun", root).failures).toEqual(["packages/engine/test/a&b.test.ts"]);
  expect(() => testResults('<testsuites tests="0" failures="0" />', "packages/engine", "bun", root)).toThrow("Missing");
  expect(() => testResults("{}", "packages/core", "vitest", root)).toThrow("Missing");
  expect(testResults(xml.replace('tests="2" failures="1"', 'tests="3" failures="2"').replace('</testsuites>', '<testsuite file="test/a&amp;b.test.ts" tests="1" failures="1"><testcase><failure /></testcase></testsuite></testsuites>'), "packages/engine", "bun", root).failures).toEqual(["packages/engine/test/a&b.test.ts"]);
});

it("records only executed LCOV source files, preserving dynamic edges as supplemental observations", () => {
  const lcov = "SF:src/a.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:1,0\nend_of_record\n";
  expect(coveredFiles(lcov, "packages/engine", resolve("project"))).toEqual(["packages/engine/src/a.ts"]);
});
