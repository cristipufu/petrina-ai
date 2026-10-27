import { afterAll, expect, it } from "bun:test";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

it("binds the actual conversation operation to its selected task, node and strict schema", async () => {
  return owners.use(async ({ e, c, task, taskId }) => {

  const otherId = e.addTask({ productId: "product", title: "Another conversation", backlog: true });
  e.task(otherId)!.session = [{ id: "other", from: "agent", at: 1, text: "Other task's words" }];
  task.journey = [{ id: "node", kind: "agent", startedAt: 1, round: 1, sub: 0 }];
  task.session = [{ id: "selected", from: "agent", step: "node", at: 2, text: "A😀B" }];
  const read = await c.call("task.conversation", { taskId, nodeId: "node", limit: 1 });
  expect(read.items).toEqual([expect.objectContaining({ id: "selected", text: "B" })]);
  expect(JSON.stringify(read)).not.toContain("Other task's words");
  expect((await c.call("task.conversation", { taskId, nodeId: "missing" })).outcome).toBe("unavailable");
  expect((await c.call("task.conversation", { taskId, limit: 0 })).outcome).toBe("invalid");
  });
});
