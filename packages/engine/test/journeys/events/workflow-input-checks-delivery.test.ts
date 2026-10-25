import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { WorkflowEvent } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Coordination, type Result } from "../../../src/coordination.js";
import { EVENT_BYTES } from "../../../src/workflow-events.js";
import { SLOW } from "../../support.js";
import { createWorkflowEventFixtures, all, drain } from "../../fixtures/workflow-event-native.js";

const { setup, close, shutdown, ownEngine } = createWorkflowEventFixtures();
afterAll(close);

describe("a real workflow through the event feed", () => {
it("links each handoff to its exact input, reports check reuse and causality, and ends with the recorded delivery", async () => {
    const { engine, productId, fakes, root } = await setup({ planner: "tester-after" });
    const c = new Coordination(engine);
    const before = await c.call("watch.events", { timeoutMs: 0 });
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file." });
    const seen = new Set<string>();
    let cursor = String(before.cursor);
    const observed: WorkflowEvent[] = [];
    let exactText: string | undefined, exactRead: Result | undefined, manifestRead: Result | undefined;
    // The documented loop: wait from a saved cursor, act on requests, fetch specific evidence when an event warrants it, continue from the returned cursor.
    for (;;) {
      const page = await c.call("watch.events", { taskIds: [taskId], cursor, timeoutMs: 20_000 * SLOW });
      expect(["completed", "timed-out"]).toContain(page.outcome);
      cursor = String(page.cursor);
      observed.push(...all(page));
      for (const event of all(page)) {
        if (event.kind === "seat.started" && event.roleId === "builder" && !exactRead) {
          const ref = (event.refs as { input: { taskId: string; nodeId: string; seat: string; index: number } }).input;
          let exact = await c.call("journey.input", { taskId: ref.taskId, nodeId: ref.nodeId, seat: ref.seat, index: ref.index, limit: 32_000 });
          exactRead = exact;
          exactText = String(exact.text);
          while (exact.next) { exact = await c.call("journey.input", { taskId, nodeId: ref.nodeId, seat: ref.seat, index: ref.index, limit: 32_000, cursor: exact.next }); exactText += exact.text; }
          manifestRead = await c.call("journey.input", { taskId, nodeId: ref.nodeId, seat: ref.seat, section: "manifest" });
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
    const task = engine.task(taskId)!;
    expect(task.error).toBeUndefined();
    const replayed = await drain(c, { taskIds: [taskId] });
    expect(replayed.map((event) => event.id)).toEqual(observed.map((event) => event.id));
    const kindsSeen = observed.map((event) => event.kind);
    expect(kindsSeen[0]).toBe("task.created");
    expect(kindsSeen).toContain("check.queued");
    expect(kindsSeen).toContain("check.finished");
    expect(kindsSeen).toContain("check.reused");
    expect(kindsSeen).toContain("review.finished");
    expect(kindsSeen).toContain("publishing.result");
    expect(kindsSeen.at(-1)).toBe("task.finished");
    // The Builder's handoff names its seat, attempt, fresh conversation and the exact saved message.
    const builderStart = observed.find((event) => event.kind === "seat.started" && event.roleId === "builder")!;
    expect(builderStart).toMatchObject({ seat: "builder", attempt: 1, mode: "fresh", stepAttempts: 1 });
    expect(typeof (builderStart.exact as { size: unknown }).size).toBe("number");
    expect((builderStart.manifest as { name: string }[]).map((entry) => entry.name)).toContain("Role instructions");
    expect(builderStart.conversation).toBeString();
    const ref = builderStart.refs as { input: { taskId: string; nodeId: string; seat: string; index: number } };
    expect(exactRead).toMatchObject({ outcome: "completed", evidence: "exact", source: "saved-file", seat: "builder", attempt: 1 });
    expect(fakes.prompts("builder")).toContain(exactText!);
    expect((exactRead!.file as string).includes(join("contexts", taskId, "messages"))).toBe(true);
    expect(JSON.parse(String(manifestRead!.text))).toContainEqual(expect.objectContaining({ name: "Role instructions", kind: "instructions" }));
    const manifestNames = JSON.parse(String(manifestRead!.text)).map((entry: { name: string }) => entry.name);
    expect(manifestNames.includes("Browser instructions")).toBe(exactText!.includes("Browser output belongs only in") || exactText!.includes("Browser capture folder for this turn:"));
    // Exact messages follow the task's context cleanup: after completion the read says so instead of rebuilding text.
    const afterCleanup = await c.call("journey.input", { taskId, nodeId: ref.input.nodeId, seat: ref.input.seat, index: ref.input.index });
    expect(["completed", "unavailable"]).toContain(afterCleanup.outcome);
    if (afterCleanup.outcome === "unavailable") expect(afterCleanup.message).toContain("no longer available");
    // The Builder finished separately from its checks; the checks ran before review and were reused for the Tester.
    const builderDone = observed.find((event) => event.kind === "seat.finished" && event.roleId === "builder")!;
    expect(builderDone.summary).toContain("automated checks are a separate step");
    const checksNode = observed.find((event) => event.kind === "node.finished" && event.work === "checks")!;
    expect(checksNode.checks).toMatchObject({ failed: 0 });
    expect(typeof (checksNode.versions as { definition: unknown }).definition).toBe("string");
    expect((checksNode.versions as { passed: boolean }).passed).toBe(true);
    const reviewStart = observed.find((event) => event.kind === "node.started" && event.roleId === "code-reviewer")!;
    expect(reviewStart.checks).toMatchObject({ basis: "ran", passed: true, nodeId: checksNode.nodeId });
    const reuse = observed.find((event) => event.kind === "check.reused")!;
    expect(reuse).toMatchObject({ purpose: "acceptance", passed: true, nodeId: checksNode.nodeId });
    const testerStart = observed.find((event) => event.kind === "node.started" && event.roleId === "tester")!;
    expect(testerStart.at).toBeGreaterThanOrEqual(reuse.at);
    expect(testerStart.checks).toMatchObject({ basis: "reused", purpose: "acceptance", passed: true });
    // The reuse record survives on the journey, with the original run's versions.
    const original = task.journey!.find((step) => step.id === checksNode.nodeId)!;
    expect(original.reuses!.map((entry) => entry.purpose)).toEqual(expect.arrayContaining(["acceptance", "delivery-check"]));
    expect(original.checkAttempts![0]!.passed).toBe(true);
    expect(typeof original.checkAttempts![0]!.definition).toBe("string");
    const checkRef = (observed.find((event) => event.kind === "check.finished")!.refs as { check: { nodeId: string; index: number } }).check;
    expect((await c.call("journey.check", { taskId, nodeId: checkRef.nodeId, index: checkRef.index })).commandOutcome).toBe("passed");
    // Review, delivery decision and publishing, through the existing rules.
    const review = observed.find((event) => event.kind === "review.finished")!;
    expect(review).toMatchObject({ since: "node-start", opening: 0 });
    expect(review.closing).toBe((review.raised as string[]).length);
    const delivery = observed.find((event) => event.kind === "coordinator.request" && event.requestKind === "delivery")!;
    expect(observed.find((event) => event.kind === "coordinator.decision" && event.requestKind === "delivery")).toMatchObject({ how: "Approved" });
    expect(delivery.nodeId).toBeString();
    const published = observed.filter((event) => event.kind === "publishing.result");
    expect(published.at(-1)).toMatchObject({ result: { kind: "committed", landed: true }, landing: "landed" });
    expect(observed.at(-1)).toMatchObject({ kind: "task.finished", history: "committed", products: [{ productId, result: { kind: "committed", landed: true } }] });
    expect(JSON.stringify(observed)).not.toContain("You are the Builder");
    for (const event of observed) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(EVENT_BYTES);
    // A restart loses continuity explicitly; the new run starts its own log.
    await shutdown(engine);
    const next = ownEngine(root, new Engine(engine.dataDir, { agentCommand: () => undefined, admissionsClosed: true }));
    try {
    const again = new Coordination(next);
    const lost = await again.call("watch.events", { taskIds: [taskId], cursor, timeoutMs: 0 });
    expect(lost).toMatchObject({ outcome: "continuity-lost", reason: "engine-restarted" });
    expect((await again.call("watch.events", { taskIds: [taskId], from: "oldest", timeoutMs: 0 })).events).toEqual([]);
    expect((await again.call("journey.input", { taskId, nodeId: ref.input.nodeId, seat: ref.input.seat })).outcome).toBe("unavailable");
    } finally { await shutdown(next); }
  });
});
