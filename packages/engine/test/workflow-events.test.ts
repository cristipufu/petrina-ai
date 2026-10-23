// Workflow events: compact, ordered, bounded, and waited on through the shared local connection, the
// MCP connection and the terminal stream, without reading task bodies or touching execution.
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowEvent } from "@petrina/core";
import { Engine } from "./engine.js";
import { Coordination, type Result } from "../src/coordination.js";
import { EngineClient } from "../src/engine-client.js";
import { executionFor } from "../src/repository-context.js";
import { serve } from "../src/server.js";
import { writeConnection } from "../src/instance.js";
import { McpPending, mcpRequest } from "../src/mcp.js";
import { ADAPTERS } from "../src/tools.js";
import { saveExactMessage } from "../src/exact-input.js";
import { boundEvent, EVENT_BYTES } from "../src/workflow-events.js";
import { CLI, Fakes, engineEnv, makeProduct, removeDir, SLOW, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.shutdown()));
  roots.forEach(removeDir);
});

/** An engine that admits no agents: decisions and persistence only. */
function fixture(options: ConstructorParameters<typeof Engine>[1] = {}) {
  const home = tempDir("petrina-events-");
  roots.push(home);
  const e = new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [], ...options });
  engines.push(e);
  e.setPoolPaused(true);
  e.schedule = () => {};
  e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const c = new Coordination(e);
  const events = (args: Record<string, unknown>) => c.call("watch.events", args);
  return { e, c, home, events };
}
const kinds = (result: Result) => (result.events as WorkflowEvent[]).map((event) => event.kind);
const all = (result: Result) => result.events as WorkflowEvent[];

