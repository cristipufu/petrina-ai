import { expect, it } from "bun:test";
import { layerBoundaries, layerStructure, packageBoundaries, testLayer } from "../../quality/layers.js";

const path = "packages/engine/test/rules/reviews/status.test.ts";
const source = (body: string, extras: [string, string][] = []) => new Map([[path, body], ...extras]);
const inventory = (files: { file: string; status: string; splitFiles?: unknown }[]) => ["docs/plans/test-layer-audit.json", JSON.stringify({ version: 1, files })] as [string, string];

it("requires a named layer and subsystem while retaining an explicit pending migration inventory", () => {
  expect(testLayer(path)).toEqual({ layer: "rules", area: "reviews" });
  expect(testLayer("apps/desktop/test/contracts/desktop/host/ownership.test.ts")).toEqual({ layer: "contracts", area: "desktop/host" });
  for (const file of ["packages/core/test/rules.test.ts", "packages/engine/test/rules/status.test.ts", "packages/engine/test/other/reviews/status.test.ts"]) expect(testLayer(file)).toBeUndefined();
  const old = "packages/engine/test/existing.test.ts", added = "packages/core/test/added.test.ts";
  expect(layerStructure(source("", [inventory([{ file: old, status: "pending" }]), [old, ""]]))).toEqual([]);
  expect(layerStructure(source("", [inventory([]), [added, ""]]))).toEqual([expect.stringContaining(added)]);
  expect(layerStructure(source(""))).toEqual([expect.stringContaining("missing complete")]);
  expect(layerStructure(source("", [inventory([{ file: old, status: "reviewed" }])]))).toEqual([expect.stringContaining("invalid")]);
  expect(layerStructure(source("", [inventory([{ file: old, status: "pending" }, { file: old, status: "pending" }])]))).toEqual([expect.stringContaining("invalid")]);
  expect(layerStructure(source("", [inventory([{ file: old, status: "pending" }])]))).toEqual([expect.stringContaining("missing inventoried test")]);
});

it("retains every audited split owner, including a companion whose deletion would otherwise be silent", () => {
  const companion = "packages/core/test/orchestration/simulator/history.test.ts";
  const files = source("", [inventory([{ file: path, status: "reviewed", splitFiles: [path, companion] }]), [companion, ""]]);
  expect(layerStructure(files)).toEqual([]);
  files.delete(companion);
  expect(layerStructure(files)).toEqual([expect.stringContaining(`${companion}: missing inventoried test`)]);
  files.set(companion, ""); files.delete(path);
  expect(layerStructure(files)).toEqual([expect.stringContaining(`${path}: missing inventoried test`)]);
});

it("rejects malformed or unaudited split ownership instead of weakening the migration guard", () => {
  const companion = "packages/core/test/orchestration/simulator/history.test.ts";
  for (const splitFiles of [[], [path, path], [companion], [path, 42], [path, "packages/core/test/flat.test.ts"], "not an array"]) {
    expect(layerStructure(source("", [inventory([{ file: path, status: "reviewed", splitFiles }])]))).toEqual([expect.stringContaining("invalid test-layer migration inventory")]);
  }
  expect(layerStructure(source("", [inventory([{ file: path, status: "pending", splitFiles: [path, companion] }]), [companion, ""]])))
    .toEqual([expect.stringContaining("invalid test-layer migration inventory")]);
});

it("follows transitive helpers, normalized paths, aliases, re-exports and cycles without executing them", () => {
  const files = source("import { inspect } from '../../helpers';", [
    ["packages/engine/test/helpers.ts", "export * from '@petrina/core';"],
    ["packages/core/src/index.ts", "export * from './rule.js';"],
    ["packages/core/src/rule.ts", "import './index.js'; import { readFile } from 'node:fs/promises';"],
  ]);
  expect(layerBoundaries(files)).toEqual([expect.stringContaining("imports node:fs/promises")]);
  files.set("packages/core/src/rule.ts", "import './index.js'; export const inspect = () => true;");
  expect(layerBoundaries(files)).toEqual([]);
  files.set("packages/core/src/rule.ts", "export * from './missing.js';");
  expect(layerBoundaries(files)).toEqual([expect.stringContaining("unresolved")]);
});

