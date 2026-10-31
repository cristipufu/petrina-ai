import { afterAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepTestTimings, seedTestTimings } from "../../quality/timings.js";
import { testResults } from "@petrina/test-support/test-results";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { runCommand } from "@petrina/test-support/commands";
import { TEST_RUNNER } from "@petrina/test-support/run";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function fixture() {
  const root = tempDir("petrina-duration-hints-"); roots.push(root);
  const workspace = "packages/engine", folder = join(root, workspace), output = join(root, "report", "engine-timings.json");
  mkdirSync(join(folder, "test"), { recursive: true }); mkdirSync(join(root, "report"));
  return { root, workspace, scope: { id: "native", cwd: workspace, workspaces: [workspace] }, folder, output, cache: join(root, ".test-results", "timings", "native.json"), expected: [`${workspace}/test/fast.test.ts`, `${workspace}/test/slow.test.ts`] };
}

it("starts without a cache, retains the exact seed and publishes only valid current measurements atomically", () => {
  const f = fixture();
  expect(seedTestTimings(f.root, f.scope, f.output, f.expected)).toEqual({ kind: "absent" });
  expect(existsSync(f.output)).toBe(false);
  writeFixtureJson(f.output, { version: 1, files: { "test/fast.test.ts": 2, "test/slow.test.ts": 900, "test/deleted.test.ts": 10 } });
  expect(keepTestTimings(f.root, f.scope, f.output, f.expected)).toEqual({ kind: "saved", files: 2 });
  const use = seedTestTimings(f.root, f.scope, f.output, f.expected);
  expect(use).toMatchObject({ kind: "used", files: 2 });
  if (use.kind !== "used") throw new Error("The measured hint seed was not supplied");
  const supplied = readFileSync(f.output, "utf8"), retained = readFileSync(join(f.root, use.artifact), "utf8");
  expect(supplied).toBe(retained);
  expect(use.sha256).toBe(createHash("sha256").update(retained).digest("hex"));
  expect(JSON.parse(supplied)).toEqual({ version: 1, files: { "test/fast.test.ts": 2, "test/slow.test.ts": 900 } });
  writeFileSync(f.output, "{unfinished measurement");
  expect(keepTestTimings(f.root, f.scope, f.output, f.expected).kind).toBe("unavailable");
  expect(readFileSync(f.cache, "utf8")).toBe(retained);
});

it("ignores a malformed cache without inventing measurements or creating a seed", () => {
  const f = fixture(); mkdirSync(join(f.root, ".test-results", "timings"), { recursive: true }); writeFileSync(f.cache, "{");
  expect(seedTestTimings(f.root, f.scope, f.output, f.expected).kind).toBe("unusable");
  expect(existsSync(f.output)).toBe(false);
});

it("retains peer durations relative to the actual shared execution folder and prunes other workspaces", () => {
  const f = fixture(), scope = { ...f.scope, workspaces: [f.workspace, "packages/storage"] };
  const expected = [...f.expected, "packages/storage/test/contracts/sqlite/store.test.ts", "packages/core/test/rules/task.test.ts"];
  writeFixtureJson(f.output, { version: 1, files: { "test/fast.test.ts": 5, "../storage/test/contracts/sqlite/store.test.ts": 12, "../core/test/rules/task.test.ts": 900 } });
  expect(keepTestTimings(f.root, scope, f.output, expected)).toEqual({ kind: "saved", files: 2 });
  expect(seedTestTimings(f.root, scope, f.output, expected)).toMatchObject({ kind: "used", files: 2 });
  expect(JSON.parse(readFileSync(f.output, "utf8"))).toEqual({ version: 1, files: { "test/fast.test.ts": 5, "../storage/test/contracts/sqlite/store.test.ts": 12 } });
});

it("the installed Bun executes every file and starts the measured slow file first", async () => {
  const f = fixture(), log = join(f.root, "order"), report = join(f.root, "report", "native.xml");
  for (const name of ["fast", "slow"]) writeFileSync(join(f.folder, "test", `${name}.test.ts`), `import { expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
it(${JSON.stringify(name)}, () => { appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name + "\n")}); expect(process.cwd()).toBe(${JSON.stringify(f.folder)}); });`);
  const seededFiles = (name: string, ms: number): Record<string, number> =>
    process.platform === "win32"
      ? {
          [`test/${name}.test.ts`]: ms,
          [`./test/${name}.test.ts`]: ms,
          [`test\\${name}.test.ts`]: ms,
          [`.\\test\\${name}.test.ts`]: ms,
          [`./test\\${name}.test.ts`]: ms,
          [join(f.folder, "test", `${name}.test.ts`)]: ms,
          [join(f.folder, "test", `${name}.test.ts`).replaceAll("\\", "/")]: ms,
        }
      : { [`test/${name}.test.ts`]: ms };
  writeFixtureJson(f.output, { version: 1, files: { ...seededFiles("fast", 1), ...seededFiles("slow", 1000) } });
  // This tiny boundary probe uses one worker to observe dispatch order deterministically.
  // The repository's required run keeps Bun's normal worker count.
  const run = await runCommand([process.execPath, TEST_RUNNER, "./test", "--parallel=1", `--timings=${f.output}`, "--update-timings", "--reporter=junit", `--reporter-outfile=${report}`], { cwd: f.folder });
  expect(run.code, run.stderr).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["slow", "fast"]);
  const parsed = testResults(readFileSync(report, "utf8"), f.workspace, "bun", f.root);
  expect(parsed).toMatchObject({ tests: 2, passed: 2, failed: 0, skipped: 0, files: f.expected });
});
