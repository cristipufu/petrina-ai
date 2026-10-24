import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { EngineClient } from "./client.js";
import { Coordination, serial, type Result } from "../src/coordination.js";
import { EngineLifecycle, LifecycleStore } from "../src/lifecycle.js";
import { FolderLock, removeConnection, writeConnection } from "../src/instance.js";
import { serve } from "../src/server.js";
import { EngineProcess, HARNESS, Fakes, engineEnv, removeDir, tempDir, waitFor, SLOW } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const kind of ["stop", "restart"] as const) it(`signals only accepted desktop ${kind} handoffs, and clears a failed handoff`, async () => {
  const home = tempDir("petrina-desktop-handoff-signal-");
  roots.push(home);
  const e = new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
  e.schedule = () => {};
  new Coordination(e);
  const store = new LifecycleStore(home);
  const signals: boolean[] = [];
  const lifecycle = new EngineLifecycle(e, store, async () => { throw new Error("controlled handoff failure"); }, (active) => signals.push(active));
  let unblock!: () => void;
  const hold = new Promise<void>((resolve) => { unblock = resolve; });
  e.settling.set("admitted", hold);
  try {
    expect((await lifecycle.request(kind, { requestId: `accepted-${kind}` })).outcome).toBe("pending");
    expect(signals).toEqual([true]);
    expect((await lifecycle.request(kind, { requestId: `accepted-${kind}` })).outcome).toBe("pending");
    expect(signals).toEqual([true, true]);
    unblock();
    e.settling.delete("admitted");
    await waitFor(() => store.current?.phase === "failed", "the controlled restart handoff failure");
    expect(signals).toEqual([true, true, false]);
    expect((await lifecycle.request(kind, { requestId: `accepted-${kind}` })).outcome).toBe("failed");
    expect(signals).toEqual([true, true, false]);
  } finally {
    unblock(); e.settling.delete("admitted"); lifecycle.close(); store.close(); await e.shutdown();
  }
});

for (const kind of ["pause", "restart"]) it(`a disconnected ${kind} follower cannot reserve a new effect after the observed operation changes`, () => {
  const home = tempDir("petrina-raced-lifecycle-follower-");
  roots.push(home);
  const store = new LifecycleStore(home);
  try {
    store.begin(kind, { requestId: "observed" }, "paused");
    const observed = store.current!;
    expect(store.follow(kind, { requestId: "following" }, observed).outcome).toBe("pending");
    store.finish("completed");
    store.begin("resume", { requestId: "unrelated-control" }, "running");
    store.finish("completed");
    expect(store.follow(kind, { requestId: "raced-follower" }, observed).outcome).toBe("disconnected");
    expect(store.receipt("raced-follower")).toBeUndefined();
    expect(store.current!.id).toBe("unrelated-control");
    expect(store.follow(kind, { requestId: "following" }, observed).outcome).toBe("completed");
    expect(store.follow("stop", { requestId: "following" }, observed).outcome).toBe("conflict");
  } finally { store.close(); }
});

for (const next of ["resume", "stop", "restart"]) it(`a lost ${next} reply during a pause cannot reserve a receipt without applying its live engine effects`, async () => {
  const home = tempDir("petrina-lost-lifecycle-");
  roots.push(home);
  const e = new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
  e.schedule = () => {};
  const ownership = FolderLock.take(home)!;
  const store = new LifecycleStore(home);
  let stops = 0;
  const lifecycle = new EngineLifecycle(e, store, async () => { stops++; store.finish("completed"); });
  const token = "lost-reply-connection-key-12345678";
  const server = serve(e, { port: 0, token, lifecycle });
  writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
  let unblock!: () => void;
  let queued: Promise<Result> | undefined;
  e.settling.set("admitted-work", new Promise(() => {}));
  try {
    expect((await lifecycle.request("pause", { requestId: "pause" })).outcome).toBe("pending");
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const held = serial(e, () => gate);
    // Stand-in transport: submit behind another app action, then lose the reply. Offline
    // recovery runs before the serialized engine request has had a chance to apply itself.
    const dropped = new EngineClient(home, () => { throw new Error("must not launch"); });
    (dropped as unknown as { request: (name: string, args: Record<string, unknown>) => Promise<Result> }).request = async (name, args) => {
      queued = lifecycle.request(name.slice(7), args);
      return { outcome: "disconnected" };
    };
    const args = { requestId: "lost-control" };
    const unknown = await dropped.call(`engine.${next}`, args);
    expect(unknown.outcome).toBe("disconnected");
    expect(store.receipt(args.requestId)).toBeUndefined();
    expect(store.current?.kind).toBe("pause");
    unblock();
    await held;
    expect((await queued)!.outcome).toBe(next === "resume" ? "completed" : "pending");
    expect(e.s.pool.paused).toBe(next !== "resume");
    expect(e.draining).toBe(next !== "resume");
    const client = new EngineClient(home);
    expect((await client.call(`engine.${next}`, args)).outcome).toBe(next === "resume" ? "completed" : "pending");
    if (next !== "resume") {
      expect(() => e.setPoolPaused(false)).toThrow("stopping or restarting");
      expect((await client.call("engine.resume", { requestId: "cannot-reopen-admissions" })).outcome).toBe("conflict");
    }
    e.settling.clear();
    if (next !== "resume") await waitFor(() => store.current?.phase === "completed", "the recovered drain to finish");
    const finished = await client.call(`engine.${next}`, { ...args, wait: true, timeoutMs: 1000 * SLOW });
    expect(finished.outcome).toBe("completed");
    expect(finished.operation).toHaveProperty("kind", next);
    expect(stops).toBe(next === "resume" ? 0 : 1);
    expect(store.receipt("pause")!.outcome).toBe("superseded");
  } finally {
    unblock?.();
    await queued;
    e.settling.clear(); lifecycle.close(); server.stop(true); ownership.release(); store.close();
    await e.shutdown();
  }
});

