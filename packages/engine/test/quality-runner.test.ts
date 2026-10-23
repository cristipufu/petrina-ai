import { afterAll, expect, it } from "bun:test";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { namedCheckFailures } from "../src/related-check-evidence.js";
import { git, removeDir, tempDir, testGitEnv, waitForFile } from "./fixtures.js";
import { sourceFacts } from "./quality/source.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/**
 * The packages the copied runner imports, each declared by the engine and found where the engine's own
 * install resolves it. The fixture links each one straight to that folder. A link to the engine's whole
 * node_modules reached them only through the installer's own links, and on Windows the copied runner
 * could not load its parser that way.
 */
const ENGINE = join(import.meta.dir, "..");
const PACKAGES = (() => {
  const manifest = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as Record<"dependencies" | "devDependencies", Record<string, string>>;
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  const sources = [...readdirSync(join(import.meta.dir, "quality")).filter(name => name.endsWith(".ts")).map(name => join(import.meta.dir, "quality", name)), join(import.meta.dir, "test-git-env.ts")];
  const names = new Set(sources.flatMap(file => sourceFacts(readFileSync(file, "utf8"), file).imports)
    .filter(({ path, runtime }) => runtime && !path.startsWith(".") && !isBuiltin(path))
    .map(({ path }) => path.split("/").slice(0, path.startsWith("@") ? 2 : 1).join("/")));
  for (const name of names) if (!declared.has(name)) throw new Error(`The quality runner imports ${name}, which the engine package does not declare`);
  return [...names].map(name => ({ name, folder: realpathSync.native(dirname(Bun.resolveSync(`${name}/package.json`, ENGINE))) }));
})();

type Suite = "core" | "desktop" | "engine";
/** A controlled workspace: its exit code, structured report, printed output, and whether it edits an input or waits for a stop signal. */
type StandIn = { code?: number; report?: "pass" | "fail" | "missing"; print?: string; change?: boolean; hold?: boolean };
const NOT_STARTED = "core and desktop did not both pass", INTERRUPTED = "the run was interrupted first";

/** A repository whose workspace test scripts are tiny stand-ins, never another full suite. */
function fixture(scenario: Partial<Record<Suite, StandIn>>): string {
  const root = tempDir("petrina-quality-runner-"); roots.push(root);
  const quality = join(root, "packages", "engine", "test", "quality");
  mkdirSync(quality, { recursive: true });
  cpSync(join(import.meta.dir, "quality"), quality, { recursive: true });
  cpSync(join(import.meta.dir, "test-git-env.ts"), join(root, "packages", "engine", "test", "test-git-env.ts"));
  for (const { name, folder } of PACKAGES) {
    const link = join(root, "packages", "engine", "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(folder, link, process.platform === "win32" ? "junction" : "dir");
  }
  writeFileSync(join(root, ".gitignore"), "node_modules\n.test-results\nruns.log\nstarted*\n");
  const runner = join(root, "runner.ts");
  writeFileSync(runner, `import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const workspace = process.argv[2]!;
const stand = (${JSON.stringify(scenario)} as Record<string, { code?: number; report?: string; print?: string; change?: boolean; hold?: boolean }>)[workspace] ?? {};
const log = (line: string) => appendFileSync(${JSON.stringify(join(root, "runs.log"))}, line + "\\n");
log(workspace);
if (stand.print) process.stdout.write(stand.print);
const failed = stand.report === "fail";
const output = process.argv.find(arg => arg.startsWith("--outputFile=") || arg.startsWith("--reporter-outfile="))!.split("=").slice(1).join("=");
if (stand.report !== "missing") writeFileSync(output, workspace === "engine" ? '<testsuites tests="1"><testsuite file="test/example.test.ts" failures="' + (failed ? 1 : 0) + '"><testcase /></testsuite></testsuites>' : JSON.stringify({ success: !failed, testResults: [{ name: resolve("test/example.test.ts"), status: failed ? "failed" : "passed" }] }));
if (stand.change) writeFileSync("test/example.test.ts", "// changed after starting");
if (stand.hold) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { log(workspace + " received " + signal); process.exit(signal === "SIGINT" ? 130 : 143); });
  const started = ${JSON.stringify(join(root, "started"))};
  writeFileSync(started + ".tmp", String(process.pid)); renameSync(started + ".tmp", started);
  // Never outlive a broken test by long.
  setTimeout(() => { log(workspace + " was never stopped"); process.exit(1); }, 20_000);
} else process.exit(stand.code ?? 0);`);
  for (const workspace of ["packages/core", "packages/engine", "apps/desktop"]) {
    const folder = join(root, workspace);
    mkdirSync(join(folder, "test"), { recursive: true });
    writeFileSync(join(folder, "test", "example.test.ts"), "// A controlled runner result, not another full suite.\n");
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: workspace, scripts: { test: `${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} ${workspace.split("/")[1]}` } }));
  }
  git(root, "init", "-q", "-b", "main"); git(root, "add", ".");
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "Fixture");
  return root;
}

