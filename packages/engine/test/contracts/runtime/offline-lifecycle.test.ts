import { afterEach } from "bun:test";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import type { CoordinatorProcess } from "../../fixtures/coordinator-process.js";
import { disconnectedCoordinator } from "../../fixtures/disconnected-coordinator.js";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { EngineClient } from "../../client.js";

import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { FolderLock, writeConnection } from "../../../src/instance.js";
import { Fakes, removeDir, tempDir, SLOW } from "../../support.js";
import { describe } from "bun:test";

import { readConnection } from "../../../src/instance.js";
import { CLI } from "../../support.js";
const roots: string[] = [];
const lifetimes = coordinatorLifetimes();
afterEach(() => lifetimes.close());
afterAll(() => roots.filter(root => !lifetimes.retained.has(root)).forEach(removeDir));

it("does not claim a silent, still living pause owner is ready or replace it", async () => {
  const home = tempDir("petrina-silent-pause-owner-");
  roots.push(home);
  const store = new LifecycleStore(home);
  store.begin("pause", { requestId: "pause" }, "paused");
  const peer = await disconnectedCoordinator();
  writeConnection(home, { api: peer.api, url: peer.url, pid: process.pid, token: "silent-owner-connection-key-12345" });
  let launches = 0;
  const client = new EngineClient(home, () => { launches++; });
  try {
    expect((await client.call("engine.start", { requestId: "start" })).outcome).toBe("disconnected");
    expect((await client.call("engine.status")).status).toBe("unresponsive");
    expect(store.receipt("start")).toBeUndefined();
    expect(store.current?.phase).toBe("draining");
    expect(launches).toBe(0);
  } finally { try { store.close(); } finally { await peer.close(); } }
});

for (const previous of ["unfinished-removed", "unfinished-stale", "completed"] as const) {
it(`starts once with saved paused scheduling after a ${previous} pause lost its engine`, async () => {
  const root = tempDir("petrina-start-after-pause-");
  roots.push(root);
  const lifetime = await lifetimes.open(root);
  const peer = previous === "unfinished-stale" ? await disconnectedCoordinator() : undefined;
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
    const dead = lifetime.start(home, ["-e", "process.exit(0)"], {}, { input: "ignore" });
    await dead.exited;
    writeConnection(home, { api: peer!.api, url: peer!.url, pid: dead.pid, token: "dead-connection-key-1234567890123" });
  }
  let launches = 0;
  let child: CoordinatorProcess | undefined;
  const client = new EngineClient(home, () => {
    launches++;
    child = lifetime.start(home, [lifetime.entry, home, fakes.dir, `--agent-program=${lifetime.actor}`], { PETRINA_LIFECYCLE_REPLACEMENT: "1" }, { input: "ignore" });
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
    try { await client.call("engine.stop", { requestId: "cleanup", wait: true, timeoutMs: 10000 * SLOW }); }
    finally { try { await child?.close(); } finally { try { await peer?.close(); } finally { store.close(); } } }
  }
});
}

describe("graceful coordination lifecycle", () => {
it("keeps the connection key on restart even when its original launch requested a fresh key", async () => {
    const root = tempDir("petrina-lifecycle-fresh-key-");
    roots.push(root);
    const lifetime = await lifetimes.open(root);
    const home = join(root, "home"),
      fakes = new Fakes(join(root, "fakes"));
    fakes.scenario({ controlled: true });
    const original = await lifetime.harness(home, fakes.dir, undefined, ["--new-key"]);
    const client = new EngineClient(home);
    const before = readConnection(home)!;
    try {
      expect((await client.call("engine.restart", { requestId: "preserve-fresh-key", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      const after = readConnection(home)!;
      expect(after.pid).not.toBe(before.pid);
      expect(after.token === before.token).toBe(true);
      expect(after.api).toBe(before.api);
    } finally {
      await client.call("engine.stop", { requestId: "stop-fresh-key-test", wait: true, timeoutMs: 30000 * SLOW });
      await original.exited(10000 * SLOW);
    }
  });
});

describe("graceful coordination lifecycle", () => {
it("distinguishes stopped, unresponsive ownership, failed startup and safe concurrent starts", async () => {
    const root = tempDir("petrina-lifecycle-offline-");
    roots.push(root);
    const lifetime = await lifetimes.open(root);
    const home = join(root, "home"),
      fakes = new Fakes(join(root, "fakes"));
    fakes.scenario({ controlled: true });
    const children: CoordinatorProcess[] = [];
    let launches = 0;
    const client = new EngineClient(home, () => {
      launches++;
      children.push(
        lifetime.start(home, [lifetime.entry, home, fakes.dir, `--agent-program=${lifetime.actor}`], { PETRINA_LIFECYCLE_REPLACEMENT: "1" }, { input: "ignore" }),
      );
    });
    try {
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
      const store = new LifecycleStore(home);
      store.begin("start", { requestId: "startup-failed" }, "paused");
      store.finish("starting");
      store.close();
      const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("stand-in") });
      try {
        // This is the explicitly requested startup, not another desktop reconnect following it.
        const child = lifetime.start(home, [lifetime.entry, home, fakes.dir, `--agent-program=${lifetime.actor}`], { PETRINA_LIFECYCLE_REPLACEMENT: "1", PETRINA_RECONNECT_PORT: String(occupied.port) }, { input: "ignore" });
        expect(await child.exited).toBe(1);
      } finally {
        occupied.stop(true);
      }
      expect((await client.call("engine.status")).status).toBe("failed");
      expect((await client.call("engine.start", { requestId: "startup-failed", wait: true })).outcome).toBe("failed");
      expect(launches).toBe(1);
    } finally {
      await Promise.all(children.map(child => child.close()));
    }
  });
});
