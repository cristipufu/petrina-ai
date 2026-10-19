import { afterAll, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineClient } from "../src/engine-client.js";
import { readConnection, removeConnection } from "../src/instance.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { EngineProcess, Fakes, HARNESS, SLOW, engineEnv, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const mode of ["explicit", "recovery", "offline"] as const) it(`recovers an interrupted ${mode} start before a connection exists, without replacing its live owner`, async () => {
  const root = tempDir(`petrina-start-owner-${mode}-`);
  roots.push(root);
  const home = join(root, "home"), marker = join(root, "starting"), wrapper = join(root, "start.ts");
  const store = new LifecycleStore(home);
  if (mode !== "offline") {
    store.begin(mode === "explicit" ? "stop" : "restart", { requestId: "earlier-operation" }, "running");
    store.finish(mode === "explicit" ? "completed" : "failed");
  }
  const clientModule = JSON.stringify(join(import.meta.dir, "../src/engine-client.ts"));
  const engineModule = JSON.stringify(join(import.meta.dir, "../src/engine.ts"));
  const launchModule = JSON.stringify(join(import.meta.dir, "../src/launch.ts"));
  writeFileSync(wrapper, mode === "offline" ? `
import { writeFileSync } from "node:fs";
import { EngineClient } from ${clientModule};
await new EngineClient(${JSON.stringify(home)}, () => {
  writeFileSync(${JSON.stringify(marker)}, "spawning");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}).call("engine.start", { requestId: "interrupted-offline" });
` : `
import { writeFileSync } from "node:fs";
import { Engine } from ${engineModule};
import { launch } from ${launchModule};
Engine.prototype.waitUntilReady = async function () {
  writeFileSync(${JSON.stringify(marker)}, "starting");
  await new Promise(() => {});
};
await launch({ home: ${JSON.stringify(home)}, mode: ${JSON.stringify(mode === "explicit" ? "serve" : "app")}, port: 0, loginShell: false, engine: { agentCommand: () => undefined, codexCommand: null, grokCommand: null, terminals: () => [] } });
`);
  const interrupted = Bun.spawn([process.execPath, wrapper], { env: engineEnv(home), stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let launches = 0;
  const client = new EngineClient(home, () => {
    launches++;
    const child = Bun.spawn([process.execPath, HARNESS, home, fakes.dir], { env: { ...engineEnv(home), PETRINA_LIFECYCLE_REPLACEMENT: "1" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    children.push(child);
    return child.pid;
  });
  try {
    await waitFor(() => existsSync(marker), "the launch to pause before its connection exists");
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
    expect((await client.call("engine.start", { requestId: "recover-start", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
    expect((await client.call("engine.status")).status).toBe("running");
    expect(readConnection(home)?.pid).toBe(children[0]!.pid);
  } finally {
    interrupted.kill("SIGKILL");
    await interrupted.exited;
    await client.call("engine.stop", { requestId: "cleanup-start-owner", wait: true, timeoutMs: 10000 * SLOW });
    for (const child of children) { child.kill("SIGKILL"); await child.exited; }
    store.close();
  }
});

it("records the current restart owner before releasing the folder or spawning its replacement", async () => {
  const root = tempDir("petrina-restart-owner-");
  roots.push(root);
  const home = join(root, "home"), marker = join(root, "starting"), wrapper = join(root, "restart.ts");
  const fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  writeFileSync(wrapper, `
import { writeFileSync } from "node:fs";
import { LifecycleStore } from ${JSON.stringify(join(import.meta.dir, "../src/lifecycle.ts"))};
const finish = LifecycleStore.prototype.finish;
LifecycleStore.prototype.finish = function (...args) {
  finish.apply(this, args);
  if (args[0] === "starting") {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify(this.current));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
};
await import(${JSON.stringify(HARNESS)});
`);
  const owner = await EngineProcess.start(home, [wrapper, home, fakes.dir]);
  const client = new EngineClient(home, () => { throw new Error("the interrupted restart must not launch a competitor"); });
  const store = new LifecycleStore(home);
  try {
    expect((await client.call("engine.restart", { requestId: "interrupted-restart" })).outcome).toBe("pending");
    await waitFor(() => existsSync(marker), "the restart to reserve replacement startup");
    const starting = store.current!;
    removeConnection(home, owner.proc.pid);
    expect((await client.call("engine.status")).status).toBe("starting");
    owner.proc.kill("SIGKILL");
    await owner.proc.exited;
    expect((await client.call("engine.status")).status).toBe("failed");
    expect(store.receipt("interrupted-restart")!.outcome).toBe("failed");
    expect(starting.launcherPid).toBe(owner.proc.pid);
  } finally {
    owner.proc.kill("SIGKILL");
    await owner.proc.exited;
    store.close();
  }
});
