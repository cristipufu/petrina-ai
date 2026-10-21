import { afterAll, expect, it, spyOn } from "bun:test";
import { getEventListeners } from "node:events";
import * as processes from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../src/acp-run.js";
import { AgentBrowser } from "../src/browser.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { removeDir, tempDir, waitFor } from "./support.js";

const root = tempDir("petrina-agent-lifetime-");
afterAll(() => removeDir(root));
const profile = ENGINE_PROFILES.find(profile => profile.id === "sol-high")!;
const command = [process.execPath, join(import.meta.dir, "fake-agent.ts")];
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };

it("stops a process aborted synchronously by its ownership callback without opening a browser", async () => {
  const browser = spyOn(AgentBrowser, "start");
  try {
    for (const probe of [false, true]) {
      const controller = new AbortController();
      let child: ChildProcess | undefined;
      const error = await AgentRun.start({ profile, cwd: root, command: [...command, "--hang"], callbacks, probe, signal: controller.signal, onProcess: process => { child = process; controller.abort(); } }).then(async run => { await run.stop(); return undefined; }, error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Stopped before the agent started");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      if (child) await new Promise<void>(done => { if (child!.exitCode !== null || child!.signalCode !== null) done(); else child!.once("exit", () => done()); });
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    }
    expect(browser).not.toHaveBeenCalled();
  } finally { browser.mockRestore(); }
});

it("releases stopped and failed runs from a shared task cancellation signal", async () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  for (let n = 0; n < 3; n++) {
    const run = await AgentRun.start({ profile, cwd: root, command, callbacks, signal: controller.signal, probe: true });
    await run.stop();
    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  }
  await expect(AgentRun.start({ profile, cwd: root, command: [...command, "--logged-out"], callbacks, signal: controller.signal, probe: true })).rejects.toThrow();
  expect(getEventListeners(controller.signal, "abort").length).toBe(before);
});

it("does not retain completed turns on the live agent's process", async () => {
  let child: ChildProcess | undefined;
  const run = await AgentRun.start({ profile, cwd: root, command, callbacks, signal: new AbortController().signal, browser: false, onProcess: process => { child = process; } });
  try {
    const before = child!.listenerCount("exit");
    for (let n = 0; n < 3; n++) {
      await run.prompt("You are the Researcher in Petrina. Hand back notes.");
      expect(child!.listenerCount("exit")).toBe(before);
    }
  } finally { await run.stop(); }
});

for (const firstTimesOut of [true, false]) for (const startsLate of [false, true]) it.skipIf(process.platform === "win32")(`finds detached work ${startsLate ? "started during stopping" : "already running"} within the quit limit when the first process scan ${firstTimesOut ? "times out" : "succeeds"}`, async () => {
  const dir = tempDir("petrina-stop-scan-");
  const record = join(dir, "worker-pid");
  const workerReady = join(dir, "worker-ready");
  const scanner = join(dir, "scan.ts"), agent = join(dir, "agent.ts");
  // The scan's real timeout is the behavior under test. Its stand-in has no child to orphan
  // when killed; successful scans still inspect the actual process tree.
  writeFileSync(scanner, `if (process.argv[2] === "timeout") await Bun.sleep(60_000);
await Bun.sleep(100);
const result = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid="]);
process.stdout.write(result.stdout);
process.exit(result.exitCode);`);
  const worker = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); require("node:fs").writeFileSync(${JSON.stringify(workerReady)}, "ready");`;
  writeFileSync(agent, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const startWorker = () => { const child = spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { detached: true, stdio: "ignore" }); writeFileSync(${JSON.stringify(record)}, String(child.pid)); child.unref(); };
${startsLate ? 'process.once("SIGTERM", startWorker);' : "startWorker();"}
process.argv.push("--stubborn");
await import(${JSON.stringify(join(import.meta.dir, "fake-agent.ts"))});`);
  // Warm the helper before any stop timer starts, keeping first-run setup outside the deadline.
  const ready = Bun.spawn([process.execPath, scanner, "fast"], { stdout: "ignore", stderr: "pipe" });
  expect(await ready.exited, await new Response(ready.stderr).text()).toBe(0);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const workerPid = () => existsSync(record) ? Number(readFileSync(record, "utf8")) || undefined : undefined;
  const original = processes.execFile;
  const scanned: boolean[] = [];
  let scans = 0, incomplete = 0;
  let child: ChildProcess | undefined, run: AgentRun | undefined;
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps") return Reflect.apply(original, processes, args);
    const mode = ++scans === 1 && firstTimesOut ? "timeout" : "fast";
    const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    return Reflect.apply(original, processes, [process.execPath, [scanner, mode], args[2], (error: Error | null, stdout: string, stderr: string) => {
      scanned.push(!error);
      done(error, stdout, stderr);
    }]);
  }) as typeof processes.execFile);
  try {
    run = await AgentRun.start({ profile, cwd: dir, command: [process.execPath, agent], callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; } }, signal: new AbortController().signal, browser: false, onProcess: process => { child = process; } });
    if (!startsLate) await waitFor(() => existsSync(workerReady), "the detached worker to be ready before stopping");
    const from = Date.now();
    const stopping = run.stop();
    const pid = await waitFor(workerPid, "the detached worker to start");
    const complete = await stopping;
    expect(Date.now() - from).toBeLessThan(7_000);
    expect([child!.pid!, pid].filter(alive)).toEqual([]);
    expect(scanned).toEqual([!firstTimesOut, true]);
    expect(complete).toBe(!firstTimesOut);
    expect(incomplete).toBe(firstTimesOut ? 1 : 0);
    expect(alive(unrelated.pid)).toBe(true);
  } finally {
    // Reclaim the missed worker even when this regression is run against broken shutdown code.
    for (const pid of [child?.pid, workerPid()].filter((pid): pid is number => !!pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Not a group leader, or already stopped. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
    await run?.stop();
    scan.mockRestore();
    unrelated.kill("SIGKILL");
    await unrelated.exited;
    await waitFor(() => ![child?.pid, workerPid()].some(pid => pid && alive(pid)), "the fixture's agent and detached worker to stop");
    removeDir(dir);
  }
});