it("permits type-only boundary references without overlooking side-effect and mixed imports", () => {
  for (const body of ["import type { ChildProcess } from 'node:child_process';", "import { type ChildProcess } from 'node:child_process';", "export { type ChildProcess } from 'node:child_process';"]) expect(layerBoundaries(source(body))).toEqual([]);
  for (const body of ["import 'node:fs';", "import {} from 'node:fs';", "import { type ChildProcess, spawn } from 'node:child_process';", "export * from 'bun:sqlite';", "await import('node:net');", "require('node:http');"]) expect(layerBoundaries(source(body))).toHaveLength(1);
});

it("recognizes actual global resource access and computed imports, while ignoring examples in prose", () => {
  for (const body of ["const start = Bun.spawn;", "const { pid } = Bun.spawn(['git']);", "const { spawn } = Bun;", "const alias = process;", "const e = process.env;", "process['kill'](42);", "fetch(address);", "new WebSocket(address);", "globalThis.fetch(address);", "globalThis.Bun.spawn(['git']);", "const { spawn } = globalThis.Bun;", "const e = globalThis.process.env;", "Bun[operation]();", "await import(chosen);"]) expect(layerBoundaries(source(body)).length).toBeGreaterThan(0);
  expect(layerBoundaries(source("// Bun.spawn(['git'])\nconst example = `import 'node:fs'; fetch(address)`;"))).toEqual([]);
  expect(layerBoundaries(source("import { request } from 'some-network-library';"))).toEqual([expect.stringContaining("unreviewed external")]);
  expect(layerBoundaries(source("import { open } from '@petrina/engine/hidden';"))).toEqual([expect.stringContaining("unreviewed external")]);
});

it("guards controller and presentation helpers while allowing actual owned boundary and journey tests", () => {
  for (const layer of ["rules", "orchestration", "presentation", "contracts", "journeys"]) {
    const file = `packages/engine/test/${layer}/agents/session.test.ts`;
    const errors = layerBoundaries(new Map([[file, "import { spawn } from 'node:child_process';"]]));
    expect(errors.length).toBe(["contracts", "journeys"].includes(layer) ? 0 : 1);
  }
});

it("keeps production controllers independent of native implementations, including unused files and type-only cycles", () => {
  const controller = "packages/orchestrator/src/repair.ts", adapter = "packages/engine/src/kernel.ts";
  const files = new Map([[controller, "import type { Kernel } from '../../engine/src/kernel.js';"], [adapter, "import { readFile } from 'node:fs/promises';"]]);
  expect(packageBoundaries(files)).toEqual([expect.stringContaining("including through types")]);
  files.set(controller, "type Kernel = import('../../engine/src/kernel.js').Kernel;");
  expect(packageBoundaries(files)).toEqual([expect.stringContaining("including through types")]);
  files.set(controller, "import type { ChildProcess } from 'node:child_process';");
  expect(packageBoundaries(files)).toEqual([expect.stringContaining("keep the controller contract portable")]);
  files.set(controller, "import { readFile } from 'node:fs/promises';");
  expect(packageBoundaries(files)).toEqual([expect.stringContaining("real I/O belongs")]);
  files.set(controller, "export const route = (input: string) => input;");
  expect(packageBoundaries(files)).toEqual([]);
  files.set("packages/orchestrator/package.json", JSON.stringify({ dependencies: { "@petrina/engine": "workspace:*" } }));
  expect(packageBoundaries(files)).toEqual([expect.stringContaining("violates the package direction")]);
});

