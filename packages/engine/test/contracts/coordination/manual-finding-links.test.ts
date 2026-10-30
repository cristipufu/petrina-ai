import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { Coordination } from "../../../src/coordination.js";
import { coordinationCli } from "../../../src/coordination-cli.js";
import { mcpRequest } from "../../../src/mcp.js";
import { mcpTools } from "../../../src/mcp-catalog.js";
import type { EngineClient } from "../../client.js";
import { Fakes } from "../../fixtures.js";
import { createFollowUpFixtures, settledSource } from "../../fixtures/follow-up-native.js";
const { open, reopen, close, use } = createFollowUpFixtures();
afterAll(close);
it("records a manual link from archived history to a running request without changing evidence or the request, and retains its receipt", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner);
  try {
    const { engine } = world;
    const source = settledSource(engine, world.shop, { verification: { by: "sol-high", verdict: "pre-existing", reason: "Confirmed on base", at: 1 } });
    engine.save();
    expect(engine.s.tasks.some(task => task.id === source.id)).toBe(false);
    const targetId = engine.addTask({ productId: world.shop, kind: "bug", title: "Coordinator's request", description: "Keep these exact requirements", backlog: true });
    const target = engine.task(targetId)!;
    target.state = "running";
    const request = { title: target.title, description: target.description, products: target.selectedProducts };
    const original = structuredClone(engine.task(source.id)!.findings[0]!);
    const count = engine.getState().tasks.length;
    const args = { taskId: source.id, findingId: "old", targetTaskId: targetId, requestId: "manual-history" };
    const c = new Coordination(engine);
    const result = await c.call("task.track-finding", args);
    expect(result).toEqual({ outcome: "completed", ...args });
    const client = { call: (name: string, args: Record<string, unknown>) => c.call(name, args) } as EngineClient;
    const output = spyOn(console, "log");
    caseOwner.onStop(() => output.mockRestore());
    output.mockImplementation(() => {});
    try {
      expect(await coordinationCli(["task", "track-finding", "--task-id", source.id, "--finding-id", "old", "--target-task-id", targetId, "--request-id", args.requestId, "--json"], client)).toBe(0);
      expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toEqual(result);
    } finally { output.mockRestore(); }
    expect(mcpTools().find(tool => tool.name === "petrina_task_track_finding")!.inputSchema.required).toContain("requestId");
    const mcp = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "petrina_task_track_finding", arguments: args } }, client);
    expect((mcp!.result as { structuredContent: unknown }).structuredContent).toEqual(result);
    expect((await c.call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: targetId })).outcome).toBe("invalid");
    expect(await c.call("task.track-finding", args)).toEqual(result);
    expect((await c.call("task.track-finding", { ...args, targetTaskId: "different" })).outcome).toBe("conflict");
    expect((await c.call("task.track-finding", { ...args, requestId: "already-linked" })).outcome).toBe("completed");
    expect(engine.taskDetails(source.id)!.findings[0]).toEqual({ ...original, tracking: { taskId: targetId } });
    expect((await c.call("task.read", { taskId: source.id, section: "findings", findingId: "old" })).text).toContain(targetId);
    expect(target.followUp!.reports).toHaveLength(1);
    expect(target.followUp!.preserveRequest).toBe(true);
    expect({ title: target.title, description: target.description, products: target.selectedProducts }).toEqual(request);
    expect(engine.getState().tasks).toHaveLength(count);
    expect(world.prompts).toEqual([]);
    expect(new Fakes(join(world.root, "agents")).prompts()).toEqual([]);
    await reopen(world);
    expect(await new Coordination(world.engine).call("task.track-finding", args)).toEqual(result);
    expect(world.engine.task(source.id)!.findings[0]).toEqual({ ...original, tracking: { taskId: targetId } });
    expect(world.engine.task(targetId)!.followUp!.reports).toHaveLength(1);
    expect(world.prompts).toEqual([]);
  } finally { await caseOwner.stop(world.engine); }
  });
});
