import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { runCommand, startCommand, type Started } from "@petrina/test-support/commands";
import { describe as originalDescribe } from "bun:test";
import { afterAll, expect, it, spyOn } from "bun:test";

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_EXIT_UNREPORTED, completeAll } from "@petrina/core";
import { childState, CLEANUP_INCOMPLETE, parseDescendants, readProcessList } from "@petrina/platform/process-tree";
import { defunctProcess } from "@petrina/test-support/defunct-process";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { runChecks } from "../../fixtures/check-runner.js";
const roots: string[] = [];
const leases = new Set<ProcessLease>();
afterAll(async () => { await completeAll([...leases].map(lease => lease.close())); roots.forEach(removeDir); });
const ownedLease = async () => { const lease = await createProcessLease(); leases.add(lease); return lease; };
const root = (prefix: string) => { const dir = tempDir(prefix); roots.push(dir); return dir; };

originalDescribe("a check that misbehaves", () => {
for (const ending of ["abort", "timeout"] as const) it.skipIf(process.platform === "win32")(`stops detached children and grandchildren on ${ending}, leaving an unrelated process alive`, async () => {
    const lease = await ownedLease();
    const dir = root("petrina-checks-detached-");
    const worker = join(dir, "worker.ts");
    const parent = join(dir, "parent.ts");
    const childPid = join(dir, "child.pid");
    const grandPid = join(dir, "grandchild.pid");
    const ready = join(dir, "ready");
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
    let sentinel!: Started;
    const sentinelWork = runCommand([process.execPath, "-e", lease.program("await new Promise(() => setInterval(() => {}, 1000));")], {
      timeoutMs: 60_000 * SLOW, start: (argv, options) => sentinel = startCommand(argv, options),
    });
    const stop = new AbortController();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const workers = () => [childPid, grandPid].filter(existsSync).map((file) => Number(readFileSync(file, "utf8")));
    let running: Promise<unknown> | undefined;
    try {
      running = runChecks(dir, [{ name: "Detached workers", argv: [process.execPath, parent] }], process.env, 20_000, stop.signal, logs);
      // Readiness precedes the diagnostic: cancellation must wait for the output it asserts.
      await waitFor(() => existsSync(ready) && readdirSync(logs).some(file => readFileSync(join(logs, file), "utf8").includes("both detached workers")), "both detached check workers and their captured start message");
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
    } finally {
      stop.abort();
      await lease.close();
      sentinel.kill("SIGKILL");
      await Promise.allSettled([running, sentinelWork]);
    }
  });
});

originalDescribe("a check that misbehaves", () => {
for (const outcome of ["recovers", "cannot read"] as const) it.skipIf(process.platform === "win32")(`reports an unavailable process tree accurately when cleanup ${outcome}`, async () => {
    const lease = await ownedLease();
    const dir = root("petrina-checks-process-list-");
    const worker = join(dir, "worker.ts");
    const parent = join(dir, "parent.ts");
    const childPid = join(dir, "child.pid");
    const grandPid = join(dir, "grandchild.pid");
    const parentPid = join(dir, "parent.pid");
    const ready = join(dir, "ready");
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
    let sentinel!: Started;
    const sentinelWork = runCommand([process.execPath, "-e", lease.program("await new Promise(() => setInterval(() => {}, 1000));")], {
      timeoutMs: 60_000 * SLOW, start: (argv, options) => sentinel = startCommand(argv, options),
    });
    const stop = new AbortController();
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
      running = runChecks(dir, [{ name: "Detached workers", argv: [process.execPath, parent] }], process.env, 20_000, stop.signal, join(dir, "logs"), processList);
      await waitFor(() => existsSync(ready), "both detached check workers to start");
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
    } finally {
      stop.abort();
      await lease.close();
      sentinel.kill("SIGKILL");
      await Promise.allSettled([running, sentinelWork]);
    }
  });
});

originalDescribe("a check that misbehaves", () => {
it.skipIf(process.platform === "win32")("ends everything a check started when it runs out of time", async () => {
    const started = Date.now();
    // The background sleep holds the output open: only stopping the whole group ends it quickly.
    const [run] = await runChecks(root("petrina-checks-group-"), [{ name: "Hangs", argv: ["sh", "-c", "sleep 30 & echo started; wait"] }], process.env, 500);
    expect(run!.timedOut).toBe(true);
    expect(run!.output).toContain("started");
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

originalDescribe("a check whose exit the system never reports", () => {
it.skipIf(process.platform === "win32")("settles within the grace as unknown, keeps its output, and stops what it started", async () => {
    // What a lost exit looks like: the output ended, the runtime never reports the exit, and the system shows the
    // check defunct. A real defunct process stands in for the check; the runtime's report never comes.
    const dir = root("petrina-checks-unreported-");
    const defunct = await defunctProcess();
    const standIn = { pid: defunct.pid, exited: new Promise<number>(() => {}), stdout: new Response("finished\n").body!, stderr: new Response("").body! } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn");
    try {
      await waitFor(async () => (await childState(defunct.pid)) === "ended", "the stand-in to be defunct", 10_000);
      spawning.mockReturnValueOnce(standIn);
      const started = Date.now();
      const [run] = await runChecks(dir, [{ name: "Ended quietly", argv: ["petrina-ended-quietly"] }], process.env, 60_000 * SLOW, undefined, join(dir, "logs"));
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
    } finally {
      spawning.mockRestore();
      await defunct.release();
    }
  });
});
