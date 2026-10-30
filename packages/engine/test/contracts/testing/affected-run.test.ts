import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { afterAll, afterEach, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { removeDir, runCommand, tempDir, testGitEnv } from "../../fixtures.js";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { closeControlledRunner, commitSuiteDirectory, entryFixture, prepareSuite, installRunFailure, isolatedRunnerEnvironment, EXAMPLE, type StandIn, type Suite } from "../../fixtures/required-suite.js";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const settlementCases = coordinatorLifetimes();
afterEach(() => settlementCases.close());
afterAll(() => settlementCases.close());
async function run(workspaces: readonly Suite[], scenario: Partial<Record<Suite, StandIn>> = {}, base = "HEAD", arrange?: (root: string) => Promise<void>) {
  const root = tempDir("petrina-affected-run-"); roots.push(root);
  await prepareSuite(entryFixture(root), scenario);
  await arrange?.(root);
  for (const workspace of workspaces) {
    const folder = workspace === "desktop" ? "apps/desktop" : `packages/${workspace}`;
    appendFileSync(join(root, folder, EXAMPLE), "\n// Change this test's current input.\n");
  }
  const command = [process.execPath, join(root, "packages/engine/test/quality/affected-run.ts"), "--base", base];
  const outcome = await runCommand(command, { cwd: root, timeoutMs: 30_000,
    env: { ...testGitEnv(), GH_TOKEN: "feedback-host-account", CODEX_HOME: "feedback-host-config" },
  });
  const relative = outcome.stdout.match(/Reports: ([^\r\n]+)/)?.[1];
  if (!relative) throw new Error(`Feedback did not report its evidence: ${outcome.stderr}`);
  const report = JSON.parse(readFileSync(join(resolve(root, relative), "results.json"), "utf8"));
  const selection = JSON.parse(readFileSync(join(resolve(root, relative), "selection.json"), "utf8"));
  const ran = existsSync(join(root, "runs.log")) ? readFileSync(join(root, "runs.log"), "utf8").trim().split("\n").sort() : [];
  return { root, report, selection, ran, ...outcome };
}

for (const failure of ["none", "error"] as const) it(`retains selected feedback's environment and stops its independent peer after ${failure} settlement`, async () => {
  const root = tempDir("petrina-affected-settlement-"), lifetime = await settlementCases.open(root);
  let browsers: string | undefined;
  const close = () => closeControlledRunner(lifetime, browsers);
  await setupWithCleanup(() => lifetime.prepare(async () => {
      entryFixture(root); installRunFailure(root, failure);
      await prepareSuite(root);
      for (const workspace of ["packages/core", "apps/desktop"]) appendFileSync(join(root, workspace, EXAMPLE), "\n// Select these independent workspaces.\n");
      const child = lifetime.start(root, [join(root, "packages/engine/test/quality/affected-run.ts"), "--base", "HEAD"], isolatedRunnerEnvironment(root));
      const result = await child.completion;
      const observed = JSON.parse(readFileSync(join(root, "command-observation.json"), "utf8"));
      browsers = observed.browsers;
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(existsSync(join(root, "runs.log"))).toBe(false);
      expect(relative(root, observed.folder)).not.toStartWith("..");
      expect(observed.folder).not.toBe(root);
      expect(existsSync(observed.folder)).toBe(true);
      expect(existsSync(observed.home)).toBe(true);
      expect(existsSync(observed.browsers)).toBe(true);
      expect(result.stderr).toContain("Test command settlement was not confirmed; private files retained");
      const reported = result.stdout.match(/Reports: ([^\r\n]+)/)?.[1];
      expect(reported).toBeDefined();
      const evidence = JSON.parse(readFileSync(join(resolve(root, reported!), "results.json"), "utf8"));
      expect(evidence).toMatchObject({ kind: "affected-feedback", scope: "partial", stableInputs: true, deliveryEligible: false });
    }), close);
  await close();
  if (browsers) expect(existsSync(browsers)).toBe(false);
});

it("runs a complete short Vitest workspace with its real runner despite colliding filename filters", async () => {
  const { report, selection, code } = await run(["core"], {}, "HEAD", async root => {
    const core = join(root, "packages/core");
    const installedCore = resolve(import.meta.dir, "../../../../core");
    const vitest = dirname(Bun.resolveSync("vitest/package.json", installedCore));
    mkdirSync(join(core, "node_modules"), { recursive: true });
    fixtureFiles.directoryLink(vitest, join(core, "node_modules/vitest"));
    const packageFile = join(core, "package.json"), manifest = JSON.parse(readFileSync(packageFile, "utf8"));
    manifest.scripts.test = "bun --no-env-file vitest-entry.ts run";
    manifest.devDependencies = { vitest: JSON.parse(readFileSync(join(vitest, "package.json"), "utf8")).version };
    writeFileSync(packageFile, JSON.stringify(manifest));
    writeFileSync(join(core, "vitest-entry.ts"), `await import(${JSON.stringify(join(vitest, "vitest.mjs"))});`);
    for (const file of [EXAMPLE, EXAMPLE + "x", `test/contracts/testing/nested/${EXAMPLE}`]) {
      const path = join(core, file); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "import { expect, it } from 'vitest'; it('runs its actual assertion', () => expect(1).toBe(1));\n");
    }
    commitSuiteDirectory(root, "Private real Vitest workspace");
  });
  expect(code).toBe(0);
  expect(selection.requested).toEqual([`packages/core/${EXAMPLE}`]);
  expect(selection.selected).toHaveLength(3);
  expect(report.results).toMatchObject([{ workspace: "packages/core", counts: { tests: 3, passed: 3, failed: 0 } }]);
  expect(report.deliveryEligible).toBe(false);
});

