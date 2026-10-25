import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxKind } from "@petrina/core";
import { Engine } from "./engine.js";
import { Coordination, requestRevision } from "../src/coordination.js";
import { EngineClient } from "./client.js";
import { EngineLifecycle, LifecycleStore } from "../src/lifecycle.js";
import { serve } from "../src/server.js";
import { writeConnection } from "../src/instance.js";
import { mcpRequest, mcpTools } from "../src/mcp.js";
import { ToolInvocations } from "@petrina/agent-runtime/tool-invocations";
import { recordToolActivity } from "../src/record-tool-activity.js";
import { CLI, firstLine, removeDir, runChecks, tempDir, engineEnv, SLOW, waitFor } from "./support.js";
const roots: string[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((e) => e.shutdown()));
  roots.forEach(removeDir);
});
function fixture() {
  const home = tempDir("petrina-coordinate-");
  roots.push(home);
  const e = new Engine(home, { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
  engines.push(e);
  e.setPoolPaused(true);
  // These tests exercise decisions and persistence without admitting real agents.
  e.schedule = () => {};
  e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const taskId = e.addTask({ productId: "product", title: "First task" });
  const c = new Coordination(e);
  const offer = (kind: InboxKind, body = "Full request"): string => {
    const id = e.id("inbox");
    e.s.inbox.push({ id, kind, taskId, title: `A ${kind} request`, body, at: Date.now(), blocking: kind === "question" || kind === "permission" });
    return id;
  };
  const inspect = async (itemId: string) => c.call("inbox.inspect", { itemId });
  return { e, c, home, taskId, offer, inspect };
}
/** A recorded start on a review place, as the engine saves it when the participant's opening goes out. */
const reviewerStart = (profileId: string, reviewerKey: string, at: number, requestedProfileId = profileId) =>
  ({ at, roleId: "code-reviewer", profileId, requestedProfileId, reviewerKey, taskTitle: "First task", mode: "fresh" as const, sections: [] });
describe("focused coordination and durable decisions", () => {
  it("inspects per-seat tool evidence without putting commands or invocation lists in live updates", async () => {
    const { e, c, taskId } = fixture();
    const task = e.task(taskId)!;
    task.state = "running";
    task.journey = [{ id: "activity", kind: "agent", startedAt: 1, round: 1, sub: 0 }];
    task.agent = { roleId: "reviewer", profileId: "sol-high", reviewKey: "reviewer:0", since: 1, step: 0 };
    task.helpers = [{ ...task.agent, reviewKey: "reviewer:1" }];
    task.hunt = { stageId: "review", round: 1, reported: {}, work: { "reviewer:0": { attempts: 1 }, "reviewer:1": { attempts: 1 } } };
    const track = (seat: string) => new ToolInvocations(event => {
      const summary = recordToolActivity(task, "activity", { seat, roleId: "reviewer", profileId: "sol-high", productId: "product" }, event)!;
      task.hunt!.work![seat]!.toolActivity = summary;
      e.showReviewWork(task);
    });
    const a = track("reviewer:0"), b = track("reviewer:1");
    a.update({ toolCallId: "first", kind: "execute", status: "in_progress", rawInput: { cmd: "private-command-one" } }, true);
    b.update({ toolCallId: "first", kind: "execute", status: "pending", rawInput: { command: "private-command-two" } }, true);
    a.update({ toolCallId: "first", status: "completed" }, false);
    a.update({ toolCallId: "second", kind: "execute" }, true);
    e.commitNow(task);
    const inspection = (await c.call("task.inspect", { taskId })).task as any;
    expect(inspection.activity.actionCount).toBe(2);
    expect(inspection.workers.map((worker: any) => worker.activity.actionCount)).toEqual([2, 1]);
    const first = await c.call("task.activity", { taskId, limit: 1 });
    expect(first.actionCount).toBe(3);
    expect(first.total).toBe(3);
    expect(first.items).toEqual([expect.objectContaining({ command: "private-command-one", status: "completed", seat: "reviewer:0" })]);
    expect((await c.call("task.activity", { taskId, limit: 1, cursor: first.next })).items).toEqual([expect.objectContaining({ command: "private-command-two", status: "pending", seat: "reviewer:1" })]);
    const worker = await c.call("task.activity", { taskId, nodeId: "activity", seat: "reviewer:1" });
    expect(worker.actionCount).toBe(1);
    expect(Object.keys(worker.workers as object)).toEqual(["reviewer:1"]);
    expect(JSON.stringify(e.windowState())).not.toContain("private-command");
    expect(e.windowState().tasks[0]!.journey).toBeUndefined();
    expect(JSON.stringify(e.taskDetails(taskId))).toContain("private-command-one");
    expect((await c.call("journey.node", { taskId, nodeId: "activity" })).text).toContain("private-command-one");
    expect((await c.call("task.activity", { taskId, nodeId: "missing" })).outcome).toBe("unavailable");
    a.endTurn();
    e.commitNow(task);
    expect((await c.call("task.activity", { taskId, limit: 1, cursor: first.next })).outcome).toBe("changed");
    const records = task.journey[0]!.toolInvocations!;
    expect(records[2]!.status).toBeUndefined();
    expect(records[2]!.endedAt).toBeUndefined();
    expect(records[2]!.turnEndedAt).toBeNumber();
    expect(task.hunt.work!["reviewer:1"]!.toolActivity!.runningTool).toBeDefined();
    expect(e.store.load()!.tasks.find(task => task.id === taskId)!.journey![0]!.toolInvocations).toEqual(records);
  });

  it("reads bounded recent node messages and follows streaming peers by stable references", async () => {
    const { e, c, taskId } = fixture();
    const task = e.task(taskId)!;
    task.journey = [
      { id: "old", kind: "agent", roleId: "architect", profileId: "opus-high", startedAt: 1, endedAt: 2, round: 1, sub: 0 },
      { id: "current", kind: "agent", roleId: "code-reviewer", profileId: "sol-high", startedAt: 3, round: 1, sub: 1, agentInputs: [reviewerStart("sol-high", "0", 3), reviewerStart("grok-high", "1", 3)] },
    ];
    task.session = [
      { id: "history", from: "agent", at: 1, step: "old", text: "Old research ".repeat(5000) },
      { id: "slow", from: "agent", at: 3, step: "current", roleId: "code-reviewer", profileId: "sol-high", text: "Checking" },
      { id: "action", from: "activity", at: 4, step: "current", text: "Read files" },
      { id: "peer", from: "agent", at: 5, step: "current", roleId: "code-reviewer", profileId: "grok-high", text: "A peer's longer message" },
    ];
    const args = { taskId, nodeId: "current", limit: 10 };
    const recent = await c.call("task.conversation", args);
    expect(recent.items).toEqual([expect.objectContaining({ id: "peer", text: "er message", offset: 13, total: 23, mayChange: true })]);
    expect(JSON.stringify(recent)).not.toContain("Old research");
    expect(recent.activeMessages).toHaveLength(2);
    expect((await c.call("task.conversation", { ...args, ifRevision: recent.revision })).items).toEqual([]);
    // The slow peer updates an earlier bubble while the later peer fills the entire page.
    task.session[1]!.text = "Checking the nearby cases";
    const update = await c.call("task.conversation", { ...args, ifRevision: recent.revision });
    expect(update.unchanged).toBe(false);
    expect(update.activeMessages).not.toEqual(recent.activeMessages);
    const slow = await c.call("task.conversation", { taskId, nodeId: "current", messageId: "slow" });
    expect(slow.items).toEqual([expect.objectContaining({ id: "slow", text: "Checking the nearby cases" })]);
    task.session.push({ id: "new", from: "agent", at: 6, step: "current", profileId: "grok-high", text: "Finished" });
    expect((await c.call("task.conversation", { ...args, cursor: recent.next })).outcome).toBe("completed");
    expect((await c.call("task.conversation", { taskId, nodeId: "old", cursor: recent.next })).outcome).toBe("changed");
    expect((await c.call("task.conversation", { taskId, nodeId: "missing" })).outcome).toBe("unavailable");
    expect((await c.call("task.conversation", { taskId, nodeId: "old", messageId: "slow" })).outcome).toBe("unavailable");
  });

  it("keeps only unfinished recorded participants active while peers in the same node finish, stand in or restart", async () => {
    const { e, c, taskId } = fixture();
    const task = e.task(taskId)!;
    const step = { id: "group", kind: "agent" as const, roleId: "code-reviewer", profileId: "opus-xhigh", startedAt: 1, round: 1, sub: 0,
      agentInputs: [reviewerStart("opus-xhigh", "0", 1), reviewerStart("grok-xhigh", "1", 1), reviewerStart("astra-xhigh", "2", 1)],
      agentResults: [] as { roleId: string; profileId: string; at: number; value: unknown; inputIndex: number }[] };
    task.journey = [step];
    const finish = (profileId: string, inputIndex: number, at: number) => step.agentResults.push({ roleId: "code-reviewer", profileId, at, value: {}, inputIndex });
    const say = (id: string, profileId: string, at: number, text: string) => task.session.push({ id, from: "agent", at, step: "group", roleId: "code-reviewer", profileId, text });
    say("astra", "astra-xhigh", 2, "Still checking 😀 ".repeat(40));
    say("grok", "grok-xhigh", 3, "Stopped at its usage limit");
    say("opus", "opus-xhigh", 4, "Opus finished its review");
    const args = { taskId, nodeId: "group", limit: 30 };
    const active = (read: Awaited<ReturnType<typeof c.call>>) => (read.activeMessages as { id: string }[]).map((message) => message.id);
    const status = async (messageId: string) => ((await c.call("task.conversation", { taskId, nodeId: "group", messageId })).items as { mayChange: boolean | null }[])[0]!.mayChange;
    const first = await c.call("task.conversation", args);
    expect(active(first)).toEqual(["astra", "grok", "opus"]);

    // A stand-in takes the stopped reviewer's place: the replaced attempt can no longer change.
    step.agentInputs.push(reviewerStart("argon-high", "1", 5, "grok-xhigh"));
    say("argon", "argon-high", 6, "Argon looked again");
    const replaced = await c.call("task.conversation", args);
    expect(active(replaced)).toEqual(["astra", "opus", "argon"]);
    expect(await status("grok")).toBe(false);
    expect(await status("argon")).toBe(true);

    // Finishing without new text still changes the response a revision-polling client sees.
    finish("opus-xhigh", 0, 7);
    const finished = await c.call("task.conversation", { ...args, ifRevision: replaced.revision });
    expect(finished.unchanged).toBe(false);
    const unchangedText = (replaced.items as { id: string; revision: string }[]).find((item) => item.id === "opus")!.revision;
    expect(finished.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "opus", revision: unchangedText, mayChange: false })]));
    expect(active(finished)).toEqual(["astra", "argon"]);
    expect((await c.call("task.conversation", { ...args, ifRevision: finished.revision })).unchanged).toBe(true);

    // Two of three reported: the slow peer stays discoverable outside the recent page, and older pages still read.
    finish("argon-high", 3, 8);
    const partial = await c.call("task.conversation", args);
    expect(active(partial)).toEqual(["astra"]);
    expect((partial.items as { id: string }[]).map((item) => item.id)).not.toContain("astra");
    expect((partial.activeMessages as { id: string; roleId: string; profileId: string }[])[0]).toEqual(expect.objectContaining({ roleId: "code-reviewer", profileId: "astra-xhigh" }));
    expect(await status("astra")).toBe(true);
    let cursor = partial.next as string | undefined;
    const older: string[] = [];
    while (cursor) {
      const page = await c.call("task.conversation", { ...args, cursor });
      expect(page.outcome).toBe("completed");
      older.unshift(...(page.items as { text: string }[]).map((item) => item.text));
      cursor = page.next as string | undefined;
    }
    expect(older.join("").startsWith("Still checking 😀 ".repeat(40))).toBe(true);

    // A restart of the same place supersedes its earlier attempt until it speaks again.
    step.agentInputs.push(reviewerStart("astra-xhigh", "2", 9));
    expect(active(await c.call("task.conversation", args))).toEqual([]);
    expect(await status("astra")).toBe(false);
    say("astra-again", "astra-xhigh", 10, "Picking up the review");
    expect(active(await c.call("task.conversation", args))).toEqual(["astra-again"]);
    finish("astra-xhigh", 4, 11);
    expect(active(await c.call("task.conversation", args))).toEqual([]);
    expect(await status("astra-again")).toBe(false);
  });

  it("tells apart places sharing a role and profile by the start each message names, and leaves older unattributable records unknown", async () => {
    const { e, c, taskId } = fixture();
    const task = e.task(taskId)!;
    type Result = { roleId: string; profileId: string; at: number; value: unknown; inputIndex?: number };
    const node = (id: string, results: Result[] = []) => ({ id, kind: "agent" as const, roleId: "code-reviewer", profileId: "opus-high", startedAt: 1, round: 1, sub: 0,
      agentInputs: [reviewerStart("opus-high", "0", 1), reviewerStart("opus-high", "1", 1), reviewerStart("grok-high", "2", 1)], agentResults: results });
    const current = node("current"), older = node("older");
    const say = (step: string, id: string, profileId: string, at: number, text: string, inputIndex?: number) =>
      task.session.push({ id, from: "agent", at, step, roleId: "code-reviewer", profileId, text, ...(inputIndex === undefined ? {} : { inputIndex }) });
    const read = (nodeId: string, ifRevision?: string) => c.call("task.conversation", { taskId, nodeId, limit: 8000, ...(ifRevision ? { ifRevision } : {}) });
    const statuses = (result: Awaited<ReturnType<typeof read>>) => Object.fromEntries((result.items as { id: string; mayChange: boolean | null }[]).map((item) => [item.id, item.mayChange]));
    const active = (result: Awaited<ReturnType<typeof read>>) => (result.activeMessages as { id: string }[]).map((message) => message.id);

    // Current records: each message names its start. The finished place spoke last; the working place stays discoverable.
    task.journey = [current];
    say("current", "working", "opus-high", 2, "Place zero is still checking", 0);
    say("current", "finishing", "opus-high", 3, "Place one is done", 1);
    const before = await read("current");
    expect(active(before)).toEqual(["working", "finishing"]);
    current.agentResults.push({ roleId: "code-reviewer", profileId: "opus-high", at: 4, value: {}, inputIndex: 1 });
    const after = await read("current", before.revision as string);
    expect(after.unchanged).toBe(false);
    expect(statuses(after)).toEqual({ working: true, finishing: false });
    expect(active(after)).toEqual(["working"]);

    // Older records name no start. A result without one may belong to either opus place: neither is called finished,
    // the working place's latest message stays listed, and a result only one start could have given still closes it.
    task.journey = [older];
    say("older", "old-finished", "opus-high", 2, "One place reported");
    say("older", "old-working", "opus-high", 3, "The other place is still checking");
    say("older", "old-grok", "grok-high", 3, "Grok reported");
    older.agentResults.push({ roleId: "code-reviewer", profileId: "opus-high", at: 4, value: {} }, { roleId: "code-reviewer", profileId: "grok-high", at: 4, value: {} });
    const unattributed = await read("older");
    expect(statuses(unattributed)).toEqual({ "old-finished": null, "old-working": null, "old-grok": false });
    expect(active(unattributed)).toEqual(["old-working"]);
    // Two results without a start for the two opus places still do not say which place gave which (one could have
    // reported twice), so both messages stay unknown and the later one stays listed.
    older.agentResults.push({ roleId: "code-reviewer", profileId: "opus-high", at: 5, value: {} });
    const counted = await read("older");
    expect(statuses(counted)).toEqual({ "old-finished": null, "old-working": null, "old-grok": false });
    expect(active(counted)).toEqual(["old-working"]);
    older.agentResults.pop();
    // With a result naming its start but older messages, which message is the working place's stays unknown.
    older.agentResults.splice(0, 1, { roleId: "code-reviewer", profileId: "opus-high", at: 4, value: {}, inputIndex: 0 });
    const mixed = await read("older");
    expect(statuses(mixed)).toEqual({ "old-finished": null, "old-working": null, "old-grok": false });
    expect(active(mixed)).toEqual(["old-working"]);
    // Once both opus places reported, nothing is left to follow.
    older.agentResults.push({ roleId: "code-reviewer", profileId: "opus-high", at: 5, value: {}, inputIndex: 1 });
    const done = await read("older");
    expect(statuses(done)).toEqual({ "old-finished": false, "old-working": false, "old-grok": false });
    expect(active(done)).toEqual([]);
  });

  it("reports single-participant and whole-node completion, and leaves unrecorded participants unknown", async () => {
    const { e, c, taskId } = fixture();
    const task = e.task(taskId)!;
    const build = { id: "build", kind: "agent" as const, roleId: "builder", profileId: "sol-high", startedAt: 1, round: 1, sub: 0,
      agentInputs: [{ at: 1, roleId: "builder", profileId: "sol-high", requestedProfileId: "sol-high", taskTitle: "First task", mode: "fresh" as const, sections: [] }],
      agentResults: [] as { roleId: string; profileId: string; at: number; value: unknown; inputIndex: number }[], endedAt: undefined as number | undefined };
    const older = { id: "older", kind: "agent" as const, roleId: "code-reviewer", profileId: "grok-high", startedAt: 1, round: 1, sub: 0, endedAt: undefined as number | undefined };
    task.journey = [build];
    task.session = [
      { id: "built", from: "agent", at: 2, step: "build", roleId: "builder", profileId: "sol-high", text: "Built it" },
      { id: "said", from: "you", at: 3, step: "build", text: "Keep the old page" },
    ];
    const read = () => c.call("task.conversation", { taskId, nodeId: "build" });
    const mayChange = async () => ((await read()).items as { id: string; mayChange: boolean | null }[]).map((item) => [item.id, item.mayChange]);
    expect((await read()).activeMessages).toEqual([expect.objectContaining({ id: "built" })]);
    expect(await mayChange()).toEqual([["built", true], ["said", true]]);
    // A lone agent's later message without a start is still its own: one current message, not two.
    task.session.splice(1, 0, { id: "asked", from: "agent", at: 2, step: "build", roleId: "builder", profileId: "sol-high", text: "Should it stay?" });
    task.session[0]!.inputIndex = 0;
    expect((await read()).activeMessages).toEqual([expect.objectContaining({ id: "asked" })]);
    task.session.splice(1, 1);
    // The Builder handed back its result; the node closes later.
    build.agentResults.push({ roleId: "builder", profileId: "sol-high", at: 4, value: {}, inputIndex: 0 });
    expect((await read()).activeMessages).toEqual([]);
    expect(await mayChange()).toEqual([["built", false], ["said", true]]);
    build.endedAt = 5;
    expect(await mayChange()).toEqual([["built", false], ["said", false]]);

    // An unfinished node saved without participant starts: its messages stay unknown rather than guessed.
    task.journey = [{ ...build, endedAt: 5 }, older];
    task.session.push(
      { id: "unrecorded", from: "agent", at: 6, step: "older", roleId: "code-reviewer", profileId: "grok-high", text: "Looking" },
      { id: "anonymous", from: "agent", at: 7, step: "older", text: "Earlier words" },
    );
    const unknown = await c.call("task.conversation", { taskId, nodeId: "older" });
    expect(unknown.activeMessages).toEqual([]);
    expect((unknown.items as { mayChange: boolean | null }[]).map((item) => item.mayChange)).toEqual([null, null]);
  });

  it("pages every part of a long message despite appends, but rejects an edited unread prefix", async () => {
    const { e, c, taskId } = fixture();
    const task = e.task(taskId)!;
    task.session = [{ id: "long", from: "agent", at: 1, text: "abcdefghijklmnopqrstuvwxyz" }];
    const args = { taskId, limit: 8 };
    const first = await c.call("task.conversation", args);
    expect(first.items).toEqual([expect.objectContaining({ text: "stuvwxyz", offset: 18, mayChange: null })]);
    task.session[0]!.text += " appended";
    const second = await c.call("task.conversation", { ...args, cursor: first.next });
    expect(second.items).toEqual([expect.objectContaining({ text: "klmnopqr", offset: 10 })]);
    const third = await c.call("task.conversation", { ...args, cursor: second.next });
    expect(third.items).toEqual([expect.objectContaining({ text: "cdefghij", offset: 2 })]);
    expect((await c.call("task.conversation", { ...args, cursor: third.next })).items).toEqual([expect.objectContaining({ text: "ab", offset: 0 })]);
    task.session[0]!.text = "edited prefix";
    expect((await c.call("task.conversation", { ...args, cursor: first.next })).outcome).toBe("changed");
  });

  it("keeps Unicode characters intact across recent-message page boundaries", async () => {
    const { e, c, taskId } = fixture();
    e.task(taskId)!.session = [{ id: "unicode", from: "agent", at: 1, text: "A😀B" }];
    let cursor: unknown;
    const pages: string[] = [];
    do {
      const page = await c.call("task.conversation", { taskId, limit: 1, ...(cursor ? { cursor } : {}) });
      pages.unshift((page.items as { text: string }[])[0]!.text);
      cursor = page.next;
    } while (cursor);
    expect(pages).toEqual(["A", "😀", "B"]);
  });

  it("bounds and filters lists before pagination, rejects changed continuations and keeps task queries small", async () => {
    const { e, c, taskId } = fixture();
    for (let i = 0; i < 130; i++) e.addTask({ productId: "product", title: `Work ${i}`, description: "x".repeat(8000) });
    const page = await c.call("task.list", {});
    expect((page.items as unknown[]).length).toBe(25);
    expect(page.next).toBeString();
    expect((await c.call("task.list", { limit: 100 })).items).toHaveLength(100);
    expect((await c.call("task.list", { limit: 101 })).outcome).toBe("invalid");
    const filtered = await c.call("task.list", { search: "First" });
    expect(filtered.items).toHaveLength(1);
    const next = await c.call("task.list", { cursor: page.next });
    expect((next.items as { id: string }[])[0]!.id).not.toBe((page.items as { id: string }[])[0]!.id);
    e.moveToTop(e.s.tasks.at(-1)!.id);
    expect((await c.call("task.list", { cursor: page.next })).outcome).toBe("changed");
    expect(JSON.stringify(await c.call("task.inspect", { taskId })).length).toBeLessThan(2000);
  });
  it("saves creation and message outcomes, rejects conflicting references and keeps them after restart", async () => {
    const { e, c, home } = fixture();
    const args = { productId: "product", title: "Once", requestId: "create-once" };
    const created = await c.call("task.add", args);
    expect(await c.call("task.add", args)).toEqual(created);
    expect((await c.call("task.add", { ...args, title: "Different" })).outcome).toBe("conflict");
    const sent = await c.call("task.message", { taskId: created.taskId, text: "Only once", requestId: "message-once" });
    expect(sent.messageId).toBeString();
    await e.shutdown();
    const restarted = new Engine(home, { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
    engines.push(restarted);
    const again = new Coordination(restarted);
    expect(await again.call("task.add", args)).toEqual(created);
    expect(await again.call("task.message", { taskId: created.taskId, text: "Only once", requestId: "message-once" })).toEqual(sent);
    expect(restarted.task(String(created.taskId))!.queued).toHaveLength(1);
  });
  it("reads and filters paged history without loading archived conversations, and keeps focused waits bounded", async () => {
    const { e, c, taskId } = fixture();
    const template = structuredClone(e.task(taskId)!);
    e.s.products.push({ id: "other", name: "Other", repo: "local/other", tone: "green" });
    for (let index = 0; index < 150; index++) {
      const product = e.s.products.find((product) => product.id === (index % 2 ? "product" : "other"))!;
      const choice = { productId: product.id, startFrom: { kind: "default" as const }, delivery: "local" as const };
      e.s.tasks.push({
        ...structuredClone(template), id: `history-${String(index).padStart(3, "0")}`, title: `Archived request ${index}`, description: "long request ".repeat(1000),
        productId: product.id, selectedProducts: [choice], workChoice: choice, repository: { productId: product.id, delivery: choice.delivery, workChoice: choice, workProduct: { id: product.id, name: product.name, repo: product.repo } },
        held: index % 3 === 0, state: index % 4 ? "done" : "cancelled", column: "done", finishedAt: index + 1,
      });
    }
    e.save();
    expect(e.activeState().tasks).toHaveLength(1);
    e.getState = () => { throw new Error("A focused read must not load the full archive"); };
    e.store.history.all = () => { throw new Error("A focused read must not load every conversation"); };
    expect((await c.call("task.list", {})).items).toHaveLength(1);
    const page = await c.call("task.history", {});
    expect(page.items).toHaveLength(25);
    expect(page.total).toBe(150);
    expect((page.items as { id: string }[])[0]!.id).toBe("history-149");
    expect(JSON.stringify(page)).not.toContain("long request");
    expect((await c.call("task.history", { limit: 100 })).items).toHaveLength(100);
    expect((await c.call("task.history", { limit: 101 })).outcome).toBe("invalid");
    const next = await c.call("task.history", { cursor: page.next });
    expect((next.items as { id: string }[])[0]!.id).toBe("history-124");
    expect((await c.call("task.history", { productId: "other", states: ["cancelled"], held: true, search: "arch req" })).total).toBe(13);
    expect((await c.call("task.list", { states: ["cancelled"] })).total).toBe(38);
    expect((await c.call("task.list", { states: ["queued", "done"] })).outcome).toBe("invalid");
    expect((await c.call("task.history", { states: [] })).total).toBe(0);
    e.s.inbox.push({ id: "archived-offer", taskId: "history-148", kind: "learnings", title: "Saved learning offer", body: "A lesson", at: 1, blocking: false });
    const readBody = e.store.history.get.bind(e.store.history);
    try {
      e.store.history.get = () => { throw new Error("Filtering inbox requests must only read history summaries"); };
      expect((await c.call("inbox.list", { productId: "other" })).items).toHaveLength(1);
      expect((await c.call("inbox.list", { productId: "product" })).items).toHaveLength(0);
    } finally { e.store.history.get = readBody; }
    expect(JSON.stringify(await c.call("task.inspect", { taskId: "history-149" })).length).toBeLessThan(2000);
    expect((await c.call("task.read", { taskId: "history-149", section: "request" })).shortened).toBe(true);
    expect((await c.call("watch.wait", { target: "task", taskId: "history-149", condition: "state", states: ["done"], timeoutMs: 0 })).outcome).toBe("completed");
    expect((await c.call("engine.status", {})).outcome).toBe("completed");
    expect((await c.call("pool.inspect", {})).outcome).toBe("completed");
    e.s.tasks.push({ ...structuredClone(template), id: "another-finished", state: "done", column: "done", finishedAt: 200 });
    e.save();
    expect((await c.call("task.history", { cursor: page.next })).outcome).toBe("changed");
  });
  it("lists shared current work, history and inbox requests under each product without reading archived bodies", async () => {
    const { e, c, taskId } = fixture();
    e.s.products.push({ id: "other", name: "Other", repo: "local/other", tone: "green" });
    const sharedId = e.addTask({ productId: "product", title: "Shared transfer", worksOn: ["product", "other"].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "local" })) });
    const otherId = e.addTask({ productId: "other", title: "Other transfer" });
    const ids = async (name: string, args: Record<string, unknown>) => ((await c.call(name, args)).items as { id: string }[]).map((item) => item.id).sort();
    expect(await ids("task.list", { productId: "product" })).toEqual([taskId, sharedId].sort());
    expect(await ids("task.list", { productId: "other" })).toEqual([sharedId, otherId].sort());
    expect((await c.call("task.list", {})).total).toBe(3);
    const shared = e.task(sharedId)!, other = e.task(otherId)!;
    shared.held = true;
    // Once planning records ownership, the selected repository still does not narrow membership.
    shared.repositories = ["product", "other"].map((productId) => ({ productId, delivery: "local", completedStages: [] }));
    shared.activeProductId = "product";
    shared.activeProductId = "other";
    expect(await ids("task.list", { productId: "product", taskId: sharedId, states: ["queued"], held: true, search: "SHARED" })).toEqual([sharedId]);
    expect(await ids("task.list", { productId: "other", held: false })).toEqual([otherId]);
    expect(await ids("task.list", { productId: "other", taskId })).toEqual([]);
    expect(await ids("task.list", { productId: "other", states: ["backlog"] })).toEqual([]);
    e.s.inbox.push(
      { id: "shared-request", taskId: sharedId, kind: "question", title: "Shared question", body: "Details", at: 1, blocking: true },
      { id: "first-request", taskId, kind: "permission", title: "First permission", body: "Details", at: 2, blocking: true },
      { id: "other-request", taskId: otherId, kind: "permission", title: "Other permission", body: "Details", at: 3, blocking: true },
    );
    expect(await ids("inbox.list", { productId: "product" })).toEqual(["first-request", "shared-request"]);
    expect(await ids("inbox.list", { productId: "other" })).toEqual(["other-request", "shared-request"]);
    expect(await ids("inbox.list", { productId: "other", taskId: sharedId, kinds: ["question"], blocking: true, search: "SHARED" })).toEqual(["shared-request"]);
    expect(await ids("inbox.list", { productId: "other", taskId })).toEqual([]);
    e.s.inbox = e.s.inbox.map((item) => ({ ...item, kind: "learnings", blocking: false }));
    Object.assign(shared, { state: "done", column: "done", finishedAt: 200 });
    Object.assign(other, { state: "cancelled", column: "done", finishedAt: 100 });
    e.save();
    expect(e.activeState().tasks.map((task) => task.id)).toEqual([taskId]);
    e.getState = () => { throw new Error("A product filter must not reconstruct history"); };
    e.store.history.all = () => { throw new Error("A product filter must not load the archive"); };
    const readBody = e.store.history.get.bind(e.store.history);
    try {
      e.store.history.get = () => { throw new Error("A product filter must only read history summaries"); };
      expect(await ids("task.history", { productId: "product" })).toEqual([sharedId]);
      expect(await ids("task.history", { productId: "other" })).toEqual([otherId, sharedId].sort());
      expect((await c.call("task.history", {})).total).toBe(2);
      expect(await ids("task.history", { productId: "other", taskId: sharedId, states: ["done"], held: true, search: "sha tra" })).toEqual([sharedId]);
      expect(await ids("task.history", { productId: "other", states: ["cancelled"], held: false })).toEqual([otherId]);
      expect(await ids("task.history", { productId: "product", taskId: otherId })).toEqual([]);
      expect(await ids("inbox.list", { productId: "product" })).toEqual(["first-request", "shared-request"]);
      expect(await ids("inbox.list", { productId: "other" })).toEqual(["other-request", "shared-request"]);
      expect(await ids("inbox.list", { productId: "other", taskId: sharedId, kinds: ["learnings"], blocking: false, search: "SHARED" })).toEqual(["shared-request"]);
      expect(await ids("inbox.list", { productId: "product", taskId: otherId })).toEqual([]);
      expect((await c.call("inbox.list", { taskId: "missing" })).outcome).toBe("missing");
    } finally { e.store.history.get = readBody; }
  });
  it("keeps task and message receipts after archival and replacement without restoring finished bodies to active work", async () => {
    const { e, c, home } = fixture();
    const args = { productId: "product", title: "Archived once", backlog: true, requestId: "archived-create" };
    const created = await c.call("task.add", args);
    const sent = await c.call("task.message", { taskId: created.taskId, text: "Keep this instruction", requestId: "archived-message" });
    const task = e.task(String(created.taskId))!;
    task.state = "done";
    task.column = "done";
    task.finishedAt = 1;
    e.save();
    expect(e.activeState().tasks.some((task) => task.id === created.taskId)).toBe(false);
    await e.shutdown();
    const restarted = new Engine(home, { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
    engines.push(restarted);
    restarted.getState = () => { throw new Error("Do not reconstruct the archive"); };
    const again = new Coordination(restarted);
    expect(await again.call("task.add", args)).toEqual(created);
    expect(await again.call("task.message", { taskId: created.taskId, text: "Keep this instruction", requestId: "archived-message" })).toEqual(sent);
    expect(restarted.activeState().tasks.some((task) => task.id === created.taskId)).toBe(false);
    expect((await again.call("task.inspect", { taskId: created.taskId })).task).toHaveProperty("state", "done");
    expect((await again.call("task.read", { taskId: created.taskId, section: "messages" })).text).toContain("Keep this instruction");
  });
  it("keeps partially delivered group messages and reports saved review results from before full handoffs were recorded", async () => {
    const { e, c, taskId } = fixture();
    const sent = await c.call("task.message", { taskId, text: "Check both views", requestId: "group-message" });
    const task = e.task(taskId)!;
    task.queued[0]!.recipients = { "review-0": true, "review-1": false };
    const denied = await c.call("task.remove-message", { taskId, messageId: sent.messageId, requestId: "remove-delivered" });
    expect(denied.outcome).toBe("invalid");
    expect(denied.message).toContain("already received");
    expect(task.queued).toHaveLength(1);
    expect(task.queued[0]!.recipients).toEqual({ "review-0": true, "review-1": false });
    task.queued[0]!.recipients = { "review-0": false, "review-1": false };
    expect((await c.call("task.remove-message", { taskId, messageId: sent.messageId, requestId: "remove-unheard" })).outcome).toBe("completed");
    expect(task.queued).toEqual([]);
    task.journey = [{ id: "review", kind: "agent", roleId: "code-reviewer", stageId: "review", round: 1, sub: 0, startedAt: 1, result: { findings: [] } }];
    const node = await c.call("journey.node", { taskId, nodeId: "review" });
    expect(node.result).toBe("recorded");
    expect(JSON.parse(String(node.text)).result).toEqual({ findings: [] });
    expect(node.input).toBe("unavailable");
  });
  it("binds checkpoint approval to source and all assignments, while unrelated activity stays valid", async () => {
    const { e, c, taskId, offer, inspect } = fixture();
    const t = e.task(taskId)!;
    executionFor(t).work.source = {
      product: { id: "product", name: "Example", repo: "local/example" },
      start: { kind: "default", branch: "main" },
      destination: { mode: "local", repo: "local/example", branch: "main", kind: "branch" },
      confirmed: true,
    };
    t.plan = {
      stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["opus-high"] }],
      rationale: "Do the work",
      plannerProfileId: "opus-high",
    };
    const itemId = offer("plan"),
      first = await inspect(itemId);
    t.plan.stages[0]!.profileIds[0] = "sol-xhigh";
    expect((await c.call("inbox.approve", { itemId, revision: first.revision, requestId: "old-plan" })).outcome).toBe("changed");
    expect(e.s.inbox.some((i) => i.id === itemId)).toBe(true);
    const second = await inspect(itemId);
    t.workChoice = { productId: "product", startFrom: { kind: "branch", name: "feature" }, delivery: "local" };
    expect((await c.call("inbox.approve", { itemId, revision: second.revision, requestId: "old-source" })).outcome).toBe("changed");
    const third = await inspect(itemId);
    e.say(t, "activity", "An unrelated clock tick");
    const args = { itemId, revision: third.revision, requestId: "approve-once" };
    expect((await c.call("inbox.approve", args)).outcome).toBe("completed");
    expect(await c.call("inbox.approve", args)).toEqual(await c.call("inbox.approve", args));
    expect((await c.call("inbox.approve", { ...args, requestId: "already-gone" })).outcome).toBe("handled");
  });
  it("serializes app plan edits with decisions and returns the saved outcome after a lost reply", async () => {
    const { e, c, taskId, offer, inspect } = fixture();
    e.task(taskId)!.plan = {
      stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["opus-high"] }],
      rationale: "",
      plannerProfileId: "opus-high",
    };
    const itemId = offer("plan"),
      read = await inspect(itemId);
    const { dispatch } = await import("../src/server.js");
    const edit = dispatch(e, { name: "setStageProfile", args: [taskId, "build", "profileIds", 0, "sol-xhigh"] });
    const approve = c.call("inbox.approve", { itemId, revision: read.revision, requestId: "raced" });
    await edit;
    expect((await approve).outcome).toBe("changed");
  });
  it("separates questions, once-only permissions, checkpoints, lessons and review-guide proposals", async () => {
    const { e, c, offer, inspect } = fixture();
    for (const kind of ["question", "permission", "learnings", "guide", "screen", "stuck", "driving"] as const) {
      const itemId = offer(kind, "- First useful lesson\n- Second useful lesson"),
        read = await inspect(itemId);
      expect((await c.call("inbox.approve", { itemId, revision: read.revision, requestId: `wrong-${kind}` })).outcome).toBe("invalid");
      expect(e.s.inbox.some((i) => i.id === itemId)).toBe(true);
    }
    const question = e.s.inbox.find((i) => i.kind === "question")!;
    const qa = { itemId: question.id, revision: requestRevision(e, question), answer: "Blue", requestId: "answer-once" };
    const answered = await c.call("inbox.answer", qa);
    expect(answered.outcome).toBe("completed");
    expect(await c.call("inbox.answer", qa)).toEqual(answered);
    const permission = e.s.inbox.find((i) => i.kind === "permission")!,
      permissionRead = await inspect(permission.id);
    const allow = { itemId: permission.id, revision: permissionRead.revision, requestId: "allow-once" };
    expect((await c.call("inbox.allow", allow)).outcome).toBe("completed");
    expect((await c.call("inbox.allow", allow)).outcome).toBe("completed");
    const learning = e.s.inbox.find((i) => i.kind === "learnings")!,
      read = await inspect(learning.id),
      base = { itemId: learning.id, revision: read.revision };
    expect((await c.call("learning.accept", { ...base, positions: [], requestId: "empty" })).outcome).toBe("invalid");
    expect((await c.call("learning.accept", { ...base, positions: [2], requestId: "outside" })).outcome).toBe("invalid");
    expect(e.s.inbox.some((i) => i.id === learning.id)).toBe(true);
    expect((await c.call("learning.accept", { ...base, positions: [0], requestId: "selected" })).outcome).toBe("completed");
    expect(e.s.products[0]!.learnings).toHaveLength(1);
    expect(e.s.products[0]!.learningsDeclined).toContain("Second useful lesson");
    const guide = e.s.inbox.find((i) => i.kind === "guide")!;
    expect((await c.call("review-guide.accept", { itemId: guide.id, revision: (await inspect(guide.id)).revision, requestId: "guide-yes" })).outcome).toBe(
      "completed",
    );
    // Keep the app's existing review-guide acceptance button working too.
    const appGuide = offer("guide", "Check another nearby case");
    e.approve(appGuide);
    expect(e.s.products[0]!.reviewGuide).toHaveLength(2);
    const declined = offer("learnings", "- A third lesson");
    expect((await c.call("learning.decline", { itemId: declined, revision: (await inspect(declined)).revision, requestId: "declined" })).outcome).toBe(
      "completed",
    );
  });
  it("preserves original long diagnostics after later checks and a restart, and reports unavailable evidence honestly", async () => {
    const { e, c, home, taskId } = fixture(),
      t = e.task(taskId)!;
    const directory = join(home, "checks", taskId);
    mkdirSync(directory, { recursive: true });
    const prefix = "Original failure near the beginning\n", repeated = "long output\n";
    const original = prefix + repeated.repeat(9000);
    const source = `process.stdout.write(${JSON.stringify(prefix)} + ${JSON.stringify(repeated)}.repeat(9000)); process.exit(1)`;
    const [run] = await runChecks(home, [{ name: "Tests", argv: [process.execPath, "-e", source] }], process.env, 10_000 * SLOW, undefined, directory);
    run!.output = original.slice(-6000);
    t.journey = [
      {
        id: "checks",
        kind: "petrina",
        work: "checks",
        round: 1,
        sub: 0,
        startedAt: 1,
        endedAt: 2,
        productChecks: [{ name: "Tests", result: "fail", run: run! }],
        outcome: "Failed",
        reason: "Back to builder",
      },
    ];
    executionFor(t).work.checks = { at: 3, sha: "newer", results: [{ name: "Tests", command: "test stand-in", ok: true, ms: 1, output: "pass" }] };
    let page = await c.call("journey.check", { taskId, nodeId: "checks", index: 0 });
    expect(page.text).toStartWith("Original failure");
    expect(page.commandOutcome).toBe("failed");
    expect(page.relevance).toBe("historical");
    expect(page.completeness).toBe("complete");
    let all = String(page.text);
    const next = page.next;
    e.commitNow();
    await e.shutdown();
    const restarted = new Engine(home, { admissionsClosed: true, usageCommands: { codex: null, grok: null }, terminals: () => [] });
    engines.push(restarted);
    const focused = new Coordination(restarted);
    while (page.next) {
      page = await focused.call("journey.check", { taskId, nodeId: "checks", index: 0, cursor: page.next });
      all += page.text;
    }
    expect(all).toBe(original);
    writeFileSync(run!.logPath!, "Changed");
    expect((await focused.call("journey.check", { taskId, nodeId: "checks", index: 0, cursor: next })).outcome).toBe("changed");
    const old = restarted.task(taskId)!;
    delete old.journey![0]!.productChecks![0]!.run;
    expect((await focused.call("journey.check", { taskId, nodeId: "checks", index: 0 })).outcome).toBe("unavailable");
    expect((await focused.call("journey.check", { taskId, index: 0 })).completeness).toBe("excerpt-only");
  });
  it("reports missing, unfinished and incomplete diagnostics separately, and keeps UTF-8 pages intact", async () => {
    const { e, c, home, taskId } = fixture();
    const directory = join(home, "checks", taskId);
    mkdirSync(directory, { recursive: true });
    const original = "é🙂λ".repeat(10);
    const [run] = await runChecks(home, [{ name: "Check", argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(original)}); process.exit(1)`] }], process.env, 10_000 * SLOW, undefined, directory);
    run!.logComplete = false;
    run!.interrupted = true;
    executionFor(e.task(taskId)!).work.checks = {
      at: 1,
      results: [run!],
    };
    let page = await c.call("journey.check", { taskId, index: 0, limit: 1 }),
      all = String(page.text);
    expect(page.commandOutcome).toBe("unfinished");
    expect(page.completeness).toBe("incomplete");
    while (page.next) {
      page = await c.call("journey.check", { taskId, index: 0, limit: 1, cursor: page.next });
      all += page.text;
    }
    expect(all).toBe(original);
    executionFor(e.task(taskId)!).work.checks!.results[0]!.logPath = join(directory, "missing.log");
    expect((await c.call("journey.check", { taskId, index: 0 })).completeness).toBe("missing-file");
  });
  it("uses one drain definition for admitted steps, questions, permissions and cleanup, while saved screen work waits separately", async () => {
    const { e, home, taskId, offer } = fixture();
    await Promise.all([...e.backgroundWork]);
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    e.settling.set(taskId, work);
    const t = e.task(taskId)!;
    t.state = "running";
    t.holdsSlot = true;
    t.agent = { roleId: "builder", profileId: "opus-high", since: Date.now(), step: 0 };
    offer("question");
    offer("permission");
    offer("screen");
    let cleaned!: () => void;
    const cleanup = e.trackWork(
      new Promise<void>((resolve) => {
        cleaned = resolve;
      }),
    );
    const store = new LifecycleStore(home);
    let stops = 0;
    const life = new EngineLifecycle(e, store, async () => {
      stops++;
      store.finish("completed");
    });
    try {
      expect((life.status().blockers as { kind: string }[]).map((item) => item.kind)).toEqual(["question", "permission", "screen"]);
      expect((await life.request("stop", { requestId: "drain-everything" })).outcome).toBe("pending");
      expect(stops).toBe(0);
      expect(await e.drain(0)).toBeGreaterThan(0);
      e.s.inbox = [];
      t.holdsSlot = false;
      delete t.agent;
      e.settling.delete(taskId);
      release();
      expect(life.status().drained).toBe(false);
      cleaned();
      await cleanup;
      t.screen = { reason: "A saved screen check", roleId: "builder", profileId: "opus-high", at: Date.now() };
      t.state = "waiting";
      expect(life.status().screenWaiting).toHaveLength(1);
      expect(await e.drain(0)).toBe(0);
      expect(life.status().drained).toBe(true);
      await waitFor(() => stops === 1, "one fully drained stop");
    } finally {
      release();
      cleaned();
      life.close();
      store.close();
      e.settling.delete(taskId);
    }
  });
  it("distinguishes confirmed delivery, awaiting merge, landing, cancellation and unconfirmed mark done", async () => {
    const { e, c, taskId } = fixture();
    const task = e.task(taskId)!;
    task.state = "done";
    expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("landing", "marked-done");
    expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("deliveryConfirmed", false);
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "delivered", timeoutMs: 0 })).outcome).toBe("timed-out");
    task.state = "pr-open";
    executionFor(task).work.pr = { number: 1, url: "https://github.com/example/product/pull/1", state: "open", openedAt: 1 };
    expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("deliveryConfirmed", true);
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "delivered", timeoutMs: 0 })).outcome).toBe("completed");
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "landed", timeoutMs: 0 })).outcome).toBe("timed-out");
    task.state = "done";
    executionFor(task).work.pr!.state = "merged";
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "landed", timeoutMs: 0 })).outcome).toBe("completed");
    task.state = "cancelled";
    expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("landing", "cancelled");
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "delivered", timeoutMs: 0 })).outcome).toBe("timed-out");
  });
  it("supports quiet deadlines, already satisfied conditions, filtered inbox changes and lost continuity", async () => {
    const { e, c, taskId, offer } = fixture();
    expect((await c.call("watch.wait", { target: "pool", condition: "drained", timeoutMs: 1000 * SLOW })).outcome).toBe("completed");
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "state", states: ["queued"], timeoutMs: 0 })).outcome).toBe("completed");
    const quiet = await c.call("watch.wait", { target: "task", taskId, timeoutMs: 5 });
    expect(quiet.outcome).toBe("timed-out");
    const watching = c.call("watch.wait", { target: "inbox", kinds: ["question"], timeoutMs: 1000 * SLOW });
    offer("question");
    e.commit();
    expect((await watching).outcome).toBe("completed");
    expect((await c.call("watch.wait", { target: "task", taskId, marker: "another-boot.123", timeoutMs: 0 })).outcome).toBe("continuity-lost");
    const drained = c.call("watch.wait", { target: "pool", condition: "drained", timeoutMs: 5 });
    expect((await drained).outcome).toBe("completed");
  });
});

describe("the shared terminal and MCP connection", () => {
  it("reconnects a focused watch and reports lost continuity after engine replacement", async () => {
    const { e, home, taskId } = fixture();
    const token = "watch-key-01234567890123456789012";
    const first = serve(e, { port: 0, token });
    let replacement: ReturnType<typeof serve> | undefined;
    const connect = (server: ReturnType<typeof serve>) =>
      writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, token, pid: process.pid });
    connect(first);
    const client = new EngineClient(home, () => {
      throw new Error("A watch must never launch an engine");
    });
    try {
      const initial = await client.call("watch.wait", { target: "task", taskId, timeoutMs: 0 });
      const listeners = e.listeners.size;
      const watching = client.call("watch.wait", { target: "task", taskId, marker: initial.marker, timeoutMs: 3000 * SLOW });
      await waitFor(() => e.listeners.size > listeners, "the focused watch connection");
      first.stop(true);
      await e.shutdown();
      const next = new Engine(home, { admissionsClosed: true, usageCommands: { codex: null, grok: null }, terminals: () => [] });
      engines.push(next);
      replacement = serve(next, { port: 0, token });
      connect(replacement);
      const result = await watching;
      expect(result.outcome).toBe("continuity-lost");
      expect(result.reconnected).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(3000);
    } finally {
      first.stop(true);
      replacement?.stop(true);
    }
  });

  it("uses typed discoverable tools and the same engine for both interfaces without exposing its key", async () => {
    const { e, home, taskId, offer, inspect } = fixture(),
      store = new LifecycleStore(home);
    const life = new EngineLifecycle(e, store, async () => {}),
      token = "coordination-key-0123456789012345";
    const server = serve(e, { port: 0, token, lifecycle: life });
    writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, token, pid: process.pid });
    const client = new EngineClient(home, () => {
      throw new Error("Unexpected launch");
    });
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, CLI, ...args, "--json"], { env: engineEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(out + err).not.toContain(token);
      return { result: JSON.parse(out), code };
    };
    try {
      const tools = mcpTools();
      expect(tools.length).toBeGreaterThan(40);
      expect(tools.find((t) => t.name === "petrina_task_add")!.inputSchema).toHaveProperty("properties.requestId");
      const added = await cli("task", "add", "--product-id", "product", "--title", "From terminal", "--backlog", "--request-id", "terminal-create");
      expect(added.code).toBe(0);
      const rpc = async (name: string, args: Record<string, unknown>) => {
        const reply = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, client);
        return (reply!.result as { structuredContent: Record<string, unknown> }).structuredContent;
      };
      expect((await rpc("petrina_task_inspect", { taskId: added.result.taskId })).outcome).toBe("completed");
      expect(e.task(String(added.result.taskId))!.state).toBe("backlog");
      const update = { taskId: added.result.taskId, title: "Reviewed terminal request", description: "Ready to queue", requestId: "review-backlog" };
      expect((await rpc("petrina_task_update_backlog", update)).outcome).toBe("completed");
      expect((await cli("task", "queue", String(added.result.taskId), "--request-id", "queue-reviewed")).code).toBe(0);
      expect((await rpc("petrina_task_update_backlog", update)).outcome).toBe("completed");
      expect((await cli("task", "backlog", String(added.result.taskId), "--request-id", "back-to-review")).code).toBe(0);
      expect((await rpc("petrina_task_queue", { taskId: added.result.taskId, requestId: "mcp-queue" })).outcome).toBe("completed");
      expect((await rpc("petrina_task_update_backlog", { ...update, requestId: "too-late" })).outcome).toBe("invalid");
      expect((await rpc("petrina_task_add", { productId: "product", title: "From MCP", requestId: "mcp-create" })).outcome).toBe("completed");
      const itemId = offer("question"),
        read = await inspect(itemId);
      expect((await cli("inbox", "answer", itemId, "--revision", String(read.revision), "--answer", "Yes", "--request-id", "terminal-answer")).code).toBe(0);
      const lessons = offer("learnings", "- A selected lesson"),
        lessonRead = await rpc("petrina_learning_inspect", { itemId: lessons });
      expect(
        (await rpc("petrina_learning_accept", { itemId: lessons, revision: lessonRead.revision, positions: [0], requestId: "mcp-learning" })).outcome,
      ).toBe("completed");
      expect((await cli("engine", "pause", "--wait", "--request-id", "terminal-pause")).code).toBe(0);
      expect((await rpc("petrina_engine_resume", { requestId: "mcp-resume" })).outcome).toBe("completed");
      expect(e.s.pool.paused).toBe(false);
      expect((await rpc("petrina_task_inspect", { taskId })).outcome).toBe("completed");
      const proc = Bun.spawn([process.execPath, CLI, "mcp"], { env: engineEnv(home), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      try {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
        expect(JSON.parse(await firstLine(proc.stdout)).result.capabilities).toHaveProperty("tools");
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        const listed = JSON.parse(await firstLine(proc.stdout)).result.tools;
        expect(listed.length).toBe(tools.length);
        for (const tool of listed) {
          expect(tool.annotations).not.toHaveProperty("destructiveHint", false);
          expect(tool.annotations).not.toHaveProperty("openWorldHint", false);
        }
        const callTool = async (name: string, args: Record<string, unknown>) => {
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }) + "\n");
          const response = JSON.parse(await firstLine(proc.stdout));
          expect(JSON.stringify(response)).not.toContain(token);
          return response.result.structuredContent;
        };
        const created = await callTool("petrina_task_add", { productId: "product", title: "From stdio", requestId: "stdio-create" });
        expect(created.outcome).toBe("completed");
        expect((await callTool("petrina_task_inspect", { taskId: created.taskId })).outcome).toBe("completed");
        Object.assign(e.task(created.taskId)!, { state: "done", column: "done", finishedAt: Date.now() });
        e.save();
        expect((await callTool("petrina_task_history", { search: "stdio" })).items).toHaveLength(1);
        expect((await cli("task", "history", "--search", "stdio")).result.items).toHaveLength(1);
        expect((await callTool("petrina_task_inspect", { taskId: created.taskId })).task).toHaveProperty("state", "done");
        const selected = [created.taskId, taskId];
        expect((await callTool("petrina_watch_wait", { target: "task", taskIds: selected, condition: "state", states: ["done"], limit: 1, timeoutMs: 0 })).outcome).toBe("timed-out");
        const terminalWait = await cli("watch", "wait", "--target", "task", "--task-ids", JSON.stringify(selected), "--condition", "state", "--states", '["done"]', "--limit", "1", "--timeout-ms", "0");
        expect(terminalWait.code).toBe(3);
        expect(terminalWait.result.outcome).toBe("timed-out");
        const question = offer("question"),
          questionRead = await callTool("petrina_inbox_inspect", { itemId: question });
        const decisionWait = await callTool("petrina_watch_wait", { target: "task", taskIds: selected, condition: "decision", limit: 1, timeoutMs: 0 });
        expect(decisionWait.outcome).toBe("completed");
        expect(decisionWait.result.items[0].id).toBe(taskId);
        expect((await cli("watch", "wait", "--target", "task", "--task-ids", JSON.stringify(selected), "--condition", "decision", "--limit", "1", "--timeout-ms", "0")).result.outcome).toBe("completed");
        expect(
          (await callTool("petrina_inbox_answer", { itemId: question, revision: questionRead.revision, answer: "Yes", requestId: "stdio-answer" })).outcome,
        ).toBe("completed");
        e.task(taskId)!.journey = [
          {
            id: "recorded",
            kind: "agent",
            round: 1,
            sub: 0,
            startedAt: 1,
            roleId: "builder",
            profileId: "opus-high",
            trigger: { reason: "Plan approved" },
            agentResults: [{ roleId: "builder", profileId: "opus-high", at: 2, value: { summary: "Ready" } }],
          },
        ];
        expect((await callTool("petrina_journey_node", { taskId, nodeId: "recorded" })).result).toBe("recorded");
        expect((await cli("journey", "node", "--task-id", taskId, "--node-id", "recorded")).result.result).toBe("recorded");
        const decline = offer("learnings", "- A declined lesson"),
          declineRead = await callTool("petrina_learning_inspect", { itemId: decline });
        expect((await callTool("petrina_learning_decline", { itemId: decline, revision: declineRead.revision, requestId: "stdio-decline" })).outcome).toBe(
          "completed",
        );
        expect((await callTool("petrina_engine_pause", { requestId: "stdio-pause", wait: true })).outcome).toBe("completed");
        expect((await callTool("petrina_engine_resume", { requestId: "stdio-resume" })).outcome).toBe("completed");
        expect((await cli("task", "add", "--title", "Choose the product", "--start-from", '{"kind":"default"}', "--request-id", "planner-chooses")).code).toBe(
          0,
        );
      } finally {
        proc.stdin.end();
        await proc.exited;
      }
    } finally {
      life.close();
      store.close();
      server.stop(true);
    }
  });
});
