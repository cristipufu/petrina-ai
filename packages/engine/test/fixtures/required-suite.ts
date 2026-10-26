import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, testGitEnv } from "../fixtures.js";
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

export type Suite = "core" | "desktop" | "orchestrator" | "test-support" | "storage" | "platform" | "agent-runtime" | "repositories" | "engine";
export type StandIn = { report?: "fail" | "missing" | "truncated" | "omitted" | "counts" | "running" | "skipped"; code?: number; print?: string; change?: boolean; moveHead?: boolean; hold?: boolean };
export const NOT_STARTED = "core and desktop and orchestrator did not all pass";
export const EXAMPLE = "test/contracts/testing/example.test.ts";
export type BrowserStandIn = "ready" | "missing" | "directory" | "resolver-error" | "changed-command";
export type ObservationStandIn = "unchanged" | "changed-command-after-observation";
export type RunFailure = "error" | "undefined" | "none" | "unconfirmed";

/** An explicitly private caller environment keeps a controlled retained run inside this case's root. */
export function isolatedRunnerEnvironment(root: string): NodeJS.ProcessEnv {
  const home = join(root, "caller-home"), temporary = join(root, "caller-temporary");
  mkdirSync(home, { recursive: true }); mkdirSync(temporary, { recursive: true });
  return { ...testGitEnv(), HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, PETRINA_TEST_BASE: "HEAD" };
}

/** Only controlled unavailable-command cases use this: their browser parent never held an actor. */
export async function closeControlledRunner(lifetime: { close(): Promise<void> }, browsers: string | undefined): Promise<void> {
  // Native wrapper/independent peer cleanup must be confirmed before touching its recorded files.
  await lifetime.close();
  if (browsers === undefined) return;
  if (!isAbsolute(browsers)) throw new Error("The controlled runner did not record an absolute browser parent");
  let directory;
  try { directory = lstatSync(browsers); }
  catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return; throw error; }
  if (!directory.isDirectory() || readdirSync(browsers).length) throw new Error("Controlled browser files remain; directory retained");
  // rmdir is deliberately nonrecursive: a late file makes cleanup fail instead of deleting unknown work.
  rmdirSync(browsers);
  try { lstatSync(browsers); }
  catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return; throw error; }
  throw new Error("The controlled browser parent could not be removed");
}

/** Substitute only the actual runProcess boundary; plans, parsing, coordination and disposal stay actual. */
export function installRunFailure(root: string, failure: RunFailure, entry: "suite" | "focused" = "suite"): string {
  const runner = import.meta.resolve("@petrina/test-support/run");
  const target = entry === "suite" ? join(root, "packages/engine/test/quality/execution.ts") : join(root, "focused-runner.ts");
  let source = readFileSync(entry === "suite" ? target : fileURLToPath(runner), "utf8");
  if (entry === "focused") source = source.replace(/from "(\.\/[^"\n]+)\.js"/g, (_all, path: string) => `from ${JSON.stringify(new URL(path + ".ts", runner).href)}`);
  const actual = import.meta.resolve("@petrina/test-support/run-process");
  const marker = entry === "suite" ? 'from "@petrina/test-support/run-process"' : `from ${JSON.stringify(actual)}`;
  if (source.split(marker).length !== 2) throw new Error("The fixture needs exactly one actual runProcess import");
  source = source.replace(marker, 'from "./fixture-run-process.js"');
  const reason = failure === "undefined" ? "undefined" : failure === "error" ? 'new Error("controlled unknown runner rejection")'
    : `new CommandFailure("controlled runner cleanup ${failure}", ${JSON.stringify(failure === "none" ? "start" : "unreadable")}, "", "", ${JSON.stringify(failure)})`;
  writeFileSync(join(dirname(target), "fixture-run-process.ts"), `import { runProcess as actualRunProcess, SUITE_RUN_TIMEOUT_MS } from ${JSON.stringify(actual)};
import { CommandFailure } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))};
import { writeFixtureJson } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-json"))};
export { SUITE_RUN_TIMEOUT_MS };
export const runProcess: typeof actualRunProcess = async (argv, options) => {
  if (${entry === "focused" ? "true" : `options.cwd === ${JSON.stringify(join(root, "packages/core"))}`}) {
    writeFixtureJson(${JSON.stringify(join(root, "command-observation.json"))}, { folder: options.env?.TMPDIR, home: options.env?.HOME, browsers: options.env?.PETRINA_TEST_BROWSERS, argv });
    throw ${reason};
  }
  return actualRunProcess(argv, options);
};\n`);
  writeFileSync(target, source);
  return target;
}

/** Copy the actual runner; control Vitest reports and only the browser-path boundary. Native packages run real Bun cases. */
export function entryFixture(root: string, browser: BrowserStandIn = "ready", observation: ObservationStandIn = "unchanged"): string {
  const quality = join(root, "packages", "engine", "test", "quality");
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  writeFileSync(join(root, "docs", "plans", "test-layer-audit.json"), JSON.stringify({ version: 1, files: [] }));
  mkdirSync(quality, { recursive: true }); cpSync(QUALITY, quality, { recursive: true });
  const executable = join(root, "fixture-bundled-browser");
  if (browser === "ready" || browser === "changed-command") writeFileSync(executable, "Fixture file availability only; never launched.\n", { mode: 0o700 });
  if (browser === "directory") mkdirSync(executable);
  // Only this unrelated native path boundary is substituted. The actual gate and filesystem checks stay real.
  writeFileSync(join(quality, "bundled-browser.ts"), `import { writeFixtureJson } from "@petrina/test-support/fixture-json";
export function bundledChromiumExecutablePath() {
  writeFixtureJson(${JSON.stringify(join(root, "browser-environment.json"))}, { home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL,
    token: process.env.GH_TOKEN, toolConfig: process.env.CODEX_HOME, browserOverride: process.env.PLAYWRIGHT_BROWSERS_PATH });
  ${browser === "changed-command" ? `writeFixtureJson(${JSON.stringify(join(root, "packages", "storage", "package.json"))}, { scripts: { test: "bun unrelated-preparation.ts" } });` : ""}
  ${browser === "resolver-error" ? 'throw new Error("controlled bundled-browser resolver failure");' : `return ${JSON.stringify(executable)};`}
}`);
  if (observation === "changed-command-after-observation") {
    // Forward the copied actual observation, then model a concurrent edit after its own input snapshot.
    const repository = join(quality, "repository.ts"), actual = readFileSync(repository, "utf8");
    const declaration = "export async function observe(";
    if (actual.split(declaration).length !== 2) throw new Error("The fixture needs exactly one actual observation boundary");
    writeFileSync(repository, `import { writeFixtureJson } from "@petrina/test-support/fixture-json";\n${actual.replace(declaration, "async function fixtureActualObserve(")}\n
export async function observe(...args: Parameters<typeof fixtureActualObserve>): ReturnType<typeof fixtureActualObserve> {
  const plan = await fixtureActualObserve(...args);
  writeFixtureJson(${JSON.stringify(join(root, "packages", "storage", "package.json"))}, { scripts: { test: "bun unrelated-after-observation.ts" } });
  return plan;
}\n`);
  }
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
  writeFileSync(join(root, ".gitignore"), "node_modules\n.test-results\nruns.log\nenvironments.log\nstarted*\nbrowser-environment.json\ncommand-observation.json\n/caller-home/\n/caller-temporary/\n");
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
