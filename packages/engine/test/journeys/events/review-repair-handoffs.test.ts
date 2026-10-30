import { afterAll, describe, expect, it } from "bun:test";
import type { WorkflowEvent } from "@petrina/core";
import { Coordination, type Result } from "../../../src/coordination.js";
import { SLOW } from "../../support.js";
import { createWorkflowEventFixtures, all } from "../../fixtures/workflow-event-native.js";
const { setup, close, use } = createWorkflowEventFixtures();
afterAll(close);
describe("a real workflow through the event feed", () => {
it("keeps parallel reviewer seats apart, reconciles findings, records the repair return and the fix round's continued conversation", async () => {
  return use("petrina-events-flow-", async caseOwner => {
    const { engine, productId } = await setup(caseOwner, { planner: "parallel", reviewer: "important", fixes: "change", reviewRounds: 2, reopen: "resume" });
    const c = new Coordination(engine);
    const before = await c.call("watch.events", { timeoutMs: 0 });
    const taskId = engine.addTask({ productId, title: "Fix the greeting", description: "A greeting file." });
    const seen = new Set<string>();
    let cursor = String(before.cursor);
    const observed: WorkflowEvent[] = [];
    const seatReads = new Map<string, Result>();
    for (;;) {
      const page = await c.call("watch.events", { productId, cursor, timeoutMs: 20_000 * SLOW });
      cursor = String(page.cursor);
      observed.push(...all(page));
      for (const event of all(page)) {
        if (event.kind === "seat.started" && event.roleId === "code-reviewer") {
          // Each seat's exact input is readable on its own, without the peer's, while the task is unfinished.
          const ref = (event.refs as { input: { nodeId: string; seat: string; index: number } }).input;
          seatReads.set(`${ref.nodeId}:${ref.seat}:${ref.index}`, await c.call("journey.input", { taskId, nodeId: ref.nodeId, seat: ref.seat, index: ref.index, limit: 200 }));
        }
        if (event.kind === "coordinator.request" && !seen.has(String(event.itemId))) {
          seen.add(String(event.itemId));
          const item = engine.s.inbox.find((entry) => entry.id === event.itemId);
          if (item?.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item?.kind === "permission") engine.allow(item.id, "once");
          else if (item && ["plan", "design", "delivery"].includes(item.kind)) engine.approve(item.id);
        }
      }
      if (observed.some((event) => event.kind === "task.finished")) break;
      expect(engine.task(taskId)?.state).not.toBe("failed");
    }
    expect(engine.task(taskId)!.error).toBeUndefined();
    const reviewSeats = observed.filter((event) => event.kind === "seat.started" && event.roleId === "code-reviewer");
    expect(new Set(reviewSeats.map((event) => event.seat))).toEqual(new Set(["reviewer:0", "reviewer:1"]));
    const firstRound = reviewSeats.filter((event) => event.nodeId === reviewSeats[0]!.nodeId);
    expect(firstRound).toHaveLength(2);
    expect(new Set(firstRound.map((event) => event.exact && (event.exact as { digest: string }).digest)).size).toBe(2);
    for (const seat of firstRound) {
      const ref = (seat.refs as { input: { nodeId: string; seat: string; index: number } }).input;
      expect(seatReads.get(`${ref.nodeId}:${ref.seat}:${ref.index}`)).toMatchObject({ outcome: "completed", seat: ref.seat, attempt: 1, evidence: "exact" });
    }
    const reviews = observed.filter((event) => event.kind === "review.finished");
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews[0]).toMatchObject({ opening: 0, since: "node-start" });
    // The round's step expected both places from the start and examined both: a completed team review.
    expect(observed.find((event) => event.kind === "node.started" && event.nodeId === reviewSeats[0]!.nodeId)).toMatchObject({ seats: ["reviewer:0", "reviewer:1"] });
    expect(observed.find((event) => event.kind === "node.finished" && event.nodeId === reviews[0]!.nodeId)).toMatchObject({ review: { examined: true, acceptedResults: 2, seats: 2 } });
    expect((reviews[0]!.raised as string[]).length).toBeGreaterThanOrEqual(1);
    expect((reviews[0]!.stillOpen as string[]).length).toBeGreaterThanOrEqual(1);
    const repair = observed.find((event) => event.kind === "repair.returned")!;
    expect(repair.repairKind).toBe("review");
    expect(typeof (repair.cause as { nodeId: unknown }).nodeId).toBe("string");
    const fixStart = observed.find((event) => event.kind === "node.started" && event.roleId === "builder" && event.fixing)!;
    expect((fixStart.findingIds as string[]).length).toBeGreaterThanOrEqual(1);
    const fixSeat = observed.find((event) => event.kind === "seat.started" && event.roleId === "builder" && event.nodeId === fixStart.nodeId)!;
    expect(fixSeat).toMatchObject({ mode: "continued", builderConversation: "resumed" });
    expect((fixSeat.manifest as { kind: string }[]).some((entry) => entry.kind === "reference" || entry.kind === "omitted")).toBe(true);
    // Each seat's result keeps the finding copies as its review left them, linked from the review's completion.
    const results = (reviews[0]!.refs as { results: { nodeId: string; index: number; seat: string; findingCopies: number }[] }).results;
    expect(results.map((result) => result.seat).sort()).toEqual(["reviewer:0", "reviewer:1"]);
    const withCopies = results.filter((result) => result.findingCopies > 0);
    expect(withCopies.length).toBeGreaterThanOrEqual(1);
    const id = (reviews[0]!.raised as string[])[0]!;
    const copies = await Promise.all(withCopies.map((result) => c.call("journey.finding", { taskId, nodeId: result.nodeId, findingId: id, result: result.index })));
    expect(copies.some((copy) => copy.outcome === "completed")).toBe(true);
    expect((await c.call("journey.finding", { taskId, nodeId: reviews[0]!.nodeId as string, findingId: id })).outcome).toBe("completed");
    const seatFinishedWithFinding = observed.filter((event) => event.kind === "seat.finished" && event.roleId === "code-reviewer");
    expect(seatFinishedWithFinding.length).toBeGreaterThanOrEqual(2);
    expect(observed.at(-1)).toMatchObject({ kind: "task.finished", history: "committed" });
  });
});
});
