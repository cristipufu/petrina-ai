import { expect, it } from "vitest";
import { createTaskState, workflowFacts } from "../../../src/index.js";

it("does not derive a prerequisite decision from an agent's status words", () => {
  const task = createTaskState({ productId: "", title: "Ordinary work" }, [], { id: "normal", now: 1, priority: 0, timelineId: "created" });
  task.state = "waiting";
  task.statusLine = "Waiting for your decision: a missing prerequisite was mentioned";
  expect(workflowFacts(task, { roles: [], profiles: [], products: [], inbox: [], now: 2 }).waitKind).toBe("other");
});
