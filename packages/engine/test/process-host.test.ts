import { expect, it } from "bun:test";
import { createProcessHost, processHost, type ProcessDeadline, type ProcessHelper } from "../src/process-host.js";
import { EngineProcess, removeDir, SLOW, tempDir } from "./support.js";
import { childState } from "../src/process-tree.js";

function clock() {
  const pending = new Set<() => void>(), delays: number[] = [];
  const arm: ProcessDeadline = (expired, ms) => { pending.add(expired); delays.push(ms); return () => { pending.delete(expired); }; };
  return { pending, delays, arm };
}

it("owns process-group capability and spawn options for each supported platform", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const host = createProcessHost(platform);
    expect(host.groups).toBe(platform !== "win32");
    expect(host.ownedSpawn).toEqual({ detached: platform !== "win32", windowsHide: true });
    expect(typeof host.stopTree).toBe(platform === "win32" ? "function" : "undefined");
  }
});

it("stops a Windows tree with an argument array and cancels its own deadline on completion", async () => {
  const calls: unknown[] = [], killed: unknown[] = [], timing = clock();
  let answer!: (error: Error | null) => void;
  const helper: ProcessHelper = (command, args, options, done) => {
    calls.push({ command, args, options }); answer = done;
    return { kill(signal) { killed.push(signal); return true; } };
  };
  const result = createProcessHost("win32", helper, timing.arm).stopTree!(4321, 3000);
  const lateDeadline = [...timing.pending][0]!;
  expect(calls).toEqual([{ command: "taskkill", args: ["/pid", "4321", "/T", "/F"], options: { timeout: 3000, windowsHide: true } }]);
  expect(timing.delays).toEqual([3000]);
  answer(null);
  expect(await result).toBe(true);
  expect(timing.pending.size).toBe(0);
  lateDeadline();
  expect(killed).toEqual([]);
});

it("bounds a missing helper completion and ignores later success", async () => {
  const killed: unknown[] = [], timing = clock();
  let answer!: (error: Error | null) => void;
  const helper: ProcessHelper = (_command, _args, _options, done) => {
    answer = done;
    return { kill(signal) { killed.push(signal); return true; } };
  };
  const result = createProcessHost("win32", helper, timing.arm).stopTree!(1234, 3000);
  const expired = [...timing.pending][0]!;
  expired();
  expect(await result).toBe(false);
  expect(killed).toEqual(["SIGKILL"]);
  expect(timing.pending.size).toBe(0);
  answer(null); expired();
  expect(await result).toBe(false);
  expect(killed).toEqual(["SIGKILL"]);
});

it("reports failed or throwing helpers without a leftover deadline", async () => {
  for (const thrown of [false, true]) {
    const timing = clock();
    const helper: ProcessHelper = (_command, _args, _options, done) => {
      if (thrown) throw new Error("Native helper unavailable");
      done(new Error("Native helper failed"));
      return { kill() { throw new Error("A finished helper must not be stopped again"); } };
    };
    expect(await createProcessHost("win32", helper, timing.arm).stopTree!(1234, 3000)).toBe(false);
    expect(timing.pending.size).toBe(0);
    expect(timing.delays).toEqual([]);
  }
});

it("refuses invalid process identities and deadlines before any native command", async () => {
  let calls = 0;
  const helper: ProcessHelper = () => { calls++; throw new Error("Must not launch"); };
  const host = createProcessHost("win32", helper);
  for (const pid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(await host.stopTree!(pid, 3000)).toBe(false);
  for (const ms of [0, -1, NaN, Infinity, 2_147_483_648]) expect(await host.stopTree!(1234, ms)).toBe(false);
  expect(calls).toBe(0);
});

it.skipIf(!processHost.stopTree)("stops a real owned Windows process through the production adapter", async () => {
  const root = tempDir("petrina-native-tree-");
  let engine: EngineProcess | undefined;
  try {
    engine = await EngineProcess.start(root, ["-e", 'console.log(JSON.stringify({ type: "ready", owned: true, url: "fixture", token: "fixture-only" })); await Bun.stdin.text();']);
    expect(await processHost.stopTree!(engine.proc.pid, 3000)).toBe(true);
    await engine.exited(10_000 * SLOW);
    expect(await childState(engine.proc.pid)).toBe("ended");
  } finally {
    if (engine && engine.proc.exitCode === null && engine.proc.signalCode === null) await engine.kill();
    removeDir(root);
  }
});
