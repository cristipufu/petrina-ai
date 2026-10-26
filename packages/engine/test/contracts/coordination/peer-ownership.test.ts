import { afterAll, afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";
import { engineProcessCases } from "../../fixtures/engine-processes.js";
import { completeAll } from "@petrina/core";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import { processAlive } from "../../../src/instance.js";
const roots: string[] = [], lifetimes = coordinatorLifetimes(), cases = engineProcessCases();
afterEach(() => completeAll([lifetimes.close(), cases.close()]));
afterAll(() => roots.filter(root => !lifetimes.retained.has(root)).forEach(removeDir));

it("keeps actual stdio lines and drains both channels before reporting peer completion", async () => {
  const root = tempDir("petrina-coordinator-peer-");
  await cases.use(root, async owners => {
  const peer = owners.command(root, ["-e", 'process.stderr.write("diagnostic\\n"); for await (const line of console) { console.log("reply:"+line); break; }']);
  try {
    peer.write("request\n");
    expect(await peer.line()).toBe("reply:request");
    peer.endInput();
    expect(await peer.wait()).toBe(0);
    expect(await peer.stdout).toBe("reply:request\n");
    expect(await peer.stderr).toBe("diagnostic\n");
  } finally { await peer.close(); }
  });
});

it("observes a completed real peer instead of waiting for an impossible next output line", async () => {
  const root = tempDir("petrina-coordinator-empty-peer-");
  await cases.use(root, async owners => {
  const peer = owners.command(root, ["-e", "process.exit(0)"]);
  try {
    const error = await rejectionOf(peer.line());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("completed before");
    expect(await peer.wait()).toBe(0);
  } finally { await peer.close(); }
  });
});

it("independently settles an actual leased startup actor that would otherwise live indefinitely", async () => {
  const root = tempDir("petrina-coordinator-leased-peer-"); roots.push(root);
  const lifetime = await lifetimes.open(root), home = join(root, "home");
  const peer = await lifetime.prepare(async () => {
    const actor = lifetime.program("ready.ts", 'console.log("ready");');
    const peer = lifetime.start(home, [actor]);
    expect(await peer.line()).toBe("ready");
    expect(processAlive(peer.pid)).toBe(true);
    return peer;
  });
  await lifetime.close();
  expect(processAlive(peer.pid)).toBe(false);
});
