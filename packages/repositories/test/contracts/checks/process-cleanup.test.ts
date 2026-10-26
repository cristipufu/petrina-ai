import { describe as originalDescribe } from "bun:test";
import { afterEach, afterAll, expect, it, spyOn } from "bun:test";

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_EXIT_UNREPORTED } from "@petrina/core";
import { childState, CLEANUP_INCOMPLETE, parseDescendants, readProcessList } from "@petrina/platform/process-tree";
import { defunctProcesses } from "@petrina/test-support/defunct-process";

const defuncts = defunctProcesses();
afterEach(() => defuncts.close());
afterAll(() => defuncts.close());
import { waitFor } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { runChecks } from "../../fixtures/check-runner.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { checkExecutionFixture } from "../../fixtures/check-execution.js";
import { checkProcessFixtures } from "../../fixtures/check-processes.js";
const worlds = checkProcessFixtures();
afterAll(worlds.close);

originalDescribe("a check that misbehaves", () => {
for (const ending of ["abort", "timeout"] as const) it.skipIf(process.platform === "win32")(`stops detached children and grandchildren on ${ending}, leaving an unrelated process alive`, async () => {
  await worlds.use("petrina-checks-detached-", async fixture => {
    const lease = await fixture.lease();
    const dir = fixture.dir;
    const worker = join(dir, "worker.ts");
    const parent = join(dir, "parent.ts");
    const childPid = join(dir, "child.pid");
    const grandPid = join(dir, "grandchild.pid");
    const ready = join(dir, "ready");
    fixture.observeActor(childPid); fixture.observeActor(grandPid);
    const logs = join(dir, "logs");
    const ownedProgram = (file: string, body: string) => {
      const implementation = file + ".body.ts";
      writeFileSync(implementation, body);
      writeFileSync(file, lease.program(`await import(${JSON.stringify(implementation)}); await new Promise(() => {});`));
    };
    ownedProgram(worker, `import { spawn } from "node:child_process"; import { renameSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[2] + ".tmp", String(process.pid)); renameSync(process.argv[2] + ".tmp", process.argv[2]);
if (process.argv[3]) spawn(process.execPath, [${JSON.stringify(worker)}, process.argv[3]], { detached: true, stdio: "ignore" }).unref();
setInterval(() => {}, 1000);`);
    ownedProgram(parent, `import { spawn } from "node:child_process"; import { existsSync, writeFileSync } from "node:fs";
spawn(process.execPath, [${JSON.stringify(worker)}, ${JSON.stringify(childPid)}, ${JSON.stringify(grandPid)}], { detached: true, stdio: "ignore" }).unref();
while (!existsSync(${JSON.stringify(grandPid)})) await Bun.sleep(20);
writeFileSync(${JSON.stringify(ready)}, "ready"); console.log("The check started both detached workers");
setInterval(() => {}, 1000);`);
    const sentinel = await fixture.sentinel();
    const stop = new AbortController(); fixture.stop(() => stop.abort());
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const workers = () => [childPid, grandPid].filter(existsSync).map((file) => Number(readFileSync(file, "utf8")));
    let running: Promise<unknown> | undefined;
    try {
      running = fixture.checks( [{ name: "Detached workers", argv: [process.execPath, parent] }], process.env, 20_000, stop.signal, logs);
      // Readiness precedes the diagnostic: cancellation must wait for the output it asserts.
      await waitFor(() => existsSync(ready) && readdirSync(logs).some(file => readFileSync(join(logs, file), "utf8").includes("both detached workers")), "both detached check workers and their captured start message", undefined, { during: running });
      expect(workers()).toHaveLength(2);
      expect(workers().every(alive)).toBe(true);
      const stoppingAt = Date.now();
      if (ending === "abort") stop.abort();
      const [run] = await running as Awaited<ReturnType<typeof runChecks>>;
      expect(run!.ok).toBe(false);
      expect(!!run!.timedOut).toBe(ending === "timeout");
      expect(readFileSync(run!.logPath!, "utf8")).toContain("both detached workers");
      if (ending === "abort") expect(Date.now() - stoppingAt).toBeLessThan(5000);
      await waitFor(() => workers().every((pid) => !alive(pid)), "the detached workers to exit", 3000);
      expect(alive(sentinel.pid!)).toBe(true);
    } finally { stop.abort(); }
  });
  });
});

