import { describe, expect, it } from "bun:test";
import type { Task } from "@petrina/core";
import { preparedBuilderConversation } from "../../fixtures/branch-boundaries.js";

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("the builder's own conversation", () => {
  it("goes back to it for a fix round, with only its job now and where things stand", async () => {
    const f = await preparedBuilderConversation("resume");
    try {
      const first = await f.buildTurn(), saved = first.builderSession!.sessionId;
      expect(f.fakes!.received("builder")).toHaveLength(1);
      const task = await f.repair(), fakes = f.fakes!;
      expect(lines(task)).toContain("Went back to its own conversation from the last step");
      const builder = fakes.prompts("builder");
      expect(new Set(fakes.received("builder").map(entry => entry.session)).size).toBe(1);
      const back = builder.find(prompt => prompt.startsWith("Petrina is back with more work on this task"));
      expect(back).toContain("You are fixing the review findings listed below");
      expect(back).toContain("## Review findings (answer every one by id; fix every Important one)");
      expect(back).not.toContain("You are the Builder in Petrina");
      expect(fakes.received("builder").map(entry => entry.session)).toEqual([saved, saved]);
      expect(task.journey!.filter(step => step.roleId === "builder").flatMap(step => step.agentInputs ?? []).map(input => input.sessionId)).toEqual([saved, saved]);
    } finally { await f.close(); }
  });

  it("starts a fresh one, with what it reported, when the tool cannot reopen it", async () => {
    const f = await preparedBuilderConversation("unsupported");
    try {
      const first = await f.buildTurn(), saved = first.builderSession!.sessionId;
      expect(first.report!.summary).toBe("Added a greeting.");
      const task = await f.repair(), fakes = f.fakes!;
      expect(lines(task).some((line) => line.startsWith("Could not go back to its own conversation"))).toBe(true);
      const fresh = fakes.openings("builder").at(-1)!;
      expect(fresh).toContain("You are fixing the review findings listed below");
      expect(fresh).toContain("## What the builder reports\nAdded a greeting.");
      expect(fakes.received("builder")).toHaveLength(2);
      expect(fakes.received("builder").at(-1)!.session).not.toBe(saved);
      expect(task.journey!.filter(step => step.roleId === "builder").flatMap(step => step.agentInputs ?? []).at(-1)!.sessionId).not.toBe(saved);
    } finally { await f.close(); }
  });
});