describe("the bounded event log", () => {
  it("records creation, transitions, requests and decisions in order, and stays quiet through activity and text churn", async () => {
    const { e, events } = fixture();
    const start = await events({ timeoutMs: 0 });
    expect(start).toMatchObject({ outcome: "completed", continuity: "fresh", events: [], more: false });
    const taskId = e.addTask({ productId: "product", title: "Watch me", backlog: true });
    const task = e.task(taskId)!;
    const first = await events({ cursor: start.cursor, timeoutMs: 0 });
    expect(kinds(first)).toEqual(["task.created"]);
    expect(first.events).toEqual([expect.objectContaining({ taskId, state: "backlog", productIds: ["product"], seq: 1, run: e.boot })]);
    e.queueTask(taskId);
    // Churn: streamed text, tool activity, to-do items and clocks change nothing in the log.
    task.session.push({ id: "line", from: "agent", at: Date.now(), text: "Working" });
    e.noteStream(task);
    task.toolActivity = { actionCount: 3, lastActivity: "Read a file" };
    task.todo = "Reading the code";
    task.statusLine = "Still working";
    e.noteTodo(task);
    e.commit(task);
    e.commit();
    const second = await events({ cursor: first.cursor, timeoutMs: 0 });
    expect(kinds(second)).toEqual(["task.state"]);
    expect(all(second)[0]).toMatchObject({ from: "backlog", to: "queued" });
    const quiet = await events({ cursor: second.cursor, timeoutMs: 30 });
    expect(quiet).toMatchObject({ outcome: "timed-out", events: [], cursor: second.cursor, continuity: "continuous" });
    // Narrowing all work to a task reuses the cursor; widening it again is refused.
    const waiting = events({ taskIds: [taskId], cursor: quiet.cursor, timeoutMs: 5000 * SLOW });
    await waitFor(() => e.events.waiting === 1, "the subscribed wait");
    // A quiet wait subscribes; it does not poll or clone the task.
    const details = e.taskDetails;
    let reads = 0;
    e.taskDetails = (id) => { reads++; return details(id); };
    await Bun.sleep(1200);
    e.taskDetails = details;
    expect(reads).toBe(0);
    // A question asked by an agent hangs under its step, as the engine records it.
    const askedAt = Date.now();
    task.journey = [{ id: "j1", kind: "agent", roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: askedAt - 10, asks: [{ id: "q1", kind: "question", title: "Which greeting?", at: askedAt }] }];
    e.s.inbox.push({ id: "q1", taskId, kind: "question", title: "Which greeting?", at: askedAt, blocking: true, roleId: "builder", profileId: "sol-xhigh" });
    task.state = "needs-you";
    e.commit(task);
    const asked = await waiting;
    expect(kinds(asked)).toEqual(["node.started", "coordinator.request", "task.state"]);
    expect(all(asked)[1]).toMatchObject({ requestKind: "question", itemId: "q1", nodeId: "j1", refs: { request: { itemId: "q1" } } });
    e.answer("q1", "Hello");
    // The item leaves the inbox one change before its answer is recorded on the journey: one decision, with the answer.
    const answered = await events({ taskIds: [taskId], cursor: asked.cursor, timeoutMs: 0 });
    expect(kinds(answered)).toEqual(["coordinator.decision", "task.state"]);
    expect(all(answered)[0]).toMatchObject({ requestKind: "question", itemId: "q1", how: "answered", answer: "Hello" });
    expect((await events({ cursor: answered.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ productId: "product", cursor: answered.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect(e.events.waiting).toBe(0);
  });

  it("captures rapid transitions inside one change, batches with explicit continuation, replays by stable identity and refuses foreign cursors", async () => {
    const { e, events } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Many steps" });
    const task = e.task(taskId)!;
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    task.state = "running";
    task.journey = [
      { id: "j1", kind: "agent", roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: 10, endedAt: 20, end: "done", outcome: "Change ready", reason: "ready for review", trigger: { reason: "Task started" }, agentInputs: [{ at: 11, roleId: "builder", profileId: "sol-xhigh", requestedProfileId: "sol-xhigh", taskTitle: "Many steps", sections: [], mode: "fresh" }], agentResults: [{ roleId: "builder", profileId: "sol-xhigh", at: 20, value: { summary: "Built", changes: [] } }] },
      { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 21, endedAt: 40, end: "done", outcome: "The check passes", reason: "checks passed", trigger: { after: "j1", reason: "ready for review" }, productChecks: [{ id: "check-0", attemptId: "run-0", name: "Tests", result: "pass", queuedAt: 21, startedAt: 22, endedAt: 40, run: { name: "Tests", command: "bun test", ok: true, ms: 18, output: "" } }] },
      { id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 41, trigger: { after: "j2", reason: "checks passed" } },
    ];
    e.commit(task);
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
    e.commit(task);
    expect(all(await events({ taskIds: [taskId], cursor: page.cursor, limit: 100, timeoutMs: 0 })).map((event) => event.id)).toEqual(all(rest).map((event) => event.id));
    const decoded = JSON.parse(Buffer.from(String(rest.cursor), "base64url").toString());
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    expect((await events({ taskIds: [taskId], cursor: "not-a-cursor", timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ taskIds: [taskId], cursor: encode({ ...decoded, seq: decoded.seq + 50 }), timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ productId: "product", cursor: rest.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    // Narrowing to a subset of kinds is safe; widening a kinds-scoped cursor is not.
    expect((await events({ taskIds: [taskId], kinds: ["node.started"], cursor: rest.cursor, timeoutMs: 0 })).outcome).toBe("completed");
    const other = await events({ taskIds: [taskId], cursor: encode({ ...decoded, run: "other-run" }), timeoutMs: 0 });
    expect(other).toMatchObject({ outcome: "continuity-lost", reason: "engine-restarted", events: [] });
    expect(other.boundary).toMatchObject({ run: e.boot, oldest: 1 });
    // Kinds filter a subset; the cursor never passes an undelivered matching event.
    const starts = await events({ taskIds: [taskId], kinds: ["node.started"], from: "oldest", limit: 2, timeoutMs: 0 });
    expect(kinds(starts)).toEqual(["node.started", "node.started"]);
    expect(starts.more).toBe(true);
    const lastStart = await events({ taskIds: [taskId], kinds: ["node.started"], cursor: starts.cursor, timeoutMs: 0 });
    expect(all(lastStart).map((event) => event.nodeId)).toEqual(["j3"]);
    expect((await events({ taskIds: [taskId], cursor: lastStart.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ taskIds: [taskId], kinds: ["node.started", "seat.started"], cursor: lastStart.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
  });

  it("keeps batches under 64 KB and events under 8 KB with explicit shortening", async () => {
    const { e, events } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Big" });
    const task = e.task(taskId)!;
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    const manifest = Array.from({ length: 12 }, (_, index) => ({ name: `Section ${index} ${"long name ".repeat(80)}`, size: index, digest: `d${index}`, kind: "text" as const }));
    task.journey = Array.from({ length: 40 }, (_, index) => ({ id: `j${index + 1}`, kind: "agent" as const, roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: index, endedAt: index + 1, end: "done" as const, outcome: "Change ready", reason: "ready for review", agentInputs: [{ at: index, roleId: "builder", profileId: "sol-xhigh", taskTitle: "Big", sections: [], mode: "fresh" as const, manifest }] }));
    e.commit(task);
    const page = await events({ taskIds: [taskId], cursor: start.cursor, limit: 100, timeoutMs: 0 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
    expect(page.more).toBe(true);
    expect(page.shortened).toBe(true);
    for (const event of all(page)) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(EVENT_BYTES);
    const seat = all(page).find((event) => event.kind === "seat.started")!;
    expect(seat.shortened).toBe(true);
    expect(seat.shortenedFields).toContain("manifest");
    expect((seat.manifest as unknown[]).length).toBeLessThan(12);
    expect(seat.manifestTotal).toBe(12);
    const huge = boundEvent({ id: "x", seq: 1, run: "r", at: 1, kind: "node.started", taskId, productIds: [], summary: "s", detail: "x".repeat(9000) });
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(EVENT_BYTES);
    expect(huge.shortenedFields).toContain("detail");
  });

  it("evicts the oldest events within the retention bound and reports an expired replay window explicitly", async () => {
    const { e, events } = fixture({ eventRetention: { events: 6 } });
    const taskId = e.addTask({ productId: "product", title: "Evict" });
    const task = e.task(taskId)!;
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    for (const state of ["waiting", "running", "needs-you", "running", "waiting", "running", "paused", "running"] as const) { task.state = state; e.commit(task); }
    expect(e.events.log.size).toBe(6);
    const expired = await events({ taskIds: [taskId], cursor: start.cursor, timeoutMs: 0 });
    expect(expired).toMatchObject({ outcome: "continuity-lost", reason: "replay-expired", events: [] });
    expect(expired.boundary).toMatchObject({ oldest: 4, newest: 9, evictedThrough: 3 });
    const oldest = await events({ taskIds: [taskId], from: "oldest", timeoutMs: 0 });
    expect(all(oldest).map((event) => event.seq)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(oldest.continuity).toBe("fresh");
    const fresh = await events({ taskIds: [taskId], timeoutMs: 0 });
    expect(fresh.events).toEqual([]);
    task.state = "needs-you";
    e.commit(task);
    expect(kinds(await events({ taskIds: [taskId], cursor: fresh.cursor, timeoutMs: 0 }))).toEqual(["task.state"]);
  });

  it("reports replay loss during an open wait, including unrelated bursts, and releases every watcher", async () => {
    const { e, events } = fixture({ eventRetention: { events: 2 } });
    const taskId = e.addTask({ productId: "product", title: "Fast transitions" });
    const task = e.task(taskId)!;
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    const matching = events({ taskIds: [taskId], cursor: start.cursor, timeoutMs: 1000 });
    const filtered = events({ taskIds: [taskId], kinds: ["node.started"], cursor: start.cursor, timeoutMs: 1000 });
    expect(e.events.waiting).toBe(2);
    // No reader can run between these changes. Both cursors lose events, even though one filter has no match.
    for (const state of ["waiting", "running", "paused", "running"] as const) { task.state = state; e.commit(task); }
    for (const result of await Promise.all([matching, filtered])) {
      expect(result).toMatchObject({ outcome: "continuity-lost", reason: "replay-expired", events: [], more: false });
      expect(result.boundary).toMatchObject({ oldest: 4, newest: 5, evictedThrough: 3 });
    }
    expect(e.events.waiting).toBe(0);
    expect(e.events.log.waiting).toBe(0);
    // Explicitly starting again remains possible at the available boundary.
    expect(all(await events({ taskIds: [taskId], from: "oldest", timeoutMs: 0 })).map(event => event.seq)).toEqual([4, 5]);
  });

  it("validates selected archived tasks without reading their bodies, so quiet renewals over more tasks than the archive cache holds read no archive", async () => {
    const { e, events } = fixture();
    const taskIds: string[] = [];
    for (let index = 0; index < 17; index++) {
      const taskId = e.addTask({ productId: "product", title: `Archived ${index}` });
      const task = e.task(taskId)!;
      executionFor(task).work.pr = { number: index + 1, url: `https://github.com/example/product/pull/${index + 1}`, state: "merged", openedAt: 1 };
      Object.assign(task, { state: "done", column: "done", finishedAt: Date.now() });
      e.commit(task);
      taskIds.push(taskId);
    }
    e.save();
    expect(e.s.tasks.filter((task) => taskIds.includes(task.id))).toHaveLength(0);
    const history = e.store.history;
    const bodies = history.get.bind(history);
    let reads = 0;
    history.get = (id) => { reads++; return bodies(id); };
    try {
      const start = await events({ taskIds, timeoutMs: 0 });
      expect(start).toMatchObject({ outcome: "completed", continuity: "fresh", events: [] });
      for (let renewal = 0; renewal < 3; renewal++) {
        expect(await events({ taskIds, cursor: start.cursor, timeoutMs: 20 })).toMatchObject({ outcome: "timed-out", events: [], continuity: "continuous", cursor: start.cursor });
      }
      expect(reads).toBe(0);
      // Validation still refuses a task that never existed, and the retained terminal events stay readable.
      expect((await events({ taskIds: [...taskIds, "missing"], timeoutMs: 0 })).outcome).toBe("missing");
      const replay = await events({ taskIds, kinds: ["task.finished"], from: "oldest", timeoutMs: 0, limit: 100 });
      expect(kinds(replay)).toEqual(Array.from({ length: 17 }, () => "task.finished" as const));
      expect(reads).toBe(0);
    } finally {
      history.get = bodies;
    }
  });

  it("follows a product's newly admitted tasks, keeps terminal and later delivery events readable after retirement, and never touches execution", async () => {
    const { e, c, events } = fixture();
    const start = await events({ productId: "product", timeoutMs: 0 });
    const taskId = e.addTask({ productId: "product", title: "Shipped" });
    const task = e.task(taskId)!;
    task.state = "pr-open";
    executionFor(task).work.pr = { number: 3, url: "https://github.com/example/product/pull/3", state: "open", openedAt: 1 };
    e.commit(task);
    const first = await events({ productId: "product", cursor: start.cursor, timeoutMs: 0 });
    expect(kinds(first)).toEqual(["task.created", "publishing.result", "task.state"]);
    expect(all(first)[1]).toMatchObject({ productId: "product", result: { kind: "pull-request-open", landed: false }, landing: "awaiting-merge" });
    // Merged on GitHub: the task finishes and retires to the archive on the next save.
    executionFor(task).work.pr!.state = "merged";
    Object.assign(task, { state: "done", column: "done", finishedAt: Date.now() });
    e.commit(task);
    e.save();
    expect(e.s.tasks.some((entry) => entry.id === taskId)).toBe(false);
    const finished = await events({ productId: "product", cursor: first.cursor, timeoutMs: 0 });
    expect(kinds(finished)).toEqual(["publishing.result", "task.state", "task.finished"]);
    expect(all(finished)[2]).toMatchObject({ state: "done", landing: "landed", history: "merged", products: [{ productId: "product", result: { kind: "merged", landed: true } }] });
    // An archived task edited later (a cleanup result, a pull request lookup) still produces its event.
    const archived = e.task(taskId)!;
    expect(e.s.tasks.includes(archived)).toBe(false);
    executionFor(archived).work.cleanup = { removedAt: Date.now() };
    executionFor(archived).work.pr!.state = "closed";
    e.commit(archived);
    const later = await events({ productId: "product", cursor: finished.cursor, timeoutMs: 0 });
    expect(later.outcome).toBe("completed");
    expect(kinds(later)).toEqual(["publishing.result"]);
    expect(all(later)[0]).toMatchObject({ result: { kind: "pull-request-closed", decision: "none" } });
    // Another product's task is outside this scope but inside "all current work".
    e.s.products.push({ id: "other", name: "Other", repo: "local/other", tone: "green", delivery: "local" });
    const otherId = e.addTask({ productId: "other", title: "Elsewhere" });
    expect((await events({ productId: "product", cursor: later.cursor, timeoutMs: 0 })).events).toEqual([]);
    // A product cursor cannot widen to all work, nor narrow to a task outside the product.
    expect((await events({ cursor: later.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ taskIds: [otherId], cursor: later.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ taskIds: [taskId], cursor: later.cursor, timeoutMs: 0 })).outcome).toBe("completed");
    expect(kinds(await events({ timeoutMs: 0, from: "oldest" })).filter((kind) => kind === "task.created")).toHaveLength(2);
    expect((await c.call("task.inspect", { taskId: otherId })).outcome).toBe("completed");
    expect((await events({ taskIds: ["missing"], timeoutMs: 0 })).outcome).toBe("missing");
    expect((await events({ productId: "nope", timeoutMs: 0 })).outcome).toBe("missing");
    expect(e.drivers.size).toBe(0);
    expect(e.s.inbox).toEqual([]);
  });

  it("keeps results on their recorded seats when peers share a role and profile, leaving ambiguous history unavailable", async () => {
    const { e, c, events } = fixture();
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

  it("reads a bounded health view and immutable finding copies, and refuses to substitute newer records", async () => {
    const { e, c } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Health" });
    const task = e.task(taskId)!;
    const now = Date.now();
    task.state = "running";
    task.stepClock = { roleId: "code-reviewer", repeat: false, worked: 60_000, since: now - 5_000 };
    task.todo = "Checking the nearby cases";
    task.toolActivity = { actionCount: 4, lastActivity: "Ran the tests", runningTool: { id: "t1", description: "Ran the tests", startedAt: now - 1_000 } };
    task.journey = [{ id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: now - 70_000, agentResults: [{ roleId: "code-reviewer", profileId: "opus-high", at: now, value: { verdict: "fail" }, findings: [{ id: "f1", text: "As this seat saw it", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open" }] }], result: { findings: [{ id: "f1", text: "As the node saw it", severity: "blocking", raisedBy: "opus-high", confirmedBy: ["sol-high"], status: "open" }] } }];
    task.findings = [{ id: "f1", text: "Newer record", severity: "blocking", raisedBy: "opus-high", confirmedBy: ["sol-high"], status: "fixed" }];
    e.commit(task);
    const health = await c.call("task.health", { taskId });
    expect(health).toMatchObject({ outcome: "completed", state: "running", working: true, todo: "Checking the nearby cases", lastActivity: "Ran the tests", estimate: null, node: { id: "j1", roleId: "code-reviewer" } });
    expect(health.workedMs as number).toBeGreaterThanOrEqual(65_000);
    expect(health.lastObservedAt).toBe(now - 1_000);
    expect(JSON.stringify(health)).not.toContain("retry");
    const nodeCopy = await c.call("journey.finding", { taskId, nodeId: "j1", findingId: "f1" });
    expect(JSON.parse(String(nodeCopy.text))).toMatchObject({ text: "As the node saw it", status: "open" });
    expect(nodeCopy.copy).toMatchObject({ basis: "hand-back", label: "Hand-back copy; no settled decision was saved" });
    const seatCopy = await c.call("journey.finding", { taskId, nodeId: "j1", findingId: "f1", result: 0 });
    expect(JSON.parse(String(seatCopy.text))).toMatchObject({ text: "As this seat saw it" });
    expect(seatCopy.copy).toEqual({ kind: "seat-result", result: 0, seat: "code-reviewer", basis: "hand-back", label: "Participant’s report before the round’s decision" });
    expect((await c.call("journey.finding", { taskId, nodeId: "j1", findingId: "f2" })).outcome).toBe("missing");
    expect((await c.call("journey.finding", { taskId, nodeId: "j1", findingId: "f1", result: 3 })).outcome).toBe("missing");
    const result = await c.call("journey.result", { taskId, nodeId: "j1", seat: "code-reviewer" });
    expect(result).toMatchObject({ outcome: "completed", seat: "code-reviewer", index: 0, findingCopies: 1, label: "Participant’s report before the round’s decision" });
    expect(JSON.parse(String(result.text))).toEqual({ verdict: "fail" });
    expect((await c.call("journey.input", { taskId, nodeId: "j1" })).outcome).toBe("unavailable");
  });
});

describe("waits over the local connection, MCP and the terminal", () => {
  function served() {
    const { e, home, events, c } = fixture();
    const token = "events-key-0123456789012345678901";
    const server = serve(e, { port: 0, token });
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, token, pid: process.pid });
    const client = new EngineClient(home, () => { throw new Error("A wait must never launch an engine"); });
    const taskId = e.addTask({ productId: "product", title: "Served" });
    return { e, home, events, c, server, client, taskId, token };
  }

  it("holds one quiet wait open past the server's idle cutoff and completes without reconnecting", async () => {
    const { e, server, client, taskId } = served();
    const fetched = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => { requests++; return fetched(...args); }) as typeof fetch;
    try {
      const start = await client.call("watch.events", { taskIds: [taskId], timeoutMs: 0 });
      const began = Date.now();
      const quiet = await client.call("watch.events", { taskIds: [taskId], cursor: start.cursor, timeoutMs: 11_500 });
      expect(quiet.outcome).toBe("timed-out");
      expect(quiet.reconnected).toBeUndefined();
      expect(quiet.cursor).toBe(start.cursor);
      expect(Date.now() - began).toBeGreaterThanOrEqual(11_400);
      expect(requests).toBe(2);
      expect(e.events.waiting).toBe(0);
    } finally {
      globalThis.fetch = fetched;
      server.stop(true);
    }
  }, 60_000 * SLOW);

  it("releases the engine wait promptly when the caller disconnects, and reports a stopped engine", async () => {
    const { e, server, client, taskId } = served();
    try {
      const controller = new AbortController();
      const pending = client.call("watch.events", { taskIds: [taskId], timeoutMs: 60_000 }, { signal: controller.signal });
      await waitFor(() => e.events.waiting === 1, "the engine-side wait");
      const subscriptions = e.events.log.waiting;
      expect(subscriptions).toBe(1);
      controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ outcome: "disconnected", cancelled: true });
      const released = Date.now();
      await waitFor(() => e.events.waiting === 0 && e.events.log.waiting === 0, "the released subscription", 2_000);
      expect(Date.now() - released).toBeLessThan(2_000 * SLOW);
      const stopping = client.call("watch.events", { taskIds: [taskId], timeoutMs: 60_000 });
      await waitFor(() => e.events.waiting === 1, "the next wait");
      await e.shutdown();
      expect((await stopping).outcome).toBe("disconnected");
    } finally {
      server.stop(true);
    }
  });

  it("ends the matching MCP wait on a cancellation notification, tolerates a late cancellation, and ends every wait when MCP closes", async () => {
    const { e, server, client, taskId } = served();
    try {
      const pending = new McpPending();
      const call = (id: number | string) => mcpRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "petrina_watch_events", arguments: { taskIds: [taskId], timeoutMs: 60_000 } } }, client, pending);
      const first = call(7);
      await waitFor(() => e.events.waiting === 1, "the MCP wait");
      await mcpRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }, client, pending);
      expect(await first).toBeUndefined();
      await waitFor(() => e.events.waiting === 0, "the cancelled wait released", 2_000);
      expect(pending.size).toBe(0);
      // Completed before its cancellation arrives: the reply stands and nothing explodes.
      const done = await mcpRequest({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "petrina_watch_events", arguments: { taskIds: [taskId], timeoutMs: 0 } } }, client, pending);
      expect((done!.result as { structuredContent: Result }).structuredContent.outcome).toBe("completed");
      expect(pending.cancel(8)).toBe(false);
      // Request ids keep their type: cancelling the number 7 leaves the text "7" waiting and tracked.
      const numeric = call(7), text = call("7");
      await waitFor(() => e.events.waiting === 2, "both mixed-id waits");
      expect(pending.size).toBe(2);
      await mcpRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }, client, pending);
      expect(await numeric).toBeUndefined();
      await waitFor(() => e.events.waiting === 1, "only the numeric wait released", 2_000);
      expect(pending.size).toBe(1);
      expect(pending.cancel(7)).toBe(false);
      expect(pending.cancel("7")).toBe(true);
      expect(await text).toBeUndefined();
      await waitFor(() => e.events.waiting === 0, "the text wait released", 2_000);
      const second = call(9), third = call(10);
      await waitFor(() => e.events.waiting === 2, "two MCP waits");
      pending.cancelAll();
      expect(await Promise.all([second, third])).toEqual([undefined, undefined]);
      await waitFor(() => e.events.waiting === 0, "every wait released", 2_000);
    } finally {
      server.stop(true);
    }
  });

  it("streams one batch per line in the terminal, renews quiet deadlines silently and stops cleanly on interruption", async () => {
    const { e, server, home, taskId } = served();
    const proc = Bun.spawn([process.execPath, CLI, "watch", "events", "--task-ids", JSON.stringify([taskId]), "--timeout-ms", "300", "--follow", "--json"], { env: engineEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      await waitFor(() => e.events.waiting >= 1, "the streaming wait");
      await Bun.sleep(900);
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const task = e.task(taskId)!;
      e.s.inbox.push({ id: "stream-q", taskId, kind: "question", title: "Streamed?", at: Date.now(), blocking: true });
      task.state = "needs-you";
      e.commit(task);
      while (!text.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      const lines = text.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const batch = JSON.parse(lines[0]!);
      expect(batch.outcome).toBe("completed");
      expect(batch.events.map((event: WorkflowEvent) => event.kind)).toEqual(["coordinator.request", "task.state"]);
      reader.releaseLock();
      await waitFor(() => e.events.waiting >= 1, "the renewed wait");
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(130);
      await waitFor(() => e.events.waiting === 0, "the stream's wait released", 2_000);
      expect(e.task(taskId)!.state).toBe("needs-you");
    } finally {
      proc.kill("SIGKILL");
      server.stop(true);
    }
  });
});

describe("a real workflow through the event feed", () => {
  const fake = join(import.meta.dir, "fake-agent.ts");
  async function setup(scenario: Parameters<Fakes["scenario"]>[0]) {
    const root = tempDir("petrina-events-flow-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario(scenario);
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, fake, fakes.dir] });
    engines.push(engine);
    const productId = await engine.addProduct(await makeProduct(root));
    engine.setProductDelivery(productId, "local", true);
    return { engine, productId, fakes, root };
  }
  async function drain(c: Coordination, args: Record<string, unknown>): Promise<WorkflowEvent[]> {
    const collected: WorkflowEvent[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await c.call("watch.events", { ...args, limit: 100, timeoutMs: 0, ...(cursor ? { cursor } : { from: "oldest" }) });
      expect(page.outcome).toBe("completed");
      collected.push(...all(page));
      if (!page.more) return collected;
      cursor = String(page.cursor);
    }
  }

  it("links each handoff to its exact input, reports check reuse and causality, and ends with the recorded delivery", async () => {
    const { engine, productId, fakes } = await setup({ planner: "tester-after" });
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
    await engine.shutdown();
    const next = new Engine(engine.dataDir, { agentCommand: () => undefined, admissionsClosed: true });
    engines.push(next);
    const again = new Coordination(next);
    const lost = await again.call("watch.events", { taskIds: [taskId], cursor, timeoutMs: 0 });
    expect(lost).toMatchObject({ outcome: "continuity-lost", reason: "engine-restarted" });
    expect((await again.call("watch.events", { taskIds: [taskId], from: "oldest", timeoutMs: 0 })).events).toEqual([]);
    expect((await again.call("journey.input", { taskId, nodeId: ref.input.nodeId, seat: ref.input.seat })).outcome).toBe("unavailable");
  });

  it("keeps parallel reviewer seats apart, reconciles findings, records the repair return and the fix round's continued conversation", async () => {
    const { engine, productId } = await setup({ planner: "parallel", reviewer: "important", fixes: "change", reviewRounds: 2, reopen: "resume" });
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

describe("a planned reviewer that never starts", () => {
  const fake = join(import.meta.dir, "fake-agent.ts");

  it("stays an expected seat on the step, so a review stopped while it waits for usage is no completed examination", async () => {
    const root = tempDir("petrina-events-seats-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "parallel", builder: "plain", controlled: true });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, fake, fakes.dir] });
    engines.push(engine);
    const productId = await engine.addProduct(await makeProduct(root));
    engine.setProductDelivery(productId, "local", true);
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

describe("focused monitoring evidence regressions", () => {
  it("keeps result finding diagnostics inside their own pages rather than repeating them as metadata", async () => {
    const { e, c } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Large diagnostic" });
    const task = e.task(taskId)!;
    const evidence = "x".repeat(160_000);
    task.journey = [{ id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1, agentResults: [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", value: { summary: "Result" }, findings: [{ id: "f1", text: "A failure", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open", evidence }] }] }];
    e.commit(task);
    let page = await c.call("journey.result", { taskId, nodeId: "j1", index: 0, limit: 1 });
    let result = String(page.text);
    expect(page.findingCopies).toBe(1);
    expect(page.findings).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1500);
    page = await c.call("journey.result", { taskId, nodeId: "j1", index: 0, limit: 100, cursor: page.next });
    result += page.text;
    expect(JSON.parse(result)).toEqual({ summary: "Result" });
    let finding = await c.call("journey.finding", { taskId, nodeId: "j1", result: 0, findingId: "f1", limit: 32000 });
    let text = String(finding.text);
    while (finding.next) { finding = await c.call("journey.finding", { taskId, nodeId: "j1", result: 0, findingId: "f1", limit: 32000, cursor: finding.next }); text += finding.text; }
    expect(JSON.parse(text).evidence).toBe(evidence);
  });

  it("bounds nested causes and complete replies and pages every omitted finding and product", async () => {
    const { e, c, events } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Complete compact pages" });
    const task = e.task(taskId)!;
    task.journey = [{ id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1, trigger: { reason: "Diagnostic ".repeat(9000) } }];
    e.commit(task);
    task.findings = Array.from({ length: 35 }, (_, index) => ({ id: `f-${index}`, text: `Finding ${index}`, status: "open" as const, severity: "blocking" as const, raisedBy: "opus-high", confirmedBy: [] }));
    // The reviewer handed back before its step ended: that accepted result is what makes the review complete.
    task.journey[0]!.agentResults = [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", value: { findings: [], verdict: "pass" } }];
    task.journey[0]!.endedAt = 2;
    e.commit(task);
    const page = await events({ taskIds: [taskId], from: "oldest", timeoutMs: 0, limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
    for (const event of all(page)) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(EVENT_BYTES);
    const start = all(page).find(event => event.kind === "node.started")!;
    expect(start.shortenedFields).toContain("cause.reason");
    const review = all(page).find(event => event.kind === "review.finished")!;
    expect(review.raised).toHaveLength(20);
    expect(review.totals).toMatchObject({ raised: 35, stillOpen: 35 });
    const readAll = async (eventId: string) => {
      let part = await c.call("watch.event", { eventId, limit: 300 });
      let text = String(part.text);
      while (part.next) { part = await c.call("watch.event", { eventId, limit: 300, cursor: part.next }); text += part.text; }
      return JSON.parse(text);
    };
    expect((await readAll(review.id)).raised).toEqual(task.findings.map(finding => finding.id));
    expect((await readAll(start.id)).cause.reason).toBe(task.journey[0]!.trigger!.reason);
    task.repositories = Array.from({ length: 30 }, (_, index) => ({ productId: `product-${index}`, delivery: "release", completedStages: [], release: { tag: "v1", url: `https://example.com/${index}` } }));
    delete task.repository;
    task.activeProductId = task.repositories[0]!.productId;
    task.state = "done";
    e.commit(task);
    const finish = all(await events({ taskIds: [taskId], kinds: ["task.finished"], from: "oldest", timeoutMs: 0 }))[0]!;
    expect((finish.products as unknown[]).length).toBeLessThan(30);
    expect((await readAll(finish.id)).products).toHaveLength(30);
    // Retained detail pages keep the original revision even as the task changes.
    task.findings[0]!.text = "Later wording";
    e.commit(task);
    expect((await readAll(review.id)).raised).toHaveLength(35);
  });

  it("keeps the byte retention bound even when one complete detail exceeds it, and expires its page explicitly", async () => {
    const { e, c, events } = fixture({ eventRetention: { bytes: 1000 } });
    const start = await events({ timeoutMs: 0 });
    const [event] = e.events.log.append([{ at: 1, kind: "node.started", taskId: "large", productIds: ["product"], summary: "A step", cause: { reason: "x".repeat(9000) } }]);
    expect(e.events.log.size).toBe(0);
    expect(await events({ cursor: start.cursor, timeoutMs: 0 })).toMatchObject({ outcome: "continuity-lost", reason: "replay-expired" });
    expect(await c.call("watch.event", { eventId: event!.id })).toMatchObject({ outcome: "unavailable", reason: "replay-expired" });
    expect(await c.call("watch.event", { eventId: "other-run:1" })).toMatchObject({ outcome: "unavailable", reason: "different-engine-run" });
  });

  it("continues a cancelled task's late delivery after more than 200 other tasks finish", async () => {
    const { e, events } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Later merge" });
    const task = e.task(taskId)!;
    executionFor(task).work.pr = { number: 1, url: "https://example.com/1", openedAt: 1, state: "open" };
    task.state = "cancelled";
    e.commit(task);
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    for (let index = 0; index < 201; index++) {
      const other = e.task(e.addTask({ productId: "product", title: `Other ${index}` }))!;
      other.state = "done";
      e.commit(other);
    }
    executionFor(task).work.pr!.state = "merged";
    e.commit(task);
    expect(await events({ taskIds: [taskId], cursor: start.cursor, timeoutMs: 0 })).toMatchObject({ continuity: "continuous", events: [expect.objectContaining({ kind: "publishing.result", result: { kind: "merged", landed: true, number: 1, url: "https://example.com/1" } })] });
  });
});

it("takes a compact review event to its matching checkpoint and original seat evidence", async () => {
  const { e, c, home, events } = fixture();
  const taskId = e.addTask({ productId: "product", title: "Reports stay open" });
  const task = e.task(taskId)!;
  const exact = await saveExactMessage(home, taskId, "The original review instructions");
  task.journey = [{ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", stageId: "review-stage", round: 1, sub: 0, startedAt: 1, agentInputs: [{ at: 1, roleId: "code-reviewer", profileId: "opus-high", taskTitle: task.title, sections: [], mode: "fresh", exact }] }];
  e.commit(task);
  task.findings = [{ id: "old", text: "Earlier problem", severity: "pre-existing", status: "open", raisedBy: "opus-high", confirmedBy: [], tracking: { taskId: "follow-up" } }, { id: "nit", text: "A small improvement", severity: "suggestion", status: "open", raisedBy: "opus-high", confirmedBy: [] }];
  task.journey[0]!.result = { findings: structuredClone(task.findings) };
  task.journey[0]!.agentResults = [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", inputIndex: 0, value: { findings: [], verdict: "pass" }, findings: structuredClone(task.findings) }];
  task.journey[0]!.endedAt = 2;
  e.commit(task);
  const review = all(await events({ taskIds: [taskId], from: "oldest", kinds: ["review.finished"], timeoutMs: 0 }))[0]!;
  expect(review.reportCounts).toEqual({ opening: { total: 0, open: { total: 0, important: 0, nits: 0, preExisting: 0 }, fixed: 0, dismissed: 0, unverified: 0 }, closing: { total: 2, open: { total: 2, important: 0, nits: 1, preExisting: 1 }, fixed: 0, dismissed: 0, unverified: 0 } });
  expect(review.refs!.currentRequests).toEqual({ taskId });
  expect((await c.call("inbox.list", { taskId })).items).toHaveLength(0); // A finished review need not be waiting for a decision.
  const { findingCopies: _copies, ...resultRef } = (review.refs!.results as Record<string, unknown>[])[0]!;
  expect(JSON.parse(String((await c.call("journey.result", resultRef)).text)).verdict).toBe("pass");
  expect((await c.call("journey.input", (review.refs!.inputs as Record<string, unknown>[])[0]!)).text).toBe("The original review instructions");
  task.journey.push({ id: "checkpoint", kind: "you", waitsFor: "delivery", startedAt: 3, round: 1, sub: 0, trigger: { after: "review", reason: "Review finished" } });
  e.s.inbox.push({ id: "delivery-request", taskId, kind: "delivery", title: "Inspect the delivery", at: 3, blocking: false });
  e.commit(task);
  const request = all(await events({ taskIds: [taskId], from: "oldest", kinds: ["coordinator.request"], timeoutMs: 0 }))[0]!;
  expect(request.refs!.request).toEqual({ itemId: "delivery-request" });
  const checkpoint = await c.call("inbox.inspect", request.refs!.request as Record<string, unknown>);
  const view = JSON.parse(String(checkpoint.text));
  expect(view.supportingReview.nodeId).toBe(review.nodeId);
  expect(view.findings.counts.open).toEqual({ total: 2, important: 0, nits: 1, preExisting: 1 });
  task.findings[0]!.status = "fixed";
  const report = (review.reports as any[]).find((report) => report.id === "old");
  const historical = await c.call("journey.finding", report.evidence.read);
  expect(JSON.parse(String(historical.text)).status).toBe("open");
  const current = await c.call("task.read", { taskId, section: "findings", findingId: "old" });
  expect(JSON.parse(String(current.text)).status).toBe("fixed");
});

for (const count of [12, 20]) it(`keeps ${count} mixed report identities before shortening supplemental descriptions`, async () => {
  const { e, c, events } = fixture();
  const taskId = e.addTask({ productId: "product", title: "Prioritize remaining reports" });
  const task = e.task(taskId)!;
  task.journey = [{ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1 }];
  e.commit(task);
  task.findings = Array.from({ length: count }, (_, index) => ({ id: `report-${index}`, text: `Report ${index}: `.padEnd(160, "x"), severity: (["blocking", "suggestion", "pre-existing"] as const)[index % 3]!, status: "open", raisedBy: "opus-high", confirmedBy: [], tracking: { taskId: `follow-up-${index}` } }));
  task.journey[0]!.result = { findings: structuredClone(task.findings) };
  task.journey[0]!.agentResults = [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", value: { findings: [], verdict: "pass" }, findings: structuredClone(task.findings) }];
  task.journey[0]!.endedAt = 2;
  e.commit(task);
  const page = await events({ taskIds: [taskId], from: "oldest", kinds: ["review.finished"], timeoutMs: 0 });
  const event = all(page)[0]!;
  expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(EVENT_BYTES);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
  expect(event.raised).toEqual(task.findings.map((finding) => finding.id));
  expect(event.stillOpen).toEqual(task.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.id));
  expect(event.openImportant).toEqual(event.stillOpen);
  expect(event.openNits).toEqual(task.findings.filter((finding) => finding.severity === "suggestion").map((finding) => finding.id));
  expect(event.openPreExisting).toEqual(task.findings.filter((finding) => finding.severity === "pre-existing").map((finding) => finding.id));
  if (count === 12) {
    expect(event.reports).toHaveLength(count);
    expect(event.shortened).toBeUndefined();
  } else {
    expect((event.reports as unknown[]).length).toBeLessThan(count);
    expect(event.totals).toEqual({ reports: count });
    expect(event.shortenedFields).toEqual(["reports"]);
    let part = await c.call("watch.event", { eventId: event.id, limit: 400 });
    let text = String(part.text);
    while (part.next) { part = await c.call("watch.event", { eventId: event.id, limit: 400, cursor: part.next }); text += part.text; }
    expect(JSON.parse(text).reports).toHaveLength(count);
  }
});

it("keeps new open descriptions ahead of a long settled report history", async () => {
  const { e, c, events } = fixture();
  const taskId = e.addTask({ productId: "product", title: "Keep open work visible" });
  const task = e.task(taskId)!;
  task.findings = Array.from({ length: 22 }, (_, index) => ({ id: `old-${index}`, text: `Settled report ${index}`.padEnd(160, "x"), severity: "blocking", status: "fixed", raisedBy: "opus-high", confirmedBy: [] }));
  task.journey = [{ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1 }];
  e.commit(task);
  task.findings.push({ id: "new-important", text: "The Important work that remains", severity: "blocking", status: "open", raisedBy: "opus-high", confirmedBy: [] }, { id: "new-nit", text: "The small improvement that remains", severity: "suggestion", status: "open", raisedBy: "opus-high", confirmedBy: [] });
  task.journey[0]!.result = { findings: structuredClone(task.findings) };
  task.journey[0]!.agentResults = [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", value: { findings: [], verdict: "pass" } }];
  task.journey[0]!.endedAt = 2;
  e.commit(task);
  const event = all(await events({ taskIds: [taskId], from: "oldest", kinds: ["review.finished"], timeoutMs: 0 }))[0]!;
  expect((event.reports as { id: string }[]).slice(0, 2).map((report) => report.id)).toEqual(["new-important", "new-nit"]);
  expect(event.reportCounts).toEqual({ opening: { total: 22, open: { total: 0, important: 0, nits: 0, preExisting: 0 }, fixed: 22, dismissed: 0, unverified: 0 }, closing: { total: 24, open: { total: 2, important: 1, nits: 1, preExisting: 0 }, fixed: 22, dismissed: 0, unverified: 0 } });
  expect(event.raised).toEqual(["new-important", "new-nit"]);
  let part = await c.call("watch.event", { eventId: event.id, limit: 300 });
  let text = String(part.text);
  while (part.next) { part = await c.call("watch.event", { eventId: event.id, limit: 300, cursor: part.next }); text += part.text; }
  expect(JSON.parse(text).reports).toHaveLength(24);
  expect(JSON.parse(text).reports.at(-1).id).toBe("old-21");
});
