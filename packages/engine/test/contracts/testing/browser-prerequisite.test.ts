import { expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tempDir, removeDir } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";
import { browserPrerequisite, observeBrowserExecutable, observeBrowserPrerequisiteCommand, type BrowserExecutableFiles } from "../../quality/browser-prerequisite.js";
import { bundledChromiumExecutablePath } from "../../quality/bundled-browser.js";
import { CommandFailure, type CommandResult } from "@petrina/test-support/commands";

it("observes a private accessible file without launching it or claiming browser startup", async () => {
  const root = tempDir("petrina-browser-prerequisite-");
  try {
    const path = join(root, "available-browser-file");
    writeFileSync(path, "A file observation fixture, not a browser program.\n", { mode: 0o700 });
    expect(await browserPrerequisite({ executablePath: () => path, observe: observeBrowserExecutable })).toEqual({ kind: "available-file", path });
  } finally { removeDir(root); }
});

for (const kind of ["missing", "not-file"] as const) it(`reports an actual private ${kind} browser prerequisite`, async () => {
  const root = tempDir("petrina-browser-prerequisite-");
  try {
    const path = join(root, "expected-browser");
    if (kind === "not-file") mkdirSync(path);
    expect(await observeBrowserExecutable(path)).toEqual({ kind });
  } finally { removeDir(root); }
});

for (const error of [Object.assign(new Error("access denied"), { code: "EACCES" }), undefined]) it(`keeps a stat failure unavailable: ${String(error)}`, async () => {
  let accessed = false;
  const result = await observeBrowserExecutable("controlled executable", {
    async stat() { throw error; },
    async access() { accessed = true; },
  });
  expect(result).toEqual({ kind: "unavailable", detail: error instanceof Error ? error.message : "undefined" });
  expect(accessed).toBe(false);
});

it("requires actual access after stat and preserves method-backed file effects", async () => {
  class Files implements BrowserExecutableFiles {
    readonly seen: string[] = [];
    async stat(path: string) { this.seen.push(`stat:${path}`); return { file: true }; }
    async access(path: string) { this.seen.push(`access:${path}`); throw Object.assign(new Error("not executable"), { code: "EACCES" }); }
  }
  const files = new Files();
  expect(await observeBrowserExecutable("expected", files)).toEqual({ kind: "unavailable", detail: "not executable" });
  expect(files.seen).toEqual(["stat:expected", "access:expected"]);
});

it("uses both prerequisite effects as methods and preserves a resolver rejection", async () => {
  const calls: string[] = [], failure = new Error("resolver unavailable");
  const effects = {
    path: "expected", failure,
    executablePath() { calls.push(this.path); throw this.failure; },
    async observe(path: string) { calls.push(path); return { kind: "available-file" as const }; },
  };
  expect(await rejectionOf(browserPrerequisite(effects))).toBe(failure);
  expect(calls).toEqual(["expected"]);
  const successful = {
    path: "resolved",
    executablePath() { return this.path; },
    async observe(path: string) { expect(path).toBe(this.path); return { kind: "missing" as const }; },
  };
  expect(await browserPrerequisite(successful)).toEqual({ kind: "missing", path: "resolved" });
});

it("refuses an absent executable identity without touching the filesystem", async () => {
  let observed = false;
  const error = await rejectionOf(browserPrerequisite({ executablePath: () => "", async observe() { observed = true; return { kind: "available-file" }; } }));
  expect(error).toBeInstanceOf(Error);
  expect(observed).toBe(false);
});

it("resolves the actual bundled public executable path without needing a browser installation", () => {
  const path = bundledChromiumExecutablePath();
  expect(path.length).toBeGreaterThan(0);
  expect(isAbsolute(path)).toBe(true);
});

for (const [error, safeToDispose] of [
  [new Error("unknown reader acquisition failure"), false],
  [undefined, false],
  [new CommandFailure("entered starter threw", "start", "", "", "none"), false],
  [new CommandFailure("cleanup uncertain", "unreadable", "", "", "unconfirmed"), false],
  [new CommandFailure("actual cleanup confirmed", "cancelled", "", "", "confirmed"), true],
] as const) it(`requires positive helper settlement authority: ${String(error)}`, async () => {
  class Effects {
    called = 0;
    readonly failure = error;
    async run(): Promise<CommandResult> { this.called++; throw this.failure; }
  }
  const effects = new Effects(), result = await observeBrowserPrerequisiteCommand(effects);
  expect(effects.called).toBe(1);
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") throw new Error("The failed helper was reported completed");
  expect(result.error).toBe(error);
  expect(result.safeToDispose).toBe(safeToDispose);
});

for (const code of [0, 7]) it(`accepts fully drained canonical command completion independently of exit ${code}`, async () => {
  class Effects {
    called = 0;
    readonly result: CommandResult = { code, stdout: "", stderr: "recorded prerequisite diagnostic" };
    async run() { this.called++; return this.result; }
  }
  const effects = new Effects(), result = await observeBrowserPrerequisiteCommand(effects);
  expect(effects.called).toBe(1);
  expect(result).toEqual({ kind: "completed", result: effects.result, safeToDispose: true });
});
