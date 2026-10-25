import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkLog } from "@petrina/storage/worklog";

it("counts runs within the requested task and stage, including repeated runs after reopening the log", () => {
  const db = new Database(":memory:");
  try {
    const log = new WorkLog(db);
    for (const [id, taskId, stageId, kind] of [
      ["first", "task-a", "build", "stage-start"], ["second", "task-a", "build", "stage-start"],
      ["other-stage", "task-a", "test", "stage-start"], ["other-task", "task-b", "build", "stage-start"],
      ["end", "task-a", "build", "stage-end"],
    ] as const) log.addMoment({ id, taskId, productId: "p", stageId, kind, at: 1 });
    expect(log.stageRuns("task-a", "build")).toBe(2);
    expect(log.stageRuns("task-a", "test")).toBe(1);
    expect(log.stageRuns("task-b", "build")).toBe(1);
    expect(log.stageRuns("missing", "build")).toBe(0);
    log.close();
    expect(new WorkLog(db).stageRuns("task-a", "build")).toBe(2);
  } finally { db.close(); }
});
