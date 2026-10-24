import { afterAll, expect, it } from "bun:test";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureJson } from "./fixture-json.js";
import { Fakes, makeWorld, removeDir, tempDir } from "./support.js";

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

it("uses the same complete-publication contract for live scenarios and workflow scripts", async () => {
  const root = tempDir("petrina-json-consumers-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  const world = await makeWorld("atomic-script"); roots.push(world.dir);
  const before = { reviewer: "important" } as const, after = { reviewer: "question" } as const;
  fakes.scenario(before); world.setScript(script => Object.assign(script, before));
  for (const [path, update] of [
    [join(fakes.dir, "scenario.json"), () => fakes.scenario(after)],
    [join(world.dir, "agents.json"), () => world.setScript(script => Object.assign(script, after))],
  ] as const) {
    const reader = openSync(path, "r");
    try {
      update();
      expect(JSON.parse(readFileSync(reader, "utf8"))).toEqual(before);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(after);
    } finally { closeSync(reader); }
  }
});
