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
