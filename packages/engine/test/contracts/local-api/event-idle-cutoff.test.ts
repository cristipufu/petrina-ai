import { afterAll, describe, expect, it } from "bun:test";
import { SLOW } from "../../support.js";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";

const { served, close, stopServer } = createWorkflowEventFixtures();
afterAll(close);

describe("waits over the local connection, MCP and the terminal", () => {
it("holds one quiet wait open past the server's idle cutoff and completes without reconnecting", async () => {
    const { e, server, client, taskId } = await served();
    const fetched = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => { requests++; return fetched(...args); }) as typeof fetch;
    try {
      const start = await client.call("watch.events", { taskIds: [taskId], timeoutMs: 0 });
      const began = Date.now();
      const quiet = await client.call("watch.events", { taskIds: [taskId], cursor: start.cursor, timeoutMs: 11_500 });
      expect(quiet.outcome).toBe("timed-out");
      expect(quiet.reconnected).toBeUndefined();
      expect(quiet.cursor).toBe(start.cursor);
      expect(Date.now() - began).toBeGreaterThanOrEqual(11_400);
      expect(requests).toBe(2);
      expect(e.events.waiting).toBe(0);
    } finally {
      globalThis.fetch = fetched;
      await stopServer(server);
    }
  }, 60_000 * SLOW);
});