originalDescribe("a check that misbehaves", () => {
for (const outcome of ["recovers", "cannot read"] as const) it.skipIf(process.platform === "win32")(`reports an unavailable process tree accurately when cleanup ${outcome}`, async () => {
  await worlds.use("petrina-checks-process-list-", async fixture => {
    const lease = await fixture.lease();
    const dir = fixture.dir;
    const worker = join(dir, "worker.ts");
    const parent = join(dir, "parent.ts");
    const childPid = join(dir, "child.pid");
    const grandPid = join(dir, "grandchild.pid");
    const parentPid = join(dir, "parent.pid");
    const ready = join(dir, "ready");
    fixture.observeActor(childPid); fixture.observeActor(grandPid);
    const ownedProgram = (file: string, body: string) => {
      const implementation = file + ".body.ts";
      writeFileSync(implementation, body);
      writeFileSync(file, lease.program(`await import(${JSON.stringify(implementation)}); await new Promise(() => {});`));
    };
    ownedProgram(worker, `import { spawn } from "node:child_process"; import { renameSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[2] + ".tmp", String(process.pid)); renameSync(process.argv[2] + ".tmp", process.argv[2]);
if (process.argv[3]) spawn(process.execPath, [${JSON.stringify(worker)}, process.argv[3]], { detached: true, stdio: "ignore" }).unref();
setInterval(() => {}, 1000);`);
    ownedProgram(parent, `import { spawn } from "node:child_process"; import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(parentPid)}, String(process.pid));
spawn(process.execPath, [${JSON.stringify(worker)}, ${JSON.stringify(childPid)}, ${JSON.stringify(grandPid)}], { detached: true, stdio: "ignore" }).unref();
while (!existsSync(${JSON.stringify(grandPid)})) await Bun.sleep(20);
writeFileSync(${JSON.stringify(ready)}, "ready"); console.log("The check started both detached workers");
setInterval(() => {}, 1000);`);
    const sentinel = await fixture.sentinel();
    const stop = new AbortController(); fixture.stop(() => stop.abort());
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const workers = () => [childPid, grandPid].filter(existsSync).map((file) => Number(readFileSync(file, "utf8")));
    const timeouts: number[] = [];
    let captured: number[] = [];
    const processList = async (timeout: number) => {
      timeouts.push(timeout);
      const pids = workers();
      expect(alive(Number(readFileSync(parentPid, "utf8")))).toBe(true);
      expect(pids).toHaveLength(2);
      expect(pids.every(alive)).toBe(true);
      expect(pids).not.toContain(sentinel.pid);
      if (timeouts.length === 1) captured = [...pids];
      if (outcome === "cannot read" || timeouts.length === 1) return undefined;
      return readProcessList(timeout);
    };
    let running: Promise<unknown> | undefined;
    try {
      running = fixture.checks( [{ name: "Detached workers", argv: [process.execPath, parent] }], process.env, 20_000, stop.signal, join(dir, "logs"), processList);
      await waitFor(() => existsSync(ready), "both detached check workers to start", undefined, { during: running });
      const parentId = Number(readFileSync(parentPid, "utf8"));
      const found = parseDescendants(await readProcessList(4_000) ?? "", [parentId]);
      for (const pid of workers()) expect(found).toContain(pid);
      expect(found).not.toContain(sentinel.pid);
      const stoppingAt = Date.now();
      stop.abort();
      const [run] = await running as Awaited<ReturnType<typeof runChecks>>;
      expect(run!.ok).toBe(false);
      expect(run!.timedOut).toBeUndefined();
      expect(Date.now() - stoppingAt).toBeLessThan(5000);
      expect(timeouts).toEqual([1_000, 2_000]);
      expect(captured).toHaveLength(2);
      expect(alive(parentId)).toBe(false);
      expect(alive(sentinel.pid!)).toBe(true);
      if (outcome === "recovers") {
        expect(run!.cleanupIncomplete).toBeUndefined();
        expect(run!.execution?.cleanup).toBe("confirmed");
        expect(run!.output).not.toContain(CLEANUP_INCOMPLETE);
        expect(captured.every((pid) => !alive(pid))).toBe(true);
      } else {
        expect(run!.cleanupIncomplete).toBe(true);
        expect(run!.execution?.cleanup).toBe("unconfirmed");
        expect(run!.output).toContain(CLEANUP_INCOMPLETE);
        expect(captured.every(alive)).toBe(true);
      }
    } finally { stop.abort(); }
  });
  });
});

