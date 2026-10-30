import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { conventions } from "../../quality/conventions.js";
import { formatProductionSource } from "../../quality/format.js";
import { sourceFacts } from "../../quality/source.js";
import { testResults } from "@petrina/test-support/test-results";
  const found = (source: string, file = "packages/engine/test/a.test.ts") => conventions(new Map([[file, source]])).map((error) => error.slice(file.length + 1));
  const fixtures = `import { expect, it } from "bun:test"; import { git, makeWorld, runCommand } from "./fixtures.js"; import { rejectionOf } from "@petrina/test-support/rejections";\n`;


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

it("limits actual Engine construction to capped ownership boundaries while respecting lexical aliases and shadows", () => {
  const imported = `import { Engine as Native } from '../../engine.js';\n`;
  for (const body of [
    `new Native(home, options);`,
    `const Alias = Native; new Alias(home, options);`,
    `const box = { Engine: Native }; const { Engine: Alias } = box; new Alias(home, options);`,
    `let Alias; Alias = Native; new Alias(home, options);`,
    `class Derived extends Native {} new Derived(home, options);`,
    `class Other {} let Creator = Native; const Saved = Creator; Creator = Other; new Saved(home, options);`,
    `class Other {} let Creator = Native; let Saved; Saved = Creator; Creator = Other; new Saved(home, options);`,
    `class Other {} let Creator = Native; const box = { ctor: Creator }; Creator = Other; new box.ctor(home, options);`,
    `class Other {} let Creator = Native; const list = [Creator]; Creator = Other; new list[0](home, options);`,
    `class Other {} let Creator = Native; const [Saved] = [Creator]; Creator = Other; new Saved(home, options);`,
    `class Other {} let Creator = Native; class Saved extends Creator {} Creator = Other; new Saved(home, options);`,
    `class Other {} let Creator = Native; const Saved = class extends Creator {}; Creator = Other; new Saved(home, options);`,
    `const Alias = Native; { const Native = class {}; new Alias(home, options); }`,
  ]) expect(found(imported + body, "packages/engine/test/contracts/testing/a.test.ts")).toContainEqual(expect.stringContaining("construct Engine through engineCaseFixtures"));
  for (const body of [
    `new runtime.Engine(home, options);`, `const alias = runtime; new alias['Engine'](home, options);`,
    `const { Engine: Alias } = runtime; new Alias(home, options);`,
    `let current = runtime; const Saved = current; current = { Engine: class {} }; new Saved.Engine(home, options);`,
  ]) expect(found(`import * as runtime from '../../engine.js';\n` + body, "packages/engine/test/contracts/testing/a.test.ts")).toContainEqual(expect.stringContaining("construct Engine through engineCaseFixtures"));
  for (const source of [
    imported + `function unrelated(Native) { return new Native(); }`,
    imported + `{ class Native {} new Native(); }`,
    imported + `let Alias = Native; Alias = class {}; new Alias();`,
    imported + `class Other {} let Creator = Other; const Saved = Creator; Creator = Native; new Saved();`,
    imported + `class Other {} let Creator = Other; const box = { ctor: Creator }; Creator = Native; new box.ctor();`,
    imported + `class Other {} let Creator = Other; const list = [Creator]; Creator = Native; new list[0]();`,
    imported + `class Other {} let Creator = Other; class Saved extends Creator {} Creator = Native; new Saved();`,
    `import * as runtime from '../../engine.js'; function unrelated(runtime) { return new runtime.Engine(); }`,
    `import type { Engine } from '../../engine.js'; type Constructor = typeof Engine;`,
    `import { Engine } from './unrelated.js'; new Engine();`,
    `// new Engine()\nconst prose = 'new Engine()'; type Engine = { name: string };`,
  ]) expect(found(source, "packages/engine/test/contracts/testing/a.test.ts")).toEqual([]);
  const primitive = `import { Engine } from '../engine.js'; function directDrivers() { const open = () => { let engine; engine = new Engine(home, options); }; }`;
  expect(found(primitive, "packages/engine/test/fixtures/direct-drivers.ts")).toEqual([]);
  expect(found(primitive + `new Engine(home, options);`, "packages/engine/test/fixtures/direct-drivers.ts")).toEqual([expect.stringContaining("construct Engine through engineCaseFixtures")]);
  expect(found(primitive.replace(`engine = new Engine(home, options);`, `engine = new Engine(home, options); engine = new Engine(home, options);`), "packages/engine/test/fixtures/direct-drivers.ts")).toEqual([expect.stringContaining("construct Engine through engineCaseFixtures")]);
  const probe = `import { Engine } from '../../engine.js'; probeCases.use(root, async owners => { const engine = nativeEngine = new Engine(data, options); });`;
  expect(found(probe, "packages/engine/test/contracts/setup/readiness.test.ts")).toEqual([]);
  expect(found(probe + `const other = new Engine(data, options);`, "packages/engine/test/contracts/setup/readiness.test.ts")).toEqual([expect.stringContaining("construct Engine through engineCaseFixtures")]);
  const child = `import { Engine } from './engine.js'; const engine = new Engine(data, options);`;
  expect(found(child, "packages/engine/test/extra-crash-engine.ts")).toEqual([]);
  expect(found(`import { Engine } from './engine.js'; (() => { const engine = new Engine(data, options); })();`, "packages/engine/test/extra-crash-engine.ts")).toEqual([expect.stringContaining("construct Engine through engineCaseFixtures")]);
});

