import { afterAll, describe, expect, it } from "bun:test";
import { type Result } from "../../../src/coordination.js";
import { McpPending, mcpRequest } from "../../../src/mcp.js";
import { waitFor } from "../../support.js";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";
const { served, close, use } = createWorkflowEventFixtures();
afterAll(close);
describe("waits over the local connection, MCP and the terminal", () => {
it("ends the matching MCP wait on a cancellation notification, tolerates a late cancellation, and ends every wait when MCP closes", async () => {
  return use("petrina-events-", async caseOwner => {
    const { e, client, taskId , stopServer} = await served(caseOwner);
    try {
      const pending = new McpPending();
      caseOwner.onStop(() => pending.cancelAll());
      const call = (id: number | string) => mcpRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "petrina_watch_events", arguments: { taskIds: [taskId], timeoutMs: 60_000 } } }, client, pending);
      const first = caseOwner.prepare(() => call(7));
      await waitFor(() => e.events.waiting === 1, "the MCP wait", undefined, { during: first });
      await mcpRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }, client, pending);
      expect(await first).toBeUndefined();
      await waitFor(() => e.events.waiting === 0, "the cancelled wait released", 2_000);
      expect(pending.size).toBe(0);
      // Completed before its cancellation arrives: the reply stands and nothing explodes.
      const done = await mcpRequest({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "petrina_watch_events", arguments: { taskIds: [taskId], timeoutMs: 0 } } }, client, pending);
      expect((done!.result as { structuredContent: Result }).structuredContent.outcome).toBe("completed");
      expect(pending.cancel(8)).toBe(false);
      // Request ids keep their type: cancelling the number 7 leaves the text "7" waiting and tracked.
      const numeric = caseOwner.prepare(() => call(7)), text = caseOwner.prepare(() => call("7"));
      await waitFor(() => e.events.waiting === 2, "both mixed-id waits", undefined, { during: Promise.all([numeric, text]) });
      expect(pending.size).toBe(2);
      await mcpRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }, client, pending);
      expect(await numeric).toBeUndefined();
      await waitFor(() => e.events.waiting === 1, "only the numeric wait released", 2_000);
      expect(pending.size).toBe(1);
      expect(pending.cancel(7)).toBe(false);
      expect(pending.cancel("7")).toBe(true);
      expect(await text).toBeUndefined();
      await waitFor(() => e.events.waiting === 0, "the text wait released", 2_000);
      const second = caseOwner.prepare(() => call(9)), third = caseOwner.prepare(() => call(10));
      await waitFor(() => e.events.waiting === 2, "two MCP waits", undefined, { during: Promise.all([second, third]) });
      pending.cancelAll();
      expect(await Promise.all([second, third])).toEqual([undefined, undefined]);
      await waitFor(() => e.events.waiting === 0, "every wait released", 2_000);
    } finally {
      await stopServer();
    }
  });
});
});
