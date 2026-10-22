import { afterAll, expect, it } from "bun:test";
import { cpSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, removeDir, tempDir, testGitEnv } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const scenario of ["pass", "fail", "changed-inputs", "missing-report", "contradictory-report"] as const) it(`the required runner executes every workspace and reports ${scenario} honestly`, () => {
  const root = tempDir("petrina-quality-runner-"); roots.push(root);
  const quality = join(root, "packages", "engine", "test", "quality");
  mkdirSync(quality, { recursive: true });
  cpSync(join(import.meta.dir, "quality"), quality, { recursive: true });
  cpSync(join(import.meta.dir, "test-git-env.ts"), join(root, "packages", "engine", "test", "test-git-env.ts"));
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(root, "packages", "engine", "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules\n.test-results\nruns.log\n");
  const runner = join(root, "runner.ts");
  writeFileSync(runner, `import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const workspace = process.argv[2];
appendFileSync(${JSON.stringify(join(root, "runs.log"))}, workspace + "\\n");
const failed = ["fail", "contradictory-report"].includes(${JSON.stringify(scenario)}) && workspace === "engine";
const output = process.argv.find(arg => arg.startsWith("--outputFile=") || arg.startsWith("--reporter-outfile="))!.split("=").slice(1).join("=");
if (!(${JSON.stringify(scenario)} === "missing-report" && workspace === "engine")) writeFileSync(output, workspace === "engine" ? '<testsuites tests="1"><testsuite file="test/example.test.ts" failures="' + (failed ? 1 : 0) + '"><testcase /></testsuite></testsuites>' : JSON.stringify({ testResults: [{ name: resolve("test/example.test.ts"), status: "passed" }] }));
if (${JSON.stringify(scenario)} === "changed-inputs" && workspace === "core") writeFileSync("test/example.test.ts", "// changed after starting");
process.exit(failed && ${JSON.stringify(scenario)} === "fail" ? 1 : 0);`);
  for (const workspace of ["packages/core", "packages/engine", "apps/desktop"]) {
    const folder = join(root, workspace);
    mkdirSync(join(folder, "test"), { recursive: true });
    writeFileSync(join(folder, "test", "example.test.ts"), "// A controlled runner result, not another full suite.\n");
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: workspace, scripts: { test: `${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} ${workspace.split("/")[1]}` } }));
  }
  git(root, "init", "-q", "-b", "main"); git(root, "add", ".");
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "Fixture");
  const run = Bun.spawnSync([process.execPath, join(quality, "full-run.ts")], { cwd: root, env: { ...testGitEnv(), PETRINA_TEST_BASE: "HEAD" }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect({ code: run.exitCode, output: run.exitCode === (scenario === "pass" ? 0 : 1) ? "" : run.stderr.toString() }).toEqual({ code: scenario === "pass" ? 0 : 1, output: "" });
  expect(readFileSync(join(root, "runs.log"), "utf8")).toBe("core\nengine\ndesktop\n");
  const folder = join(root, ".test-results", readdirSync(join(root, ".test-results"))[0]!);
  const result = JSON.parse(readFileSync(join(folder, "results.json"), "utf8"));
  expect(result.mode).toBe("observation");
  expect(result.stableInputs).toBe(scenario !== "changed-inputs");
  if (scenario === "fail") expect(result.results[1].missedFailures).toEqual(["packages/engine/test/example.test.ts"]);
});
