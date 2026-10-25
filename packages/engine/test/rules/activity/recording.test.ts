import { describe, expect, it } from "bun:test";
import { clearRunningTools, createTaskState } from "@petrina/core";
import { MAX_TOOL_COMMAND, MAX_TOOL_INVOCATIONS, ToolInvocations } from "@petrina/agent-runtime/tool-invocations";
import type { ToolActivityEvent } from "@petrina/orchestrator";
import { recordToolActivity } from "../../../src/record-tool-activity.js";
import { createToolActivity } from "@petrina/agent-runtime/tool-activity";

function fixture() {
  const task = createTaskState({ productId: "", title: "Invocation evidence" }, [], { id: "task", timelineId: "timeline", now: 0, priority: 0 });
  task.state = "running"; task.statusLine = "Working";
  task.journey = [{ id: "step", kind: "agent", startedAt: 0, round: 1, sub: 0 }];
  let at = 10, serial = 0;
  const events: ToolActivityEvent[] = [];
  const track = (seat = "main") => new ToolInvocations(event => {
    events.push(structuredClone(event));
    recordToolActivity(task, "step", { seat, roleId: "reviewer", profileId: seat, productId: "p" }, event);
  }, { now: () => at++, id: () => `inv-${++serial}`, activity: createToolActivity(() => undefined) });
  const records = () => task.journey![0]!.toolInvocations!;
  const summary = (seat = "main") => task.journey![0]!.toolActivity![seat]!;
  return { task, events, track, records, summary };
}

