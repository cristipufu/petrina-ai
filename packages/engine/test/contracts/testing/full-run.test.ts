import { afterAll, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { namedCheckFailures } from "../../../src/related-check-evidence.js";
import { removeDir, runCommand, tempDir, testGitEnv, waitForFile } from "../../fixtures.js";
import { TEST_WORKSPACES } from "../../quality/workspaces.js";
import { CommandFailure, type Started } from "@petrina/test-support/commands";
import { entryFixture as prepareEntry, prepareSuite, PACKAGES, EXAMPLE, NOT_STARTED, type Suite, type StandIn } from "../../fixtures/required-suite.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

function entryFixture(): string {
  const root = tempDir("petrina-quality-runner-"); roots.push(root);
  return prepareEntry(root);
}
const fixture = (scenario: Partial<Record<Suite, StandIn>> = {}) => prepareSuite(entryFixture(), scenario);
const command = (root: string) => [process.execPath, join(root, "packages", "engine", "test", "quality", "full-run.ts")];
const environment = () => ({ ...testGitEnv(), PETRINA_TEST_BASE: "HEAD", GH_TOKEN: "fixture-host-account", CODEX_HOME: "fixture-host-tool-config" });
function recorded(root: string, stdout: string) {
  const reported = stdout.match(/Reports: ([^\r\n]+)/)?.[1];
  if (!reported) throw new Error("The runner did not identify its evidence folder");
  const folder = resolve(root, reported), report = JSON.parse(readFileSync(join(folder, "results.json"), "utf8"));
  const ran = readFileSync(join(root, "runs.log"), "utf8").trim().split("\n");
  const lines = stdout.split("\n"), summaryAt = lines.findIndex(line => line.startsWith("Test summary"));
  return { folder, report, ran, summary: summaryAt < 0 ? [] : lines.slice(summaryAt).filter(Boolean),
    environments: readFileSync(join(root, "environments.log"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
}
async function run(scenario: Partial<Record<Suite, StandIn>>, expected: number) {
  const root = await fixture(scenario);
  const result = await runCommand(command(root), { cwd: root, env: environment(), timeoutMs: 30_000 });
  expect(result.code, result.stdout + result.stderr).toBe(expected);
  return { root, ...recorded(root, result.stdout), ...result };
}
function expectRuns(ran: string[], native: boolean) {
  expect(ran.slice(0, 3)).toEqual(["core", "desktop", "orchestrator"]);
  expect(ran.slice(3).sort()).toEqual(native ? ["agent-runtime", "engine", "platform", "repositories", "storage", "test-support"] : []);
}

for (const args of [["test/chosen.test.ts"], ["--watch"], ["-t", "chosen"], ["--reporter=json"], ["--help", "chosen"], ["chosen", "-h"]]) it(`rejects root arguments before any repository scan: ${args.join(" ")}`, async () => {
  const root = entryFixture(), result = await runCommand([...command(root), ...args], { cwd: root, env: environment() });
  expect(result.code).toBe(1); expect(result.stderr).toContain("No tests ran.");
  expect(result.stderr).toContain("test/contracts/testing/execution-results.test.ts");
  expect(result.stderr).not.toContain("Could not inspect test inputs"); expect(result.stdout).toBe("");
  expect(existsSync(join(root, ".test-results"))).toBe(false); expect(existsSync(join(root, "runs.log"))).toBe(false);
});
for (const option of ["--help", "-h"]) it(`shows ${option} without suites, a repository or reports`, async () => {
  const root = entryFixture(), result = await runCommand([...command(root), option], { cwd: root, env: environment() });
  expect(result.code).toBe(0); expect(result.stdout).toContain("Focused runs do not replace the required full check.");
  expect(result.stdout).toContain("test/contracts/testing/execution-results.test.ts"); expect(result.stdout).not.toContain("Test summary:");
  expect(result.stderr).not.toContain("Could not inspect test inputs"); expect(existsSync(join(root, ".test-results"))).toBe(false);
});
it("also refuses selectors in a ready repository before starting a suite", async () => {
  const root = await fixture(), result = await runCommand([...command(root), "test/chosen.test.ts"], { cwd: root, env: environment() });
  expect(result.code).toBe(1); expect(result.stderr).toContain("No tests ran.");
  expect(existsSync(join(root, "runs.log"))).toBe(false); expect(existsSync(join(root, ".test-results"))).toBe(false);
});
for (const invalid of ["missing inventory", "new flat test", "native effect in rules", "custom native command"]) it(`rejects ${invalid} before producing delivery evidence`, async () => {
  const root = await fixture();
  if (invalid === "missing inventory") unlinkSync(join(root, "docs", "plans", "test-layer-audit.json"));
  else if (invalid === "new flat test") writeFileSync(join(root, "packages", "core", "test", "unclassified.test.ts"), "// Missing owner");
  else if (invalid === "custom native command") writeFileSync(join(root, "packages", "storage", "package.json"), JSON.stringify({ scripts: { test: "bun preparation.ts" } }));
  else {
    const folder = join(root, "packages", "core", "test", "rules", "reviews"); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "status.test.ts"), "import { readFile } from 'node:fs/promises';");
  }
  const result = await runCommand(command(root), { cwd: root, env: environment() });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(invalid === "missing inventory" ? "missing complete" : invalid === "new flat test" ? "place tests in test/<layer>/<area>" : invalid === "custom native command" ? "shared native suite requires" : "real I/O belongs in contracts or journeys");
  expect(existsSync(join(root, "runs.log"))).toBe(false); expect(existsSync(join(root, ".test-results"))).toBe(false);
});
it("resolves the copied runner's dependencies from the engine's own install", async () => {
  const root = await fixture(), modules = join(root, "packages", "engine", "node_modules"), copy = join(root, "packages", "engine", "test", "quality");
  expect(PACKAGES.map(({ name }) => name)).toContain("@babel/parser"); expect(lstatSync(modules).isSymbolicLink()).toBe(false);
  expect(readdirSync(modules).sort()).toEqual([...new Set(PACKAGES.map(({ name }) => name.split("/")[0]!))].sort());
  for (const { name, folder } of PACKAGES) {
    expect(realpathSync.native(join(modules, name))).toBe(folder);
    expect(realpathSync.native(dirname(Bun.resolveSync(`${name}/package.json`, copy)))).toBe(folder);
  }
});
it("runs every package with one native execution, complete manifests and a private environment", async () => {
  const { ran, report, summary, environments } = await run({}, 0); expectRuns(ran, true);
  expect({ mode: report.mode, scope: report.scope, stableInputs: report.stableInputs, interrupted: report.interrupted }).toEqual({ mode: "observation", scope: "complete", stableInputs: true, interrupted: undefined });
  expect(report.executions.map((execution: { id: string }) => execution.id)).toEqual(["packages/core", "apps/desktop", "packages/orchestrator", "native"]);
  expect(report.results.map((work: { workspace: string }) => work.workspace)).toEqual(TEST_WORKSPACES.map(workspace => workspace.path));
  for (const work of report.results) {
    expect(work.reportComplete).toBe(true); expect(work.missedFailures).toEqual([]); expect(work.counts.passed).toBe(1);
    expect(work).not.toHaveProperty("ms"); expect(work).not.toHaveProperty("code");
  }
  expect(summary.filter(line => line.startsWith("  "))).toEqual(TEST_WORKSPACES.map(workspace => `  ${workspace.path.split("/").at(-1)}: passed`));
  expect(report.source.head).toMatch(/^[a-f0-9]{40}$/); expect(report.source.tree).toMatch(/^[a-f0-9]{40}$/);
  expect(report.source.clean).toBe(true); expect(report.source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(report.environment).toEqual({ platform: process.platform, arch: process.arch, bun: Bun.version });
  for (const env of environments) {
    expect(env.home).not.toBe(process.env.HOME); expect(env.gitConfig).not.toBe(process.env.GIT_CONFIG_GLOBAL);
    expect(env.token).toBeUndefined(); expect(env.toolConfig).toBeUndefined();
    expect(existsSync(env.home)).toBe(false); expect(existsSync(env.gitConfig)).toBe(false);
  }
});
for (const scenario of [{ orchestrator: { report: "fail", code: 1 } }, { core: { report: "fail", code: 1 }, desktop: { report: "fail", code: 1 } }, { core: { report: "missing" } }, { desktop: { report: "fail" } }] satisfies Partial<Record<Suite, StandIn>>[]) it(`runs independent preliminary work and gates the whole native group: ${JSON.stringify(scenario)}`, async () => {
  const { ran, report } = await run(scenario, 1); expectRuns(ran, false); expect(report.scope).toBe("partial");
  expect(report.executions.at(-1)).toEqual({ id: "native", workspaces: ["packages/test-support", "packages/storage", "packages/platform", "packages/agent-runtime", "packages/repositories", "packages/engine"], notRun: NOT_STARTED });
  for (const work of report.results.slice(3)) expect(work).toEqual({ workspace: work.workspace, executionId: "native", notRun: NOT_STARTED });
});
for (const name of ["test-support", "storage", "platform", "agent-runtime", "repositories", "engine"] as const) it(`attributes a genuine ${name} failure without blaming its passing peers`, async () => {
  const { ran, report, summary } = await run({ [name]: { report: "fail" } }, 1); expectRuns(ran, true); expect(report.scope).toBe("complete");
  expect(report.executions.at(-1)).toMatchObject({ id: "native", code: 1 });
  for (const work of report.results.slice(3)) {
    const failed = work.workspace.endsWith(`/${name}`);
    expect(work.counts.failed).toBe(Number(failed)); expect(work.failures).toEqual(failed ? [`${work.workspace}/${EXAMPLE}`] : []);
    expect(work.missedFailures).toEqual(failed ? [`${work.workspace}/${EXAMPLE}`] : []);
    expect(summary).toContain(`  ${work.workspace.split("/").at(-1)}: ${failed ? `failed; failing files: ${work.workspace}/${EXAMPLE}` : "passed"}`);
  }
});
for (const report of ["truncated", "omitted", "counts", "skipped", "running"] as const) it(`rejects incomplete preliminary ${report} evidence before native execution`, async () => {
  const { ran, report: saved, stderr } = await run({ core: { report } }, 1); expectRuns(ran, false);
  expect(saved.scope).toBe("partial"); expect(stderr).toContain("Incomplete test evidence");
  expect(saved.results[0].reportComplete).toBeUndefined(); expect(saved.results[0].error).toBeTruthy();
});
for (const report of ["skipped", "omitted"] as const) it(`rejects native ${report} evidence despite a zero native exit`, async () => {
  const { report: saved, stderr } = await run({ engine: { report } }, 1);
  expect(saved.executions.at(-1)).toMatchObject({ id: "native", code: 0 });
  expect(saved.scope).toBe("partial"); expect(stderr).toContain("Incomplete test evidence");
  expect(saved.results.find((work: { workspace: string }) => work.workspace === "packages/engine").reportComplete).toBeUndefined();
});
for (const change of ["change", "moveHead"] as const) it(`cannot authorize delivery after concurrent ${change}`, async () => {
  const { root, ran, report, stderr } = await run({ core: { [change]: true } }, 1); expectRuns(ran, true);
  expect({ scope: report.scope, stableInputs: report.stableInputs }).toEqual({ scope: "complete", stableInputs: false });
  expect(stderr).toContain("checkout revision moved"); expect(existsSync(join(root, ".test-results", "timings"))).toBe(false);
});
it("preserves the actual failed check diagnostic despite noisy later output", async () => {
  const failure = '(fail) greeting > shows the registered name\nerror: expected "Run tests" but received "run_tests"\n';
  const { stdout, report, summary } = await run({ core: { code: 1, report: "fail", print: failure }, desktop: { print: "✓ passing case\n".repeat(2000) } }, 1);
  expect(stdout.indexOf(failure)).toBeGreaterThanOrEqual(0); expect(stdout.indexOf(failure)).toBeLessThan(stdout.indexOf("✓ passing case"));
  expect(report.results[0].failures).toEqual([`packages/core/${EXAMPLE}`]);
  expect(namedCheckFailures(stdout)).toEqual([{ name: "greeting > shows the registered name" }]); expect(namedCheckFailures(summary.join("\n"))).toEqual([]);
});
for (const [signal, code, scenario] of [["SIGTERM", 143, { core: { hold: true } }], ["SIGINT", 130, { desktop: { hold: true } }], ["SIGTERM", 143, { engine: { hold: true } }]] as const) it.skipIf(process.platform === "win32")(`owns a real ${signal} interruption of ${JSON.stringify(scenario)} through settlement`, async () => {
  const root = await fixture(scenario), controller = new AbortController(); let runner: Started | undefined;
  const running = runCommand(command(root), { cwd: root, env: environment(), timeoutMs: 30_000, signal: controller.signal,
    start: (args, options) => runner = Bun.spawn(args, { ...options, stdout: "pipe", stderr: "pipe", windowsHide: true }) as unknown as Started,
  });
  const settled = running.then(result => ({ result }), (error: unknown) => ({ error }));
  try {
    await waitForFile(join(root, "started"), { timeoutMs: 20_000, during: running });
    const pid = Number(readFileSync(join(root, "started"), "utf8")); runner!.kill(signal);
    const result = await running; expect(result.code, result.stderr).toBe(code);
    const { report, summary } = recorded(root, result.stdout);
    expect(() => process.kill(pid, 0)).toThrow(); expect(report.interrupted).toBe(code); expect(report.scope).toBe("partial"); expect(summary).toEqual([]);
    expect(existsSync(join(root, ".test-results", "timings"))).toBe(false);
    if (!("engine" in scenario)) expect(report.executions.at(-1)).toHaveProperty("notRun", "the run was interrupted first");
  } finally {
    controller.abort(); const stopped = await settled;
    if ("error" in stopped && stopped.error instanceof CommandFailure && stopped.error.cleanup === "unconfirmed") throw stopped.error;
  }
});
it("reuses the exact shared timing seed without omitting any native package", async () => {
  const root = await fixture(), first = await runCommand(command(root), { cwd: root, env: environment() });
  expect(first.code, first.stderr).toBe(0);
  const cache = join(root, ".test-results", "timings", "native.json"), body = readFileSync(cache, "utf8");
  expect(Object.keys(JSON.parse(body).files)).toHaveLength(6);
  const second = await runCommand(command(root), { cwd: root, env: environment() }); expect(second.code, second.stderr).toBe(0);
  const { report } = recorded(root, second.stdout), execution = report.executions.at(-1);
  expect(execution.durationHints).toMatchObject({ kind: "used", files: 6 }); expect(report.scope).toBe("complete"); expect(report.stableInputs).toBe(true);
  expect(readFileSync(join(root, execution.durationHints.artifact), "utf8")).toBe(body);
});
for (const report of ["fail", "skipped"] as const) it(`does not publish timing hints after native ${report} evidence`, async () => {
  const root = await fixture({ engine: { report } }), folder = join(root, ".test-results", "timings"); mkdirSync(folder, { recursive: true });
  const file = join(folder, "native.json"), body = JSON.stringify({ version: 1, files: { [EXAMPLE]: 12 } }); writeFileSync(file, body);
  const result = await runCommand(command(root), { cwd: root, env: environment() }); expect(result.code, result.stderr).toBe(1);
  expect(readFileSync(file, "utf8")).toBe(body);
});
