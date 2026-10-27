import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { State } from "@petrina/core";
import { Engine } from "../../engine.js";
import { serve } from "../../../src/server.js";
import { waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


interface Message { type: string; stateId?: number; state?: State; id?: number; ok?: boolean }

it("keeps repair proof bookkeeping out of board broadcasts while retaining task details and saved state", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const root = mkdtempSync(join(owner.root, "petrina-proof-projection-"));
    const engine = owner.open(join(root, "data"), {});
    engine.setPoolPaused(true);
    try {
      await owner.run(engine, async () => {
        const id = engine.addTask({ productId: "", title: "Current proof", description: "A bounded projection", backlog: true });
        const task = engine.task(id)!;
        task.hunt = { stageId: "review", round: 2, reported: { "0": true }, findingChecks: { older: { "0": { by: "sol-high", resolved: true, evidence: "CURRENT-REPAIR-PROOF" } } } };
        engine.commitNow(task);
        expect(engine.windowState().tasks.find(entry => entry.id === id)?.hunt?.findingChecks).toBeUndefined();
        expect(engine.taskDetails(id)!.hunt?.findingChecks?.older?.["0"]?.evidence).toBe("CURRENT-REPAIR-PROOF");
        expect(engine.store.load()!.tasks.find(entry => entry.id === id)?.hunt?.findingChecks?.older?.["0"]?.resolved).toBe(true);

      });
    } finally { await owner.stop(engine);  }

  });
});

async function withServer(owner: EngineCaseOwner, run: (fixture: { engine: Engine; connect: () => Promise<{ socket: WebSocket; messages: Message[]; states: () => Message[] }>; reads: () => number }) => Promise<void>) {
  const dir = mkdtempSync(join(owner.root, "petrina-state-stream-"));
  const engine = owner.open(join(dir, "data"), {});
  engine.setPoolPaused(true);
  let reads = 0;
  const windowState = engine.windowState;
  engine.windowState = () => { reads++; return windowState(); };
  const token = randomBytes(24).toString("base64url");
  let server: ReturnType<typeof serve> | undefined;
  const clients: WebSocket[] = [];
  owner.onStop(() => { for (const socket of clients) socket.close(); });
  owner.onStop(() => server?.stop(true));
  server = serve(engine, { port: 0, token });
  const connect = async () => {
    const messages: Message[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`, { protocols: ["petrina.v1", `petrina.token.${token}`], headers: { origin: "tauri://localhost" } } as unknown as string[]);
    clients.push(socket);
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    const states = () => messages.filter((message) => message.type === "state");
    await waitFor(() => states()[0], "the initial state snapshot");
    expect(socket.protocol).toBe("petrina.v1");
    return { socket, messages, states };
  };
  try {
    await owner.run(engine, async () => { await run({ engine, connect, reads: () => reads });
    });
  }
  finally {
    for (const socket of clients) socket.close();
    server.stop(true);
    await owner.stop(engine);

  }
}

it("keeps one unacknowledged state per window and coalesces changes without serializing obsolete snapshots", () => cases.use("petrina-engine-case-", async owner => (withServer(owner, async ({ engine, connect, reads }) => {
  const { socket, states } = await connect();
  const first = states()[0]!;
  for (const limit of [4, 5, 6]) engine.setPoolLimit(limit);
  await Bun.sleep(220);
  expect(states()).toHaveLength(1);
  expect(reads()).toBe(1);
  socket.send(JSON.stringify({ type: "state-ack", stateId: first.stateId }));
  await waitFor(() => states()[1], "the latest coalesced snapshot");
  expect(states()[1]!.state!.pool.limit).toBe(6);
  expect(reads()).toBe(2);
  // A stale receipt cannot release the newer snapshot, including after further changes.
  engine.setPoolLimit(7);
  socket.send(JSON.stringify({ type: "state-ack", stateId: first.stateId }));
  socket.send(JSON.stringify({ type: "state-ack", stateId: "invalid" }));
  await Bun.sleep(220);
  expect(states()).toHaveLength(2);
  socket.send(JSON.stringify({ type: "state-ack", stateId: states()[1]!.stateId }));
  await waitFor(() => states()[2], "the next current snapshot");
  expect(states()[2]!.state!.pool.limit).toBe(7);
}))));

it("keeps other windows and command replies moving while one window stops reading states", () => cases.use("petrina-engine-case-", async owner => (withServer(owner, async ({ engine, connect }) => {
  const slow = await connect(), fast = await connect();
  fast.socket.send(JSON.stringify({ type: "state-ack", stateId: fast.states()[0]!.stateId }));
  slow.socket.send(JSON.stringify({ id: 10, action: { name: "setPoolLimit", args: [8] } }));
  await waitFor(() => slow.messages.find((message) => message.type === "result" && message.id === 10), "the command reply without a state receipt");
  await waitFor(() => fast.states()[1], "the other window's current state");
  expect(slow.states()).toHaveLength(1);
  expect(fast.states()[1]!.state!.pool.limit).toBe(8);
  fast.socket.send(JSON.stringify({ type: "state-ack", stateId: fast.states()[1]!.stateId }));
  engine.setPoolLimit(9);
  await waitFor(() => fast.states()[2], "the other window's next update");
  expect(fast.states()[2]!.state!.pool.limit).toBe(9);
  expect(slow.states()).toHaveLength(1);
}))));

it("sends current state on reconnect without retaining the old window's backlog", () => cases.use("petrina-engine-case-", async owner => (withServer(owner, async ({ engine, connect }) => {
  const first = await connect();
  engine.setPoolLimit(10);
  first.socket.close();
  const next = await connect();
  expect(next.states()[0]!.state!.pool.limit).toBe(10);
  expect(next.states()).toHaveLength(1);
  engine.setPoolLimit(11);
  next.socket.send(JSON.stringify({ type: "state-ack", stateId: next.states()[0]!.stateId }));
  await waitFor(() => next.states()[1], "the reconnected window's next update");
  expect(next.states()[1]!.state!.pool.limit).toBe(11);
}))));

it("skips snapshots when no window is open and resumes when one connects", () => cases.use("petrina-engine-case-", async owner => (withServer(owner, async ({ engine, connect, reads }) => {
  engine.setPoolLimit(4);
  await Bun.sleep(220);
  expect(reads()).toBe(0);
  const client = await connect();
  client.socket.send(JSON.stringify({ type: "state-ack", stateId: client.states()[0]!.stateId }));
  engine.setPoolLimit(5);
  await waitFor(() => client.states()[1], "the window's update");
  expect(client.states()[1]!.state!.pool.limit).toBe(5);
  client.socket.close();
  await waitFor(() => client.socket.readyState === WebSocket.CLOSED, "the closed window");
  const before = reads();
  engine.setPoolLimit(6);
  await Bun.sleep(220);
  expect(reads()).toBe(before);
}))));
