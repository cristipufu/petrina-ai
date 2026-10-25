import { afterAll, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "@petrina/test-support/commands";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { TEST_RUNNER } from "@petrina/test-support/run";
import { executionTestResults, requireFiles } from "@petrina/test-support/test-results";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const failing of [false, true]) it(`the real Bun reports every native package in one normal worker pool with failure ${failing}`, async () => {
  const root = tempDir("petrina-shared-report-"); roots.push(root);
  const names = ["engine", "test-support", "storage", "platform"], cwd = join(root, "packages", "engine");
  const expected = names.map(name => `packages/${name}/test/contracts/probe/membership.test.ts`);
  for (const name of names) {
    const folder = join(root, "packages", name, "test", "contracts", "probe"); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "membership.test.ts"), `import { expect, it } from "bun:test";
it(${JSON.stringify(name)}, () => { expect(process.cwd()).toBe(${JSON.stringify(cwd)}); expect(process.env.GH_TOKEN).toBeUndefined(); expect(${JSON.stringify(name)}).not.toBe(${JSON.stringify(failing ? "storage" : "none")}); });
${name === "platform" ? 'it.skip("an explicit probe skip", () => {});' : ""}`);
  }
  const report = join(root, "native.xml");
  const result = await runCommand([process.execPath, TEST_RUNNER, "./test", "../test-support/test", "../storage/test", "../platform/test", "--reporter=junit", `--reporter-outfile=${report}`], { cwd, timeoutMs: 30_000 });
  expect(result.code, result.stderr).toBe(failing ? 1 : 0);
  const parsed = executionTestResults(readFileSync(report, "utf8"), { root, cwd, runner: "bun", workspaces: names.map(name => `packages/${name}`) });
  expect(parsed.total).toMatchObject({ tests: 5, passed: failing ? 3 : 4, failed: failing ? 1 : 0, skipped: 1 });
  requireFiles(parsed.total, expected);
  expect(parsed.workspaces.map(work => ({ name: work.workspace, tests: work.tests, failed: work.failed, skipped: work.skipped }))).toEqual(names.map(name => ({ name: `packages/${name}`, tests: name === "platform" ? 2 : 1, failed: failing && name === "storage" ? 1 : 0, skipped: name === "platform" ? 1 : 0 })));
  expect(parsed.total.failures).toEqual(failing ? [expected[2]!] : []);
});