it("keeps native persistence and shared test infrastructure independent of the application host", () => {
  const host = "packages/engine/src/kernel.ts";
  for (const [owner, dependency] of [
    ["packages/storage", "../../engine/src/kernel.js"],
    ["packages/agent-runtime", "../../engine/src/kernel.js"],
    ["packages/repositories", "../../engine/src/kernel.js"],
    ["packages/platform", "../../engine/src/kernel.js"],
    ["packages/platform", "../../test-support/src/environment.js"],
    ["packages/test-support", "../../engine/src/kernel.js"],
    ["packages/storage", "../../test-support/src/environment.js"],
  ]) {
    const file = `${owner}/src/adapter.ts`;
    const target = dependency!.includes("test-support") ? "packages/test-support/src/environment.ts" : host;
    const errors = packageBoundaries(new Map([[file, `import type { Host } from '${dependency}';`], [target, "export interface Host {}"]]));
    expect(errors.some(error => error.includes("including through types"))).toBe(true);
  }
  expect(packageBoundaries(new Map([["packages/storage/src/adapter.ts", "import { Database } from 'bun:sqlite';"],
    ["packages/platform/src/process-host.ts", "import { execFile } from 'node:child_process';"],
    ["packages/agent-runtime/src/session.ts", "import type { AgentSession } from '@petrina/orchestrator';"],
    ["packages/repositories/src/query.ts", "import type { RepositoryQueries } from '@petrina/orchestrator';"],
    ["packages/test-support/src/fixtures.ts", "import { mkdir } from 'node:fs/promises';"]]))).toEqual([]);
});

it("follows package subpaths and rejects test-support imports from any shipped source", () => {
  const target = "packages/test-support/src/fixtures.ts", caller = "packages/storage/test/rules/testing/private.test.ts";
  expect(layerBoundaries(new Map([[caller, "import { make } from '@petrina/test-support/fixtures';"], [target, "import 'node:fs';"]])))
    .toEqual([expect.stringContaining("imports node:fs")]);
  for (const imported of ["@petrina/test-support/fixtures", "../../test-support/src/fixtures.js"]) {
    expect(packageBoundaries(new Map([["packages/engine/src/host.ts", `import type { Fixture } from '${imported}';`], [target, "export interface Fixture {}"]])))
      .toEqual([expect.stringContaining("production code cannot depend on test support")]);
  }
});

const viewFile = "apps/desktop/test/presentation/tasks/client.test.tsx";
const viewSource = (mock: string, extra: [string, string][] = [], imports = "import { vi } from 'vitest';") => new Map([
  [viewFile, `${imports}\n${mock}\nimport { View } from '../../../src/View';`],
  ["apps/desktop/src/View.tsx", "import { client } from './engine'; export const View = () => client;"],
  ["apps/desktop/src/engine.ts", "import { readFile } from 'node:fs/promises'; export const client = readFile;"],
  ...extra,
]);

it("follows presentation replacements by resolved module identity while still inspecting the view", () => {
  for (const [imported, call] of [
    ["import { vi } from 'vitest';", "vi"],
    ["import { vitest } from 'vitest';", "vitest"],
    ["import { vitest as vi } from 'vitest';", "vi"],
  ]) {
    const files = viewSource(`${call}.mock('../../../src/./engine.js', () => ({ client: {} }));`, [], imported);
    expect(layerBoundaries(files)).toEqual([]);
    files.set("apps/desktop/src/View.tsx", "import { client } from './engine'; fetch('https://example.test');");
    expect(layerBoundaries(files)).toEqual([expect.stringContaining("accesses fetch")]);
  }
});

it("distinguishes explicit export keys and member names from real factory value references", () => {
  for (const body of [
    "const state = {}; vi.mock('../../../src/engine', () => ({ client: { getState: () => state } }));",
    "const state = { client: {} }; vi.mock('../../../src/engine', () => ({ client: state.client }));",
    "const state = { client: {} }; vi.mock('../../../src/engine', () => ({ client: state?.client }));",
    "const state = {}; vi.mock('../../../src/engine', () => ({ client() { return state; } }));",
  ]) {
    const files = viewSource(`import { client } from '../../../src/engine'; ${body}`);
    expect(layerBoundaries(files)).toEqual([]);
  }
  for (const factory of [
    "() => ({ client })",
    "() => ({ client: client })",
    "() => ({ client: { getState: () => client } })",
    "() => ({ client: { getState: () => state[client] } })",
    "() => ({ client: { getState: () => state?.[client] } })",
  ]) {
    const files = viewSource(`import { client } from '../../../src/engine'; const state = {}; vi.mock('../../../src/engine', ${factory});`);
    expect(layerBoundaries(files)).toEqual([expect.stringContaining("imports node:fs/promises")]);
  }
});

