import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { completeAll } from "@petrina/core";
import { afterEach } from "bun:test";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import type { CoordinatorProcess } from "../../fixtures/coordinator-process.js";
import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineClient } from "../../client.js";
import { readConnection, removeConnection } from "../../../src/instance.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { Fakes, HARNESS, SLOW, removeDir, tempDir, waitFor } from "../../support.js";
import { ENGINE_TEST_ROOT } from "../../fixtures/runtime-paths.js";
const roots: string[] = [];
const lifetimes = coordinatorLifetimes();
afterEach(() => lifetimes.close());
afterAll(() => roots.filter(root => !lifetimes.retained.has(root)).forEach(removeDir));

for (const mode of ["explicit", "recovery", "offline"] as const) {
it(`recovers an interrupted ${mode} start before a connection exists, without replacing its live owner`, async () => {
  const root = tempDir(`petrina-start-owner-${mode}-`);
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
  const home = join(root, "home"), marker = join(root, "starting");
  const store = pendingStore = new LifecycleStore(home);
  if (mode !== "offline") {
    store.begin(mode === "explicit" ? "stop" : "restart", { requestId: "earlier-operation" }, "running");
    store.finish(mode === "explicit" ? "completed" : "failed");
  }
  const clientModule = JSON.stringify(join(ENGINE_TEST_ROOT, "client.ts"));
  const fixtureModule = JSON.stringify(join(ENGINE_TEST_ROOT, "engine.ts"));
  const launchModule = JSON.stringify(join(ENGINE_TEST_ROOT, "../src/launch.ts"));
  const wrapper = lifetime.program("start.ts", mode === "offline" ? `
const { writeFileSync } = await import("node:fs");
const { EngineClient } = await import(${clientModule});
await new EngineClient(${JSON.stringify(home)}, () => {
  writeFileSync(${JSON.stringify(marker)}, "spawning");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}).call("engine.start", { requestId: "interrupted-offline" });
` : `
const { writeFileSync } = await import("node:fs");
const { launch } = await import(${launchModule});
const { fixtureEngineOptions } = await import(${fixtureModule});
await launch({ home: ${JSON.stringify(home)}, mode: ${JSON.stringify(mode === "explicit" ? "serve" : "app")}, port: 0, loginShell: false,
  engine: fixtureEngineOptions(${JSON.stringify(home)}, { browserRecovery: async () => {
    writeFileSync(${JSON.stringify(marker)}, "starting");
    await new Promise(() => {});
  } }) });
`, mode === "offline" ? { monitor: "worker" } : undefined);
  const interrupted = lifetime.start(home, [wrapper]);
  const fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  const harnessArgs = await lifetime.harnessArgs(home, fakes.dir);
  const children: CoordinatorProcess[] = [];
  let launches = 0;
  const client = new EngineClient(home, () => {
    launches++;
    const child = lifetime.start(home, harnessArgs, { PETRINA_LIFECYCLE_REPLACEMENT: "1" }, { input: "ignore" });
    children.push(child);
    return child.pid;
  });

  cleanup = async () => {
    try {
      interrupted.kill("SIGKILL");
      await interrupted.exited;
      await lifetime.prepare(() => client.call("engine.stop", { requestId: "cleanup-start-owner", wait: true, timeoutMs: 10000 * SLOW }));
    } finally { try { await lifetime.close(); } finally { closeStore(); } }

  };
    await waitFor(() => existsSync(marker), "the launch to pause before its connection exists", undefined, { during: interrupted.completion });
    const starting = store.current!;
    expect(starting.phase).toBe("starting");
    expect(readConnection(home)).toBeUndefined();
    expect((await client.call("engine.status")).status).toBe("starting");
    expect(["conflict", "disconnected"]).toContain((await client.call("engine.start", { requestId: "leave-live-start-alone" })).outcome);
    expect(launches).toBe(0);
    interrupted.kill("SIGKILL");
    await interrupted.exited;
    expect((await client.call("engine.status")).status).toBe("failed");
    expect(store.receipt(starting.id)!.outcome).toBe("failed");
    expect(starting.launcherPid).toBe(interrupted.pid);
    const submitted = await Promise.all([client.call("engine.start", { requestId: "recover-start" }), client.call("engine.start", { requestId: "competing-start" })]);
    expect(submitted.some((result) => result.outcome === "pending")).toBe(true);
    expect(launches).toBe(1);
    const recovered = await client.call("engine.start", { requestId: "recover-start", wait: true, timeoutMs: 30000 * SLOW });
    expect(recovered, readFileSync(join(home, "engine.log"), "utf8")).toMatchObject({ outcome: "completed" });
    expect((await client.call("engine.status")).status).toBe("running");
    expect(readConnection(home)?.pid).toBe(children[0]!.pid);

  }), close);
  await close();
});
}

it("records the current restart owner before releasing the folder or spawning its replacement", async () => {
  const root = tempDir("petrina-restart-owner-");
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
  const home = join(root, "home"), marker = join(root, "starting");
  const fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  const wrapper = lifetime.program("restart.ts", `
const { writeFixtureJson } = await import(${JSON.stringify(join(ENGINE_TEST_ROOT, "../../test-support/src/fixture-json.ts"))});
const { LifecycleStore } = await import(${JSON.stringify(join(ENGINE_TEST_ROOT, "../../storage/src/lifecycle-store.ts"))});
const finish = LifecycleStore.prototype.finish;
LifecycleStore.prototype.finish = function (...args) {
  finish.apply(this, args);
  if (args[0] === "starting") {
    writeFixtureJson(${JSON.stringify(marker)}, this.current);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
};
await import(${JSON.stringify(HARNESS)});
`, { monitor: "worker" });
  const owner = await lifetime.harness(home, fakes.dir, undefined, { entry: wrapper });
  const client = new EngineClient(home, () => { throw new Error("the interrupted restart must not launch a competitor"); });
  const store = pendingStore = new LifecycleStore(home);

  cleanup = async () => {
    try { await owner.kill(); } finally { try { await lifetime.close(); } finally { closeStore(); } }

  };
    expect((await client.call("engine.restart", { requestId: "interrupted-restart" })).outcome).toBe("pending");
    await waitFor(() => existsSync(marker), "the restart to reserve replacement startup", undefined, { during: owner.proc.exited });
    const starting = store.current!;
    removeConnection(home, owner.proc.pid);
    expect((await client.call("engine.status")).status).toBe("starting");
    await owner.kill();
    expect((await client.call("engine.status")).status).toBe("failed");
    expect(store.receipt("interrupted-restart")!.outcome).toBe("failed");
    expect(starting.launcherPid).toBe(owner.proc.pid);

  }), close);
  await close();
});
