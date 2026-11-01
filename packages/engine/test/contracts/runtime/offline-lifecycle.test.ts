import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { completeAll } from "@petrina/core";
import { afterEach } from "bun:test";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import type { CoordinatorProcess } from "../../fixtures/coordinator-process.js";
import { disconnectedCoordinator } from "../../fixtures/disconnected-coordinator.js";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Engine } from "../../engine.js";
import { EngineClient } from "../../client.js";

import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { FolderLock, writeConnection } from "../../../src/instance.js";
import { Fakes, removeDir, tempDir, SLOW } from "../../support.js";
import { describe } from "bun:test";

import { readConnection } from "../../../src/instance.js";
import { CLI } from "../../support.js";
import { engineProcessCases } from "../../fixtures/engine-processes.js";
import { coordinatorStoreAfterSeed, stopEngineAndAwaitExit } from "../../fixtures/coordinator-lifecycle.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";
const roots: string[] = [];
const lifetimes = coordinatorLifetimes();
const cases = engineProcessCases();
afterEach(() => completeAll([lifetimes.close(), cases.close()]));
afterAll(() => roots.filter(root => !lifetimes.retained.has(root)).forEach(removeDir));

it("does not claim a silent, still living pause owner is ready or replace it", async () => {
  const home = tempDir("petrina-silent-pause-owner-");
  let ownedStore: LifecycleStore | undefined;
  let ownedPeer: Awaited<ReturnType<typeof disconnectedCoordinator>> | undefined;
  const closeStore = () => { ownedStore?.close(); ownedStore = undefined; };
  const closePeer = async () => { await ownedPeer?.close(); ownedPeer = undefined; };
  await cases.use(home, async owners => {
  const store = ownedStore = new LifecycleStore(home);
  store.begin("pause", { requestId: "pause" }, "paused");
  const peer = ownedPeer = await disconnectedCoordinator();
  if (owners.signal.aborted) { await closePeer(); throw new Error("Coordinator setup closed while acquiring its peer"); }
  writeConnection(home, { api: peer.api, url: peer.url, pid: process.pid, token: "silent-owner-connection-key-12345" });
  let launches = 0;
  const client = new EngineClient(home, () => { launches++; });
  try {
    expect((await client.call("engine.start", { requestId: "start" })).outcome).toBe("disconnected");
    expect((await client.call("engine.status")).status).toBe("unresponsive");
    expect(store.receipt("start")).toBeUndefined();
    expect(store.current?.phase).toBe("draining");
    expect(launches).toBe(0);
  } finally { try { closeStore(); } finally { await closePeer(); } }
  }, { async stopPeers() { await completeAll([Promise.resolve().then(closeStore), Promise.resolve().then(closePeer)]); } });
});

for (const previous of ["unfinished-removed", "unfinished-stale", "completed"] as const) {
it(`starts once with saved paused scheduling after a ${previous} pause lost its engine`, async () => {
  const root = tempDir("petrina-start-after-pause-");
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
  const peer = pendingPeer = previous === "unfinished-stale" ? await disconnectedCoordinator() : undefined;
  if (lifetime.signal.aborted) { await closePeer(); throw new Error("Coordinator setup closed while acquiring its peer"); }
  const home = join(root, "home"), fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  // Persist the state an app leaves behind when it closes during a pause. Its connection
  // is normally removed; a crash may instead leave a dead connection on disk.
  const before = pendingSeed = new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
  before.setPoolPaused(true);
  const store = await coordinatorStoreAfterSeed(lifetime.signal, async () => {
    await before.shutdown(); pendingSeed = undefined;
  }, () => pendingStore = new LifecycleStore(home));
  store.begin("pause", { requestId: "old-pause" }, "paused");
  if (previous === "completed") store.finish("completed");
  if (previous === "unfinished-stale") {
    const dead = lifetime.start(home, ["-e", "process.exit(0)"], {}, { input: "ignore" });
    await dead.exited;
    writeConnection(home, { api: peer!.api, url: peer!.url, pid: dead.pid, token: "dead-connection-key-1234567890123" });
  }
  let launches = 0;
  let child: CoordinatorProcess | undefined;
  const harnessArgs = await lifetime.harnessArgs(home, fakes.dir);
  const client = new EngineClient(home, () => {
    launches++;
    child = lifetime.start(home, harnessArgs, { PETRINA_LIFECYCLE_REPLACEMENT: "1" }, { input: "ignore" });
    return child.pid;
  });

  cleanup = async () => {
    try {
      await stopEngineAndAwaitExit(client, home, {
        requestId: "cleanup",
        timeoutMs: 10000 * SLOW,
        run: (step) => lifetime.prepare(step),
      });
    } finally { try { await child?.settle(); } finally { try { await closePeer(); } finally { closeStore(); } } }
  };
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

  }), close);
  await close();
});
}

