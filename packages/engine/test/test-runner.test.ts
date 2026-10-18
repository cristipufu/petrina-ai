import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDir, tempDir, testGitEnv, waitFor } from "./support.js";

const fixture = tempDir("petrina-test-runner-");
afterAll(() => removeDir(fixture));

for (const passes of [true, false]) it(`cleans a parallel run's fixtures and Git helpers when its test ${passes ? "passes" : "fails"}`, async () => {
  const record = join(fixture, `${passes}.json`);
  const test = join(fixture, `${passes}.test.ts`);
  writeFileSync(test, `import { it, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from ${JSON.stringify(join(import.meta.dir, "../src/git.ts"))};
it("leaves files for its parent to reclaim", async () => {
  const left = join(tmpdir(), "abandoned-fixture");
  mkdirSync(left);
  writeFileSync(join(left, "build-output"), "discard");
  const result = await run(["git", "config", "--get", "core.hooksPath"], ${JSON.stringify(fixture)});
  if (result.code) throw new Error(result.stderr);
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ folder: tmpdir(), helper: dirname(result.stdout.trim()), left }));
  expect(${passes}).toBe(true);
});`);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), test], { cwd: fixture, env: testGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(passes ? 0 : 1);
  const saved = JSON.parse(readFileSync(record, "utf8")) as { folder: string; helper: string; left: string };
  expect(existsSync(saved.folder)).toBe(false);
  expect(existsSync(saved.helper)).toBe(false);
  expect(existsSync(saved.left)).toBe(false);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) it(`stops its parallel workers and reclaims their temporary folder on ${signal}`, async () => {
  const record = join(fixture, `${signal}.json`);
  const test = join(fixture, `${signal}.test.ts`);
  writeFileSync(test, `import { it } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
it("waits to be interrupted", async () => {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ folder: tmpdir(), pid: process.pid }));
  await Bun.sleep(60_000);
}, 90_000);`);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), test], { cwd: fixture, env: testGitEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let worker: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await waitFor(() => existsSync(record), "the isolated test worker to start");
    const saved = JSON.parse(readFileSync(record, "utf8")) as { folder: string; pid: number };
    worker = saved.pid;
    child.kill(signal);
    expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
    await waitFor(() => !alive(saved.pid), "the isolated test worker to stop");
    expect(existsSync(saved.folder)).toBe(false);
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    if (worker && alive(worker)) process.kill(worker, "SIGKILL");
  }
});