it("admits explicit block replacements, getters, private proxies and asynchronous exported callbacks", () => {
  const files = viewSource(`vi.mock('../../../src/engine', () => {
    class Unavailable extends Error {}
    const commands = { async askBrowser() { return []; } };
    return { get desktop() { return false; }, client: new Proxy({}, { get(_target, key) { return commands[key]; } }), Unavailable };
  });`);
  expect(layerBoundaries(files)).toEqual([]);
});

it("allows proven external host replacements without turning unknown external modules into pure dependencies", () => {
  const files = viewSource("vi.mock('../../../src/engine', () => ({ client: {} })); vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));");
  files.set("apps/desktop/src/View.tsx", "import { isTauri } from '@tauri-apps/api/core'; export const View = isTauri;");
  expect(layerBoundaries(files)).toEqual([]);
  files.set("apps/desktop/src/View.tsx", "import { invoke } from '@tauri-apps/api/event'; export const View = invoke;");
  expect(layerBoundaries(files)).toEqual([expect.stringContaining("unreviewed external")]);
});

it("never trusts fake, type-only, shadowed or changed Vitest bindings as presentation boundaries", () => {
  for (const [imports, replacement] of [
    ["const vi = { mock() {} };", "vi.mock('../../../src/engine', () => ({ client: {} }));"],
    ["import type { vi } from 'vitest';", "vi.mock('../../../src/engine', () => ({ client: {} }));"],
    ["import { vi } from './local-test-double';", "vi.mock('../../../src/engine', () => ({ client: {} }));"],
    ["import { vi } from 'vitest';", "function unused(vi) { vi.mock('../../../src/engine', () => ({ client: {} })); }"],
    ["import { vi as replace } from 'vitest';", "replace.mock('../../../src/engine', () => ({ client: {} }));"],
    ["import * as testApi from 'vitest';", "testApi.vi.mock('../../../src/engine', () => ({ client: {} }));"],
    ["import { vi } from 'vitest';", "vi.mock = fake; vi.mock('../../../src/engine', () => ({ client: {} }));"],
  ] as const) {
    expect(layerBoundaries(viewSource(replacement, [], imports)).some(error => error.includes("node:fs/promises"))).toBe(true);
  }
});

it("rejects partial, async, original-module, computed and indirect replacement factories", () => {
  for (const replacement of [
    "vi.mock('../../../src/engine', async () => ({ client: {} }));",
    "vi.mock('../../../src/engine', () => ({ ...actual, client: {} }));",
    "vi.mock('../../../src/engine', (importOriginal) => ({ client: importOriginal() }));",
    "vi.mock('../../../src/engine', () => ({ client: vi.importActual('../../../src/engine') }));",
    "vi.mock('../../../src/engine', () => ({ client: vi['importActual']('../../../src/engine') }));",
    "const original = vi.importActual; vi.mock('../../../src/engine', () => ({ client: original() }));",
    "vi.mock('../../../src/engine', () => ({ [exportName]: {} }));",
    "vi.mock(moduleName, () => ({ client: {} }));",
    "vi['mock']('../../../src/engine', () => ({ client: {} }));",
    "vi.mock('../../../src/engine', factory);",
    "vi.mock('../../../src/engine', () => ({ client: {} })); vi.unmock('../../../src/engine');",
    "vi.mock('../../../src/engine', () => ({ client: {} })); vi.doUnmock('../../../src/engine');",
    "vi.mock('../../../src/engine', () => ({ client: {} })); vi.doMock('../../../src/engine', () => actual);",
    "vi.mock('../../../src/engine', () => { if (condition) return actual; return { client: {} }; });",
  ]) {
    const errors = layerBoundaries(viewSource(replacement));
    expect(errors.some(error => error.includes("unsupported presentation replacement"))).toBe(true);
    expect(errors.some(error => error.includes("node:fs/promises"))).toBe(true);
  }
});