it("executes the selected preliminary file and keeps its evidence separate from the full gate", async () => {
  const { root, report, ran, code } = await run(["core"]);
  expect(code).toBe(0); expect(ran).toEqual(["core"]);
  expect(report).toMatchObject({ kind: "affected-feedback", deliveryEligible: false, scope: "selected-complete", stableInputs: true });
  expect(report.executions).toHaveLength(1);
  expect(report.results).toMatchObject([{ workspace: "packages/core", counts: { tests: 1, passed: 1, failed: 0 } }]);
  const environment = JSON.parse(readFileSync(join(root, "environments.log"), "utf8").trim());
  expect(environment.token).toBeUndefined(); expect(environment.toolConfig).toBeUndefined();
});

it("executes selected native peers together without starting unrelated packages", async () => {
  const { report, ran, code } = await run(["engine", "storage"]);
  expect(code).toBe(0); expect(ran).toEqual(["engine", "storage"]);
  expect(report.executions).toMatchObject([{ id: "native", workspaces: ["packages/storage", "packages/engine"], code: 0 }]);
  expect(report.results).toHaveLength(2); expect(report.deliveryEligible).toBe(false);
});

it("does no work for an unchanged source without claiming validation", async () => {
  const { report, ran, code, stdout } = await run([]);
  expect(code).toBe(0); expect(ran).toEqual([]);
  expect(report).toMatchObject({ scope: "no-work", deliveryEligible: false, executions: [], results: [] });
  expect(stdout).toContain("no validation was performed");
});

it("holds selected native work after a selected preliminary failure", async () => {
  const { report, ran, code } = await run(["core", "engine"], { core: { report: "fail" } });
  expect(code).toBe(1); expect(ran).toEqual(["core"]);
  expect(report.scope).toBe("partial");
  expect(report.results).toContainEqual({ workspace: "packages/engine", executionId: "native", notRun: "core did not all pass" });
});

it("rejects a changed source even when the selected test itself passed", async () => {
  const { report, code } = await run(["core"], { core: { change: true } });
  expect(code).toBe(1); expect(report.stableInputs).toBe(false); expect(report.deliveryEligible).toBe(false);
});

it("rejects a moved commit even when the selected source bytes stay the same", async () => {
  const { report, code } = await run(["core"], { core: { moveHead: true } });
  expect(code).toBe(1); expect(report.stableInputs).toBe(false); expect(report.deliveryEligible).toBe(false);
});

for (const report of ["missing", "truncated", "running", "skipped"] as const) {
  it(`refuses ${report} selected execution as passing feedback`, async () => {
    const { report: evidence, code } = await run(["core"], { core: { report } });
    expect(code).toBe(1); expect(evidence.scope).toBe("partial"); expect(evidence.deliveryEligible).toBe(false);
  });
}

it("falls back to all registered files when the requested base cannot be read", async () => {
  const { report, ran, code } = await run([], {}, "missing-base");
  expect(code).toBe(0);
  expect(ran).toEqual(["agent-runtime", "core", "desktop", "engine", "orchestrator", "platform", "repositories", "storage", "test-support"]);
  expect(report.results).toHaveLength(9); expect(report.deliveryEligible).toBe(false);
});
