import { afterAll, expect, it } from "bun:test";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("keeps an opened reader on the complete old JSON while new readers see the complete update", () => {
  const root = tempDir("petrina-json-publication-"); roots.push(root);
  const path = join(root, "config.json");
  const before = { text: "Earlier complete configuration", items: [1, 2] };
  const after = { text: "New complete configuration", items: [3, 4] };
  writeFixtureJson(path, before);
  const reader = openSync(path, "r");
  try {
    writeFixtureJson(path, after);
    expect(JSON.parse(readFileSync(reader, "utf8"))).toEqual(before);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(after);
    expect(readdirSync(root)).toEqual(["config.json"]);
  } finally { closeSync(reader); }
});

it("preserves published state and removes staging files when serialization or publication fails", () => {
  const root = tempDir("petrina-json-failure-"); roots.push(root);
  const path = join(root, "config.json"), target = join(root, "unreplaceable");
  writeFixtureJson(path, { kept: true });
  const circular: { self?: unknown } = {}; circular.self = circular;
  expect(() => writeFixtureJson(path, circular)).toThrow();
  expect(() => writeFixtureJson(path, undefined)).toThrow("JSON value");
  mkdirSync(target); writeFileSync(join(target, "keep"), "owned existing state");
  expect(() => writeFixtureJson(target, { replacement: true })).toThrow();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ kept: true });
  expect(readFileSync(join(target, "keep"), "utf8")).toBe("owned existing state");
  expect(readdirSync(root).sort()).toEqual(["config.json", "unreplaceable"]);
});