it("continues to inspect replacement factories and their helper dependencies for native effects", () => {
  expect(layerBoundaries(viewSource("vi.mock('../../../src/engine', () => ({ client: () => Bun.spawn(['agent']) }));")))
    .toEqual([expect.stringContaining("accesses Bun.spawn")]);
  const helpers = viewSource("vi.mock('../../../src/engine', () => ({ client: stub })); import { stub } from './stub';", [
    ["apps/desktop/test/presentation/tasks/stub.ts", "import { readFile } from 'node:fs/promises'; export const stub = readFile;"],
  ]);
  expect(layerBoundaries(helpers)).toEqual([expect.stringContaining("imports node:fs/promises")]);
  helpers.set("apps/desktop/test/presentation/tasks/stub.ts", "import { client } from '../../../src/engine'; export const stub = client;");
  expect(layerBoundaries(helpers)).toEqual([expect.stringContaining("imports node:fs/promises")]);
  helpers.set(viewFile, "import { vi } from 'vitest'; import { stub } from './stub'; const commands = stub; vi.mock('../../../src/engine', () => ({ client: commands })); import { View } from '../../../src/View';");
  expect(layerBoundaries(helpers)).toEqual([expect.stringContaining("imports node:fs/promises")]);
  helpers.set(viewFile, "import { vi } from 'vitest'; import { stub } from './stub'; let commands; function setup() { commands = stub; } vi.mock('../../../src/engine', () => ({ client: commands })); import { View } from '../../../src/View';");
  expect(layerBoundaries(helpers)).toEqual([expect.stringContaining("imports node:fs/promises")]);
  const unmock = viewSource("vi.mock('../../../src/engine', () => ({ client: {} })); import './stub';", [
    ["apps/desktop/test/presentation/tasks/stub.ts", "import { vi } from 'vitest'; vi.unmock('../../../src/engine');"],
  ]);
  expect(layerBoundaries(unmock)).toEqual([expect.stringContaining("unsupported presentation replacement")]);
  const required = viewSource("vi.mock('../../../src/engine', () => ({ client: require('../../../src/engine') }));");
  expect(layerBoundaries(required)).toEqual([expect.stringContaining("imports node:fs/promises")]);
  const direct = viewSource("vi.mock('node:fs', () => ({ readFile() {} })); const fs = require('node:fs'); vi.mock('../../../src/engine', () => ({ client: {} }));");
  expect(layerBoundaries(direct)).toEqual([expect.stringContaining("imports node:fs")]);
});

it("does not apply presentation replacements to rule, controller or production package boundaries", () => {
  for (const layer of ["rules", "orchestration"]) {
    const file = `apps/desktop/test/${layer}/tasks/client.test.tsx`;
    const files = new Map([[file, "import { vi } from 'vitest'; vi.mock('node:fs', () => ({})); import 'node:fs';"]]);
    expect(layerBoundaries(files)).toEqual([expect.stringContaining("imports node:fs")]);
  }
  expect(packageBoundaries(new Map([["packages/core/src/model.ts", "import { vi } from 'vitest'; vi.mock('node:fs', () => ({})); import 'node:fs';"]])))
    .toEqual([expect.stringContaining("imports node:fs")]);
});

it("treats only real presentation stylesheets as assets, retaining pure and unresolved-import guards", () => {
  const files = viewSource("vi.mock('../../../src/engine', () => ({ client: {} }));", [["apps/desktop/src/view.css", ":root { color: red; }"]]);
  files.set("apps/desktop/src/View.tsx", "import './view.css'; import '@xyflow/react/dist/base.css'; export const View = () => null;");
  expect(layerBoundaries(files)).toEqual([]);
  files.delete("apps/desktop/src/view.css");
  expect(layerBoundaries(files)).toEqual([expect.stringContaining("stylesheets need a real presentation asset")]);
  files.set("apps/desktop/src/View.tsx", "import 'some-network-library/pretend.css';");
  expect(layerBoundaries(files)).toEqual([expect.stringContaining("stylesheets need a real presentation asset")]);
  for (const layer of ["rules", "orchestration"]) {
    const file = `apps/desktop/test/${layer}/tasks/client.test.tsx`;
    expect(layerBoundaries(new Map([[file, "import '../../../src/view.css';"], ["apps/desktop/src/view.css", "body {}"]])))
      .toEqual([expect.stringContaining("stylesheets need a real presentation asset")]);
  }
  expect(packageBoundaries(new Map([["packages/core/src/model.ts", "import './view.css';"], ["packages/core/src/view.css", "body {}"]])))
    .toEqual([expect.stringContaining("stylesheets need a real presentation asset")]);
});

