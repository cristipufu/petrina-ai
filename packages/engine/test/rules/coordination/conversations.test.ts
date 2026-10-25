import { describe, expect, it } from "bun:test";
import { readConversation } from "../../../src/conversation-read.js";
import { conversationFixture, reviewerStart } from "../../fixtures/coordinator-conversation.js";

describe("focused coordination and durable decisions", () => {
it("reads bounded recent node messages and follows streaming peers by stable references", async () => {
    const { task } = conversationFixture();
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
    const args = { nodeId: "current", limit: 10 };
    const recent = await readConversation(task, args);
    expect(recent.items).toEqual([expect.objectContaining({ id: "peer", text: "er message", offset: 13, total: 23, mayChange: true })]);
    expect(JSON.stringify(recent)).not.toContain("Old research");
    expect(recent.activeMessages).toHaveLength(2);
    expect((await readConversation(task, { ...args, ifRevision: (recent.revision as string) })).items).toEqual([]);
    // The slow peer updates an earlier bubble while the later peer fills the entire page.
    task.session[1]!.text = "Checking the nearby cases";
    const update = await readConversation(task, { ...args, ifRevision: (recent.revision as string) });
    expect(update.unchanged).toBe(false);
    expect(update.activeMessages).not.toEqual(recent.activeMessages);
    const slow = await readConversation(task, { nodeId: "current", messageId: "slow" });
    expect(slow.items).toEqual([expect.objectContaining({ id: "slow", text: "Checking the nearby cases" })]);
    task.session.push({ id: "new", from: "agent", at: 6, step: "current", profileId: "grok-high", text: "Finished" });
    expect((await readConversation(task, { ...args, cursor: (recent.next as string) })).outcome).toBe("completed");
    expect((await readConversation(task, { nodeId: "old", cursor: (recent.next as string) })).outcome).toBe("changed");
    expect((await readConversation(task, { nodeId: "missing" })).outcome).toBe("unavailable");
    expect((await readConversation(task, { nodeId: "old", messageId: "slow" })).outcome).toBe("unavailable");
  });
});

