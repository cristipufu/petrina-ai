import { afterAll, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createFixtureJournal, fixtureRetention, FIXTURE_JOURNAL, registerFixtureRoot } from "../../../src/fixture-retention.js";
import { removeDir, tempDir } from "../../../src/fixtures.js";

const root = tempDir("petrina-fixture-journal-");
afterAll(() => removeDir(root));
function journal(name: string) {
  const path = join(root, name);
  createFixtureJournal(path);
  return { path, env: { [FIXTURE_JOURNAL]: path } };
}

it("retains every actual root until its independent terminal cleanup removes that exact path", () => {
  const f = journal("roots"), first = join(root, "first"), browser = join(root, "external-browser");
  fs.mkdirSync(first); fs.mkdirSync(browser);
  registerFixtureRoot(first, f.env); registerFixtureRoot(browser, f.env);
  const both = fixtureRetention(f.path);
  expect(both.kind).toBe("retained");
  if (both.kind !== "retained") throw new Error("Existing roots lost their disposal veto");
  expect(new Set(both.roots)).toEqual(new Set([first, browser]));
  // This control starts no actors. These are actual terminal filesystem removals, not inferred stops.
  fs.rmSync(first, { recursive: true });
  expect(fixtureRetention(f.path)).toEqual({ kind: "retained", roots: [browser] });
  fs.rmSync(browser, { recursive: true });
  expect(fixtureRetention(f.path)).toEqual({ kind: "clear" });
});

for (const corruption of ["missing journal", "missing header", "malformed header", "partial record", "unknown record", "malformed record"] as const) it(`refuses disposal with ${corruption}`, () => {
  const f = journal(corruption), actual = join(root, "owned-" + corruption);
  fs.mkdirSync(actual); registerFixtureRoot(actual, f.env);
  const record = fs.readdirSync(f.path).find(name => name !== "journal.json")!;
  if (corruption === "missing journal") fs.rmSync(f.path, { recursive: true });
  else if (corruption === "missing header") fs.rmSync(join(f.path, "journal.json"));
  else if (corruption === "malformed header") fs.writeFileSync(join(f.path, "journal.json"), '{"version":1,"unknown":true}');
  else if (corruption === "partial record") fs.writeFileSync(join(f.path, record), '{"version":');
  else if (corruption === "unknown record") fs.writeFileSync(join(f.path, "unpublished.tmp"), "");
  else fs.writeFileSync(join(f.path, record), JSON.stringify({ version: 1, root: "relative" }));
  expect(fixtureRetention(f.path).kind).toBe("unknown");
  expect(fs.lstatSync(actual).isDirectory()).toBe(true);
});

for (const [index, failure] of [Object.assign(new Error("Access unavailable"), { code: "EACCES" }), undefined].entries()) it(`preserves an unknown actual root inspection ${String(failure)}`, () => {
  const f = journal("inspection-" + index), actual = join(root, "inspection-root-" + index);
  fs.mkdirSync(actual); registerFixtureRoot(actual, f.env);
  const native = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync");
  try {
    stat.mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (path === actual) throw failure;
      return Reflect.apply(native, fs, [path, ...args]);
    }) as typeof fs.lstatSync);
    const result = fixtureRetention(f.path);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("Unknown root access authorized disposal");
    expect(result.error).toBe(failure);
  } finally { stat.mockRestore(); }
  expect(fs.lstatSync(actual).isDirectory()).toBe(true);
});

it("rejects publication into a missing parent journal before a record can be handed out", () => {
  const actual = join(root, "publication-root"); fs.mkdirSync(actual);
  expect(() => registerFixtureRoot(actual, { [FIXTURE_JOURNAL]: join(root, "not-created") })).toThrow();
  expect(fs.readdirSync(actual)).toEqual([]);
  expect(() => registerFixtureRoot("relative", journal("absolute-only").env)).toThrow();
});
