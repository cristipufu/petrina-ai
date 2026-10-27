import { coordinatorCommand } from "../../fixtures/coordinator-process.js";

import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it } from "bun:test";

import { serve } from "../../../src/server.js";
import { writeConnection } from "../../../src/instance.js";
import { CLI } from "../../support.js";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
import { interfaceClient } from "../../fixtures/coordinator-interface.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

for (const kind of ["cli", "mcp"] as const) {
it(`${kind} reports rejected starting points, preserves the previous source and replays the saved rejection`, async () => {
  return owners.use(async ({ home, engine, task, coordination, owner: lifetime }) => {

    engine.s.inbox.push({ id: "plan", taskId: task.id, kind: "plan", title: "Review the plan", at: 1, blocking: false });
    lifetime.check();
    const server = serve(engine, { port: 0, token: "source-validation-key-12345678901" });
    lifetime.onStop(() => server.stop(true));
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token: "source-validation-key-12345678901" });
    const call = interfaceClient(kind, home);
    const choice = { productId: "product", startFrom: { kind: "default" }, delivery: "local" };
    try {
      expect((await call("task.source", { taskId: task.id, choice, requestId: "valid-source" })).outcome).toBe("completed");
      const source = structuredClone(executionFor(task).work.source);
      const inspected = await coordination.call("inbox.inspect", { itemId: "plan" });
      const invalid = { taskId: task.id, choice: { ...choice, startFrom: { kind: "branch", name: "bad..branch" } }, requestId: "invalid-source" };
      const rejected = await call("task.source", invalid, 2);
      expect(rejected.outcome).toBe("invalid");
      expect(rejected.message).toBe(task.workError!);
      expect(rejected.message).toContain("valid branch name");
      expect(executionFor(task).work.source).toEqual(source);
      expect(task.proposedSource).toBeUndefined();
      expect(engine.s.inbox.map((item) => item.id)).toContain("plan");
      expect((await coordination.call("inbox.approve", { itemId: "plan", revision: inspected.revision, requestId: "stale-approval" })).outcome).toBe("changed");
      expect((await call("task.source", { taskId: task.id, choice, requestId: "correct-source" })).outcome).toBe("completed");
      expect(task.workError).toBeUndefined();
      expect(await call("task.source", invalid, 2)).toEqual(rejected);
      expect(task.workError).toBeUndefined();
      expect((await call("task.source", { ...invalid, choice }, 5)).outcome).toBe("conflict");
      expect(executionFor(task).work.source).toEqual(source);
      for (const [index, other] of [
        { ...choice, productId: "unregistered-product" },
        { ...choice, startFrom: { kind: "branch", name: "main" }, delivery: "release" },
      ].entries()) {
        const rejected = await call("task.source", { taskId: task.id, choice: other, requestId: `other-rejection-${index}` }, 2);
        expect(rejected.outcome).toBe("invalid");
        expect(rejected.message).toBe(task.workError!);
        expect(executionFor(task).work.source).toEqual(source);
      }
      if (kind === "cli") {
        const { stdout: out, code } = await coordinatorCommand(home, [CLI, "task", "source", task.id, "--choice", JSON.stringify(invalid.choice), "--request-id", "human-rejection"]);
        expect(code).toBe(2);
        expect(out).toContain("Outcome: invalid");
        expect(out).toContain("valid branch name");
      }
      engine.s.inbox = [];
      expect((await call("task.source", { taskId: task.id, choice, requestId: "no-plan-checkpoint" }, 2)).message).toContain("plan check before work starts");
    } finally { await server.stop(true); }

  }, { prefix: "petrina-coordination-outcomes-", title: "Inspect outcomes" });
});
}
