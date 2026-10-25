import { nativeSession } from "../../fixtures/native-session.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { expect, it } from "bun:test";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import type { ToolActivityEvent } from "@petrina/orchestrator";

it("publishes richer metadata only for the latest visible tool, without duplicate or plumbing activity", async () => {
  const root = tempDir("tool-updates-");
  const peer = nativeSession(root);
  const activity: string[] = [];
  const events: ToolActivityEvent[] = [];
  let run: AgentRun | undefined;
  try {
    run = await AgentRun.start({ profile: { id: "fake", toolId: "grok", model: "fake", effort: "high" }, cwd: root,
      signal: AbortSignal.timeout(10_000), command: peer.command, browser: false,
      callbacks: { onActivity: text => activity.push(text), onToolActivity: event => events.push(structuredClone(event)), onPlanStep: () => {}, onPermission: async () => "deny" } });
    const prompt = (updates: unknown[]) => {
      const steps = updates.map(update => update && typeof update === "object" && "crash" in update
        ? { fail: { code: -32603, message: "Turn failed" } } : { update });
      return run!.prompt(`NATIVE-STEPS ${JSON.stringify({ steps })}`);
    };
    const call = (id: string, title = "Shell") => ({ sessionUpdate: "tool_call", toolCallId: id, title, kind: "execute", status: "pending" });
    const update = (id: string, extra: object) => ({ sessionUpdate: "tool_call_update", toolCallId: id, ...extra });
    await prompt([
      call("one"), update("one", { rawInput: { description: "Inspect saved usage records" } }),
      update("one", { rawInput: null, title: null }), update("one", { status: "completed" }),
      update("one", { rawInput: { description: "Inspect saved usage records" } }),
      call("two", "Read"), update("one", { rawInput: { description: "Old late completion" }, status: "completed" }),
      update("two", { kind: "read", locations: [{ path: "/product/usage.ts" }] }),
      { ...call("todo", "TodoWrite"), kind: "other" }, update("todo", { rawInput: { description: "Private bookkeeping" } }),
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private thought" } },
      update("two", { title: "Stale tool" }), update("unknown", { title: "Unstarted tool" }),
    ]);
    expect(activity).toEqual(["Running a command", "Inspect saved usage records", "Running a command", "Reading usage.ts"]);
    expect(events.filter(event => event.isNew)).toHaveLength(2);
    expect(events.find(event => event.invocation?.toolCallId === "one" && event.invocation.status === "completed")?.invocation?.endedAt).toBeNumber();
    expect(events.at(-1)?.runningTool).toBeUndefined();
    expect(events.at(-1)?.turnEndedAt).toBeNumber();
    await prompt([update("two", { rawInput: { description: "Previous turn" } })]);
    expect(activity).toHaveLength(4);
    const before = events.filter(event => event.invocation).length;
    await prompt([call("repeat"), update("repeat", { status: "completed" }), call("again"), update("again", { status: "failed" })]);
    expect(events.filter(event => event.isNew)).toHaveLength(4);
    expect(events.filter(event => event.invocation).slice(before).map(event => [event.invocation!.toolCallId, event.invocation!.status])).toEqual([["repeat", "pending"], ["repeat", "completed"], ["again", "pending"], ["again", "failed"]]);
    await expectRejection(prompt([call("unfinished"), { crash: true }]), "Turn failed");
    expect(events.at(-1)?.runningTool).toBeUndefined();
    expect(events.at(-1)?.turnEndedAt).toBeNumber();
    const unfinished = events.filter(event => event.invocation?.toolCallId === "unfinished");
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]!.invocation!.status).toBe("pending");
    expect(unfinished[0]!.invocation!.endedAt).toBeUndefined();
    // A failed turn's call cannot be mistaken for an invocation in the recovery turn.
    await prompt([update("unfinished", { status: "completed" }), call("recovered")]);
    expect(events.filter(event => event.invocation?.toolCallId === "unfinished")).toHaveLength(1);
    expect(events.filter(event => event.isNew).at(-1)?.invocation?.toolCallId).toBe("recovered");
  } finally { await run?.stop(); removeDir(root); }
});
