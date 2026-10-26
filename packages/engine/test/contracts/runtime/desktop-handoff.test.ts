import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { completeAll } from "@petrina/core";
import { afterEach } from "bun:test";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import type { CoordinatorProcess } from "../../fixtures/coordinator-process.js";
import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineClient } from "../../client.js";
import { FolderLock, processAlive, readConnection } from "../../../src/instance.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { HARNESS, Fakes, removeDir, tempDir, waitFor, SLOW } from "../../support.js";
import { ENGINE_TEST_ROOT } from "../../fixtures/runtime-paths.js";
const roots: string[] = [];
const lifetimes = coordinatorLifetimes();
afterEach(() => lifetimes.close());
afterAll(() => roots.filter(root => !lifetimes.retained.has(root)).forEach(removeDir));

for (const [kind, survives] of [["restart", true], ["restart", false], ["start", true]] as const) {
it(`desktop recovery during ${kind} ${survives ? "follows a live replacement without a competitor" : "replaces a launcher that dies while recovery is already waiting"}`, async () => {
  const root = tempDir("petrina-desktop-handoff-");
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
  const release = join(root, "release-replacement"), replacement = join(root, "replacement-started"), observed = join(root, "recovery-observed");
  const stopReplacement = join(root, "stop-replacement");
  // Hold the requested replacement before it claims ownership. The stand-in desktop asks
  // again after its old child exits; observe its next lifecycle read before allowing startup.
  const wrapper = lifetime.program("desktop-stand-in.ts", `const { existsSync, writeFileSync } = await import("node:fs");
const { LifecycleStore } = await import(${JSON.stringify(join(ENGINE_TEST_ROOT, "../../storage/src/lifecycle-store.ts"))});
const { writeFixtureJson } = await import(${JSON.stringify(join(ENGINE_TEST_ROOT, "../../test-support/src/fixture-json.ts"))});
if (process.env.PETRINA_TEST_HOST_RECOVERY) {
  const property = Object.getOwnPropertyDescriptor(LifecycleStore.prototype, "current")!;
  let reads = 0;
  Object.defineProperty(LifecycleStore.prototype, "current", { ...property, get() {
    const operation = property.get!.call(this);
    if (++reads >= 2) writeFileSync(${JSON.stringify(observed)}, "observed");
    return operation;
  }});
}
if (process.env.PETRINA_LIFECYCLE_REPLACEMENT) {
  writeFixtureJson(${JSON.stringify(replacement)}, process.pid);
  while (!existsSync(${JSON.stringify(release)})) {
    if (existsSync(${JSON.stringify(stopReplacement)})) process.exit(78);
    await Bun.sleep(20);
  }
}
await import(${JSON.stringify(HARNESS)});
`);
  const harnessArgs = await lifetime.harnessArgs(home, fakes.dir, undefined, { entry: wrapper });
  const original = await lifetime.harness(home, fakes.dir, undefined, { entry: wrapper });
  const before = readConnection(home)!;
  let requested: CoordinatorProcess | undefined;
  const client = new EngineClient(home, () => {
    requested = lifetime.start(home, harnessArgs, { PETRINA_LIFECYCLE_REPLACEMENT: "1", PETRINA_RECONNECT_PORT: new URL(before.api).port }, { input: "ignore" });
    return requested.pid;
  });
  let recovery: CoordinatorProcess | undefined;

  cleanup = async () => {
    try {
      writeFileSync(release, "go");
      await lifetime.prepare(() => client.call("engine.stop", { requestId: "stop-desktop-test", wait: true, timeoutMs: 10000 * SLOW }));
    } finally { await lifetime.close(); }
    await recovery?.exited;
    await requested?.exited;
    await original.exited(10000 * SLOW);

  };
    if (kind === "start") expect((await client.call("engine.stop", { requestId: "stop-before-start", wait: true, timeoutMs: 10000 * SLOW })).outcome).toBe("completed");
    expect((await client.call(`engine.${kind}`, { requestId: "desktop-handoff" })).outcome).toBe("pending");
    await waitFor(() => existsSync(replacement), "the replacement launcher to wait");
    expect(await original.exited(10000 * SLOW)).toBe(0);
    recovery = lifetime.start(home, harnessArgs, { PETRINA_TEST_HOST_RECOVERY: "1" });
    const hello = recovery.line().then((line) => JSON.parse(line));
    await waitFor(() => existsSync(observed), "desktop recovery to inspect the unfinished handoff", undefined, { during: recovery.completion });
    // Recovery briefly probes the lock to distinguish a live launcher from a dead handoff;
    // it releases that probe instead of holding ownership for an engine of its own.
    await waitFor(() => {
      const free = FolderLock.take(home);
      free?.release();
      return !!free;
    }, "the recovery probe to release ownership", undefined, { during: recovery.completion });
    const store = pendingStore = new LifecycleStore(home);
    try { expect(store.current?.phase).toBe("starting"); } finally { closeStore(); }
    if (survives) writeFileSync(release, "go");
    else {
      const pid = Number(readFileSync(replacement, "utf8"));
      // The independently owned replacement exits itself; a saved PID is observation, never signal authority.
      writeFileSync(stopReplacement, "stop");
      await waitFor(() => !processAlive(pid), "the replacement launcher to exit");
    }
    expect((await client.call(`engine.${kind}`, { requestId: "desktop-handoff", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe(survives ? "completed" : "failed");
    const returned = await hello;
    expect(returned.type).toBe(survives ? "running" : "ready");
    expect(returned.owned).toBe(!survives);
    if (survives) expect(await recovery.exited).toBe(0);
    const after = readConnection(home)!;
    expect(after.pid).not.toBe(before.pid);
    expect(after.token === before.token).toBe(true);
    if (survives) expect(after.url).toBe(before.url);
    expect(returned.url).toBe(after.url);
    expect((await client.call("engine.status")).status).not.toBe("failed");
    const log = readFileSync(join(home, "engine.log"), "utf8");
    // Each owner starts the log fresh. Its one startup belongs to the requested replacement.
    expect(log.match(/Petrina engine starting \(process/g)).toHaveLength(1);
    expect(log).toContain(`starting (process ${after.pid},`);
    expect(after.pid).toBe(survives ? Number(readFileSync(replacement, "utf8")) : recovery.pid);
    expect(log.includes(before.token)).toBe(false);

  }), close);
  await close();
});
}
