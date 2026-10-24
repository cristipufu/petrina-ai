import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { afterAll, expect, it } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { namedCheckFailures } from "../../../src/related-check-evidence.js";
import { git, removeDir, runCommand, tempDir, testGitEnv, waitForFile } from "../../fixtures.js";
import { sourceFacts } from "../../quality/source.js";
import { TEST_WORKSPACES } from "../../quality/workspaces.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/**
 * The packages the copied runner imports, each declared by the engine and found where the engine's own
 * install resolves it. The fixture links each one straight to that folder. A link to the engine's whole
 * node_modules reached them only through the installer's own links, and on Windows the copied runner
 * could not load its parser that way.
 */
const ENGINE = resolve(import.meta.dir, "../../..");
const QUALITY = join(ENGINE, "test", "quality");
/** The engine files the copied runner imports from outside its own folder: the tests' bounded Git path and its helpers. */
const SUPPORT = ["test/test-git-env.ts", "test/commands.ts", "src/process-tree.ts", "src/process-host.ts"];
const PACKAGES = (() => {
  const manifest = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as Record<"dependencies" | "devDependencies", Record<string, string>>;
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  const sources = [...readdirSync(QUALITY).filter(name => name.endsWith(".ts")).map(name => join(QUALITY, name)), ...SUPPORT.map(file => join(ENGINE, file))];
  const names = new Set(sources.flatMap(file => sourceFacts(readFileSync(file, "utf8"), file).imports)
    .filter(({ path, runtime }) => runtime && !path.startsWith(".") && !isBuiltin(path))
    .map(({ path }) => path.split("/").slice(0, path.startsWith("@") ? 2 : 1).join("/")));
  for (const name of names) if (!declared.has(name)) throw new Error(`The quality runner imports ${name}, which the engine package does not declare`);
  return [...names].map(name => ({ name, folder: realpathSync.native(dirname(Bun.resolveSync(`${name}/package.json`, ENGINE))) }));
})();

type Suite = "core" | "desktop" | "orchestrator" | "test-support" | "storage" | "engine";
/** A controlled workspace: its exit code, structured report, printed output, and whether it edits an input or waits for a stop signal. */
type StandIn = { code?: number; report?: "pass" | "fail" | "missing" | "truncated" | "omitted" | "counts" | "running" | "skipped"; print?: string; change?: boolean; moveHead?: boolean; hold?: boolean };
const NOT_STARTED = "core and desktop and orchestrator and test-support and storage did not all pass", INTERRUPTED = "the run was interrupted first";

/** The real root script and runner, without a repository to scan or any suites to run. */
function entryFixture(): string {
  const root = tempDir("petrina-quality-runner-"); roots.push(root);
  const quality = join(root, "packages", "engine", "test", "quality");
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  writeFileSync(join(root, "docs", "plans", "test-layer-audit.json"), JSON.stringify({ version: 1, files: [] }));
  mkdirSync(quality, { recursive: true });
  cpSync(QUALITY, quality, { recursive: true });
  for (const file of SUPPORT) {
    mkdirSync(dirname(join(root, "packages", "engine", file)), { recursive: true });
    cpSync(join(ENGINE, file), join(root, "packages", "engine", file));
  }
  for (const { name, folder } of PACKAGES) {
    const link = join(root, "packages", "engine", "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    fixtureFiles.directoryLink(folder, link);
  }
  const manifest = JSON.parse(readFileSync(join(ENGINE, "..", "..", "package.json"), "utf8"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: manifest.scripts.test } }));
  return root;
}