it("does not claim a silent, still living pause owner is ready or replace it", async () => {
  const home = tempDir("petrina-silent-pause-owner-");
  roots.push(home);
  const store = new LifecycleStore(home);
  store.begin("pause", { requestId: "pause" }, "paused");
  writeConnection(home, { api: "http://127.0.0.1:1", url: "ws://127.0.0.1:1/ws", pid: process.pid, token: "silent-owner-connection-key-12345" });
  let launches = 0;
  const client = new EngineClient(home, () => { launches++; });
  try {
    expect((await client.call("engine.start", { requestId: "start" })).outcome).toBe("disconnected");
    expect((await client.call("engine.status")).status).toBe("unresponsive");
    expect(store.receipt("start")).toBeUndefined();
    expect(store.current?.phase).toBe("draining");
    expect(launches).toBe(0);
  } finally { store.close(); }
});

for (const previous of ["unfinished-removed", "unfinished-stale", "completed"] as const) it(`starts once with saved paused scheduling after a ${previous} pause lost its engine`, async () => {
  const root = tempDir("petrina-start-after-pause-");
  roots.push(root);
  const home = join(root, "home"), fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  // Persist the state an app leaves behind when it closes during a pause. Its connection
  // is normally removed; a crash may instead leave a dead connection on disk.
  const before = new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
  before.setPoolPaused(true);
  await before.shutdown();
  const store = new LifecycleStore(home);
  store.begin("pause", { requestId: "old-pause" }, "paused");
  if (previous === "completed") store.finish("completed");
  if (previous === "unfinished-stale") {
    const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { env: engineEnv(home), stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    writeConnection(home, { api: "http://127.0.0.1:1", url: "ws://127.0.0.1:1/ws", pid: dead.pid, token: "dead-connection-key-1234567890123" });
  }
  let launches = 0;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const client = new EngineClient(home, () => {
    launches++;
    child = Bun.spawn([process.execPath, HARNESS, home, fakes.dir], { env: { ...engineEnv(home), PETRINA_LIFECYCLE_REPLACEMENT: "1" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return child.pid;
  });
  try {
    const args = { requestId: "start-once", wait: true, timeoutMs: 30000 * SLOW };
    const started = await client.call("engine.start", args);
    expect(started.outcome).toBe("completed");
    expect(launches).toBe(1);
    expect((await client.call("engine.status")).status).toBe("paused");
    expect(store.receipt("old-pause")!.outcome).toBe(previous === "completed" ? "completed" : "failed");
    expect((await client.call("engine.start", args)).outcome).toBe("completed");
    expect(launches).toBe(1);
    const lock = FolderLock.take(home);
    try { expect(lock).toBeUndefined(); } finally { lock?.release(); }
  } finally {
    await client.call("engine.stop", { requestId: "cleanup", wait: true, timeoutMs: 10000 * SLOW });
    child?.kill("SIGKILL");
    await child?.exited;
    store.close();
  }
});

for (const noticedBy of ["app", "status", "resume"] as const) for (const staleConnection of [false, true])
it(`desktop reconnects once after an interrupted pause noticed by ${noticedBy}, with a ${staleConnection ? "stale" : "removed"} connection`, async () => {
  const root = tempDir("petrina-desktop-after-pause-");
  roots.push(root);
  const home = join(root, "home"), fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  const before = new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
  before.setPoolPaused(true);
  await before.shutdown();
  const store = new LifecycleStore(home);
  store.begin("pause", { requestId: "interrupted-pause" }, "paused");
  if (staleConnection) {
    const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { env: engineEnv(home), stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    writeConnection(home, { api: "http://127.0.0.1:1", url: "ws://127.0.0.1:1/ws", pid: dead.pid, token: "closed-pause-connection-key-12345" });
  }
  const client = new EngineClient(home, () => { throw new Error("the desktop owns recovery"); });
  const children: EngineProcess[] = [];
  try {
    if (noticedBy === "status") expect((await client.call("engine.status")).status).toBe("failed");
    if (noticedBy === "resume") expect((await client.call("engine.resume", { requestId: "resume-closed-engine" })).outcome).toBe("invalid");
    if (noticedBy !== "app") expect(store.receipt("interrupted-pause")!.outcome).toBe("failed");
    await Promise.all([0, 1].map(async () => { children.push(await EngineProcess.harness(home, fakes.dir)); }));
    expect(children.map((child) => child.hello.type).sort()).toEqual(["ready", "running"]);
    await waitFor(async () => (await client.call("engine.status")).status === "paused", "paused scheduling after desktop recovery");
    if (noticedBy === "app") await waitFor(() => store.receipt("interrupted-pause")!.outcome === "completed", "the original pause to finish draining");
    expect(store.receipt("interrupted-pause")!.outcome).toBe(noticedBy === "app" ? "completed" : "failed");
    const reconnect = await EngineProcess.harness(home, fakes.dir);
    children.push(reconnect);
    expect(reconnect.hello.type).toBe("running");
    expect(await reconnect.exited(10000 * SLOW)).toBe(0);
    if (noticedBy !== "app") {
      expect(store.current).toHaveProperty("kind", "start");
      expect(store.current).toHaveProperty("phase", "completed");
    }
    const lock = FolderLock.take(home);
    try { expect(lock).toBeUndefined(); } finally { lock?.release(); }
  } finally {
    await client.call("engine.stop", { requestId: "cleanup-desktop-pause", wait: true, timeoutMs: 10000 * SLOW });
    for (const child of children) { child.proc.kill("SIGKILL"); await child.proc.exited; }
    store.close();
  }
});

for (const ending of ["restart-starting", "restart-draining", "stop-stopping"] as const) it(`desktop recovery fails a dead ${ending} handoff and concurrent reconnects start exactly one engine`, async () => {
  const root = tempDir("petrina-dead-desktop-handoff-");
  roots.push(root);
  const home = join(root, "home"), fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  const original = await EngineProcess.harness(home, fakes.dir);
  const paused = ending === "restart-starting";
  if (paused) await original.act("setPoolPaused", true);
  await original.kill();
  const store = new LifecycleStore(home);
  const [kind, phase] = ending.split("-") as ["restart" | "stop", "starting" | "draining" | "stopping"];
  store.begin(kind, { requestId: "dead-handoff" }, paused ? "paused" : "running");
  store.finish(phase);
  if (phase === "starting") {
    store.noteLauncher(original.proc.pid);
    removeConnection(home, original.proc.pid);
  }
  const children: EngineProcess[] = [];
  try {
    await Promise.all([0, 1].map(async () => { children.push(await EngineProcess.harness(home, fakes.dir)); }));
    expect(children.map((child) => child.hello.type).sort()).toEqual(["ready", "running"]);
    expect(store.receipt("dead-handoff")!.outcome).toBe("failed");
    expect(store.current).toHaveProperty("kind", "start");
    expect(store.current).toHaveProperty("phase", "completed");
    const client = new EngineClient(home, () => { throw new Error("retries must not launch"); });
    expect((await client.call(`engine.${kind}`, { requestId: "dead-handoff", wait: true })).outcome).toBe("failed");
    expect((await client.call("engine.status")).status).toBe(paused ? "paused" : "running");
    for (const child of children.filter((child) => child.hello.type === "running")) expect(await child.exited(10000 * SLOW)).toBe(0);
    const owner = children.find((child) => child.hello.type === "ready")!;
    expect((await client.call("engine.status")).operation).toHaveProperty("id", store.current!.id);
    await owner.quit();
  } finally {
    for (const child of children) { child.proc.kill("SIGKILL"); await child.proc.exited; }
    store.close();
  }
});
