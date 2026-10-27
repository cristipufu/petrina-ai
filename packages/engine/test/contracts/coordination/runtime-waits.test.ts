import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { syncRuntimeWait } from "@petrina/core";
import { Coordination, requestRevision } from "../../../src/coordination.js";
import { coordinationCli } from "../../../src/coordination-cli.js";
import type { EngineClient } from "../../client.js";
import { mcpRequest } from "../../../src/mcp.js";
import { mcpTools } from "../../../src/mcp-catalog.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


afterEach(() => mock.restore());


function fixture(owner: EngineCaseOwner) {
  const home = mkdtempSync(join(owner.root, "petrina-runtime-wait-coordination-"));

  const engine = owner.open(home, { admissionsClosed: true, agentCommand: () => undefined, terminals: () => [] });

  engine.schedule = () => {};
  engine.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const add = (title: string) => engine.addTask({ productId: "product", title });
  const taskId = add("Running task"), prerequisiteId = add("Fix the tests");
  const task = engine.task(taskId)!;
  task.startedAt = 1;
  task.state = "running";
  const coordination = new Coordination(engine);
  return { engine, coordination, home, task, taskId, prerequisiteId, add };
}

it("offers the same complete-list wait control through CLI and MCP", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { coordination, taskId, prerequisiteId, task } = fixture(owner);
    const client = { call: (name: string, args: unknown) => coordination.call(name, args) } as EngineClient;
    const output = spyOn(console, "log").mockImplementation(() => {});
    expect(mcpTools().find(tool => tool.name === "petrina_task_wait")).toMatchObject({ annotations: { readOnlyHint: false, idempotentHint: true } });
    expect(await coordinationCli(["task", "wait", "--task-id", taskId, "--after", JSON.stringify([prerequisiteId]), "--reason", "The Linux fix must land", "--request-id", "cli-wait", "--json"], client)).toBe(0);
    expect(task.runtimeWait?.after).toEqual([prerequisiteId]);
    const reply = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "petrina_task_wait", arguments: { taskId, after: [], reason: "The coordinator removed the prerequisite", requestId: "mcp-clear" } } }, client);
    expect((reply!.result as { structuredContent: unknown }).structuredContent).toMatchObject({ outcome: "completed", unchanged: false });
    expect(task.runtimeWait?.after).toEqual([]);
    expect(output).toHaveBeenCalled();

  });
});

it("saves decisions and retry receipts together, keeps unchanged requests out of the audit, and survives restart", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, coordination, home, task, taskId, prerequisiteId, add } = fixture(owner);
    const args = { taskId, after: [prerequisiteId], reason: "The prerequisite must land", requestId: "save-wait" };
    const first = await coordination.call("task.wait", args);
    expect(first).toMatchObject({ outcome: "completed", unchanged: false });
    expect(await coordination.call("task.wait", args)).toEqual(first);
    expect((await coordination.call("task.wait", { ...args, reason: "Different", requestId: args.requestId })).outcome).toBe("conflict");
    expect(await coordination.call("task.wait", { ...args, requestId: "same-wait" })).toMatchObject({ outcome: "completed", unchanged: true });
    expect(task.runtimeWait?.changes).toHaveLength(1);
    engine.task(prerequisiteId)!.state = "done";
    expect(await coordination.call("task.wait", { ...args, requestId: "same-after-finished" })).toMatchObject({ outcome: "completed", unchanged: true });
    expect(task.runtimeWait?.changes).toHaveLength(1);
    const otherId = add("Another fix");
    expect(await coordination.call("task.wait", { taskId, after: [otherId], reason: "Use the replacement fix", requestId: "revise-wait" })).toMatchObject({ outcome: "completed", unchanged: false });
    const saved = structuredClone(task.runtimeWait);
    expect(saved?.changes[1]).toMatchObject({ before: [prerequisiteId], after: [otherId], reason: "Use the replacement fix", requestId: "revise-wait" });
    await owner.stop(engine);
    const restarted = owner.open(home, { admissionsClosed: true, agentCommand: () => undefined, terminals: () => [] });

    expect(restarted.task(taskId)!.runtimeWait).toEqual(saved);
    expect(await new Coordination(restarted).call("task.wait", args)).toEqual(first);

  });
});