/** A repository whose workspace test scripts are tiny stand-ins, never another full suite. */
async function fixture(scenario: Partial<Record<Suite, StandIn>>): Promise<string> {
  const root = entryFixture();
  writeFileSync(join(root, ".gitignore"), "node_modules\n.test-results\nruns.log\nenvironments.log\nstarted*\n");
  const runner = join(root, "runner.ts");
  writeFileSync(runner, `import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const workspace = process.argv[2]!;
const stand = (${JSON.stringify(scenario)} as Record<string, { code?: number; report?: string; print?: string; change?: boolean; moveHead?: boolean; hold?: boolean }>)[workspace] ?? {};
const log = (line: string) => appendFileSync(${JSON.stringify(join(root, "runs.log"))}, line + "\\n");
log(workspace);
appendFileSync(${JSON.stringify(join(root, "environments.log"))}, JSON.stringify({ workspace, home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL, token: process.env.GH_TOKEN, toolConfig: process.env.CODEX_HOME }) + "\\n");
if (stand.print) process.stdout.write(stand.print);
const failed = stand.report === "fail";
const output = process.argv.find(arg => arg.startsWith("--outputFile=") || arg.startsWith("--reporter-outfile="))!.split("=").slice(1).join("=");
const skipped = stand.report === "skipped";
const status = failed ? "failed" : skipped ? "skipped" : stand.report === "running" ? "pending" : "passed";
let report = ["engine", "test-support", "storage"].includes(workspace)
  ? '<testsuites tests="' + (stand.report === "counts" ? 2 : 1) + '" failures="' + Number(failed) + '" skipped="' + Number(skipped) + '"><testsuite file="test/contracts/testing/example.test.ts" tests="1" failures="' + Number(failed) + '" skipped="' + Number(skipped) + '"><testcase>' + (failed ? '<failure message="controlled failure" />' : skipped ? '<skipped />' : '') + '</testcase></testsuite></testsuites>'
  : JSON.stringify({ success: !failed, numTotalTestSuites: 1, numPassedTestSuites: Number(!failed), numFailedTestSuites: Number(failed), numPendingTestSuites: 0, numTotalTests: stand.report === "counts" ? 2 : 1, numPassedTests: Number(status === "passed"), numFailedTests: Number(failed), numPendingTests: Number(skipped || status === "pending"), numTodoTests: 0, testResults: [{ name: resolve("test/contracts/testing/example.test.ts"), status: failed ? "failed" : "passed", assertionResults: [{ status }] }] });
if (stand.report === "truncated") report = report.slice(0, -5);
if (stand.report !== "missing") writeFileSync(output, report);
if (stand.change) writeFileSync("test/contracts/testing/example.test.ts", "// changed after starting");
if (stand.moveHead) {
  const child = Bun.spawn(["git", "commit", "--allow-empty", "-q", "-m", "Concurrent revision"], { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("The controlled revision could not advance");
}
if (stand.hold) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { log(workspace + " received " + signal); process.exit(signal === "SIGINT" ? 130 : 143); });
  const started = ${JSON.stringify(join(root, "started"))};
  writeFileSync(started + ".tmp", String(process.pid)); renameSync(started + ".tmp", started);
  // Never outlive a broken test by long.
  setTimeout(() => { log(workspace + " was never stopped"); process.exit(1); }, 20_000);
} else process.exit(stand.code ?? 0);`);
  for (const { path: workspace } of TEST_WORKSPACES) {
    const folder = join(root, workspace);
    mkdirSync(join(folder, "test", "contracts", "testing"), { recursive: true });
    writeFileSync(join(folder, "test", "contracts", "testing", "example.test.ts"), "// A controlled runner result, not another full suite.\n");
    if (scenario[workspace.split("/")[1] as Suite]?.report === "omitted") writeFileSync(join(folder, "test", "contracts", "testing", "omitted.test.ts"), "// The stand-in deliberately omits this required file.\n");
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: workspace, scripts: { test: `${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} ${workspace.split("/")[1]}` } }));
  }
  await git(root, "init", "-q", "-b", "main"); await git(root, "add", ".");
  await git(root, "-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "Fixture");
  return root;
}

const command = (root: string) => [process.execPath, join(root, "packages", "engine", "test", "quality", "full-run.ts")];
const environment = () => ({ ...testGitEnv(), PETRINA_TEST_BASE: "HEAD", GH_TOKEN: "fixture-host-account", CODEX_HOME: "fixture-host-tool-config" });

