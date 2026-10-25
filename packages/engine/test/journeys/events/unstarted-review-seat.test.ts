import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowEvent } from "@petrina/core";
import { Coordination } from "../../../src/coordination.js";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { SLOW } from "../../support.js";
import { createWorkflowEventFixtures, all } from "../../fixtures/workflow-event-native.js";

const { setup, close } = createWorkflowEventFixtures();
afterAll(close);

describe("a planned reviewer that never starts", () => {
it("stays an expected seat on the step, so a review stopped while it waits for usage is no completed examination", async () => {
    const { engine, productId, fakes } = await setup({ planner: "parallel", builder: "plain", controlled: true });
    // One agent at a time: the second reviewer cannot start beside the first.
    engine.setPoolLimit(1);
    const c = new Coordination(engine);
    const before = await c.call("watch.events", { timeoutMs: 0 });
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file." });
    const released = new Set<string>();
    const release = (session: string) => { if (!released.has(session)) { released.add(session); writeFileSync(join(fakes.dir, `release-${session}`), "go"); } };
    const seen = new Set<string>();
    let cursor = String(before.cursor);
    const observed: WorkflowEvent[] = [];
    let limited = false;
    let cancelled = false;
    for (;;) {
      const page = await c.call("watch.events", { taskIds: [taskId], cursor, timeoutMs: 2_000 * SLOW });
      cursor = String(page.cursor);
      observed.push(...all(page));
      for (const event of all(page)) {
        if (event.kind === "coordinator.request" && !seen.has(String(event.itemId))) {
          seen.add(String(event.itemId));
          const item = engine.s.inbox.find((entry) => entry.id === event.itemId);
          if (item?.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item?.kind === "permission") engine.allow(item.id, "once");
          else if (item && ["plan", "design", "delivery"].includes(item.kind)) engine.approve(item.id);
        }
        // Once the first reviewer holds the only slot, every tool runs out of usage: the running reviewer finishes its
        // turn, but the second place can neither start on its own tool nor on a stand-in.
        if (event.kind === "seat.started" && event.roleId === "code-reviewer" && !limited) {
          limited = true;
          engine.s.pool.limited = Object.keys(ADAPTERS).map((toolId) => ({ toolId, until: Date.now() + 3_600_000, reason: `${toolId}'s usage limit` }));
        }
      }
      for (const prompt of fakes.received()) if (prompt.role !== "code reviewer" || limited) release(prompt.session);
      const live = engine.task(taskId)!;
      expect(live.state).not.toBe("failed");
      const review = live.journey?.find((step) => step.roleId === "code-reviewer");
      if (!cancelled && review && review.endedAt === undefined && (review.agentResults?.length ?? 0) === 1 && live.state === "waiting") {
        // The first reviewer handed back; the second place is still waiting for usage and never started.
        expect(review).toMatchObject({ seats: ["reviewer:0", "reviewer:1"], team: ["opus-high"] });
        expect(review.agentInputs?.map((input) => input.reviewerKey)).toEqual(["0"]);
        cancelled = true;
        engine.cancel(taskId);
      }
      if (observed.some((event) => event.kind === "task.finished")) break;
    }
    expect(cancelled).toBe(true);
    const task = engine.task(taskId)!;
    const review = task.journey!.find((step) => step.roleId === "code-reviewer")!;
    expect(review).toMatchObject({ end: "cancelled", seats: ["reviewer:0", "reviewer:1"], team: ["opus-high"] });
    expect(review.agentResults).toHaveLength(1);
    // The step expected both places from its start; only one seat ever started and handed back.
    expect(observed.find((event) => event.kind === "node.started" && event.nodeId === review.id)).toMatchObject({ seats: ["reviewer:0", "reviewer:1"], team: ["opus-high"] });
    expect(observed.filter((event) => event.kind === "seat.started" && event.nodeId === review.id).map((event) => event.seat)).toEqual(["reviewer:0"]);
    expect(observed.filter((event) => event.kind === "seat.finished" && event.nodeId === review.id).map((event) => event.seat)).toEqual(["reviewer:0"]);
    const finished = observed.find((event) => event.kind === "node.finished" && event.nodeId === review.id)!;
    expect(finished).toMatchObject({ end: "cancelled", review: { examined: false, acceptedResults: 1, seats: 2 }, refs: { results: [{ nodeId: review.id, seat: "reviewer:0", index: 0 }] } });
    expect(finished.summary).toContain("no completed review (1 of 2 accepted results)");
    expect(observed.some((event) => event.kind === "review.finished")).toBe(false);
    expect(observed.at(-1)).toMatchObject({ kind: "task.finished", state: "cancelled" });
  });
});
