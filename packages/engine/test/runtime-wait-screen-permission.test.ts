import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { screenNext } from "@petrina/core";
import { Engine } from "./engine.js";
import { removeDir, tempDir } from "./fixtures.js";
import { Coordination, requestRevision } from "../src/coordination.js";
import { coordinationCli } from "../src/coordination-cli.js";
import type { EngineClient } from "./client.js";
import { mcpRequest } from "../src/mcp.js";

const roots: string[] = [], engines: Engine[] = [];
afterEach(() => mock.restore());
afterAll(async () => {
  await Promise.all(engines.map(engine => engine.shutdown()));
  roots.forEach(removeDir);
});

/** Exercise saved permission decisions and scheduling without starting an agent or using a screen. */
function fixture() {
  const home = tempDir("petrina-held-screen-permission-"); roots.push(home);
  const options = { admissionsClosed: true, agentCommand: () => undefined, terminals: () => [] };
  let engine = new Engine(home, options); engines.push(engine);
  engine.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const taskId = engine.addTask({ productId: "product", title: "Screen check", backlog: true });
  const prerequisiteId = engine.addTask({ productId: "product", title: "Fix screen validation", backlog: true });
  const task = engine.task(taskId)!;
  task.startedAt = 1;
  task.state = "waiting";
  task.screen = { at: 2, reason: "Check the saved window", roleId: "builder", profileId: "sol-xhigh" };
  engine.syncScreen();
  engine.commitNow();
  const item = engine.s.inbox.find(item => item.taskId === taskId && item.kind === "screen")!;
  const revision = requestRevision(engine, item);
  return {
    get engine() { return engine; },
    get coordination() { return new Coordination(engine); },
    taskId, prerequisiteId, item: structuredClone(item), revision,
    async restart() {
      await engine.shutdown();
      engine = new Engine(home, options); engines.push(engine);
      await engine.waitUntilReady();
    },
  };
}

describe("screen permission references during prerequisite waits", () => {
  it("keeps the original request and revision through a hold, restart and clear before permission is answered", async () => {
    const f = fixture();
    const saved = structuredClone(f.engine.task(f.taskId)!.screen);
    expect((await f.coordination.call("task.wait", { taskId: f.taskId, after: [f.prerequisiteId], reason: "Wait for the screen fix", requestId: "hold-permission" })).outcome).toBe("completed");
    expect(f.engine.s.inbox.find(item => item.id === f.item.id)).toEqual(f.item);
    expect((await f.coordination.call("inbox.inspect", { itemId: f.item.id })).revision).toBe(f.revision);
    await f.restart();
    expect(f.engine.s.inbox.find(item => item.id === f.item.id)).toEqual(f.item);
    expect((await f.coordination.call("task.wait", { taskId: f.taskId, after: [], reason: "The coordinator resolved the prerequisite", requestId: "clear-permission" })).outcome).toBe("completed");
    expect(f.engine.s.inbox.filter(item => item.taskId === f.taskId && item.kind === "screen")).toEqual([f.item]);
    expect((await f.coordination.call("inbox.inspect", { itemId: f.item.id })).revision).toBe(f.revision);
    expect(f.engine.task(f.taskId)!.screen).toEqual(saved);
    const output = spyOn(console, "log").mockImplementation(() => {});
    const client = { call: (name: string, args: unknown) => f.coordination.call(name, args) } as EngineClient;
    expect(await coordinationCli(["screen", "allow", "--item-id", f.item.id, "--revision", f.revision, "--request-id", "allow-after-clear", "--json"], client)).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ outcome: "pending" });
    expect(f.engine.task(f.taskId)!.screen?.allowed).toBe(true);
    expect(f.engine.task(f.taskId)!.screen?.granted).not.toBe(true);
  });

  it("allows the saved request while held and keeps the reply receipt across restart without admitting the task", async () => {
    const f = fixture();
    expect((await f.coordination.call("task.wait", { taskId: f.taskId, after: [f.prerequisiteId], reason: "Wait for the screen fix", requestId: "hold-answer" })).outcome).toBe("completed");
    const args = { itemId: f.item.id, revision: f.revision, requestId: "allow-while-held" };
    const client = { call: (name: string, args: unknown) => f.coordination.call(name, args) } as EngineClient;
    const reply = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "petrina_screen_allow", arguments: args } }, client);
    const result = (reply!.result as { structuredContent: unknown }).structuredContent;
    expect(result).toMatchObject({ outcome: "pending", message: "Screen request allowed; existing screen and pool rules still apply." });
    const assertHeld = () => {
      expect(f.engine.task(f.taskId)!.screen).toEqual({ at: 2, reason: "Check the saved window", roleId: "builder", profileId: "sol-xhigh", allowed: true });
      expect(f.engine.s.inbox.some(item => item.id === f.item.id)).toBe(false);
      expect(f.engine.task(f.taskId)!.holdsSlot).toBe(false);
      expect(f.engine.drivers.has(f.taskId)).toBe(false);
      expect(screenNext(f.engine.getState(), Date.now())).toBeUndefined();
    };
    assertHeld();
    expect(result).toEqual(await f.coordination.call("screen.allow", args));
    expect(f.engine.task(f.taskId)!.timeline.filter(line => line.text === "You allowed the screen for this request")).toHaveLength(1);
    await f.restart();
    assertHeld();
    expect(result).toEqual(await f.coordination.call("screen.allow", args));
    expect(f.engine.task(f.taskId)!.timeline.filter(line => line.text === "You allowed the screen for this request")).toHaveLength(1);
    expect((await f.coordination.call("task.wait", { taskId: f.taskId, after: [], reason: "The coordinator resolved the prerequisite", requestId: "release-answer" })).outcome).toBe("completed");
    expect(screenNext(f.engine.getState(), Date.now())).toBe(f.taskId);
    expect(f.engine.task(f.taskId)!.screen?.granted).not.toBe(true);
  });

  it.each([false, true])("keeps ordinary screen requests answerable with the pool paused: %s", async paused => {
    const f = fixture();
    if (paused) f.engine.setPoolPaused(true);
    expect(f.engine.s.inbox.find(item => item.id === f.item.id)).toEqual(f.item);
    expect((await f.coordination.call("screen.allow", { itemId: f.item.id, revision: f.revision, requestId: "normal-permission" })).outcome).toBe("pending");
    expect(f.engine.task(f.taskId)!.screen?.allowed).toBe(true);
    expect(f.engine.task(f.taskId)!.screen?.granted).not.toBe(true);
    expect(screenNext(f.engine.getState(), Date.now())).toBe(f.taskId);
  });
});