it("locks desktop UI to core and web/Tauri APIs while preventing engine from depending on desktop", () => {
  expect(
    packageBoundaries(
      new Map([
        ["apps/desktop/src/App.tsx", "import { columnOf } from '@petrina/core'; export const ok = () => fetch('/api');"],
        ["packages/core/src/index.ts", "export const columnOf = () => 'backlog';"],
      ]),
    ),
  ).toEqual([]);

  for (const forbidden of [
    "import type { Engine } from '../../../packages/engine/src/engine.js';",
    "import { scopesFor } from '@petrina/orchestrator';",
    "import { Store } from '@petrina/storage/store';",
    "import * as git from '@petrina/repositories/git';",
  ]) {
    const errors = packageBoundaries(
      new Map([
        ["apps/desktop/src/App.tsx", forbidden],
        ["packages/engine/src/engine.ts", "export class Engine {}"],
        ["packages/orchestrator/src/index.ts", "export const scopesFor = () => [];"],
        ["packages/storage/src/store.ts", "export class Store {}"],
        ["packages/repositories/src/git.ts", "export const run = () => {};"],
      ]),
    );
    expect(errors.some((error) => error.includes("apps/desktop cannot depend on"))).toBe(true);
  }

  for (const nativeLeak of [
    "import { readFileSync } from 'node:fs';",
    "import type { ChildProcess } from 'node:child_process';",
    "export const spawn = () => Bun.spawn(['git']);",
    "export const home = () => process.env.HOME;",
  ]) {
    expect(packageBoundaries(new Map([["apps/desktop/src/App.tsx", nativeLeak]])).length).toBeGreaterThan(0);
  }

  expect(
    packageBoundaries(
      new Map([["apps/desktop/package.json", JSON.stringify({ dependencies: { "@petrina/engine": "workspace:*" } })]]),
    ),
  ).toEqual([expect.stringContaining("violates the package direction")]);

  expect(
    packageBoundaries(
      new Map([
        ["packages/engine/src/server.ts", "import type { Theme } from '../../../apps/desktop/src/theme.js';"],
        ["apps/desktop/src/theme.ts", "export type Theme = 'light' | 'dark';"],
      ]),
    ),
  ).toEqual([expect.stringContaining("packages/engine cannot depend on apps/desktop")]);
});

it("rejects intra-package runtime import cycles across workspaces while allowing acyclic DAGs and type-only back references", () => {
  expect(
    packageBoundaries(
      new Map([
        ["packages/core/src/a.ts", "import { b } from './b.js'; export const a = () => b();"],
        ["packages/core/src/b.ts", "import type { A } from './a.js'; export const b = (): A => 'ok'; export type A = string;"],
      ]),
    ),
  ).toEqual([]);

  expect(
    packageBoundaries(
      new Map([
        ["packages/core/src/a.ts", "import { b } from './b.js'; export const a = () => b();"],
        ["packages/core/src/b.ts", "import { a } from './a.js'; export const b = () => a();"],
      ]),
    ),
  ).toEqual([expect.stringContaining("intra-package runtime import cycle (packages/core/src/a.ts <-> packages/core/src/b.ts)")]);

  expect(
    packageBoundaries(
      new Map([
        ["packages/engine/src/one.ts", "import './two.js';"],
        ["packages/engine/src/two.ts", "import './three.js';"],
        ["packages/engine/src/three.ts", "import './one.js';"],
      ]),
    ),
  ).toEqual([expect.stringContaining("intra-package runtime import cycle (packages/engine/src/one.ts <-> packages/engine/src/three.ts <-> packages/engine/src/two.ts)")]);
});
