import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { afterAll, afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { removeDir, runCommand, tempDir, testGitEnv, waitFor } from "../../fixtures.js";
import { TEST_GIT_IDENTITY, TEST_RUNNER } from "@petrina/test-support/run";
import { testTempParent } from "@petrina/test-support/temp-parent";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import { closeControlledRunner, installRunFailure, isolatedRunnerEnvironment } from "../../fixtures/required-suite.js";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";

const fixture = tempDir("petrina-test-runner-");
afterAll(() => removeDir(fixture));
const settlementCases = coordinatorLifetimes();
afterEach(() => settlementCases.close());
afterAll(() => settlementCases.close());

it("retains a nested actor-free fixture after its worker exits successfully and drains", async () => {
  const root = tempDir("petrina-focused-inner-retention-"), lifetime = await settlementCases.open(root);
  const record = join(root, "retained.json");
  let observed: { root: string; folder: string; browsers: string; nestedFolder: string; nestedBrowsers: string } | undefined;
  const finish = async () => {
    // The control starts no actors; confirm its actual owned runner before independent directory cleanup.
    await lifetime.close();
    if (existsSync(record)) observed ??= JSON.parse(readFileSync(record, "utf8"));
    const settled = await Promise.allSettled([observed?.browsers, observed?.nestedBrowsers].map(async path => { if (path) removeFixtureRoot(path); }));
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Actor-free retained runner roots could not be removed");
  };
  await setupWithCleanup(() => lifetime.prepare(async () => {
      const file = join(root, "retained.test.ts");
      writeFileSync(file, `import { it, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { engineProcessCases } from ${JSON.stringify(import.meta.resolve("../../fixtures/engine-processes.ts"))};
import { writeFixtureJson } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-json"))};
import { createTestRun } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/environment"))};
import { registerFixtureRoot, FIXTURE_JOURNAL } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-retention"))};
it("reports a failed finished fixture without starting a command", async () => {
  const nested = createTestRun();
  expect(nested.env[FIXTURE_JOURNAL]).not.toBe(process.env[FIXTURE_JOURNAL]);
  const local = engineProcessCases(), root = join(nested.env.TMPDIR, "retained-child"); mkdirSync(root);
  registerFixtureRoot(root, nested.env);
  let error;
  try { await local.use(root, async () => { throw undefined; }); } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(AggregateError);
  await local.close();
  expect(nested.close()).toBe(false);
  writeFixtureJson(${JSON.stringify(record)}, { root, folder: process.env.TMPDIR, browsers: process.env.PETRINA_TEST_BROWSERS, nestedFolder: nested.env.TMPDIR, nestedBrowsers: nested.env.PETRINA_TEST_BROWSERS });
});`);
      const child = lifetime.start(root, [TEST_RUNNER, file], isolatedRunnerEnvironment(root));
      const result = await child.completion;
      observed = JSON.parse(readFileSync(record, "utf8"));
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("private files retained");
      expect(existsSync(observed!.root)).toBe(true);
      expect(existsSync(observed!.folder)).toBe(true);
      expect(existsSync(observed!.browsers)).toBe(true);
      expect(existsSync(observed!.nestedFolder)).toBe(true);
      expect(existsSync(observed!.nestedBrowsers)).toBe(true);
    }), finish);
  await finish();
});

for (const failure of ["unconfirmed", "undefined"] as const) it(`retains focused-run files after an actual runner boundary rejects with ${failure}`, async () => {
  const root = tempDir("petrina-focused-settlement-"), lifetime = await settlementCases.open(root);
  let browsers: string | undefined;
  const close = () => closeControlledRunner(lifetime, browsers);
  await setupWithCleanup(() => lifetime.prepare(async () => {
      const runner = installRunFailure(root, failure, "focused"), file = join(root, "not-started.test.ts");
      const marker = join(root, "test-started");
      writeFileSync(file, `import { it } from "bun:test"; import { writeFileSync } from "node:fs"; it("must not start", () => writeFileSync(${JSON.stringify(marker)}, ""));`);
      const child = lifetime.start(root, [runner, file], isolatedRunnerEnvironment(root));
      const result = await child.completion;
      const observed = JSON.parse(readFileSync(join(root, "command-observation.json"), "utf8"));
      browsers = observed.browsers;
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(relative(root, observed.folder)).not.toStartWith("..");
      expect(observed.folder).not.toBe(root);
      expect(existsSync(observed.folder)).toBe(true);
      expect(existsSync(observed.home)).toBe(true);
      expect(existsSync(observed.browsers)).toBe(true);
      expect(result.stderr).toContain("Test command settlement was not confirmed; private files retained");
    }), close);
  await close();
  if (browsers) expect(existsSync(browsers)).toBe(false);
});


it("does not reload account configuration from the working folder's dotenv file after filtering the environment", async () => {
  const cwd = join(fixture, "dotenv"); mkdirSync(cwd);
  writeFileSync(join(cwd, ".env"), "GH_TOKEN=fixture-dotenv-account\nCODEX_HOME=fixture-dotenv-settings\n");
  const file = join(cwd, "dotenv.test.ts");
  writeFileSync(file, `import { expect, it } from "bun:test";
it("retains the runner's account-free environment", () => { expect(process.env.GH_TOKEN).toBeUndefined(); expect(process.env.CODEX_HOME).toBeUndefined(); });`);
  const result = await runCommand([process.execPath, TEST_RUNNER, file], { cwd, env: testGitEnv() });
  expect(result.code, result.stdout + result.stderr).toBe(0);
});

it.skipIf(process.platform === "win32")("recognizes a link to the system parent and preserves a link to a custom parent", () => {
  const system = join(fixture, "system-parent"), custom = join(fixture, "custom-parent");
  fixtureFiles.directoryLink("/tmp", system);
  fixtureFiles.directoryLink(fixture, custom);
  expect(testTempParent(system, "darwin")).toBe(join(homedir(), ".petrina", "test-tmp"));
  expect(testTempParent(custom, "darwin")).toBe(custom);
});

it.skipIf(process.platform !== "darwin")("uses an isolated home folder even when the normal macOS parent is already in the environment", async () => {
  const session = await runCommand(["getconf", "DARWIN_USER_TEMP_DIR"]);
  expect(session.code).toBe(0);
  const normal = session.stdout.trim();
  const record = join(fixture, "normal-parent.json"), test = join(fixture, "normal-parent.test.ts");
  writeFileSync(test, `import { it } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { tempDir } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixtures"))};
it("records the worker's temporary folder", () => writeFileSync(${JSON.stringify(record)}, JSON.stringify({ folder: tmpdir(), ordinary: tempDir("ordinary-") })));`);
  const custom = mkdtempSync(join(normal, "petrina-custom-parent-"));
  const keep = join(custom, "caller-owned");
  writeFileSync(keep, "keep");
  try {
    for (const parent of [normal, realpathSync(normal), "/tmp", realpathSync("/tmp"), custom, undefined]) {
      const env = testGitEnv();
      for (const key of ["TMPDIR", "TMP", "TEMP"]) {
        if (parent === undefined) delete env[key];
        else env[key] = parent;
      }
      const child = Bun.spawn([process.execPath, TEST_RUNNER, test], { cwd: fixture, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const { folder, ordinary } = JSON.parse(readFileSync(record, "utf8")) as { folder: string; ordinary: string };
      expect(realpathSync(dirname(folder))).toBe(realpathSync(parent === custom ? custom : join(homedir(), ".petrina", "test-tmp")));
      expect(dirname(ordinary)).toBe(folder);
      expect(existsSync(folder)).toBe(false);
      expect(existsSync(ordinary)).toBe(false);
      expect(existsSync(parent ?? "/tmp")).toBe(true);
    }
    expect(readFileSync(keep, "utf8")).toBe("keep");
  } finally { removeDir(custom); }
});

for (const passes of [true, false]) it(`cleans a parallel run's fixtures and Git helpers when its test ${passes ? "passes" : "fails"}`, async () => {
  const parent = join(fixture, `${passes}-parent`);
  mkdirSync(parent);
  const keep = join(parent, "caller-owned");
  writeFileSync(keep, "keep");
  const record = join(fixture, `${passes}.json`);
  const test = join(fixture, `${passes}.test.ts`);
  writeFileSync(test, `import { it, expect } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from ${JSON.stringify(import.meta.resolve("@petrina/repositories/git"))};
import { browserTempRoot } from ${JSON.stringify(import.meta.resolve("@petrina/agent-runtime/browser"))};
import { tempDir, testBrowserRoot } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixtures"))};
it("leaves files for its parent to reclaim", async () => {
  const left = join(tmpdir(), "abandoned-fixture");
  mkdirSync(left);
  writeFileSync(join(left, "build-output"), "discard");
  const browsers = testBrowserRoot();
  mkdirSync(join(browsers, "petrina-browser-abandoned"));
  const result = await run(["git", "config", "--get", "core.hooksPath"], ${JSON.stringify(fixture)});
  if (result.code) throw new Error(result.stderr);
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ folder: tmpdir(), helper: dirname(result.stdout.trim()), left, ordinary: tempDir("ordinary-"), browser: browserTempRoot(), browsers, owned: realpathSync.native(process.env.PETRINA_TEST_BROWSERS!), env: [process.env.TMPDIR, process.env.TMP, process.env.TEMP] }));
  expect(${passes}).toBe(true);
});`);
  const child = Bun.spawn([process.execPath, TEST_RUNNER, test], { cwd: fixture, env: { ...testGitEnv(), TMPDIR: parent, TMP: parent, TEMP: parent }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(passes ? 0 : 1);
  const saved = JSON.parse(readFileSync(record, "utf8")) as { folder: string; helper: string; left: string; ordinary: string; browser: string; browsers: string; owned: string; env: string[] };
  expect(realpathSync(dirname(saved.folder))).toBe(realpathSync(parent));
  expect(dirname(saved.ordinary)).toBe(saved.folder);
  expect(saved.env).toEqual([saved.folder, saved.folder, saved.folder]);
  if (process.platform === "darwin") expect(saved.browser).toBe(join(saved.folder, "home", ".petrina", "b"));
  // A fixture's private browser folder sits in the run's own short folder, which the run removes.
  expect(dirname(saved.browsers)).toBe(saved.owned);
  if (process.platform === "darwin") expect(Buffer.byteLength(join(saved.browsers, "petrina-browser-abcdef", "SingletonSocket"))).toBeLessThan(104);
  expect(existsSync(saved.browsers)).toBe(false);
  expect(existsSync(saved.owned)).toBe(false);
  expect(existsSync(saved.folder)).toBe(false);
  expect(existsSync(saved.helper)).toBe(false);
  expect(existsSync(saved.left)).toBe(false);
  expect(existsSync(saved.ordinary)).toBe(false);
  expect(readFileSync(keep, "utf8")).toBe("keep");
});

it("gives engine commits the run's own Git identity, yields to a repository's own and leaves the caller's Git settings alone", async () => {
  const parent = join(fixture, "git-identity"); mkdirSync(parent);
  // A machine with no saved identity, where Git may not guess one either (as on Linux CI).
  const callers = join(parent, "caller.gitconfig"), settings = "[user]\n\tuseConfigOnly = true\n";
  writeFileSync(callers, settings);
  const record = join(fixture, "git-identity.json");
  const test = join(fixture, "git-identity.test.ts");
  writeFileSync(test, `import { it } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll } from ${JSON.stringify(import.meta.resolve("@petrina/repositories/git"))};
import { git } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))};
it("commits as the engine does in fresh repositories", async () => {
  const repo = async (name: string) => {
    const path = join(tmpdir(), name);
    mkdirSync(path); await git(path, "init", "-q", "-b", "main"); writeFileSync(join(path, "file.txt"), name);
    return path;
  };
  const fresh = await repo("fresh"), own = await repo("own");
  await git(own, "config", "user.name", "Someone else"); await git(own, "config", "user.email", "other@example.com");
  await commitAll(fresh, "Engine commit"); await commitAll(own, "Engine commit");
  const who = (path: string) => git(path, "log", "-1", "--format=%an <%ae>|%cn <%ce>");
  const record = ${JSON.stringify(record)};
  writeFileSync(record + ".tmp", JSON.stringify({ folder: tmpdir(), config: process.env.GIT_CONFIG_GLOBAL, fresh: await who(fresh), own: await who(own) }));
  renameSync(record + ".tmp", record);
});`);
  const child = Bun.spawn([process.execPath, TEST_RUNNER, test], { cwd: fixture, env: { ...testGitEnv(), GIT_CONFIG_GLOBAL: callers, TMPDIR: parent, TMP: parent, TEMP: parent }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  const saved = JSON.parse(readFileSync(record, "utf8")) as { folder: string; config: string; fresh: string; own: string };
  const runner = `${TEST_GIT_IDENTITY.name} <${TEST_GIT_IDENTITY.email}>`;
  expect(saved.fresh).toBe(`${runner}|${runner}`);
  expect(saved.own).toBe("Someone else <other@example.com>|Someone else <other@example.com>");
  expect(dirname(saved.config)).toBe(saved.folder);
  expect(existsSync(saved.config)).toBe(false);
  expect(readFileSync(callers, "utf8")).toBe(settings);
});

it("isolates simultaneous runner instances and never removes another run's live files", async () => {
  const parent = join(fixture, "simultaneous-runs"); mkdirSync(parent);
  const test = join(fixture, "simultaneous.test.ts");
  writeFileSync(test, `import { it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProduct } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/repositories"))};
import { testBrowserRoot } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixtures"))};
it("owns only this run's repositories, database and captures", async () => {
  const label = process.env.PETRINA_FIXTURE_RUN!;
  const folder = tmpdir(), home = process.env.PETRINA_HOME!;
  const repo = await makeProduct(join(folder, "product"));
  const browser = testBrowserRoot(); mkdirSync(join(browser, "captures"));
  const db = new Database(join(home, "petrina.db"));
  db.exec("CREATE TABLE own (value TEXT)"); db.query("INSERT INTO own VALUES (?)").run(label);
  // The test reads the record as soon as its name appears, so publish it complete.
  const record = join(${JSON.stringify(parent)}, label + ".json");
  writeFileSync(record + ".tmp", JSON.stringify({ folder, home, repo, browser, gitConfig: process.env.GIT_CONFIG_GLOBAL }));
  renameSync(record + ".tmp", record);
  try {
    while (!existsSync(join(${JSON.stringify(parent)}, label + ".release"))) await Bun.sleep(20);
    expect(db.query("SELECT value FROM own").get()).toEqual({ value: label });
    expect(existsSync(repo)).toBe(true); expect(existsSync(join(browser, "captures"))).toBe(true);
  } finally { db.close(); }
});`);
  const runs = ["first", "second"].map(label => ({ label, child: Bun.spawn([process.execPath, TEST_RUNNER, test], {
    cwd: fixture, env: { ...testGitEnv(), TMPDIR: parent, TMP: parent, TEMP: parent, PETRINA_FIXTURE_RUN: label },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  }) }));
  // Drain while running; even a failed child must not block on its diagnostic pipe.
  const results = runs.map(async ({ child }) => {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, diagnostic: out + err };
  });
  try {
    const recorded = await Promise.all(runs.map(async ({ label }, index) => {
      const file = join(parent, label + ".json");
      await Promise.race([waitFor(() => existsSync(file), "both independent runners to record their owned folders"), results[index]!.then(result => { throw new Error(`Runner ended before the barrier: ${result.diagnostic}`); })]);
      return JSON.parse(readFileSync(file, "utf8")) as Record<"folder" | "home" | "repo" | "browser" | "gitConfig", string>;
    }));
    for (const key of ["folder", "home", "repo", "browser", "gitConfig"] as const) expect(recorded[0]![key]).not.toBe(recorded[1]![key]);
    writeFileSync(join(parent, "first.release"), "");
    const first = await results[0]!; expect(first.code, first.diagnostic).toBe(0);
    for (const path of Object.values(recorded[0]!)) expect(existsSync(path)).toBe(false);
    for (const path of Object.values(recorded[1]!)) expect(existsSync(path)).toBe(true);
    writeFileSync(join(parent, "second.release"), "");
    const second = await results[1]!; expect(second.code, second.diagnostic).toBe(0);
    for (const path of Object.values(recorded[1]!)) expect(existsSync(path)).toBe(false);
    expect(existsSync(parent)).toBe(true);
  } finally {
    for (const { label } of runs) writeFileSync(join(parent, label + ".release"), "");
    await Promise.all(results);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) it(`stops its parallel workers and reclaims their temporary folder on ${signal}`, async () => {
  const record = join(fixture, `${signal}.json`);
  const test = join(fixture, `${signal}.test.ts`);
  writeFileSync(test, `import { afterAll, it } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir, testBrowserRoot } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixtures"))};
// The fixture's own cleanup never runs when the run is interrupted.
const browsers = testBrowserRoot();
afterAll(() => removeDir(browsers));
it("waits to be interrupted", async () => {
  const record = ${JSON.stringify(record)};
  mkdirSync(join(browsers, "petrina-browser-interrupted"));
  writeFileSync(record + ".tmp", JSON.stringify({ folder: tmpdir(), pid: process.pid, browsers, owned: process.env.PETRINA_TEST_BROWSERS }));
  renameSync(record + ".tmp", record);
  await Bun.sleep(60_000);
}, 90_000);`);
  const child = Bun.spawn([process.execPath, TEST_RUNNER, test], { cwd: fixture, env: testGitEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let worker: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await waitFor(() => existsSync(record), "the isolated test worker to start");
    const saved = JSON.parse(readFileSync(record, "utf8")) as { folder: string; pid: number; browsers: string; owned: string };
    worker = saved.pid;
    expect(existsSync(join(saved.browsers, "petrina-browser-interrupted"))).toBe(true);
    child.kill(signal);
    expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
    await waitFor(() => !alive(saved.pid), "the isolated test worker to stop");
    expect(existsSync(saved.folder)).toBe(false);
    expect(existsSync(saved.browsers)).toBe(false);
    expect(existsSync(saved.owned)).toBe(false);
    expect(realpathSync(dirname(saved.folder))).toBe(realpathSync(tmpdir()));
    expect(existsSync(tmpdir())).toBe(true);
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    if (worker && alive(worker)) process.kill(worker, "SIGKILL");
  }
});
