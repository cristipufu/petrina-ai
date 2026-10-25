import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";

import { currentSlow, waitFor } from "../../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { McpPending, mcpRequest } from "../../../src/mcp.js";


import { ExtraFixtures, connection } from "../../extra-fixtures.js";

const owned = new ExtraFixtures();
const {  } = owned;
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
it("keeps a validation wait open past the ordinary connection cutoff and returns still pending", async () => {
    const f = await fixture();
    const { server, client } = connection(f);
    const baseline = f.engine.listeners.size;
    try {
      const from = Date.now();
      const pending = client.call("validation.run", { ...f.request("connection-deadline"), wait: true, timeoutMs: 11_500 });
      // The first submission adds separate queue-owner and caller-wait subscriptions.
      await waitFor(() => f.engine.listeners.size === baseline + 2, "the queue owner and server-side validation wait");
      // The request's wait must not retain the coordination decision queue.
      expect((await client.call("pool.inspect")).outcome).toBe("completed");
      const result = await pending;
      expect(result.outcome).toBe("pending");
      expect(result.message).toContain("Still pending");
      expect(Date.now() - from).toBeGreaterThanOrEqual(11_400);
      expect(f.engine.listeners.size).toBe(baseline + 1); // Only the durable queued owner remains.
      const record = result.validation as ExtraValidation;
      expect(record.state).toBe("queued");
      expect(record.commit).toBe(executionFor(f.task).work.savedVersion!.commit);
      expect(record.tree).toBe(executionFor(f.task).work.savedVersion!.tree);
      expect((await client.call("validation.run", f.request("connection-deadline"))).validation).toEqual(record);
      expect(existsSync(join(f.service, "started"))).toBe(false);
    } finally { server.stop(true); }
  });

it("cancels validation waits through the client and MCP without cancelling or duplicating queued work", async () => {
    const f = await fixture();
    const record = await f.submit("connection-cancel");
    const { server, client } = connection(f);
    const baseline = f.engine.listeners.size;
    const deadline = spyOn(AbortSignal, "timeout");
    const mcp = new McpPending();
    try {
      const controller = new AbortController();
      const wait = client.call("validation.run", { ...f.request("connection-cancel"), wait: true }, { signal: controller.signal });
      await waitFor(() => f.engine.listeners.size === baseline + 1, "the default thirty-second wait");
      expect(deadline).toHaveBeenCalledWith(35_000);
      const from = Date.now(); controller.abort();
      expect(await wait).toMatchObject({ outcome: "disconnected", cancelled: true });
      await waitFor(() => f.engine.listeners.size === baseline, "the cancelled subscription to release", 2_000);
      expect(Date.now() - from).toBeLessThan(2_000 * currentSlow());
      const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
      const before = Date.now();
      expect(await client.call("validation.run", { ...f.request("connection-cancel"), wait: true, timeoutMs: 6_000 }, { signal: alreadyCancelled.signal })).toMatchObject({ outcome: "disconnected", cancelled: true });
      expect(Date.now() - before).toBeLessThan(2_000 * currentSlow());
      const tool = mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "petrina_validation_run", arguments: { ...f.request("connection-cancel"), wait: true, timeoutMs: 6_000 } } }, client, mcp);
      await waitFor(() => f.engine.listeners.size === baseline + 1, "the MCP validation wait");
      await mcpRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }, client, mcp);
      expect(await tool).toBeUndefined();
      await waitFor(() => f.engine.listeners.size === baseline, "the MCP subscription to release", 2_000);
      expect(mcp.size).toBe(0);
      expect((await client.call("validation.run", f.request("connection-cancel"))).validation).toMatchObject({ id: record.id, state: "queued" });
      expect(f.engine.s.extraValidations).toHaveLength(1);
      f.engine.setPoolPaused(false); await f.started(record);
      const runningBaseline = f.engine.listeners.size; // The queue owner's subscription ends at handoff.
      const runningCaller = new AbortController();
      const runningWait = client.call("validation.run", { ...f.request("connection-cancel"), wait: true, timeoutMs: 6_000 }, { signal: runningCaller.signal });
      await waitFor(() => f.engine.listeners.size === runningBaseline + 1, "the running validation wait");
      runningCaller.abort();
      expect(await runningWait).toMatchObject({ outcome: "disconnected", cancelled: true });
      await waitFor(() => f.engine.listeners.size === runningBaseline, "the running wait subscription to release", 2_000);
      const completed = client.call("validation.run", { ...f.request("connection-cancel"), wait: true, timeoutMs: 6_000 });
      await waitFor(() => f.engine.listeners.size === runningBaseline + 1, "the wait for a completed validation");
      f.release(record);
      expect(await completed).toMatchObject({ outcome: "completed", validation: { id: record.id, result: "passed" } });
      expect((await client.call("validation.run", f.request("connection-cancel"))).validation).toMatchObject({ id: record.id, state: "finished", result: "passed" });
      expect(f.engine.listeners.size).toBe(runningBaseline);
      expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
    } finally { deadline.mockRestore(); mcp.cancelAll(); server.stop(true); }
  });
});