originalDescribe("a check that misbehaves", () => {
it.skipIf(process.platform === "win32")("ends everything a check started when it runs out of time", async () => {
    let owner: Awaited<ReturnType<typeof checkExecutionFixture>> | undefined;
    await setupWithCleanup(async () => {
      // The real parent and same-group output holder are ready before the unchanged500ms allowance starts.
      owner = await checkExecutionFixture("group-output", { name: "Hangs", timeoutMs: 500 });
      expect(owner.actorPid()).toBeDefined();
      expect(await childState(owner.actorPid()!)).toBe("running");
      const started = Date.now();
      const [run] = await owner.run();
      expect(run!.timedOut).toBe(true);
      expect(run!.output).toContain("started");
      expect(Date.now() - started).toBeLessThan(4000);
      expect(await childState(owner.actorPid()!)).toBe("ended");
    }, async () => { await owner?.close(); });
    await owner?.close();
  });
});

originalDescribe("a check whose exit the system never reports", () => {
it.skipIf(process.platform === "win32")("settles within the grace as unknown, keeps its output, and stops what it started", async () => defuncts.use(async defunct => {
    // What a lost exit looks like: the output ended, the runtime never reports the exit, and the system shows the
    // check defunct. A real defunct process stands in for the check; the runtime's report never comes.
  await worlds.use("petrina-checks-unreported-", async fixture => {
    const dir = fixture.dir;
    fixture.stop(() => defunct.release());

    const standIn = { pid: defunct.pid, exited: new Promise<number>(() => {}), stdout: new Response("finished\n").body!, stderr: new Response("").body! } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
    let spawning: ReturnType<typeof spyOn<typeof Bun, "spawn">> | undefined;
    fixture.restore(() => spawning?.mockRestore());
    spawning = spyOn(Bun, "spawn");
    {
      await waitFor(async () => (await childState(defunct.pid)) === "ended", "the stand-in to be defunct", 10_000);
      spawning.mockReturnValueOnce(standIn);
      const started = Date.now();
      const [run] = await fixture.run(() => runChecks(dir, [{ name: "Ended quietly", argv: ["petrina-ended-quietly"] }], process.env, 60_000 * SLOW, undefined, join(dir, "logs")));
      expect(Date.now() - started).toBeLessThan(30_000 * SLOW);
      expect(run!.ok).toBe(false);
      expect(run!.timedOut).toBeUndefined();
      expect(run!.output).toContain("finished");
      expect(run!.output).toContain(CHECK_EXIT_UNREPORTED);
      // A defunct check is not a running process: its cleanup is complete.
      expect(run!.cleanupIncomplete).toBeUndefined();
      expect(run!.output).not.toContain(CLEANUP_INCOMPLETE);
      expect(run!.logComplete).toBe(true);
      expect(run!.execution).toMatchObject({ exit: { status: "unreported" }, stdout: "eof", stderr: "eof", failure: { kind: "exit", message: CHECK_EXIT_UNREPORTED }, cleanup: "confirmed" });
    }
  });
  }));
});
