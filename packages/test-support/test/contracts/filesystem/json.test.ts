import { afterAll, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFixtureJsonLines, writeFixtureJson, writeFixtureText } from "@petrina/test-support/fixture-json";
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

it("publishes plain-text flags atomically to live readers and cleans up staging files on failure", () => {
  const root = tempDir("petrina-text-publication-"); roots.push(root);
  const path = join(root, "release.flag"), unreplaceable = join(root, "directory-target");
  writeFixtureText(path, "hold");
  const reader = openSync(path, "r");
  try {
    writeFixtureText(path, "fail");
    expect(readFileSync(reader, "utf8")).toBe("hold");
    expect(readFileSync(path, "utf8")).toBe("fail");
    mkdirSync(unreplaceable);
    expect(() => writeFixtureText(unreplaceable, "fail")).toThrow();
    expect(readdirSync(root).sort()).toEqual(["directory-target", "release.flag"]);
  } finally { closeSync(reader); }
});

it("waits for a complete record when the live fixture log is missing or empty", () => {
  const root = tempDir("petrina-json-lines-empty-"); roots.push(root);
  const path = join(root, "requests.jsonl");
  expect(readFixtureJsonLines(path)).toEqual([]);
  writeFileSync(path, "");
  expect(readFixtureJsonLines(path)).toEqual([]);
});

it("preserves complete records while an appended tail is unfinished, even if that tail is already valid JSON", () => {
  const root = tempDir("petrina-json-lines-tail-"); roots.push(root);
  const path = join(root, "requests.jsonl");
  const first = { method: "initialize" }, second = { method: "get_usage", text: "été 😀" };
  writeFileSync(path, '{"method":"initial');
  expect(readFixtureJsonLines(path)).toEqual([]);
  fs.appendFileSync(path, 'ize"}\n{"method":"get_');
  expect(readFixtureJsonLines(path)).toEqual([first]);
  fs.appendFileSync(path, 'usage","text":"été 😀"}');
  expect(readFixtureJsonLines(path)).toEqual([first]);
  fs.appendFileSync(path, "\n");
  expect(readFixtureJsonLines(path)).toEqual([first, second]);
});

it("preserves CRLF framing, Unicode and literal JSON values without trimming record data", () => {
  const root = tempDir("petrina-json-lines-values-"); roots.push(root);
  const path = join(root, "requests.jsonl");
  const records = [{ text: "  été 😀\nsecond line\r\n  " }, null, false, 0, "", ["résumé"]];
  writeFileSync(path, records.map(value => JSON.stringify(value) + "\r\n").join(""));
  expect(readFixtureJsonLines(path)).toEqual(records);
});

for (const [name, malformed] of [["invalid JSON", '{"method":}'], ["blank line", ""]] as const) {
  it(`rejects a malformed complete record (${name}) rather than hiding it behind a pending tail`, () => {
    const root = tempDir("petrina-json-lines-invalid-"); roots.push(root);
    const path = join(root, "requests.jsonl");
    writeFileSync(path, '{"method":"initialize"}\n' + malformed + '\n{"method":"unfinished');
    expect(() => readFixtureJsonLines(path)).toThrow(SyntaxError);
  });
}

for (const [label, failure] of [["Error", Object.assign(new Error("Cannot read the fixture log"), { code: "EACCES" })], ["undefined", undefined]] as const) {
  it(`preserves an unrelated live-log read rejection ${label} exactly`, () => {
    const root = tempDir("petrina-json-lines-read-failure-"); roots.push(root);
    const path = join(root, "requests.jsonl");
    writeFileSync(path, '{"method":"initialize"}\n');
    const native = fs.readFileSync;
    let restore: (() => void) | undefined;
    try {
      const read = spyOn(fs, "readFileSync"); restore = () => read.mockRestore();
      read.mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (file === path) throw failure;
        return Reflect.apply(native, fs, [file, ...args]);
      }) as typeof fs.readFileSync);
      let caught: { error: unknown } | undefined;
      try { readFixtureJsonLines(path); } catch (error) { caught = { error }; }
      expect(caught).toBeDefined();
      if (!caught) throw new Error("An unavailable fixture-log read became an empty successful read");
      expect(caught.error).toBe(failure);
    } finally { restore?.(); }
    expect(readFixtureJsonLines(path)).toEqual([{ method: "initialize" }]);
  });
}
