import { afterAll, describe, expect, it } from "bun:test";
import { createWorkflowEventFixtures, all } from "../../fixtures/workflow-event-native.js";
const { fixture, close, use } = createWorkflowEventFixtures();
afterAll(close);
describe("the bounded event log", () => {
it("keeps results on their recorded seats when peers share a role and profile, leaving ambiguous history unavailable", async () => {
  return use("petrina-events-", async caseOwner => {
    const { e, c, events } = fixture(caseOwner);
    const taskId = e.addTask({ productId: "product", title: "Shared profiles" });
    const task = e.task(taskId)!;
    task.journey = [{ id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1,
      agentInputs: ["0", "1"].map((reviewerKey, index) => ({ at: 2 + index, roleId: "code-reviewer", profileId: "opus-high", reviewerKey, requestedProfileId: "opus-high", taskTitle: task.title, mode: "fresh", sections: [] })),
      agentResults: [
        { at: 5, roleId: "code-reviewer", profileId: "opus-high", inputIndex: 0, value: { summary: "First seat" } },
        { at: 6, roleId: "code-reviewer", profileId: "opus-high", inputIndex: 1, value: { summary: "Second seat" } },
        { at: 7, roleId: "code-reviewer", profileId: "opus-high", value: { summary: "Unknown older seat" } },
      ],
    }];
    e.commit(task);
    const finishes = all(await events({ taskIds: [taskId], kinds: ["seat.finished"], from: "oldest", timeoutMs: 0 }));
    expect(finishes.map(event => event.seat)).toEqual(["reviewer:0", "reviewer:1", undefined]);
    expect(finishes.slice(0, 2).map(event => event.attempt)).toEqual([1, 1]);
    for (const [seat, index, summary] of [["reviewer:0", 0, "First seat"], ["reviewer:1", 1, "Second seat"]] as const) {
      const result = await c.call("journey.result", { taskId, nodeId: "j1", seat });
      expect(result).toMatchObject({ outcome: "completed", seat, index });
      expect(JSON.parse(String(result.text))).toEqual({ summary });
      expect((await c.call("journey.result", { taskId, nodeId: "j1", seat, index: 2 })).outcome).toBe("unavailable");
    }
  });
});
});
