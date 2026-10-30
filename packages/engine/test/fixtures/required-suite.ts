import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync, type BigIntStats } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { testGitEnv } from "../fixtures.js";
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

function writeSuiteGitObject(gitDir: string, type: "blob" | "tree" | "commit", payload: Buffer): { hex: string; raw: Buffer } {
  const full = Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, "utf8"), payload]);
  const raw = createHash("sha1").update(full).digest();
  const hex = raw.toString("hex");
  const dir = join(gitDir, "objects", hex.slice(0, 2));
  const file = join(dir, hex.slice(2));
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, deflateSync(full));
  }
  return { hex, raw };
}

function isIgnoredSuiteEntry(relPath: string, name: string, isDir: boolean): boolean {
  return name === ".git"
    || name === "node_modules"
    || name === ".test-results"
    || name === "runs.log"
    || name === "environments.log"
    || name.startsWith("started")
    || name === "browser-environment.json"
    || name === "command-observation.json"
    || name === "fixture-scenario.json"
    || (isDir && (relPath === "caller-home" || relPath === "caller-temporary"));
}

/** Initialize or advance the synthetic runner checkout on `main` without spawning `git`. */
export function commitSuiteDirectory(root: string, message: string): void {
  const gitDir = join(root, ".git");
  const mainRef = join(gitDir, "refs", "heads", "main");
  if (!existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(join(gitDir, "objects"), { recursive: true });
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(gitDir, "config"),
      `[core]\n\trepositoryformatversion = 0\n\tfilemode = ${process.platform === "win32" ? "false" : "true"}\n\tbare = false\n\tlogallrefupdates = true\n\tautocrlf = false\n\teol = lf\n[user]\n\tname = Test\n\temail = t@example.com\n`,
    );
  }
  const indexEntries: Array<{ pathBytes: Buffer; st: BigIntStats; mode: number; size: number; raw: Buffer }> = [];
  const buildTree = (dir: string, relPrefix: string): { hex: string; raw: Buffer; hasFiles: boolean } => {
    const items: Array<{ name: string; sortKey: string; modeStr: string; raw: Buffer }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      const st = lstatSync(fullPath, { bigint: true });
      const isDir = st.isDirectory();
      if (isIgnoredSuiteEntry(relPath, entry.name, isDir)) continue;
      if (isDir) {
        const sub = buildTree(fullPath, relPath);
        if (sub.hasFiles) items.push({ name: entry.name, sortKey: `${entry.name}/`, modeStr: "40000", raw: sub.raw });
      } else if (st.isFile()) {
        const data = readFileSync(fullPath);
        const exec = process.platform !== "win32" && (Number(st.mode) & 0o111) !== 0;
        const blob = writeSuiteGitObject(gitDir, "blob", data);
        items.push({ name: entry.name, sortKey: entry.name, modeStr: exec ? "100755" : "100644", raw: blob.raw });
        indexEntries.push({ pathBytes: Buffer.from(relPath, "utf8"), st, mode: exec ? 0o100755 : 0o100644, size: data.length, raw: blob.raw });
      }
    }
    items.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, "utf8"), Buffer.from(b.sortKey, "utf8")));
    const payload = Buffer.concat(items.map((item) => Buffer.concat([Buffer.from(`${item.modeStr} ${item.name}\0`, "utf8"), item.raw])));
    const tree = writeSuiteGitObject(gitDir, "tree", payload);
    return { hex: tree.hex, raw: tree.raw, hasFiles: items.length > 0 };
  };
  const rootTree = buildTree(root, "");
  indexEntries.sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(indexEntries.length, 8);
  const entryBuffers = indexEntries.map((entry) => {
    const buf = Buffer.alloc((62 + entry.pathBytes.length + 8) & ~7);
    buf.writeUInt32BE(Number(entry.st.ctimeNs / 1_000_000_000n) >>> 0, 0);
    buf.writeUInt32BE(Number(entry.st.ctimeNs % 1_000_000_000n) >>> 0, 4);
    buf.writeUInt32BE(Number(entry.st.mtimeNs / 1_000_000_000n) >>> 0, 8);
    buf.writeUInt32BE(Number(entry.st.mtimeNs % 1_000_000_000n) >>> 0, 12);
    buf.writeUInt32BE(Number(entry.st.dev & 0xffffffffn) >>> 0, 16);
    buf.writeUInt32BE(Number(entry.st.ino & 0xffffffffn) >>> 0, 20);
    buf.writeUInt32BE(entry.mode >>> 0, 24);
    buf.writeUInt32BE(Number(entry.st.uid & 0xffffffffn) >>> 0, 28);
    buf.writeUInt32BE(Number(entry.st.gid & 0xffffffffn) >>> 0, 32);
    buf.writeUInt32BE(entry.size >>> 0, 36);
    entry.raw.copy(buf, 40);
    buf.writeUInt16BE(Math.min(entry.pathBytes.length, 0x0fff), 60);
    entry.pathBytes.copy(buf, 62);
    return buf;
  });
  const indexBody = Buffer.concat([header, ...entryBuffers]);
  writeFileSync(join(gitDir, "index"), Buffer.concat([indexBody, createHash("sha1").update(indexBody).digest()]));
  const parent = existsSync(mainRef) ? readFileSync(mainRef, "utf8").trim() : undefined;
  const nowSec = Math.floor(Date.now() / 1000);
  const commitPayload = Buffer.from(
    `tree ${rootTree.hex}\n${parent ? `parent ${parent}\n` : ""}author Test <t@example.com> ${nowSec} +0000\ncommitter Test <t@example.com> ${nowSec} +0000\n\n${message}\n`,
    "utf8",
  );
  const commitObj = writeSuiteGitObject(gitDir, "commit", commitPayload);
  writeFileSync(mainRef, `${commitObj.hex}\n`);
}

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
  const rootExpr = entry === "suite" ? 'resolve(import.meta.dir, "../../../..")' : "import.meta.dir";
  writeFileSync(join(dirname(target), "fixture-run-process.ts"), `import { join, resolve } from "node:path";
import { runProcess as actualRunProcess, SUITE_RUN_TIMEOUT_MS } from ${JSON.stringify(actual)};
import { CommandFailure } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))};
import { writeFixtureJson } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-json"))};
export { SUITE_RUN_TIMEOUT_MS };
const fixtureRoot = ${rootExpr};
export const runProcess: typeof actualRunProcess = async (argv, options) => {
  if (${entry === "focused" ? "true" : 'options.cwd === join(fixtureRoot, "packages/core")'}) {
    writeFixtureJson(join(fixtureRoot, "command-observation.json"), { folder: options.env?.TMPDIR, home: options.env?.HOME, browsers: options.env?.PETRINA_TEST_BROWSERS, argv });
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
  writeFileSync(join(quality, "bundled-browser.ts"), `import { join, resolve } from "node:path";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
const fixtureRoot = resolve(import.meta.dir, "../../../..");
export function bundledChromiumExecutablePath() {
  writeFixtureJson(join(fixtureRoot, "browser-environment.json"), { home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL,
    token: process.env.GH_TOKEN, toolConfig: process.env.CODEX_HOME, browserOverride: process.env.PLAYWRIGHT_BROWSERS_PATH });
  ${browser === "changed-command" ? 'writeFixtureJson(join(fixtureRoot, "packages", "storage", "package.json"), { scripts: { test: "bun unrelated-preparation.ts" } });' : ""}
  ${browser === "resolver-error" ? 'throw new Error("controlled bundled-browser resolver failure");' : 'return join(fixtureRoot, "fixture-bundled-browser");'}
}`);
  if (observation === "changed-command-after-observation") {
    // Forward the copied actual observation, then model a concurrent edit after its own input snapshot.
    const repository = join(quality, "repository.ts"), actual = readFileSync(repository, "utf8");
    const declaration = "export async function observe(";
    if (actual.split(declaration).length !== 2) throw new Error("The fixture needs exactly one actual observation boundary");
    writeFileSync(repository, `import { writeFixtureJson } from "@petrina/test-support/fixture-json";\n${actual.replace(declaration, "async function fixtureActualObserve(")}\n
export async function observe(...args: Parameters<typeof fixtureActualObserve>): ReturnType<typeof fixtureActualObserve> {
  const plan = await fixtureActualObserve(...args);
  writeFixtureJson(join(ROOT, "packages", "storage", "package.json"), { scripts: { test: "bun unrelated-after-observation.ts" } });
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
  writeFileSync(join(root, ".gitignore"), "node_modules\n.test-results\nruns.log\nenvironments.log\nstarted*\nbrowser-environment.json\ncommand-observation.json\nfixture-scenario.json\n/caller-home/\n/caller-temporary/\n");
  writeFileSync(join(root, "fixture-scenario.json"), JSON.stringify(scenario));
  const runner = join(root, "vitest-report.ts");
  writeFileSync(runner, `import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const workspace = process.argv[2], stand = JSON.parse(readFileSync(resolve(import.meta.dir, "fixture-scenario.json"), "utf8"))[workspace] ?? {};
const log = line => appendFileSync(resolve(import.meta.dir, "runs.log"), line + "\\n");
log(workspace);
appendFileSync(resolve(import.meta.dir, "environments.log"), JSON.stringify({ workspace, home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL, token: process.env.GH_TOKEN, toolConfig: process.env.CODEX_HOME }) + "\\n");
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
 const mark = resolve(import.meta.dir, "started"); writeFileSync(mark + ".tmp", String(process.pid)); renameSync(mark + ".tmp", mark);
 setTimeout(() => process.exit(1), 20_000);
} else process.exit(stand.code ?? 0);`);
  for (const { path: workspace, runner: kind } of TEST_WORKSPACES) {
    const name = workspace.split("/").at(-1)! as Suite, stand = scenario[name] ?? {}, folder = join(root, workspace);
    const relToRoot = [...workspace.split("/"), "test", "contracts", "testing"].map(() => "..").join("/");
    const runnerFromWorkspace = `${workspace.split("/").map(() => "..").join("/")}/vitest-report.ts`;
    mkdirSync(join(folder, "test", "contracts", "testing"), { recursive: true });
    writeFileSync(join(folder, ".env"), "GH_TOKEN=fixture-dotenv-account\nCODEX_HOME=fixture-dotenv-config\n");
    const file = join(folder, EXAMPLE);
    writeFileSync(file, kind === "vitest" ? "// Controlled Vitest result.\n" : `import { expect, it } from "bun:test";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const fixtureRoot = resolve(import.meta.dir, ${JSON.stringify(relToRoot)});
const stand = JSON.parse(readFileSync(join(fixtureRoot, "fixture-scenario.json"), "utf8"))[${JSON.stringify(name)}] ?? {};
const log = line => appendFileSync(join(fixtureRoot, "runs.log"), line + "\\n");
(stand.report === "skipped" ? it.skip : it)(${JSON.stringify(name)}, async () => {
 log(${JSON.stringify(name)});
 appendFileSync(join(fixtureRoot, "environments.log"), JSON.stringify({ workspace: ${JSON.stringify(name)}, home: process.env.HOME, gitConfig: process.env.GIT_CONFIG_GLOBAL, token: process.env.GH_TOKEN, toolConfig: process.env.CODEX_HOME }) + "\\n");
 expect(process.cwd()).toBe(join(fixtureRoot, "packages", "engine"));
 if (stand.hold) {
  const mark = join(fixtureRoot, "started"); writeFileSync(mark + ".tmp", String(process.pid)); renameSync(mark + ".tmp", mark);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Unreleased fixture")), 20_000);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearTimeout(timer); resolve(); }); });
 }
 expect(stand.report !== "fail").toBe(true);
});`);
    if (stand.report === "omitted") writeFileSync(join(folder, "test", "contracts", "testing", "omitted.test.ts"), "// No test outcome can be reported.\n");
    const nativeCommand = name === "test-support" ? "bun src/run.ts" : "bun ../test-support/src/run.ts";
    // The scripted Vitest producer is itself a Bun program; keep its own dotenv loading explicit too.
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: workspace, scripts: { test: kind === "bun" ? nativeCommand : `${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(runnerFromWorkspace)} ${name}` } }));
  }
  commitSuiteDirectory(root, "Fixture");
  return root;
}