it("refuses invalid lists and reasons without changing the saved wait", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, coordination, task, taskId, prerequisiteId, add } = fixture(owner);
    const args = { taskId, after: [prerequisiteId], reason: "Required fix", requestId: "valid-wait" };
    expect((await coordination.call("task.wait", args)).outcome).toBe("completed");
    const before = structuredClone(task.runtimeWait);
    const finished = add("Finished task");
    engine.task(finished)!.state = "done";
    for (const [index, change] of [
      { after: ["unknown"] }, { after: [taskId] }, { after: [finished] },
      { reason: "   " }, { reason: "x".repeat(1001) },
      { after: Array.from({ length: 21 }, (_, index) => `task-${index}`) },
      { taskId: prerequisiteId },
    ].entries()) {
      expect((await coordination.call("task.wait", { ...args, ...change, requestId: `invalid-${index}` })).outcome).toBe("invalid");
      expect(task.runtimeWait).toEqual(before);
    }
    for (const state of ["done", "cancelled", "pr-open"] as const) {
      task.state = state;
      expect((await coordination.call("task.wait", { ...args, after: [], requestId: `finished-${state}` })).outcome).toBe("invalid");
      expect(task.runtimeWait).toEqual(before);
    }

  });
});

it("keeps the original wait receipt retryable after admitted publishing ends the hold", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, coordination, home, task, taskId, prerequisiteId } = fixture(owner);
    const args = { taskId, after: [prerequisiteId], reason: "Needed before new work", requestId: "during-publishing" };
    const receipt = await coordination.call("task.wait", args);
    task.state = "pr-open";
    task.repository!.pr = { number: 1, url: "https://example.test/1", state: "open", openedAt: 20 };
    engine["driver"].syncRuntimeWaits();
    engine.commitNow();
    const saved = structuredClone(task.runtimeWait);
    expect(saved?.releaseReason).toContain("Publishing finished");
    expect(await coordination.call("task.wait", args)).toEqual(receipt);
    expect(task.runtimeWait).toEqual(saved);
    expect(await coordination.call("task.inspect", { taskId })).toMatchObject({ task: { waitKind: null } });
    await owner.stop(engine);
    const restarted = owner.open(home, { admissionsClosed: true, agentCommand: () => undefined, terminals: () => [] });

    await restarted.waitUntilReady();
    expect(await new Coordination(restarted).call("task.wait", args)).toEqual(receipt);
    expect(restarted.task(taskId)!.runtimeWait).toEqual(saved);

  });
});

it.each(["landed", "cleared"] as const)("keeps an ended wait unchanged and its clear receipt retryable after restart (ended: %s)", async ending => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, coordination, home, task, taskId, prerequisiteId } = fixture(owner);
    await coordination.call("task.wait", { taskId, after: [prerequisiteId], reason: "Required fix", requestId: "ended-set" });
    if (ending === "landed") {
      engine.task(prerequisiteId)!.repository!.landed = { branch: "main", sha: "landed-fix" };
      syncRuntimeWait(task, id => engine.taskDetails(id), 20);
    } else await coordination.call("task.wait", { taskId, after: [], reason: "The coordinator resolved it", requestId: "ended-clear" });
    // The original post-wait update has completed; a housekeeping clear must not owe another one.
    delete task.runtimeWait!.refreshPending;
    const saved = structuredClone(task.runtimeWait), timeline = structuredClone(task.timeline);
    const request = { taskId, after: [], reason: "Tidy up the ended wait", requestId: "ended-housekeeping" };
    const reply = await coordination.call("task.wait", request);
    expect(reply).toMatchObject({ outcome: "completed", unchanged: true, message: "Unchanged. This prerequisite wait has already ended." });
    expect(task.runtimeWait).toEqual(saved); expect(task.timeline).toEqual(timeline);
    expect(await coordination.call("task.wait", { ...request, reason: "A second reason", requestId: "ended-second" })).toMatchObject({ unchanged: true });
    expect(task.runtimeWait).toEqual(saved); expect(task.timeline).toEqual(timeline);
    await owner.stop(engine);
    const restarted = owner.open(home, { admissionsClosed: true, agentCommand: () => undefined, terminals: () => [] });

    expect(await new Coordination(restarted).call("task.wait", request)).toEqual(reply);
    expect(restarted.task(taskId)!.runtimeWait).toEqual(saved);

  });
});

