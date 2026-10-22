import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { removeDir, tempDir, testGitEnv, waitFor } from "./fixtures.js";
import { testTempParent } from "./temp-parent.js";

const fixture = tempDir("petrina-test-runner-");
afterAll(() => removeDir(fixture));

it("moves only macOS's default temporary parents, including equivalent spellings", () => {
  const home = join(fixture, "chosen-home");
  for (const parent of ["/tmp", "/private/tmp/", "/tmp/unused/..", "/var/folders/ab/session/T/", "/private/var/folders/ab/session/T/./"]) {
    expect(testTempParent(parent, "darwin", home, posix.resolve)).toBe(join(home, ".petrina", "test-tmp"));
  }
  for (const parent of ["/var/folders/ab/session/T/enclosing-run", "/private/var/folders/ab/session/T/custom", fixture]) {
    expect(testTempParent(parent, "darwin", home, posix.resolve)).toBe(parent);
  }
  for (const platform of ["linux", "win32"] as const) expect(testTempParent("/tmp", platform, home)).toBe("/tmp");
});

it.skipIf(process.platform === "win32")("recognizes a link to the system parent and preserves a link to a custom parent", () => {
  const system = join(fixture, "system-parent"), custom = join(fixture, "custom-parent");
  symlinkSync("/tmp", system);
  symlinkSync(fixture, custom);
  expect(testTempParent(system, "darwin")).toBe(join(homedir(), ".petrina", "test-tmp"));
  expect(testTempParent(custom, "darwin")).toBe(custom);
});

it.skipIf(process.platform !== "darwin")("uses an isolated home folder even when the normal macOS parent is already in the environment", async () => {
  const session = Bun.spawnSync(["getconf", "DARWIN_USER_TEMP_DIR"]);
  expect(session.exitCode).toBe(0);
  const normal = session.stdout.toString().trim();
  const record = join(fixture, "normal-parent.json"), test = join(fixture, "normal-parent.test.ts");
  writeFileSync(test, `import { it } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { tempDir } from ${JSON.stringify(join(import.meta.dir, "support.ts"))};
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
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), test], { cwd: fixture, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
import { run } from ${JSON.stringify(join(import.meta.dir, "../src/git.ts"))};
import { browserTempRoot } from ${JSON.stringify(join(import.meta.dir, "../src/browser.ts"))};
import { tempDir, testBrowserRoot } from ${JSON.stringify(join(import.meta.dir, "support.ts"))};
it("leaves files for its parent to reclaim", async () => {
  const left = join(tmpdir(), "abandoned-fixture");
  mkdirSync(left);
  writeFileSync(join(left, "build-output"), "discard");
  const browsers = testBrowserRoot();
  mkdirSync(join(browsers, "petrina-browser-abandoned"));
  const result = await run(["git", "config", "--get", "core.hooksPath"], ${JSON.stringify(fixture)});
  if (result.code) throw new Error(result.stderr);
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ folder: tmpdir(), helper: dirname(result.stdout.trim()), left, ordinary: tempDir("ordinary-"), browser: browserTempRoot(), browsers, owned: realpathSync(process.env.PETRINA_TEST_BROWSERS!), env: [process.env.TMPDIR, process.env.TMP, process.env.TEMP] }));
  expect(${passes}).toBe(true);
});`);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), test], { cwd: fixture, env: { ...testGitEnv(), TMPDIR: parent, TMP: parent, TEMP: parent }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(passes ? 0 : 1);
  const saved = JSON.parse(readFileSync(record, "utf8")) as { folder: string; helper: string; left: string; ordinary: string; browser: string; browsers: string; owned: string; env: string[] };
  expect(realpathSync(dirname(saved.folder))).toBe(realpathSync(parent));
  expect(dirname(saved.ordinary)).toBe(saved.folder);
  expect(saved.env).toEqual([saved.folder, saved.folder, saved.folder]);
  if (process.platform === "darwin") expect(saved.browser).toBe(join(homedir(), ".petrina", "b"));
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

it("isolates simultaneous runner instances and never removes another run's live files", async () => {
  const parent = join(fixture, "simultaneous-runs"); mkdirSync(parent);
  const test = join(fixture, "simultaneous.test.ts");
  writeFileSync(test, `import { it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProduct, testBrowserRoot } from ${JSON.stringify(join(import.meta.dir, "support.ts"))};
it("owns only this run's repositories, database and captures", async () => {
  const label = process.env.PETRINA_FIXTURE_RUN!;
  const folder = tmpdir(), home = process.env.PETRINA_HOME!;
  const repo = makeProduct(join(folder, "product"));
  const browser = testBrowserRoot(); mkdirSync(join(browser, "captures"));
  const db = new Database(join(home, "petrina.db"));
  db.exec("CREATE TABLE own (value TEXT)"); db.query("INSERT INTO own VALUES (?)").run(label);
  writeFileSync(join(${JSON.stringify(parent)}, label + ".json"), JSON.stringify({ folder, home, repo, browser }));
  try {
    while (!existsSync(join(${JSON.stringify(parent)}, label + ".release"))) await Bun.sleep(20);
    expect(db.query("SELECT value FROM own").get()).toEqual({ value: label });
    expect(existsSync(repo)).toBe(true); expect(existsSync(join(browser, "captures"))).toBe(true);
  } finally { db.close(); }
});`);
  const runs = ["first", "second"].map(label => ({ label, child: Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), test], {
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
      return JSON.parse(readFileSync(file, "utf8")) as Record<"folder" | "home" | "repo" | "browser", string>;
    }));
    for (const key of ["folder", "home", "repo", "browser"] as const) expect(recorded[0]![key]).not.toBe(recorded[1]![key]);
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
import { removeDir, testBrowserRoot } from ${JSON.stringify(join(import.meta.dir, "support.ts"))};
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
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), test], { cwd: fixture, env: testGitEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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