/** What the run recorded, with timings that vary removed. */
function recorded(root: string, stdout: string) {
  const folder = join(root, ".test-results", readdirSync(join(root, ".test-results"))[0]!);
  const report = JSON.parse(readFileSync(join(folder, "results.json"), "utf8"));
  const lines = stdout.split("\n"), summary = lines.findIndex(line => line.startsWith("Test summary"));
  return {
    ran: readFileSync(join(root, "runs.log"), "utf8"),
    environments: readFileSync(join(root, "environments.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { home: string; gitConfig: string; token?: string; toolConfig?: string }),
    report,
    outcomes: report.results.map((result: { workspace: string; code?: number; notRun?: string }) => [result.workspace, result.code ?? result.notRun]),
    summary: summary < 0 ? [] : lines.slice(summary).filter(Boolean).map(line => line.replace(/\d+\.\ds\b/g, "Ns")),
  };
}

async function run(scenario: Partial<Record<Suite, StandIn>>, expected: number) {
  const root = await fixture(scenario);
  const result = await runCommand([process.execPath, "run", "test"], { cwd: root, env: environment(), timeoutMs: 30_000 });
  const stdout = result.stdout;
  expect({ code: result.code, output: result.code === expected ? "" : `${stdout}\n${result.stderr}` }).toEqual({ code: expected, output: "" });
  return { ...recorded(root, stdout), stdout, stderr: result.stderr };
}

for (const args of [
  ["test/chosen.test.ts"],
  Array.from({ length: 6 }, (_, index) => `test/chosen-${index}.test.ts`),
  ["--watch"],
  ["-t", "chosen test"],
  ["--reporter=json"],
  ["--help", "test/chosen.test.ts"],
  ["test/chosen.test.ts", "-h"],
] as const) it(`rejects root arguments ${args.join(" ")} before scanning or writing a report`, async () => {
  const root = entryFixture();
  const result = await runCommand([process.execPath, "run", "test", ...args], { cwd: root, env: environment(), timeoutMs: 10_000 });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("The root test command does not accept file selectors or options. No tests ran.");
  expect(result.stderr).toContain("bun run --cwd packages/engine test test/rules/testing/results.test.ts");
  expect(result.stderr).not.toContain("Could not inspect test inputs");
  expect(result.stdout).toBe("");
  expect(existsSync(join(root, ".test-results"))).toBe(false);
  expect(existsSync(join(root, "runs.log"))).toBe(false);
});

for (const option of ["--help", "-h"]) it(`shows ${option} through the root script without a repository, suites or reports`, async () => {
  const root = entryFixture();
  const result = await runCommand([process.execPath, "run", "test", option], { cwd: root, env: environment(), timeoutMs: 10_000 });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("bun run --cwd packages/engine test test/rules/testing/results.test.ts");
  expect(result.stdout).toContain("Focused runs do not replace the required full check.");
  expect(result.stdout).not.toContain("Test summary:");
  expect(result.stderr).not.toContain("Could not inspect test inputs");
  expect(existsSync(join(root, ".test-results"))).toBe(false);
  expect(existsSync(join(root, "runs.log"))).toBe(false);
});

it("rejects a selector in a ready repository without launching even a stand-in suite", async () => {
  const root = await fixture({});
  const result = await runCommand([process.execPath, "run", "test", "test/chosen.test.ts"], { cwd: root, env: environment(), timeoutMs: 10_000 });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("No tests ran.");
  expect(existsSync(join(root, "runs.log"))).toBe(false);
  expect(existsSync(join(root, ".test-results"))).toBe(false);
});

for (const invalid of ["missing inventory", "new flat test", "native effect in rules"] as const) it(`rejects ${invalid} before starting a suite or producing delivery evidence`, async () => {
  const root = await fixture({});
  if (invalid === "missing inventory") unlinkSync(join(root, "docs", "plans", "test-layer-audit.json"));
  else if (invalid === "new flat test") writeFileSync(join(root, "packages", "core", "test", "unclassified.test.ts"), "// New tests need an owner");
  else {
    const folder = join(root, "packages", "core", "test", "rules", "reviews");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "status.test.ts"), "import { readFile } from 'node:fs/promises';");
  }
  const result = await runCommand([process.execPath, "run", "test"], { cwd: root, env: environment(), timeoutMs: 10_000 });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(invalid === "missing inventory" ? "missing complete" : invalid === "new flat test" ? "place tests in test/<layer>/<area>" : "real I/O belongs in contracts or journeys");
  expect(existsSync(join(root, "runs.log"))).toBe(false);
  expect(existsSync(join(root, ".test-results"))).toBe(false);
});