it("explains wait limits in plain language through CLI and MCP without changing the task", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { coordination, task, taskId, prerequisiteId, add } = fixture(owner);
    const client = { call: (name: string, args: unknown) => coordination.call(name, args) } as EngineClient;
    const output = spyOn(console, "log").mockImplementation(() => {});
    const after = Array.from({ length: 21 }, (_, index) => add(`Required fix ${index}`));
    const args = { taskId, after: [prerequisiteId], reason: "Required fix", requestId: "plain-valid" };
    expect((await coordination.call("task.wait", args)).outcome).toBe("completed");
    const before = structuredClone({ wait: task.runtimeWait, timeline: task.timeline });
    const cases = [
      { change: { reason: "" }, message: "Give a reason between 1 and 1,000 characters." },
      { change: { reason: "   " }, message: "Give a reason between 1 and 1,000 characters." },
      { change: { reason: "x".repeat(1001) }, message: "Give a reason between 1 and 1,000 characters." },
      { change: { after }, message: "Choose up to 20 prerequisites. Remove a task before adding another." },
      { change: { after: Array(21).fill(prerequisiteId) }, message: "Choose up to 20 prerequisites. Remove a task before adding another." },
    ];
    for (const [index, { change, message }] of cases.entries()) {
      const request = { ...args, ...change, requestId: `plain-mcp-${index}` };
      const reply = await mcpRequest({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: "petrina_task_wait", arguments: request } }, client);
      expect((reply!.result as { structuredContent: unknown }).structuredContent).toMatchObject({ outcome: "invalid", message });
      expect(await coordinationCli(["task", "wait", "--task-id", taskId, "--after", JSON.stringify(request.after), "--reason", request.reason, "--request-id", `plain-cli-${index}`, "--json"], client)).toBe(2);
      expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ outcome: "invalid", message });
      expect({ wait: task.runtimeWait, timeline: task.timeline }).toEqual(before);
    }
    // The limits are inclusive; ordinary valid input still reaches the saved control.
    expect((await coordination.call("task.wait", { ...args, after: after.slice(0, 20), reason: "x".repeat(1000), requestId: "plain-boundary" })).outcome).toBe("completed");
    expect(task.runtimeWait?.after).toHaveLength(20);
    expect(task.runtimeWait?.reason).toHaveLength(1000);

  });
});

it("keeps strict wait input shapes separate from the plain-language limits", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { coordination, task, taskId, prerequisiteId } = fixture(owner);
    const before = structuredClone({ wait: task.runtimeWait, timeline: task.timeline });
    for (const [index, change] of [{ reason: null }, { reason: false }, { after: prerequisiteId }, { after: [false] }, { after: [{}] }].entries()) {
      expect((await coordination.call("task.wait", { taskId, after: [prerequisiteId], reason: "Required fix", ...change, requestId: `shape-${index}` })).outcome).toBe("invalid");
      expect({ wait: task.runtimeWait, timeline: task.timeline }).toEqual(before);
    }

  });
});

it("truthfully reports clearing a wait that was never saved and retains its retry receipt", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { coordination, task, taskId } = fixture(owner);
    const before = structuredClone(task.timeline);
    const args = { taskId, after: [], reason: "No prerequisite is needed", requestId: "clear-absent" };
    const reply = await coordination.call("task.wait", args);
    expect(reply).toMatchObject({ outcome: "completed", unchanged: true, message: "Unchanged. This task has no prerequisite wait to clear." });
    expect(await coordination.call("task.wait", args)).toEqual(reply);
    expect(task.runtimeWait).toBeUndefined();
    expect(task.timeline).toEqual(before);

  });
});

