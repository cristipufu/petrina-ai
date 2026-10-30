import { afterAll, describe, expect, it } from "bun:test";
import { SLOW, waitFor } from "../../support.js";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";
const { served, close, use } = createWorkflowEventFixtures();
afterAll(close);
describe("waits over the local connection, MCP and the terminal", () => {
it("releases the engine wait promptly when the caller disconnects, and reports a stopped engine", async () => {
  return use("petrina-events-", async caseOwner => {
    const { e, client, taskId , stopServer} = await served(caseOwner);
    try {
      const controller = new AbortController();
      caseOwner.onStop(() => controller.abort());
      const pending = caseOwner.prepare(() => client.call("watch.events", { taskIds: [taskId], timeoutMs: 60_000 }, { signal: controller.signal }));
      await waitFor(() => e.events.waiting === 1, "the engine-side wait", undefined, { during: pending });
      const subscriptions = e.events.log.waiting;
      expect(subscriptions).toBe(1);
      controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ outcome: "disconnected", cancelled: true });
      const released = Date.now();
      await waitFor(() => e.events.waiting === 0 && e.events.log.waiting === 0, "the released subscription", 2_000);
      expect(Date.now() - released).toBeLessThan(2_000 * SLOW);
      const stopping = caseOwner.prepare(() => client.call("watch.events", { taskIds: [taskId], timeoutMs: 60_000 }));
      await waitFor(() => e.events.waiting === 1, "the next wait", undefined, { during: stopping });
      await caseOwner.stop(e);
      expect((await stopping).outcome).toBe("disconnected");
    } finally {
      await stopServer();
    }
  });
});
});
