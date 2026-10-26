import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { completeAll } from "@petrina/core";
import { afterEach } from "bun:test";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import { coordinatorStoreAfterSeed } from "../../fixtures/coordinator-lifecycle.js";
import { disconnectedCoordinator } from "../../fixtures/disconnected-coordinator.js";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { EngineClient } from "../../client.js";

import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { FolderLock, removeConnection, writeConnection } from "../../../src/instance.js";

import { EngineProcess, Fakes, removeDir, tempDir, waitFor, SLOW } from "../../support.js";
const roots: string[] = [];
const lifetimes = coordinatorLifetimes();
afterEach(() => lifetimes.close());
afterAll(() => roots.filter(root => !lifetimes.retained.has(root)).forEach(removeDir));

for (const noticedBy of ["app", "status", "resume"] as const) {
for (const staleConnection of [false, true])
{
it(`desktop reconnects once after an interrupted pause noticed by ${noticedBy}, with a ${staleConnection ? "stale" : "removed"} connection`, async () => {
  const root = tempDir("petrina-desktop-after-pause-");
  roots.push(root);
  let pendingSeed: Engine | undefined;
  const stopSeed = async () => { await pendingSeed?.shutdown(); pendingSeed = undefined; };
  let pendingStore: LifecycleStore | undefined;
  const closeStore = () => { pendingStore?.close(); pendingStore = undefined; };
  let pendingPeer: Awaited<ReturnType<typeof disconnectedCoordinator>> | undefined;
  const closePeer = async () => { await pendingPeer?.close(); pendingPeer = undefined; };
  const lifetime = await lifetimes.open(root, { async stopPeers() { await completeAll([Promise.resolve().then(stopSeed), Promise.resolve().then(closeStore), Promise.resolve().then(closePeer)]); } });
  let cleanup: (() => Promise<void>) | undefined;
  const close = async () => {
    await setupWithCleanup(async () => { await cleanup?.(); }, () => lifetime.close());
    await lifetime.close();
  };
  await setupWithCleanup(() => lifetime.prepare(async () => {
  const home = join(root, "home"), fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  const before = pendingSeed = new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
  before.setPoolPaused(true);
  const store = await coordinatorStoreAfterSeed(lifetime.signal, async () => {
    await before.shutdown(); pendingSeed = undefined;
  }, () => pendingStore = new LifecycleStore(home));
  store.begin("pause", { requestId: "interrupted-pause" }, "paused");
  const peer = pendingPeer = staleConnection ? await disconnectedCoordinator() : undefined;
  if (lifetime.signal.aborted) { await closePeer(); throw new Error("Coordinator setup closed while acquiring its peer"); }
  if (staleConnection) {
    const dead = lifetime.start(home, ["-e", "process.exit(0)"], {}, { input: "ignore" });
    await dead.exited;
    writeConnection(home, { api: peer!.api, url: peer!.url, pid: dead.pid, token: "closed-pause-connection-key-12345" });
  }
  const client = new EngineClient(home, () => { throw new Error("the desktop owns recovery"); });
  const children: EngineProcess[] = [];

  cleanup = async () => {
    try { await lifetime.prepare(() => client.call("engine.stop", { requestId: "cleanup-desktop-pause", wait: true, timeoutMs: 10000 * SLOW })); }
    finally { try { await lifetime.close(); } finally { try { closeStore(); } finally { await closePeer(); } } }

  };
    if (noticedBy === "status") expect((await client.call("engine.status")).status).toBe("failed");
    if (noticedBy === "resume") expect((await client.call("engine.resume", { requestId: "resume-closed-engine" })).outcome).toBe("invalid");
    if (noticedBy !== "app") expect(store.receipt("interrupted-pause")!.outcome).toBe("failed");
    await Promise.all([0, 1].map(async () => { children.push(await lifetime.harness(home, fakes.dir)); }));
    expect(children.map((child) => child.hello.type).sort()).toEqual(["ready", "running"]);
    await waitFor(async () => (await client.call("engine.status")).status === "paused", "paused scheduling after desktop recovery", undefined, { during: children.find(child => child.hello.type === "ready")!.proc.exited });
    if (noticedBy === "app") await waitFor(() => store.receipt("interrupted-pause")!.outcome === "completed", "the original pause to finish draining");
    expect(store.receipt("interrupted-pause")!.outcome).toBe(noticedBy === "app" ? "completed" : "failed");
    const reconnect = await lifetime.harness(home, fakes.dir);
    children.push(reconnect);
    expect(reconnect.hello.type).toBe("running");
    expect(await reconnect.exited(10000 * SLOW)).toBe(0);
    if (noticedBy !== "app") {
      expect(store.current).toHaveProperty("kind", "start");
      expect(store.current).toHaveProperty("phase", "completed");
    }
    const lock = FolderLock.take(home);
    try { expect(lock).toBeUndefined(); } finally { lock?.release(); }

  }), close);
  await close();
});
}
}

for (const ending of ["restart-starting", "restart-draining", "stop-stopping"] as const) {
it(`desktop recovery fails a dead ${ending} handoff and concurrent reconnects start exactly one engine`, async () => {
  const root = tempDir("petrina-dead-desktop-handoff-");
  roots.push(root);
  let pendingStore: LifecycleStore | undefined;
  const closeStore = () => { pendingStore?.close(); pendingStore = undefined; };
  const lifetime = await lifetimes.open(root, { async stopPeers() { await completeAll([Promise.resolve().then(closeStore)]); } });
  let cleanup: (() => Promise<void>) | undefined;
  const close = async () => {
    await setupWithCleanup(async () => { await cleanup?.(); }, () => lifetime.close());
    await lifetime.close();
  };
  await setupWithCleanup(() => lifetime.prepare(async () => {
  const home = join(root, "home"), fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  const original = await lifetime.harness(home, fakes.dir);
  const paused = ending === "restart-starting";
  if (paused) await original.act("setPoolPaused", true);
  await original.kill();
  const store = pendingStore = new LifecycleStore(home);
  const [kind, phase] = ending.split("-") as ["restart" | "stop", "starting" | "draining" | "stopping"];
  store.begin(kind, { requestId: "dead-handoff" }, paused ? "paused" : "running");
  store.finish(phase);
  if (phase === "starting") {
    store.noteLauncher(original.proc.pid);
    removeConnection(home, original.proc.pid);
  }
  const children: EngineProcess[] = [];

  cleanup = async () => {
    try { await lifetime.close(); } finally { closeStore(); }

  };
    await Promise.all([0, 1].map(async () => { children.push(await lifetime.harness(home, fakes.dir)); }));
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

  }), close);
  await close();
});
}
