import { expect, it, describe } from "vitest";
import { executionFor } from "../../../src/repository-context.js";
import { eventFixture } from "../../fixtures/workflow-events.js";

describe("focused monitoring evidence regressions", () => {
it("continues a cancelled task's late delivery after more than 200 other tasks finish", async () => {
    const f = eventFixture(); const events = f.query;
    const taskId = f.newTask({ productId: "product", title: "Later merge" }).id;
    const task = f.task(taskId)!;
    executionFor(task).work.pr = { number: 1, url: "https://example.com/1", openedAt: 1, state: "open" };
    task.state = "cancelled";
    f.observe(task);
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    for (let index = 0; index < 201; index++) {
      const other = f.task(f.newTask({ productId: "product", title: `Other ${index}` }).id)!;
      other.state = "done";
      f.observe(other);
    }
    executionFor(task).work.pr!.state = "merged";
    f.observe(task);
    expect(await events({ taskIds: [taskId], cursor: start.cursor, timeoutMs: 0 })).toMatchObject({ continuity: "continuous", events: [expect.objectContaining({ kind: "publishing.result", result: { kind: "merged", landed: true, number: 1, url: "https://example.com/1" } })] });
  });
});
