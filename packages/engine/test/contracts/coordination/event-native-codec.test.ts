import { afterAll, expect, it } from "bun:test";
import { WorkflowEventLog } from "../../../src/workflow-events.js";
import { fingerprint } from "@petrina/storage/receipt-identity";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";

const { fixture, close } = createWorkflowEventFixtures();
afterAll(close);

it("keeps the native SHA/Base64 event cursor and default log composition", async () => {
  const { e, events } = fixture();
  const taskId = e.addTask({ productId: "product", title: "Native cursor" });
  const selected = await events({ taskIds: [taskId], timeoutMs: 0 });
  const decoded = JSON.parse(Buffer.from(String(selected.cursor), "base64url").toString());
  expect(e.events.log).toBeInstanceOf(WorkflowEventLog);
  expect(decoded).toEqual({ run: e.boot, seq: e.events.log.newest, scope: { tasks: fingerprint([taskId]) } });
  expect(decoded.scope.tasks).toMatch(/^[a-f0-9]{24}$/);
  expect((await events({ taskIds: [taskId], cursor: selected.cursor, timeoutMs: 0 })).outcome).toBe("completed");
  expect((await events({ taskIds: [taskId], cursor: "not-a-cursor", timeoutMs: 0 })).outcome).toBe("invalid");
  const foreign = Buffer.from(JSON.stringify({ ...decoded, run: "another-native-run" })).toString("base64url");
  expect(await events({ taskIds: [taskId], cursor: foreign, timeoutMs: 0 })).toMatchObject({ outcome: "continuity-lost", reason: "engine-restarted" });
});