const command = (root: string) => [process.execPath, join(root, "packages", "engine", "test", "quality", "full-run.ts")];
const environment = () => ({ ...testGitEnv(), PETRINA_TEST_BASE: "HEAD" });

/** What the run recorded, with timings that vary removed. */
function recorded(root: string, stdout: string) {
  const folder = join(root, ".test-results", readdirSync(join(root, ".test-results"))[0]!);
  const report = JSON.parse(readFileSync(join(folder, "results.json"), "utf8"));
  const lines = stdout.split("\n"), summary = lines.findIndex(line => line.startsWith("Test summary"));
  return {
    ran: readFileSync(join(root, "runs.log"), "utf8"),
    report,
    outcomes: report.results.map((result: { workspace: string; code?: number; notRun?: string }) => [result.workspace, result.code ?? result.notRun]),
    summary: summary < 0 ? [] : lines.slice(summary).filter(Boolean).map(line => line.replace(/\d+\.\ds\b/g, "Ns")),
  };
}

function run(scenario: Partial<Record<Suite, StandIn>>, expected: number) {
  const root = fixture(scenario);
  const result = Bun.spawnSync(command(root), { cwd: root, env: environment(), stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const stdout = result.stdout.toString();
  expect({ code: result.exitCode, output: result.exitCode === expected ? "" : `${stdout}\n${result.stderr.toString()}` }).toEqual({ code: expected, output: "" });
  return { ...recorded(root, stdout), stdout, stderr: result.stderr.toString() };
}

it("resolves the copied runner's packages from the engine's own install, never another one", () => {
  const root = fixture({});
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

it("runs core and desktop before engine and passes only when every workspace passed", () => {
  const { ran, report, summary } = run({}, 0);
  expect(ran).toBe("core\ndesktop\nengine\n");
  expect({ mode: report.mode, scope: report.scope, stableInputs: report.stableInputs, interrupted: report.interrupted }).toEqual({ mode: "observation", scope: "complete", stableInputs: true, interrupted: undefined });
  expect(report.results.every((result: { ms: number; missedFailures: string[] }) => result.ms >= 0 && result.missedFailures.length === 0)).toBe(true);
  expect(summary).toEqual(["Test summary:", "  core: passed in Ns", "  desktop: passed in Ns", "  engine: passed in Ns"]);
});

for (const [name, scenario, outcomes, lines] of [
  ["core fails", { core: { code: 1, report: "fail" } }, [1, 0], ["  core: failed after Ns; failing files: packages/core/test/example.test.ts", "  desktop: passed in Ns"]],
  ["desktop fails", { desktop: { code: 1, report: "fail" } }, [0, 1], ["  core: passed in Ns", "  desktop: failed after Ns; failing files: apps/desktop/test/example.test.ts"]],
  ["both quick suites fail", { core: { code: 1, report: "fail" }, desktop: { code: 1, report: "fail" } }, [1, 1], ["  core: failed after Ns; failing files: packages/core/test/example.test.ts", "  desktop: failed after Ns; failing files: apps/desktop/test/example.test.ts"]],
  ["core's report is missing", { core: { report: "missing" } }, [0, 0], ["  core: incomplete after Ns: its structured results were unavailable", "  desktop: passed in Ns"]],
  ["core fails without a report", { core: { code: 1, report: "missing" } }, [1, 0], ["  core: failed after Ns; no failing test file could be attributed", "  desktop: passed in Ns"]],
  ["desktop's report contradicts its exit", { desktop: { report: "fail" } }, [0, 0], ["  core: passed in Ns", "  desktop: incomplete after Ns: it exited successfully but its structured results report failures; failing files: apps/desktop/test/example.test.ts"]],
] as const) it(`never starts engine when ${name}, and records it as not run`, () => {
  const { ran, report, outcomes: recordedOutcomes, summary } = run(scenario, 1);
  expect(ran).toBe("core\ndesktop\n");
  expect(recordedOutcomes).toEqual([["packages/core", outcomes[0]], ["apps/desktop", outcomes[1]], ["packages/engine", NOT_STARTED]]);
  // The unexecuted suite claims neither a pass nor an observation without misses.
  expect(report.results[2]).toEqual({ workspace: "packages/engine", notRun: NOT_STARTED });
  expect(report.scope).toBe("partial");
  expect(summary).toEqual(["Test summary: engine did not run, so this run cannot pass and its affected-test observation covers only the suites that ran.", ...lines, "  engine: not run, because core and desktop did not both pass"]);
  // Unavailable attribution never invents a failed test.
  if (name.includes("missing") || name.includes("without")) expect(report.results[0].failures).toBeUndefined();
});

for (const [name, scenario, engine] of [
  ["engine fails", { engine: { code: 1, report: "fail" } }, "  engine: failed after Ns; failing files: packages/engine/test/example.test.ts"],
  ["engine's report is missing", { engine: { report: "missing" } }, "  engine: incomplete after Ns: its structured results were unavailable"],
  ["engine's report contradicts its exit", { engine: { report: "fail" } }, "  engine: incomplete after Ns: it exited successfully but its structured results report failures; failing files: packages/engine/test/example.test.ts"],
] as const) it(`runs every workspace and fails honestly when ${name}`, () => {
  const { ran, report, summary } = run(scenario, 1);
  expect(ran).toBe("core\ndesktop\nengine\n");
  expect(report.scope).toBe("complete");
  expect(summary).toEqual(["Test summary:", "  core: passed in Ns", "  desktop: passed in Ns", engine]);
  if (name === "engine fails") expect(report.results[2].missedFailures).toEqual(["packages/engine/test/example.test.ts"]);
});

it("compares inputs once at the end: a change during core still runs every workspace and cannot pass", () => {
  const { ran, report, stderr } = run({ core: { change: true } }, 1);
  expect(ran).toBe("core\ndesktop\nengine\n");
  expect({ scope: report.scope, stableInputs: report.stableInputs }).toEqual({ scope: "complete", stableInputs: false });
  expect(stderr).toContain("Test inputs changed during the run. Results cannot authorize delivery.");
});

it("keeps core's real failure as the diagnostic when noisy desktop output follows", () => {
  const failure = "(fail) greeting > shows the registered name\nerror: expected \"Run tests\" but received \"run_tests\"\n";
  const { stdout, report, summary } = run({ core: { code: 1, report: "fail", print: failure }, desktop: { print: "✓ a passing desktop case\n".repeat(2000) } }, 1);
  expect(stdout.indexOf(failure)).toBeGreaterThanOrEqual(0);
  expect(stdout.indexOf(failure)).toBeLessThan(stdout.indexOf("✓ a passing desktop case"));
  expect(report.results[0].failures).toEqual(["packages/core/test/example.test.ts"]);
  // The closing summary names the failing file but adds no failure marker or test name of its own.
  expect(namedCheckFailures(stdout)).toEqual([{ name: "greeting > shows the registered name" }]);
  expect(namedCheckFailures(summary.join("\n"))).toEqual([]);
  expect(summary[1]).toBe("  core: failed after Ns; failing files: packages/core/test/example.test.ts");
});

// Windows has no gentle stop signal one process can send another.
for (const [signal, code, scenario, ran] of [
  ["SIGTERM", 143, { core: { hold: true } }, "core\ncore received SIGTERM\n"],
  ["SIGINT", 130, { core: { code: 1, report: "fail" }, desktop: { hold: true } }, "core\ndesktop\ndesktop received SIGINT\n"],
] as const) it.skipIf(process.platform === "win32")(`passes a gentle ${signal} to the running suite, stops it and starts nothing later`, async () => {
  const root = fixture(scenario);
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
  expect(outcomes.slice(signal === "SIGTERM" ? 1 : 2)).toEqual(signal === "SIGTERM" ? [["apps/desktop", INTERRUPTED], ["packages/engine", INTERRUPTED]] : [["packages/engine", INTERRUPTED]]);
  expect(summary).toEqual([]);
});
