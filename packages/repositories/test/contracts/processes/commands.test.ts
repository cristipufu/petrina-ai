import { afterEach, afterAll, describe, expect, it } from "bun:test";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { currentSlow } from "@petrina/test-support/slow";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import * as operations from "../../../src/git.js";
import { childState } from "@petrina/platform/process-tree";
import { defunctProcesses } from "@petrina/test-support/defunct-process";

const defuncts = defunctProcesses();
afterEach(() => defuncts.close());
afterAll(() => defuncts.close());
import { firstLine, removeDir, waitFor, waitForFile } from "@petrina/test-support/fixtures";
import { testGitEnv } from "@petrina/test-support/test-git-env";

const temp = mkdtempSync(join(tmpdir(), "petrina-git-"));

describe("Petrina's own git steps", () => {
  afterAll(() => removeDir(temp));

  for (const ownHome of [false, true]) it(`removes its private Git helpers on exit${ownHome ? " inside the engine home" : " in the system temp folder"}`, async () => {
    const parent = join(temp, ownHome ? "helper-home" : "helper-temp");
    const release = join(temp, ownHome ? "release-home" : "release-temp");
    mkdirSync(parent);
    const env: NodeJS.ProcessEnv = { ...testGitEnv(), TMPDIR: parent, TMP: parent, TEMP: parent };
    delete env.PETRINA_HOME;
    if (ownHome) env.PETRINA_HOME = parent;
    const script = `import { existsSync } from "node:fs";
import { run } from ${JSON.stringify(join(import.meta.dir, "../../../src/git.ts"))};
const result = await run(["git", "config", "--get", "core.hooksPath"], ${JSON.stringify(temp)});
if (result.code) throw new Error(result.stderr);
console.log(result.stdout.trim());
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(20);`;
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: temp, env, stdout: "pipe", stderr: "pipe" });
    try {
      const helper = dirname(await firstLine(child.stdout));
      expect(helper.startsWith(parent + sep)).toBe(true);
      expect(existsSync(join(helper, "hooks"))).toBe(true);
      writeFileSync(release, "go");
      expect(await child.exited).toBe(0);
      expect(existsSync(helper)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it("keeps a command that closed its output running inside its allowance, and still reports its exit, its timeout and a lost exit plainly", async () => {
    const lease = await createProcessLease();
    const closed = `const { closeSync } = require("node:fs"); closeSync(1); closeSync(2);`;
    const command = (body: string) => [process.execPath, "-e", lease.program(body)];
    try {
      // A valid command that closes both pipes and keeps working: closed output is no evidence that it ended.
      const started = Date.now();
      const live = await operations.run(command(`${closed} await new Promise(resolve => setTimeout(resolve, 6_500));`), temp, undefined, { timeoutMs: 10_000 });
      expect(live).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(6_000);
      // An exit reported after the pipes close is an ordinary result; the time limit still ends one that runs past it.
      const reported = await operations.run(command(`require("node:fs").writeSync(1, "done\\n"); ${closed} await new Promise(resolve => setTimeout(resolve, 1_000)); process.exit(3);`), temp);
      expect(reported).toEqual({ code: 3, stdout: "done", stderr: "" });
      const limited = Date.now();
      const late = await operations.run(command(`${closed} await new Promise(resolve => setTimeout(resolve, 30_000));`), temp, undefined, { timeoutMs: 2_000 });
      expect(late).toEqual({ code: 124, stdout: "", stderr: "timed out", timedOut: true });
      expect(Date.now() - limited).toBeLessThan(operations.EXIT_GRACE_MS + 2_000);
    } finally { await lease.close(); }
  });

  it.skipIf(process.platform === "win32")("fails within a bounded grace when a command's exit is never reported, keeping its complete output", async () => defuncts.use(async defunct => {
    // What a lost exit looks like: the output ended, the runtime never reports the exit, and the system shows the
    // child gone or defunct. A real defunct process stands in for the child; the runtime's report never comes.
    const gone = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    const standIn = (pid: number, out: string, err: string) => ({ pid, exited: new Promise<number>(() => {}), stdout: new Response(out).body!, stderr: new Response(err).body!, kill() {} }) as unknown as ReturnType<typeof Bun.spawn>;
    try {
      await waitFor(async () => (await childState(defunct.pid)) === "ended", "the stand-in to be defunct", 10_000 * currentSlow());
      const started = Date.now();
      const lost = await operations.run(["git", "status"], temp, undefined, {
        start: () => standIn(defunct.pid, "finished\n", "complaint\n"),
      });
      const elapsed = Date.now() - started;
      expect(lost).toEqual({ code: 124, stdout: "finished", stderr: `complaint\n${operations.EXIT_UNREPORTED}`, timedOut: true, exitUnreported: true });
      expect(elapsed).toBeGreaterThanOrEqual(operations.EXIT_GRACE_MS);
      expect(elapsed).toBeLessThan(25_000 * currentSlow());
      // A child already collected without its exit reported, under a time limit that is not what ends the wait.
      const collected = await operations.run(["git", "status"], temp, undefined, {
        timeoutMs: 60_000 * currentSlow(),
        start: () => standIn(gone.pid, "", ""),
      });
      expect(collected).toEqual({ code: 124, stdout: "", stderr: operations.EXIT_UNREPORTED, timedOut: true, exitUnreported: true });
    } finally {
      await defunct.release();
    }
  }));

  it("bounds the whole command when an exited parent's child retains its output pipe", async () => {
    // Prepare both actors before measuring output draining: cold process startup is a separate contract.
    // Their real inherited descriptors stay open until the lease ends, never a self-expiring sleep.
    const lease = await createProcessLease();
    const ready = join(temp, "pipe-holder-ready"), parentReady = join(temp, "pipe-parent-ready"), release = join(temp, "pipe-parent-release");
    const child = lease.program(`require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready"); await new Promise(() => {});`);
    const parent = lease.program(`const { existsSync, writeFileSync } = require("node:fs");
      Bun.spawn([process.execPath, "--no-env-file", "-e", ${JSON.stringify(child)}], { stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true }).unref();
      while (!existsSync(${JSON.stringify(ready)})) await new Promise(resolve => setTimeout(resolve, 1));
      writeFileSync(${JSON.stringify(parentReady)}, "ready");
      while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 1));`);
    let command: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const owned = command = Bun.spawn([process.execPath, "-e", parent], { cwd: temp, env: testGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
      await waitForFile(parentReady, { during: owned.exited });
      const started = Date.now();
      const result = await operations.run([process.execPath, "-e", parent], temp, undefined, {
        timeoutMs: 200,
        start() { writeFileSync(release, "go"); return owned; },
      });
      expect(result).toMatchObject({ code: 124, timedOut: true });
      expect(result.stderr).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(1_500 * currentSlow());
      expect(existsSync(ready)).toBe(true);
      expect(owned.exitCode).toBe(0);
    } finally {
      await lease.close();
      if (command?.exitCode === null && command.signalCode === null) command.kill("SIGKILL");
      await command?.exited;
    }
  });

  it.skipIf(process.platform === "win32")("detects a lost exit even when the runtime never closes an output stream", async () => defuncts.use(async defunct => {
    let cancelled = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial diagnostic\n")); },
      cancel() { cancelled = true; },
    });
    try {
      await waitFor(async () => (await childState(defunct.pid)) === "ended", "the owned process to be defunct");
      const started = Date.now();
      const result = await operations.run(["git", "worktree", "prune"], temp, undefined, {
        start: () =>
          ({
            pid: defunct.pid,
            exited: new Promise<number>(() => {}),
            stdout,
            stderr: new Response("").body!,
            kill() {},
          }) as unknown as ReturnType<typeof Bun.spawn>,
      });
      expect(result).toEqual({ code: 124, timedOut: true, exitUnreported: true, stdout: "partial diagnostic", stderr: operations.EXIT_UNREPORTED });
      expect(Date.now() - started).toBeLessThan(25_000 * currentSlow());
      expect(cancelled).toBe(true);
    } finally { await defunct.release(); }
  }));
});