describe("bounded invocation evidence", () => {
  it("counts identical actions separately and merges streamed command metadata and outcomes in place", () => {
    const f = fixture(), tools = f.track();
    tools.update({ toolCallId: "one", title: "Shell", kind: "execute", status: "pending" }, true);
    const id = f.records()[0]!.id;
    tools.update({ toolCallId: "one", rawInput: { cmd: ["date", "+%s"] }, status: "in_progress" }, false);
    tools.update({ toolCallId: "one", rawInput: { description: "Check the clock" }, title: "Clock", kind: "execute", locations: [{ path: "/product" }] }, false);
    tools.update({ toolCallId: "one", rawInput: null, title: null, status: "completed" }, false);
    expect(f.summary()).toEqual(expect.objectContaining({ actionCount: 1, lastActivity: "Check the clock" }));
    expect(f.summary().runningTool).toBeUndefined();
    expect(f.records()).toEqual([expect.objectContaining({ id, toolCallId: "one", command: "date +%s", paths: ["/product"], title: "Clock", kind: "execute", description: "Check the clock", status: "completed", startedAt: 10, updatedAt: 13, endedAt: 13 })]);
    tools.update({ toolCallId: "two", kind: "execute", rawInput: { description: "Check the clock" } }, true);
    expect(f.summary().actionCount).toBe(2);
    expect(f.records()).toHaveLength(2);
    expect(f.records()[1]!.id).not.toBe(id);
    expect(f.records()[1]!.status).toBeUndefined();
    expect(f.records()[1]!.command).toBeUndefined();
  });

  it("keeps overlapping calls active independently and never promotes a late completed call", () => {
    const f = fixture(), tools = f.track();
    tools.update({ toolCallId: "one", kind: "execute", status: "in_progress" }, true);
    tools.update({ toolCallId: "two", kind: "read", status: "pending" }, true);
    tools.update({ toolCallId: "one", status: "failed" }, false);
    expect(f.summary().runningTool?.id).toBe(f.records()[1]!.id);
    tools.update({ toolCallId: "two", status: "completed" }, false);
    tools.update({ toolCallId: "one", rawInput: { cmd: "date" } }, false);
    expect(f.summary()).toEqual(expect.objectContaining({ actionCount: 2, lastActivity: "Reading the code" }));
    expect(f.summary().runningTool).toBeUndefined();
    expect(f.records()[0]!.status).toBe("failed");
    expect(f.records()[0]!.command).toBe("date");
    expect(f.records()[0]!.endedAt).toBe(12);
    tools.update({ toolCallId: "three", kind: "execute" }, true);
    tools.update({ toolCallId: "four", kind: "read", status: "completed" }, true);
    expect(f.summary().runningTool?.id).toBe(f.records()[2]!.id);
  });

  it("separates reviewer and voter seats, clears ended turns without inventing completion, and accepts reused IDs in later turns", () => {
    const f = fixture(), a = f.track("reviewer:0"), b = f.track("reviewer:1"), voter = f.track("verifier:1");
    for (const tools of [a, b, voter]) tools.update({ toolCallId: "same", kind: "execute", status: "in_progress" }, true);
    a.endTurn();
    expect(f.summary("reviewer:0").runningTool).toBeUndefined();
    expect(f.summary("reviewer:1").runningTool).toBeDefined();
    expect(f.summary("verifier:1").runningTool).toBeDefined();
    expect(f.records()[0]).toEqual(expect.objectContaining({ status: "in_progress", turnEndedAt: 13 }));
    expect(f.records()[0]!.endedAt).toBeUndefined();
    a.startTurn();
    a.update({ toolCallId: "same", kind: "read", status: "completed" }, true);
    expect(f.summary("reviewer:0").actionCount).toBe(2);
    expect(new Set(f.records().map(record => record.id)).size).toBe(4);
    b.endTurn(); voter.endTurn();
    expect(f.records()[3]!.turnEndedAt).toBeUndefined();
    a.update({ toolCallId: "unknown", status: "completed" }, false);
    expect(f.records()).toHaveLength(4);
  });

  it("bounds long sessions, excludes plumbing, and ignores updates to evicted or previous-turn calls", () => {
    const f = fixture(), tools = f.track();
    tools.update({ toolCallId: "todo", title: "TodoWrite" }, true);
    tools.update({ toolCallId: "todo", rawInput: { description: "Private bookkeeping" } }, false);
    for (let i = 0; i < MAX_TOOL_INVOCATIONS + 30; i++) tools.update({ toolCallId: String(i), kind: "execute", title: "X".repeat(1000), rawInput: { command: "x".repeat(9000), output: "discard".repeat(1000) }, locations: Array.from({ length: 20 }, () => ({ path: "p".repeat(900) })), status: "completed" }, true);
    expect(f.summary().actionCount).toBe(MAX_TOOL_INVOCATIONS + 30);
    expect(f.records()).toHaveLength(MAX_TOOL_INVOCATIONS);
    expect(f.records()[0]!.toolCallId).toBe("30");
    expect(f.records().every(record => record.command?.length === MAX_TOOL_COMMAND && record.title?.length === 240 && record.paths?.length === 8 && record.paths.every(path => path.length === 512) && record.metadataShortened)).toBe(true);
    expect(JSON.stringify(f.records())).not.toContain("discard");
    const before = structuredClone(f.records());
    tools.update({ toolCallId: "0", status: "failed" }, false);
    expect(f.records()).toEqual(before);
    tools.endTurn(); tools.startTurn();
    tools.update({ toolCallId: "129", status: "failed" }, false);
    expect(f.records()).toEqual(before);
  });

  it("clears stale running summaries on recovery without changing recorded outcomes", () => {
    const f = fixture(), tools = f.track();
    tools.update({ toolCallId: "quiet", kind: "execute" }, true);
    const summary = f.summary();
    f.task.toolActivity = summary;
    f.task.statusLine = summary.runningTool!.description;
    f.task.hunt = { stageId: "review", round: 1, reported: {}, work: { main: { attempts: 1, activity: summary.runningTool!.description, toolActivity: structuredClone(summary) } } };
    clearRunningTools(f.task);
    expect(f.task.statusLine).toBe("Continuing work");
    expect(f.task.hunt.work!.main!.activity).toBe("Continuing work");
    expect(f.summary().runningTool).toBeUndefined();
    expect(f.task.hunt.work!.main!.toolActivity!.runningTool).toBeUndefined();
    expect(f.records()[0]!.status).toBeUndefined();
    expect(f.records()[0]!.endedAt).toBeUndefined();
    expect(f.records()[0]!.turnEndedAt).toBeUndefined();
  });
});