it("rejects loops through started waits and unstarted prerequisites in both controls", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, coordination, taskId, prerequisiteId, add } = fixture(owner);
    const queuedId = add("Queued prerequisite");
    engine.setAfter(queuedId, [taskId]);
    expect((await coordination.call("task.wait", { taskId, after: [queuedId], reason: "Would loop", requestId: "runtime-loop" })).outcome).toBe("invalid");
    expect(engine.task(taskId)!.runtimeWait).toBeUndefined();
    expect((await coordination.call("task.wait", { taskId, after: [prerequisiteId], reason: "A genuine prerequisite", requestId: "runtime-edge" })).outcome).toBe("completed");
    expect((await coordination.call("task.dependencies", { taskId: prerequisiteId, after: [queuedId], requestId: "static-loop" })).outcome).toBe("invalid");
    expect(engine.task(prerequisiteId)!.after).toBeUndefined();

  });
});

it("reports saved reason and non-landing decisions, keeps checkpoint revisions stable, and reads the full audit", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, coordination, task, taskId, prerequisiteId } = fixture(owner);
    const item = { id: "checkpoint", taskId, kind: "delivery" as const, title: "Approve delivery", blocking: false, at: 1 };
    engine.s.inbox.push(item);
    const revision = requestRevision(engine, item);
    expect((await coordination.call("task.wait", { taskId, after: [prerequisiteId], reason: "The final Linux run needs this fix", requestId: "reason-wait" })).outcome).toBe("completed");
    expect(requestRevision(engine, item)).toBe(revision);
    const prerequisite = engine.task(prerequisiteId)!;
    prerequisite.state = "cancelled";
    engine.commitNow(prerequisite);
    const inspection = (await coordination.call("task.inspect", { taskId })).task;
    expect(inspection).toMatchObject({ waitKind: "needs-your-decision", runtimeWait: { held: true, reason: "The final Linux run needs this fix", decisionNeeded: true, phase: "active", changeCount: 1, latestChange: { requestId: "reason-wait" }, prerequisites: [{ id: prerequisiteId, state: "cancelled", landed: false, decisionNeeded: true }] } });
    expect((inspection as { runtimeWait: { changes?: unknown } }).runtimeWait.changes).toBeUndefined();
    expect((await coordination.call("task.wait", { taskId, after: [], reason: "Proceed after a coordinator decision", requestId: "decision-clear" })).outcome).toBe("completed");
    const originalTimeline = structuredClone(task.timeline);
    const fullTimeline = await coordination.call("task.read", { taskId, section: "timeline" });
    const recordedEntries = JSON.parse(String(fullTimeline.text));
    expect(recordedEntries).toHaveLength(originalTimeline.length);
    expect(recordedEntries.filter((entry: { kind?: string }) => entry.kind === "prerequisite-wait-change")).toHaveLength(2);
    expect(new Set(recordedEntries.map((entry: { id: string }) => entry.id)).size).toBe(recordedEntries.length);
    task.timeline = [];
    const timeline = await coordination.call("task.read", { taskId, section: "timeline" });
    expect(JSON.parse(String(timeline.text))).toEqual([
    expect.objectContaining({ before: [], after: [prerequisiteId], reason: "The final Linux run needs this fix", requestId: "reason-wait" }),
    expect.objectContaining({ before: [prerequisiteId], after: [], reason: "Proceed after a coordinator decision", requestId: "decision-clear" }),
  ]);
    expect(JSON.parse(String(timeline.text)).map((entry: { id: string }) => entry.id)).toEqual(recordedEntries.filter((entry: { kind?: string }) => entry.kind === "prerequisite-wait-change").map((entry: { id: string }) => entry.id));
    task.timeline = originalTimeline;
    task.state = "done";
    task.finishedAt = Date.now();
    engine.save();
    expect(engine.s.tasks.some(entry => entry.id === taskId)).toBe(false);
    const archived = await coordination.call("task.read", { taskId, section: "timeline" });
    expect(JSON.parse(String(archived.text)).filter((entry: { kind?: string }) => entry.kind === "prerequisite-wait-change")).toHaveLength(2);
    expect(JSON.parse(String(archived.text))).toEqual(recordedEntries);

  });
});
