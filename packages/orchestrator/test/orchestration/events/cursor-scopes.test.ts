import type { WorkflowEvent } from "@petrina/core";
import { expect, it, describe } from "vitest";
import { eventFixture, kinds, all } from "../../fixtures/workflow-events.js";

describe("the bounded event log", () => {
it("captures rapid transitions inside one change, batches with explicit continuation, replays by stable identity and refuses foreign cursors", async () => {
    const f = eventFixture(); const events = f.query;
    const taskId = f.newTask({ productId: "product", title: "Many steps" }).id;
    const task = f.task(taskId)!;
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    task.state = "running";
    task.journey = [
      { id: "j1", kind: "agent", roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: 10, endedAt: 20, end: "done", outcome: "Change ready", reason: "ready for review", trigger: { reason: "Task started" }, agentInputs: [{ at: 11, roleId: "builder", profileId: "sol-xhigh", requestedProfileId: "sol-xhigh", taskTitle: "Many steps", sections: [], mode: "fresh" }], agentResults: [{ roleId: "builder", profileId: "sol-xhigh", at: 20, value: { summary: "Built", changes: [] } }] },
      { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 21, endedAt: 40, end: "done", outcome: "The check passes", reason: "checks passed", trigger: { after: "j1", reason: "ready for review" }, productChecks: [{ id: "check-0", attemptId: "run-0", name: "Tests", result: "pass", queuedAt: 21, startedAt: 22, endedAt: 40, run: { name: "Tests", command: "bun test", ok: true, ms: 18, output: "" } }] },
      { id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 41, trigger: { after: "j2", reason: "checks passed" } },
    ];
    f.observe(task);
    // Recorded times order the batch; the observed state change comes last.
    const page = await events({ taskIds: [taskId], cursor: start.cursor, limit: 4, timeoutMs: 0 });
    expect(kinds(page)).toEqual(["node.started", "seat.started", "seat.finished", "node.finished"]);
    expect(page.more).toBe(true);
    const rest = await events({ taskIds: [taskId], cursor: page.cursor, limit: 100, timeoutMs: 0 });
    expect(kinds(rest)).toEqual(["node.started", "check.queued", "check.started", "check.finished", "node.finished", "node.started", "task.state"]);
    expect(rest.more).toBe(false);
    expect(all(rest).map((event) => event.seq)).toEqual(all(rest).map((_, index) => (page.events as WorkflowEvent[]).at(-1)!.seq + index + 1));
    // The same cursor replays the same identities, and appends do not invalidate it.
    task.statusLine = "Reviewing";
    f.observe(task);
    expect(all(await events({ taskIds: [taskId], cursor: page.cursor, limit: 100, timeoutMs: 0 })).map((event) => event.id)).toEqual(all(rest).map((event) => event.id));
    const decoded = f.codec.decodeCursor(String(rest.cursor)) as { seq: number; run: string; scope: unknown };
    const encode = (value: unknown) => f.codec.encodeCursor(value);
    expect((await events({ taskIds: [taskId], cursor: "not-a-cursor", timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ taskIds: [taskId], cursor: encode({ ...decoded, seq: decoded.seq + 50 }), timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ productId: "product", cursor: rest.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    // Narrowing to a subset of kinds is safe; widening a kinds-scoped cursor is not.
    expect((await events({ taskIds: [taskId], kinds: ["node.started"], cursor: rest.cursor, timeoutMs: 0 })).outcome).toBe("completed");
    const other = await events({ taskIds: [taskId], cursor: encode({ ...decoded, run: "other-run" }), timeoutMs: 0 });
    expect(other).toMatchObject({ outcome: "continuity-lost", reason: "engine-restarted", events: [] });
    expect(other.boundary).toMatchObject({ run: f.host.boot, oldest: 1 });
    // Kinds filter a subset; the cursor never passes an undelivered matching event.
    const starts = await events({ taskIds: [taskId], kinds: ["node.started"], from: "oldest", limit: 2, timeoutMs: 0 });
    expect(kinds(starts)).toEqual(["node.started", "node.started"]);
    expect(starts.more).toBe(true);
    const lastStart = await events({ taskIds: [taskId], kinds: ["node.started"], cursor: starts.cursor, timeoutMs: 0 });
    expect(all(lastStart).map((event) => event.nodeId)).toEqual(["j3"]);
    expect((await events({ taskIds: [taskId], cursor: lastStart.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ taskIds: [taskId], kinds: ["node.started", "seat.started"], cursor: lastStart.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
  });
});