describe("focused coordination and durable decisions", () => {
it("keeps only unfinished recorded participants active while peers in the same node finish, stand in or restart", async () => {
    const { task } = conversationFixture();
    const step = { id: "group", kind: "agent" as const, roleId: "code-reviewer", profileId: "opus-xhigh", startedAt: 1, round: 1, sub: 0,
      agentInputs: [reviewerStart("opus-xhigh", "0", 1), reviewerStart("grok-xhigh", "1", 1), reviewerStart("astra-xhigh", "2", 1)],
      agentResults: [] as { roleId: string; profileId: string; at: number; value: unknown; inputIndex: number }[] };
    task.journey = [step];
    const finish = (profileId: string, inputIndex: number, at: number) => step.agentResults.push({ roleId: "code-reviewer", profileId, at, value: {}, inputIndex });
    const say = (id: string, profileId: string, at: number, text: string) => task.session.push({ id, from: "agent", at, step: "group", roleId: "code-reviewer", profileId, text });
    say("astra", "astra-xhigh", 2, "Still checking 😀 ".repeat(40));
    say("grok", "grok-xhigh", 3, "Stopped at its usage limit");
    say("opus", "opus-xhigh", 4, "Opus finished its review");
    const args = { nodeId: "group", limit: 30 };
    const active = (read: ReturnType<typeof readConversation>) => (read.activeMessages as { id: string }[]).map((message) => message.id);
    const status = async (messageId: string) => ((await readConversation(task, { nodeId: "group", messageId })).items as { mayChange: boolean | null }[])[0]!.mayChange;
    const first = await readConversation(task, args);
    expect(active(first)).toEqual(["astra", "grok", "opus"]);

    // A stand-in takes the stopped reviewer's place: the replaced attempt can no longer change.
    step.agentInputs.push(reviewerStart("argon-high", "1", 5, "grok-xhigh"));
    say("argon", "argon-high", 6, "Argon looked again");
    const replaced = await readConversation(task, args);
    expect(active(replaced)).toEqual(["astra", "opus", "argon"]);
    expect(await status("grok")).toBe(false);
    expect(await status("argon")).toBe(true);

    // Finishing without new text still changes the response a revision-polling client sees.
    finish("opus-xhigh", 0, 7);
    const finished = await readConversation(task, { ...args, ifRevision: (replaced.revision as string) });
    expect(finished.unchanged).toBe(false);
    const unchangedText = (replaced.items as { id: string; revision: string }[]).find((item) => item.id === "opus")!.revision;
    expect(finished.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "opus", revision: unchangedText, mayChange: false })]));
    expect(active(finished)).toEqual(["astra", "argon"]);
    expect((await readConversation(task, { ...args, ifRevision: (finished.revision as string) })).unchanged).toBe(true);

    // Two of three reported: the slow peer stays discoverable outside the recent page, and older pages still read.
    finish("argon-high", 3, 8);
    const partial = await readConversation(task, args);
    expect(active(partial)).toEqual(["astra"]);
    expect((partial.items as { id: string }[]).map((item) => item.id)).not.toContain("astra");
    expect((partial.activeMessages as { id: string; roleId: string; profileId: string }[])[0]).toEqual(expect.objectContaining({ roleId: "code-reviewer", profileId: "astra-xhigh" }));
    expect(await status("astra")).toBe(true);
    let cursor = (partial.next as string) as string | undefined;
    const older: string[] = [];
    while (cursor) {
      const page = await readConversation(task, { ...args, cursor });
      expect(page.outcome).toBe("completed");
      older.unshift(...(page.items as { text: string }[]).map((item) => item.text));
      cursor = (page.next as string) as string | undefined;
    }
    expect(older.join("").startsWith("Still checking 😀 ".repeat(40))).toBe(true);

    // A restart of the same place supersedes its earlier attempt until it speaks again.
    step.agentInputs.push(reviewerStart("astra-xhigh", "2", 9));
    expect(active(await readConversation(task, args))).toEqual([]);
    expect(await status("astra")).toBe(false);
    say("astra-again", "astra-xhigh", 10, "Picking up the review");
    expect(active(await readConversation(task, args))).toEqual(["astra-again"]);
    finish("astra-xhigh", 4, 11);
    expect(active(await readConversation(task, args))).toEqual([]);
    expect(await status("astra-again")).toBe(false);
  });
});

