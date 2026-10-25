import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { git } from "../fixtures.js";
import { sourceFacts } from "../quality/source.js";
import { TEST_WORKSPACES } from "../quality/workspaces.js";

const ENGINE = resolve(import.meta.dir, "../..");
const QUALITY = join(ENGINE, "test", "quality");
export const PACKAGES = (() => {
  const manifest = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as Record<"dependencies" | "devDependencies", Record<string, string>>;
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  const sources = [...readdirSync(QUALITY).filter(name => name.endsWith(".ts")).map(name => join(QUALITY, name))];
  const names = new Set(sources.flatMap(file => sourceFacts(readFileSync(file, "utf8"), file).imports)
    .filter(({ path, runtime }) => runtime && !path.startsWith(".") && !isBuiltin(path))
    .map(({ path }) => path.split("/").slice(0, path.startsWith("@") ? 2 : 1).join("/")));
  for (const name of names) if (!declared.has(name)) throw new Error(`The quality runner imports ${name}, which the engine package does not declare`);
  return [...names].map(name => ({ name, folder: realpathSync.native(dirname(Bun.resolveSync(`${name}/package.json`, ENGINE))) }));
})();

export type Suite = "core" | "desktop" | "orchestrator" | "test-support" | "storage" | "platform" | "engine";
export type StandIn = { report?: "fail" | "missing" | "truncated" | "omitted" | "counts" | "running" | "skipped"; code?: number; print?: string; change?: boolean; moveHead?: boolean; hold?: boolean };
export const NOT_STARTED = "core and desktop and orchestrator did not all pass";
export const EXAMPLE = "test/contracts/testing/example.test.ts";

/** Copy the actual entry point. Only Vitest report production is scripted; native packages run real Bun cases. */
export function entryFixture(root: string): string {
  const quality = join(root, "packages", "engine", "test", "quality");
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  writeFileSync(join(root, "docs", "plans", "test-layer-audit.json"), JSON.stringify({ version: 1, files: [] }));
  mkdirSync(quality, { recursive: true }); cpSync(QUALITY, quality, { recursive: true });
  for (const { name, folder } of PACKAGES) {
    const link = join(root, "packages", "engine", "node_modules", name);
    mkdirSync(dirname(link), { recursive: true }); fixtureFiles.directoryLink(folder, link);
  }
  const manifest = JSON.parse(readFileSync(join(ENGINE, "..", "..", "package.json"), "utf8"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: manifest.scripts.test } }));
  return root;
}

export async function prepareSuite(root: string, scenario: Partial<Record<Suite, StandIn>> = {}) {
  const log = join(root, "runs.log"), environments = join(root, "environments.log");
  writeFileSync(join(root, ".gitignore"), "node_modules\n.test-results\nruns.log\nenvironments.log\nstarted*\n");
  const runner = join(root, "vitest-report.ts");
  writeFileSync(runner, `import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const workspace = process.argv[2], stand = (${JSON.stringify(scenario)})[workspace] ?? {};
const log = line => appendFileSync(${JSON.stringify(log)}, line + "\\n");
log(workspace);
appendFileSync(${JSON.stringify(environments)}, JSON.stringify({ workspace, home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL, token: process.env.GH_TOKEN, toolConfig: process.env.CODEX_HOME }) + "\\n");
if (stand.print) process.stdout.write(stand.print);
const failed = stand.report === "fail", skipped = stand.report === "skipped";
const status = failed ? "failed" : skipped ? "skipped" : stand.report === "running" ? "pending" : "passed";
let report = JSON.stringify({ success: !failed, numTotalTestSuites: 1, numPassedTestSuites: Number(!failed), numFailedTestSuites: Number(failed), numPendingTestSuites: 0,
 numTotalTests: stand.report === "counts" ? 2 : 1, numPassedTests: Number(status === "passed"), numFailedTests: Number(failed), numPendingTests: Number(skipped || status === "pending"), numTodoTests: 0,
 testResults: [{ name: resolve(${JSON.stringify(EXAMPLE)}), status: failed ? "failed" : "passed", assertionResults: [{ status }] }] });
if (stand.report === "truncated") report = report.slice(0, -5);
if (stand.report !== "missing") writeFileSync(process.argv.find(arg => arg.startsWith("--outputFile=")).slice("--outputFile=".length), report);
if (stand.change) writeFileSync(${JSON.stringify(EXAMPLE)}, "// changed after starting");
if (stand.moveHead) {
 const { runCommand } = await import(${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))});
 const result = await runCommand(["git", "commit", "--allow-empty", "-q", "-m", "Concurrent revision"]);
 if (result.code !== 0) throw new Error(result.stderr);
}
if (stand.hold) {
 for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { log(workspace + " received " + signal); process.exit(signal === "SIGINT" ? 130 : 143); });
 const mark = ${JSON.stringify(join(root, "started"))}; writeFileSync(mark + ".tmp", String(process.pid)); renameSync(mark + ".tmp", mark);
 setTimeout(() => process.exit(1), 20_000);
} else process.exit(stand.code ?? 0);`);
  for (const { path: workspace, runner: kind } of TEST_WORKSPACES) {
    const name = workspace.split("/").at(-1)! as Suite, stand = scenario[name] ?? {}, folder = join(root, workspace);
    mkdirSync(join(folder, "test", "contracts", "testing"), { recursive: true });
    writeFileSync(join(folder, ".env"), "GH_TOKEN=fixture-dotenv-account\nCODEX_HOME=fixture-dotenv-config\n");
    const file = join(folder, EXAMPLE);
    writeFileSync(file, kind === "vitest" ? "// Controlled Vitest result.\n" : `import { expect, it } from "bun:test";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
const log = line => appendFileSync(${JSON.stringify(log)}, line + "\\n");
it${stand.report === "skipped" ? ".skip" : ""}(${JSON.stringify(name)}, async () => {
 log(${JSON.stringify(name)});
 appendFileSync(${JSON.stringify(environments)}, JSON.stringify({ workspace: ${JSON.stringify(name)}, home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL, token: process.env.GH_TOKEN, toolConfig: process.env.CODEX_HOME }) + "\\n");
 expect(process.cwd()).toBe(${JSON.stringify(join(root, "packages", "engine"))});
 ${stand.hold ? `const mark = ${JSON.stringify(join(root, "started"))}; writeFileSync(mark + ".tmp", String(process.pid)); renameSync(mark + ".tmp", mark);
 await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Unreleased fixture")), 20_000);
 for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearTimeout(timer); resolve(); }); });` : ""}
 expect(${JSON.stringify(stand.report !== "fail")}).toBe(true);
});`);
    if (stand.report === "omitted") writeFileSync(join(folder, "test", "contracts", "testing", "omitted.test.ts"), "// No test outcome can be reported.\n");
    const nativeCommand = name === "test-support" ? "bun src/run.ts" : "bun ../test-support/src/run.ts";
    // The scripted Vitest producer is itself a Bun program; keep its own dotenv loading explicit too.
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: workspace, scripts: { test: kind === "bun" ? nativeCommand : `${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(runner)} ${name}` } }));
  }
  await git(root, "init", "-q", "-b", "main"); await git(root, "add", ".");
  await git(root, "-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "Fixture");
  return root;
}
