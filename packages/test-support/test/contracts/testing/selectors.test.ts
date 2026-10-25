import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../../../src/commands.js";
import { TEST_RUNNER } from "../../../src/run.js";
import { removeDir, tempDir } from "../../../src/fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function fixture() {
  const cwd = tempDir("petrina-test-selectors-"); roots.push(cwd);
  const directory = join(cwd, "test"), marker = join(cwd, "ran"); mkdirSync(directory);
  const file = join(directory, "valid.test.ts");
  writeFileSync(file, `import { it } from "bun:test"; import { writeFileSync } from "node:fs";
it("ran the selected case", () => writeFileSync(${JSON.stringify(marker)}, "ran"));`);
  return { cwd, marker, file };
}

it("rejects a missing explicit selector before a valid peer can run and hide it", async () => {
  const f = fixture();
  const result = await runCommand([process.execPath, TEST_RUNNER, f.file, "./test/missing.test.ts"], { cwd: f.cwd });
  expect(result.code).toBe(1); expect(result.stderr).toContain("No tests ran");
  expect(result.stderr).toContain("./test/missing.test.ts"); expect(existsSync(f.marker)).toBe(false);
});

it("accepts existing directories and an option's new report path without hiding the selected case", async () => {
  const f = fixture(), report = join(f.cwd, "new-report.xml");
  const result = await runCommand([process.execPath, TEST_RUNNER, "--reporter", "junit", "--reporter-outfile", report, "./test"], { cwd: f.cwd });
  expect(result.code, result.stderr).toBe(0); expect(existsSync(report)).toBe(true); expect(existsSync(f.marker)).toBe(true);
});

it("preserves Bun's bare filename filters when the matching file is inside a test directory", async () => {
  const f = fixture();
  expect(existsSync(join(f.cwd, "valid.test.ts"))).toBe(false);
  const result = await runCommand([process.execPath, TEST_RUNNER, "valid.test.ts"], { cwd: f.cwd });
  expect(result.code, result.stderr).toBe(0); expect(existsSync(f.marker)).toBe(true);
});

for (const spelling of ["split", "equals"] as const) for (const relative of [false, true]) it(`validates selectors from the ${spelling} ${relative ? "relative" : "absolute"} working directory`, async () => {
  const f = fixture(), chosen = join(f.cwd, "chosen"), cases = join(chosen, "cases"); mkdirSync(cases, { recursive: true });
  writeFileSync(join(cases, "cwd.test.ts"), `import { it } from "bun:test"; import { writeFileSync } from "node:fs";
it("uses the chosen folder", () => writeFileSync(${JSON.stringify(f.marker)}, "ran"));`);
  const requested = relative ? "chosen" : chosen;
  const args = spelling === "split" ? ["--cwd", requested] : [`--cwd=${requested}`];
  const result = await runCommand([process.execPath, TEST_RUNNER, ...args, "./cases"], { cwd: f.cwd });
  expect(result.code, result.stderr).toBe(0); expect(existsSync(f.marker)).toBe(true);
});