describe("focused coordination and durable decisions", () => {
it("tells apart places sharing a role and profile by the start each message names, and leaves older unattributable records unknown", async () => {
    const { task } = conversationFixture();
    type Result = { roleId: string; profileId: string; at: number; value: unknown; inputIndex?: number };
    const node = (id: string, results: Result[] = []) => ({ id, kind: "agent" as const, roleId: "code-reviewer", profileId: "opus-high", startedAt: 1, round: 1, sub: 0,
      agentInputs: [reviewerStart("opus-high", "0", 1), reviewerStart("opus-high", "1", 1), reviewerStart("grok-high", "2", 1)], agentResults: results });
    const current = node("current"), older = node("older");
    const say = (step: string, id: string, profileId: string, at: number, text: string, inputIndex?: number) =>
      task.session.push({ id, from: "agent", at, step, roleId: "code-reviewer", profileId, text, ...(inputIndex === undefined ? {} : { inputIndex }) });
    const read = (nodeId: string, ifRevision?: string) => readConversation(task, { nodeId, limit: 8000, ...(ifRevision ? { ifRevision } : {}) });
    const statuses = (result: Awaited<ReturnType<typeof read>>) => Object.fromEntries((result.items as { id: string; mayChange: boolean | null }[]).map((item) => [item.id, item.mayChange]));
    const active = (result: Awaited<ReturnType<typeof read>>) => (result.activeMessages as { id: string }[]).map((message) => message.id);

    // Current records: each message names its start. The finished place spoke last; the working place stays discoverable.
    task.journey = [current];
    say("current", "working", "opus-high", 2, "Place zero is still checking", 0);
    say("current", "finishing", "opus-high", 3, "Place one is done", 1);
    const before = await read("current");
    expect(active(before)).toEqual(["working", "finishing"]);
    current.agentResults.push({ roleId: "code-reviewer", profileId: "opus-high", at: 4, value: {}, inputIndex: 1 });
    const after = await read("current", (before.revision as string) as string);
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
});

describe("focused coordination and durable decisions", () => {
it("reports single-participant and whole-node completion, and leaves unrecorded participants unknown", async () => {
    const { task } = conversationFixture();
    const build = { id: "build", kind: "agent" as const, roleId: "builder", profileId: "sol-high", startedAt: 1, round: 1, sub: 0,
      agentInputs: [{ at: 1, roleId: "builder", profileId: "sol-high", requestedProfileId: "sol-high", taskTitle: "First task", mode: "fresh" as const, sections: [] }],
      agentResults: [] as { roleId: string; profileId: string; at: number; value: unknown; inputIndex: number }[], endedAt: undefined as number | undefined };
    const older = { id: "older", kind: "agent" as const, roleId: "code-reviewer", profileId: "grok-high", startedAt: 1, round: 1, sub: 0, endedAt: undefined as number | undefined };
    task.journey = [build];
    task.session = [
      { id: "built", from: "agent", at: 2, step: "build", roleId: "builder", profileId: "sol-high", text: "Built it" },
      { id: "said", from: "you", at: 3, step: "build", text: "Keep the old page" },
    ];
    const read = () => readConversation(task, { nodeId: "build" });
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
    const unknown = await readConversation(task, { nodeId: "older" });
    expect(unknown.activeMessages).toEqual([]);
    expect((unknown.items as { mayChange: boolean | null }[]).map((item) => item.mayChange)).toEqual([null, null]);
  });
});

describe("focused coordination and durable decisions", () => {
it("pages every part of a long message despite appends, but rejects an edited unread prefix", async () => {
    const { task } = conversationFixture();
    task.session = [{ id: "long", from: "agent", at: 1, text: "abcdefghijklmnopqrstuvwxyz" }];
    const args = { limit: 8 };
    const first = await readConversation(task, args);
    expect(first.items).toEqual([expect.objectContaining({ text: "stuvwxyz", offset: 18, mayChange: null })]);
    task.session[0]!.text += " appended";
    const second = await readConversation(task, { ...args, cursor: (first.next as string) });
    expect(second.items).toEqual([expect.objectContaining({ text: "klmnopqr", offset: 10 })]);
    const third = await readConversation(task, { ...args, cursor: (second.next as string) });
    expect(third.items).toEqual([expect.objectContaining({ text: "cdefghij", offset: 2 })]);
    expect((await readConversation(task, { ...args, cursor: (third.next as string) })).items).toEqual([expect.objectContaining({ text: "ab", offset: 0 })]);
    task.session[0]!.text = "edited prefix";
    expect((await readConversation(task, { ...args, cursor: (first.next as string) })).outcome).toBe("changed");
  });
});

describe("focused coordination and durable decisions", () => {
it("keeps Unicode characters intact across recent-message page boundaries", async () => {
    const { task } = conversationFixture();
    task.session = [{ id: "unicode", from: "agent", at: 1, text: "A😀B" }];
    let cursor: string | undefined;
    const pages: string[] = [];
    do {
      const page = await readConversation(task, { limit: 1, ...(cursor ? { cursor } : {}) });
      pages.unshift((page.items as { text: string }[])[0]!.text);
      cursor = (page.next as string);
    } while (cursor);
    expect(pages).toEqual(["A", "😀", "B"]);
  });
});
