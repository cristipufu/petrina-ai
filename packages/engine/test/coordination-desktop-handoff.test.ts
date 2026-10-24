import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineClient } from "./client.js";
import { FolderLock, processAlive, readConnection } from "../src/instance.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { EngineProcess, HARNESS, Fakes, engineEnv, firstLine, removeDir, tempDir, waitFor, SLOW } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const [kind, survives] of [["restart", true], ["restart", false], ["start", true]] as const) it(`desktop recovery during ${kind} ${survives ? "follows a live replacement without a competitor" : "replaces a launcher that dies while recovery is already waiting"}`, async () => {
  const root = tempDir("petrina-desktop-handoff-");
  roots.push(root);
  const home = join(root, "home"), fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true });
  const release = join(root, "release-replacement"), replacement = join(root, "replacement-started"), observed = join(root, "recovery-observed");
  const wrapper = join(root, "desktop-stand-in.ts");
  // Hold the requested replacement before it claims ownership. The stand-in desktop asks
  // again after its old child exits; observe its next lifecycle read before allowing startup.
  writeFileSync(wrapper, `import { existsSync, writeFileSync } from "node:fs";
import { LifecycleStore } from ${JSON.stringify(join(import.meta.dir, "../src/lifecycle.ts"))};
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
  writeFileSync(${JSON.stringify(replacement)}, String(process.pid));
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
}
await import(${JSON.stringify(HARNESS)});
`);
  const original = await EngineProcess.start(home, [wrapper, home, fakes.dir]);
  const before = readConnection(home)!;
  let requested: ReturnType<typeof Bun.spawn> | undefined;
  const client = new EngineClient(home, () => {
    requested = Bun.spawn([process.execPath, wrapper, home, fakes.dir], { env: { ...engineEnv(home), PETRINA_LIFECYCLE_REPLACEMENT: "1", PETRINA_RECONNECT_PORT: new URL(before.api).port }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return requested.pid;
  });
  let recovery: ReturnType<typeof Bun.spawn> | undefined;
  try {
    if (kind === "start") expect((await client.call("engine.stop", { requestId: "stop-before-start", wait: true, timeoutMs: 10000 * SLOW })).outcome).toBe("completed");
    expect((await client.call(`engine.${kind}`, { requestId: "desktop-handoff" })).outcome).toBe("pending");
    await waitFor(() => existsSync(replacement), "the replacement launcher to wait");
    expect(await original.exited(10000 * SLOW)).toBe(0);
    recovery = Bun.spawn([process.execPath, wrapper, home, fakes.dir], { env: { ...engineEnv(home), PETRINA_TEST_HOST_RECOVERY: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const hello = firstLine(recovery.stdout as ReadableStream<Uint8Array>).then((line) => JSON.parse(line));
    await waitFor(() => existsSync(observed), "desktop recovery to inspect the unfinished handoff");
    // Recovery briefly probes the lock to distinguish a live launcher from a dead handoff;
    // it releases that probe instead of holding ownership for an engine of its own.
    await waitFor(() => {
      const free = FolderLock.take(home);
      free?.release();
      return !!free;
    }, "the recovery probe to release ownership");
    const store = new LifecycleStore(home);
    try { expect(store.current?.phase).toBe("starting"); } finally { store.close(); }
    if (survives) writeFileSync(release, "go");
    else {
      const pid = Number(readFileSync(replacement, "utf8"));
      process.kill(pid, "SIGKILL");
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
  } finally {
    writeFileSync(release, "go");
    await client.call("engine.stop", { requestId: "stop-desktop-test", wait: true, timeoutMs: 10000 * SLOW });
    for (const pid of new Set([original.proc.pid, recovery?.pid, readConnection(home)?.pid, existsSync(replacement) ? Number(readFileSync(replacement, "utf8")) : undefined])) {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await recovery?.exited;
    await requested?.exited;
    await original.proc.exited;
  }
});