describe("graceful coordination lifecycle", () => {
it("keeps the connection key on restart even when its original launch requested a fresh key", async () => {
    const root = tempDir("petrina-lifecycle-fresh-key-");
    roots.push(root);
    const lifetime = await lifetimes.open(root);
  let cleanup: (() => Promise<void>) | undefined;
  const close = async () => {
    await setupWithCleanup(async () => { await cleanup?.(); }, () => lifetime.close());
    await lifetime.close();
  };
  await setupWithCleanup(() => lifetime.prepare(async () => {
    const home = join(root, "home"),
      fakes = new Fakes(join(root, "fakes"));
    fakes.scenario({ controlled: true });
    const original = await lifetime.harness(home, fakes.dir, undefined, { extra: ["--new-key"] });
    const client = new EngineClient(home);
    const before = readConnection(home)!;

    let replacementPid: number | undefined;
    cleanup = async () => {
      await stopEngineAndAwaitExit(client, home, {
        requestId: "stop-fresh-key-test",
        timeoutMs: 30000 * SLOW,
        observePids: () => [replacementPid],
        run: (step) => lifetime.prepare(step),
        afterStop: async () => { await original.exited(10000 * SLOW); },
      });
    };
      expect((await client.call("engine.restart", { requestId: "preserve-fresh-key", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      const after = readConnection(home)!;
      replacementPid = after.pid;
      expect(after.pid).not.toBe(before.pid);
      expect(after.token === before.token).toBe(true);
      expect(after.api).toBe(before.api);

  }), close);
  await close();
  });
});

describe("graceful coordination lifecycle", () => {
it("distinguishes stopped, unresponsive ownership, failed startup and safe concurrent starts", async () => {
    const root = tempDir("petrina-lifecycle-offline-");
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
    const home = join(root, "home"),
      fakes = new Fakes(join(root, "fakes"));
    fakes.scenario({ controlled: true });
    const children: CoordinatorProcess[] = [];
    let launches = 0;
    const harnessArgs = await lifetime.harnessArgs(home, fakes.dir);
    const client = new EngineClient(home, () => {
      launches++;
      children.push(
        lifetime.start(home, harnessArgs, { PETRINA_LIFECYCLE_REPLACEMENT: "1" }, { input: "ignore" }),
      );
    });

  cleanup = async () => {
      await Promise.all(children.map(child => child.settle()));

  };
      expect((await client.call("engine.status")).status).toBe("stopped");
      const lock = FolderLock.take(home)!;
      try {
        expect((await client.call("engine.start", { requestId: "busy" })).status).toBe("unresponsive");
        expect(launches).toBe(0);
      } finally {
        lock.release();
      }
      const both = await Promise.all([client.call("engine.start", { requestId: "start-once" }), client.call("engine.start", { requestId: "competing-start" })]);
      expect(both.some((r) => r.outcome === "pending")).toBe(true);
      expect(launches).toBe(1);
      expect((await client.call("engine.start", { requestId: "start-once", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      expect(launches).toBe(1);
      expect((await client.call("engine.stop", { requestId: "intentional-stop", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      expect((await client.call("engine.status")).status).toBe("stopped");
      const app = await lifetime.app(home, [CLI, "app"]);
      expect(app.hello.type).toBe("error");
      expect(await app.exited(10000 * SLOW)).toBe(0);
      expect(launches).toBe(1);
      const store = pendingStore = new LifecycleStore(home);
      store.begin("start", { requestId: "startup-failed" }, "paused");
      store.finish("starting");
      closeStore();
      const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("stand-in") });
      try {
        // This is the explicitly requested startup, not another desktop reconnect following it.
        const child = lifetime.start(home, harnessArgs, { PETRINA_LIFECYCLE_REPLACEMENT: "1", PETRINA_RECONNECT_PORT: String(occupied.port) }, { input: "ignore" });
        expect(await child.exited).toBe(1);
      } finally {
        await occupied.stop(true);
      }
      expect((await client.call("engine.status")).status).toBe("failed");
      expect((await client.call("engine.start", { requestId: "startup-failed", wait: true })).outcome).toBe("failed");
      expect(launches).toBe(1);

  }), close);
  await close();
  });
});

it("does not open lifecycle storage when cleanup starts during held seed shutdown", async () => {
  const root = tempDir("petrina-late-lifecycle-store-"), controller = new AbortController();
  let release!: () => void, store: LifecycleStore | undefined, opens = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const opening = coordinatorStoreAfterSeed(controller.signal, () => held, () => {
    opens++; return store = new LifecycleStore(root);
  });
  const outcome = opening.then(value => ({ value }), (error: unknown) => ({ error }));
  const close = () => { store?.close(); store = undefined; removeFixtureRoot(root); };
  await setupWithCleanup(async () => {
    try {
      expect(opens).toBe(0);
      controller.abort(); release();
      const result = await outcome;
      expect("error" in result).toBe(true);
      if (!("error" in result)) throw new Error("Lifecycle storage opened after cleanup began");
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("Coordinator setup closed while stopping its seed");
      expect(opens).toBe(0);
      expect(existsSync(join(root, "lifecycle.db"))).toBe(false);
    } finally { release(); await outcome; }
  }, close);
  close();
});

it("opens actual lifecycle storage only after seed shutdown while admission stays open", async () => {
  const root = tempDir("petrina-ready-lifecycle-store-"), controller = new AbortController();
  let release!: () => void, store: LifecycleStore | undefined, opens = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const opening = coordinatorStoreAfterSeed(controller.signal, () => held, () => {
    opens++; return store = new LifecycleStore(root);
  });
  const outcome = opening.then(value => ({ value }), (error: unknown) => ({ error }));
  const close = () => { store?.close(); store = undefined; removeFixtureRoot(root); };
  await setupWithCleanup(async () => {
    try {
      expect(opens).toBe(0);
      release();
      const result = await outcome;
      if (!("value" in result)) throw result.error;
      expect(result.value).toBe(store!);
      expect(result.value.current).toBeUndefined();
      expect(opens).toBe(1);
      expect(existsSync(join(root, "lifecycle.db"))).toBe(true);
    } finally { release(); await outcome; }
  }, close);
  close();
});

for (const failure of [new Error("seed shutdown rejected"), undefined]) it(`preserves a rejected seed shutdown before storage opens: ${String(failure)}`, async () => {
  const root = tempDir("petrina-failed-lifecycle-store-");
  let store: LifecycleStore | undefined, opens = 0;
  const opening = coordinatorStoreAfterSeed(new AbortController().signal, () => Promise.reject(failure), () => {
    opens++; return store = new LifecycleStore(root);
  });
  const close = () => { store?.close(); store = undefined; removeFixtureRoot(root); };
  await setupWithCleanup(async () => {
    try {
      expect(await rejectionOf(opening)).toBe(failure);
      expect(opens).toBe(0);
      expect(existsSync(join(root, "lifecycle.db"))).toBe(false);
    } finally { await opening.catch(() => undefined); }
  }, close);
  close();
});