it("resolves the copied runner's packages from the engine's own install, never another one", async () => {
  const root = await fixture({});
  const modules = join(root, "packages", "engine", "node_modules"), copy = join(root, "packages", "engine", "test", "quality");
  expect(PACKAGES.map(({ name }) => name)).toContain("@babel/parser");
  // The copy's own package folder holds only those packages, each one link away from its installed folder,
  // rather than a link to the engine's whole install that reaches them through the installer's links.
  expect(lstatSync(modules).isSymbolicLink()).toBe(false);
  expect(readdirSync(modules).sort()).toEqual([...new Set(PACKAGES.map(({ name }) => name.split("/")[0]!))].sort());
  for (const { name, folder } of PACKAGES) {
    expect(realpathSync.native(join(modules, name))).toBe(folder);
    expect(realpathSync.native(dirname(Bun.resolveSync(`${name}/package.json`, copy)))).toBe(folder);
  }
});

it("runs every quick workspace before engine and passes only when every workspace passed", async () => {
  const { ran, report, summary, environments } = await run({}, 0);
  expect(ran).toBe("core\ndesktop\norchestrator\ntest-support\nstorage\nengine\n");
  expect({ mode: report.mode, scope: report.scope, stableInputs: report.stableInputs, interrupted: report.interrupted }).toEqual({ mode: "observation", scope: "complete", stableInputs: true, interrupted: undefined });
  expect(report.results.every((result: { ms: number; missedFailures: string[] }) => result.ms >= 0 && result.missedFailures.length === 0)).toBe(true);
  expect(summary).toEqual(["Test summary:", "  core: passed in Ns", "  desktop: passed in Ns", "  orchestrator: passed in Ns", "  test-support: passed in Ns", "  storage: passed in Ns", "  engine: passed in Ns"]);
  expect(report.source.head).toMatch(/^[a-f0-9]{40}$/);
  expect(report.source.tree).toMatch(/^[a-f0-9]{40}$/);
  expect(report.source.clean).toBe(true);
  expect(report.source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(report.environment).toEqual({ platform: process.platform, arch: process.arch, bun: Bun.version });
  for (const env of environments) {
    expect(env.home).not.toBe(process.env.HOME);
    expect(env.gitConfig).not.toBe(process.env.GIT_CONFIG_GLOBAL);
    expect(env.token).toBeUndefined();
    expect(env.toolConfig).toBeUndefined();
    expect(existsSync(env.home)).toBe(false);
    expect(existsSync(env.gitConfig)).toBe(false);
  }
});

it("includes the orchestrator in the required gate and never starts engine after its failure", async () => {
  const { ran, report, outcomes } = await run({ orchestrator: { code: 1, report: "fail" } }, 1);
  expect(ran).toBe("core\ndesktop\norchestrator\ntest-support\nstorage\n");
  expect(outcomes).toEqual([["packages/core", 0], ["apps/desktop", 0], ["packages/orchestrator", 1], ["packages/test-support", 0], ["packages/storage", 0], ["packages/engine", NOT_STARTED]]);
  expect(report.scope).toBe("partial");
  expect(report.results[2].failures).toEqual(["packages/orchestrator/test/contracts/testing/example.test.ts"]);
});

for (const workspace of ["test-support", "storage"] as const) it(`includes ${workspace}'s native contracts in the required gate before engine`, async () => {
  const { ran, report, outcomes } = await run({ [workspace]: { code: 1, report: "fail" } }, 1);
  expect(ran).toBe("core\ndesktop\norchestrator\ntest-support\nstorage\n");
  expect(outcomes).toContainEqual([`packages/${workspace}`, 1]);
  expect(outcomes.at(-1)).toEqual(["packages/engine", NOT_STARTED]);
  expect(report.results.find((entry: { workspace: string }) => entry.workspace === `packages/${workspace}`).failures)
    .toEqual([`packages/${workspace}/test/contracts/testing/example.test.ts`]);
  expect(report.scope).toBe("partial");
});

for (const [name, scenario, outcomes, lines] of [
  ["core fails", { core: { code: 1, report: "fail" } }, [1, 0], ["  core: failed after Ns; failing files: packages/core/test/contracts/testing/example.test.ts", "  desktop: passed in Ns"]],
  ["desktop fails", { desktop: { code: 1, report: "fail" } }, [0, 1], ["  core: passed in Ns", "  desktop: failed after Ns; failing files: apps/desktop/test/contracts/testing/example.test.ts"]],
  ["both quick suites fail", { core: { code: 1, report: "fail" }, desktop: { code: 1, report: "fail" } }, [1, 1], ["  core: failed after Ns; failing files: packages/core/test/contracts/testing/example.test.ts", "  desktop: failed after Ns; failing files: apps/desktop/test/contracts/testing/example.test.ts"]],
  ["core's report is missing", { core: { report: "missing" } }, [0, 0], ["  core: incomplete after Ns: its structured results were unavailable", "  desktop: passed in Ns"]],
  ["core fails without a report", { core: { code: 1, report: "missing" } }, [1, 0], ["  core: failed after Ns; no failing test file could be attributed", "  desktop: passed in Ns"]],
  ["desktop's report contradicts its exit", { desktop: { report: "fail" } }, [0, 0], ["  core: passed in Ns", "  desktop: incomplete after Ns: it exited successfully but its structured results report failures; failing files: apps/desktop/test/contracts/testing/example.test.ts"]],
] as const) it(`never starts engine when ${name}, and records it as not run`, async () => {
  const { ran, report, outcomes: recordedOutcomes, summary } = await run(scenario, 1);
  expect(ran).toBe("core\ndesktop\norchestrator\ntest-support\nstorage\n");
  expect(recordedOutcomes).toEqual([["packages/core", outcomes[0]], ["apps/desktop", outcomes[1]], ["packages/orchestrator", 0], ["packages/test-support", 0], ["packages/storage", 0], ["packages/engine", NOT_STARTED]]);
  // The unexecuted suite claims neither a pass nor an observation without misses.
  expect(report.results[5]).toEqual({ workspace: "packages/engine", notRun: NOT_STARTED });
  expect(report.scope).toBe("partial");
  expect(summary).toEqual(["Test summary: engine did not run, so this run cannot pass and its affected-test observation covers only the suites that ran.", ...lines, "  orchestrator: passed in Ns", "  test-support: passed in Ns", "  storage: passed in Ns", "  engine: not run, because core and desktop and orchestrator and test-support and storage did not all pass"]);
  // Unavailable attribution never invents a failed test.
  if (name.includes("missing") || name.includes("without")) expect(report.results[0].failures).toBeUndefined();
});

for (const [name, scenario, engine] of [
  ["engine fails", { engine: { code: 1, report: "fail" } }, "  engine: failed after Ns; failing files: packages/engine/test/contracts/testing/example.test.ts"],
  ["engine's report is missing", { engine: { report: "missing" } }, "  engine: incomplete after Ns: its structured results were unavailable"],
  ["engine's report contradicts its exit", { engine: { report: "fail" } }, "  engine: incomplete after Ns: it exited successfully but its structured results report failures; failing files: packages/engine/test/contracts/testing/example.test.ts"],
] as const) it(`runs every workspace and fails honestly when ${name}`, async () => {
  const { ran, report, summary } = await run(scenario, 1);
  expect(ran).toBe("core\ndesktop\norchestrator\ntest-support\nstorage\nengine\n");
  expect(report.scope).toBe(name === "engine's report is missing" ? "partial" : "complete");
  expect(summary).toEqual(["Test summary:", "  core: passed in Ns", "  desktop: passed in Ns", "  orchestrator: passed in Ns", "  test-support: passed in Ns", "  storage: passed in Ns", engine]);
  if (name === "engine fails") expect(report.results[5].missedFailures).toEqual(["packages/engine/test/contracts/testing/example.test.ts"]);
});

for (const workspace of ["core", "desktop", "orchestrator", "engine"] as const) for (const report of ["truncated", "omitted", "counts", "skipped"] as const) it(`rejects ${workspace}'s ${report} report even after a zero exit code`, async () => {
  const { ran, report: result, stderr } = await run({ [workspace]: { report } }, 1);
  expect(result.scope).toBe("partial");
  expect(stderr).toContain("Incomplete test evidence");
  const invalid = result.results.find((entry: { workspace: string }) => entry.workspace.endsWith(`/${workspace}`));
  expect(invalid.code).toBe(0);
  expect(invalid.reportComplete).toBeUndefined();
  expect(invalid.error).toBeTruthy();
  expect(ran).toBe(workspace === "engine" ? "core\ndesktop\norchestrator\ntest-support\nstorage\nengine\n" : "core\ndesktop\norchestrator\ntest-support\nstorage\n");
  if (report === "omitted") {
    expect(invalid.error).toContain("omitted.test.ts");
    expect(invalid.failures).toEqual([]);
  }
});

it("rejects Vitest cases still running when the report was written", async () => {
  const { report, stderr } = await run({ core: { report: "running" } }, 1);
  expect(report.scope).toBe("partial");
  expect(stderr).toContain("Unfinished or unknown Vitest test outcome: pending");
});

it("compares inputs once at the end: a change during core still runs every workspace and cannot pass", async () => {
  const { ran, report, stderr } = await run({ core: { change: true } }, 1);
  expect(ran).toBe("core\ndesktop\norchestrator\ntest-support\nstorage\nengine\n");
  expect({ scope: report.scope, stableInputs: report.stableInputs }).toEqual({ scope: "complete", stableInputs: false });
  expect(stderr).toContain("Test inputs changed during the run, or the checkout revision moved. Results cannot authorize delivery.");
});

it("cannot authorize a different commit even when a concurrent commit preserves every input byte", async () => {
  const { report, stderr } = await run({ core: { moveHead: true } }, 1);
  expect({ scope: report.scope, stableInputs: report.stableInputs }).toEqual({ scope: "complete", stableInputs: false });
  expect(stderr).toContain("checkout revision moved");
});

it("keeps core's real failure as the diagnostic when noisy desktop output follows", async () => {
  const failure = "(fail) greeting > shows the registered name\nerror: expected \"Run tests\" but received \"run_tests\"\n";
  const { stdout, report, summary } = await run({ core: { code: 1, report: "fail", print: failure }, desktop: { print: "✓ a passing desktop case\n".repeat(2000) } }, 1);
  expect(stdout.indexOf(failure)).toBeGreaterThanOrEqual(0);
  expect(stdout.indexOf(failure)).toBeLessThan(stdout.indexOf("✓ a passing desktop case"));
  expect(report.results[0].failures).toEqual(["packages/core/test/contracts/testing/example.test.ts"]);
  // The closing summary names the failing file but adds no failure marker or test name of its own.
  expect(namedCheckFailures(stdout)).toEqual([{ name: "greeting > shows the registered name" }]);
  expect(namedCheckFailures(summary.join("\n"))).toEqual([]);
  expect(summary[1]).toBe("  core: failed after Ns; failing files: packages/core/test/contracts/testing/example.test.ts");
});

// Windows has no gentle stop signal one process can send another.
for (const [signal, code, scenario, ran] of [
  ["SIGTERM", 143, { core: { hold: true } }, "core\ncore received SIGTERM\n"],
  ["SIGINT", 130, { core: { code: 1, report: "fail" }, desktop: { hold: true } }, "core\ndesktop\ndesktop received SIGINT\n"],
] as const) it.skipIf(process.platform === "win32")(`passes a gentle ${signal} to the running suite, stops it and starts nothing later`, async () => {
  const root = await fixture(scenario);
  const runner = Bun.spawn(command(root), { cwd: root, env: environment(), stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" });
  const stdout = new Response(runner.stdout).text();
  await waitForFile(join(root, "started"), 20_000);
  const pid = Number(readFileSync(join(root, "started"), "utf8"));
  runner.kill(signal);
  expect(await runner.exited).toBe(code);
  const { ran: recordedRuns, report, outcomes, summary } = recorded(root, await stdout);
  expect(recordedRuns).toBe(ran);
  // The suite's own process has ended before the runner reports.
  expect(() => process.kill(pid, 0)).toThrow();
  expect({ interrupted: report.interrupted, scope: report.scope }).toEqual({ interrupted: code, scope: "partial" });
  expect(outcomes.slice(signal === "SIGTERM" ? 1 : 2)).toEqual(signal === "SIGTERM"
    ? [["apps/desktop", INTERRUPTED], ["packages/orchestrator", INTERRUPTED], ["packages/test-support", INTERRUPTED], ["packages/storage", INTERRUPTED], ["packages/engine", INTERRUPTED]]
    : [["packages/orchestrator", INTERRUPTED], ["packages/test-support", INTERRUPTED], ["packages/storage", INTERRUPTED], ["packages/engine", INTERRUPTED]]);
  expect(summary).toEqual([]);
});