originalDescribe("test programs and the waits on them", () => {
it("requires callers to own the shared interruptible process result", () => {
    const imported = 'import { runProcess as execute } from "@petrina/test-support/run-process";\n';
    expect(found(imported + 'execute(args, settings);')).toContainEqual(expect.stringContaining("await execute"));
    expect(found(imported + 'await execute(args, settings);')).toEqual([]);
    expect(found('import { runProcess as execute } from "./unrelated.js"; execute(args, settings);')).toEqual([]);
  });
});

originalDescribe("test programs and the waits on them", () => {
it("applies Bun assertion rules to every native workspace and accepts the shared rejection helper", () => {
    for (const file of ["packages/storage/test/contracts/sqlite/calls.test.ts", "packages/test-support/test/contracts/processes/calls.test.ts", "packages/platform/test/contracts/processes/calls.test.ts"]) {
      expect(found('await expect(work()).rejects.toThrow();', file)).toEqual([expect.stringContaining("do not use Bun's promise matchers")]);
      expect(found('import { rejectionOf } from "@petrina/test-support/rejections";\nasync function check() { await rejectionOf(work()); }', file)).toEqual([]);
    }
  });
});

originalDescribe("test programs and the waits on them", () => {
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
});

originalDescribe("test programs and the waits on them", () => {
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
});

originalDescribe("test programs and the waits on them", () => {
it("recognizes an awaited completeAll import without accepting unawaited, unrelated or shadowed collectors", () => {
    const imported = `import { completeAll as settle } from "@petrina/core";\n`;
    expect(found(imported + `await settle(engines.map(engine => engine.shutdown()));`)).toEqual([]);
    expect(found(imported + `settle(engines.map(engine => engine.shutdown()));`)).toContainEqual(expect.stringContaining("await shutdown"));
    expect(found(`import { settle } from "./other.js"; await settle(engines.map(engine => engine.shutdown()));`)).toContainEqual(expect.stringContaining("await shutdown"));
    expect(found(imported + `async function wrong(settle) { await settle(engines.map(engine => engine.shutdown())); }`)).toContainEqual(expect.stringContaining("await shutdown"));
    expect(found(imported + `const stops = engines.map(engine => engine.shutdown()); await settle(stops);`)).toEqual([]);
  });
});

originalDescribe("test programs and the waits on them", () => {
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
});

originalDescribe("test programs and the waits on them", () => {
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
});

originalDescribe("test programs and the waits on them", () => {
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
});

originalDescribe("test programs and the waits on them", () => {
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
});

originalDescribe("test programs and the waits on them", () => {
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

it("enforces the 650-line production module ceiling and frozen native boundary ratchets", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `export const v${index} = ${index};`).join("\n") + "\n";
  expect(found(lines(650), "packages/core/src/example.ts")).toEqual([]);
  expect(found(lines(651), "packages/core/src/example.ts")).toEqual([
    expect.stringContaining("651 lines exceeds the 650-line production module ceiling"),
  ]);
  expect(found(lines(707), "packages/repositories/src/git/worktrees.ts")).toEqual([]);
  expect(found(lines(708), "packages/repositories/src/git/worktrees.ts")).toEqual([
    expect.stringContaining("708 lines exceeds the 707-line production module ceiling"),
  ]);
});

it("rejects TypeScript any keywords in production source while ignoring comments, strings and identifiers", () => {
  for (const snippet of [
    "export function parse(input: any) { return input; }",
    "export type Bag = Record<string, any>;",
    "export const cast = (value: unknown) => value as any;",
  ]) {
    expect(found(snippet, "packages/engine/src/example.ts")).toEqual([
      expect.stringContaining("avoid 'any' in production source"),
    ]);
  }
  expect(
    found(
      "// any comment mentioning Record<string, any>\nexport const text = 'do not match any word in prose';\nexport const anyValue = Promise.any([Promise.resolve(1)]);\n",
      "packages/engine/src/example.ts",
    ),
  ).toEqual([]);
  expect(
    found(
      "export type Ctor = new (...args: any[]) => Error;\n",
      "packages/test-support/src/rejections.ts",
    ),
  ).toEqual([]);
  expect(
    found(
      "export type Ctor = new (...args: any[]) => Error;\nexport type Extra = any;\n",
      "packages/test-support/src/rejections.ts",
    ),
  ).toEqual([expect.stringContaining("avoid 'any' in production source")]);
});

it("enforces vertical statement density and 160-character structured line wrapping in production source", () => {
  expect(found("export const a = 1; export const b = 2;\n", "packages/core/src/example.ts")).toEqual([
    expect.stringContaining("keep one statement or member per line"),
  ]);
  expect(found("export function pick(flag: boolean) {\n  if (flag) return 1; else return 2;\n}\n", "packages/core/src/example.ts")).toEqual([
    expect.stringContaining("place 'else' on its own line"),
  ]);
  expect(found("export const a = 1, b = 2;\n", "packages/core/src/example.ts")).toEqual([
    expect.stringContaining("keep one variable declaration per line"),
  ]);
  const wideObject = `export const config = { alphaParameterName: "first-value", betaParameterName: "second-value", gammaParameterName: "third-value", deltaParameterName: "fourth-value" };\n`;
  expect(found(wideObject, "packages/core/src/example.ts")).toEqual([
    expect.stringContaining("wrap structured line exceeding 160 characters"),
  ]);
  for (const unformatted of [
    "export const a = 1; export const b = 2;\n",
    "export function pick(flag: boolean) {\n  if (flag) return 1; else return 2;\n}\n",
    "export const a = 1, b = 2;\n",
    wideObject,
  ]) {
    const formatted = formatProductionSource(unformatted, "packages/core/src/example.ts");
    expect(formatProductionSource(formatted, "packages/core/src/example.ts")).toBe(formatted);
    expect(found(formatted, "packages/core/src/example.ts")).toEqual([]);
  }
});
