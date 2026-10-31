import { AgentRun } from "@petrina/agent-runtime/acp-run";
import {
  AgentMessages,
  completeAll,
  immediateMessageClock,
  TurnText,
  type AgentMessage,
  type SessionLine,
} from "@petrina/core";
import { executionOf } from "@petrina/orchestrator";
import { waitFor } from "@petrina/test-support/fixtures";
import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { Coordination, type Result } from "../../../src/coordination.js";
import { coordinationCli } from "../../../src/coordination-cli.js";
import { writeConnection } from "../../../src/instance.js";
import { mcpRequest } from "../../../src/mcp.js";
import { parseResult } from "../../../src/prompts.js";
import { NotesResult } from "../../../src/roles.js";
import { serve } from "../../../src/server.js";
import { EngineClient } from "../../client.js";
import type { Engine, EngineOptions } from "../../engine.js";
import { Fakes } from "../../fixtures.js";
import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

const ENGINE_OPTIONS: EngineOptions = { agentCommand: () => undefined, terminals: () => [] };

async function openPaused(owner: EngineCaseOwner, home: string): Promise<Engine> {
  const e = owner.open(home, ENGINE_OPTIONS);
  e.setPoolPaused(true);
  e.schedule = () => {};
  await owner.run(e, async () => {
    await e.waitUntilReady();
    await completeAll([...e.backgroundWork]);
  });
  return e;
}

async function setupCase(owner: EngineCaseOwner) {
  const home = join(owner.root, "data");
  const e = await openPaused(owner, home);
  e.s.products.push({ id: "product", name: "Product", repo: "local/product", tone: "blue", delivery: "local" });
  const task = e.task(e.addTask({ productId: "product", title: "Read long public updates" }))!;
  task.journey = [
    {
      id: "node",
      kind: "agent",
      roleId: "code-reviewer",
      profileId: "sol-high",
      startedAt: 1,
      round: 1,
      sub: 0,
      agentInputs: ["0", "1"].map((reviewerKey) => ({
        at: 1,
        roleId: "code-reviewer",
        profileId: "sol-high",
        reviewerKey,
        mode: "fresh" as const,
        sections: [],
        taskTitle: task.title,
      })),
    },
  ];
  const scope = executionOf(task);
  const stream = (seat = "0") =>
    new AgentMessages(immediateMessageClock, e["turns"]["messageStream"](scope, "code-reviewer", "sol-high", seat));
  return { home, e, task, scope, stream, c: new Coordination(e) };
}

const items = (result: Result) =>
  result.items as (SessionLine & { offset: number; total: number; mayChange: boolean | null })[];

it.each([
  "I checked the files and will hand back my result now.",
  "As asked, I end with a ```petrina block containing my result.",
  "Use ``` to open a fence.",
  "An unfinished code example:\n```typescript\nconst value = 1;",
  "A closed code example:\n```typescript\nconst value = 1;\n```",
])("preserves result matching after %s, whole and across split chunks", (opening) => {
  const schema = z.object({ ok: z.boolean() });
  for (const ending of [
    '```petrina\n{"ok":true}\n```',
    '```json \n{"ok":true}\n```',
    '```petrina\n{"ok":false}\n```\n```json\n{"ok":true}\n```',
  ]) {
    const reply = `${opening}\n${ending}`;
    for (const size of [reply.length, 7, 1]) {
      const turn = new TurnText();
      const seen: AgentMessage[] = [];
      const messages = new AgentMessages(immediateMessageClock, (message) => seen.push(message));
      for (let offset = 0; offset < reply.length; offset += size) {
        const chunk = reply.slice(offset, offset + size);
        turn.push(chunk);
        messages.push(chunk);
      }
      messages.boundary();
      expect(parseResult(turn.text, schema)).toEqual(parseResult(reply, schema));
      expect(parseResult(turn.text, schema)).toEqual({ ok: true, value: { ok: true } });
      expect(seen.every((message) => !message.text.includes("```") && !message.text.includes('{"ok"'))).toBe(true);
    }
  }
});

it("records newly created questions, summaries and picture reports with accurate attribution and completeness", () =>
  engineCases.use("petrina-public-conversation-", async (owner) => {
    const f = await setupCase(owner);
    const question = "Should the limit be 256 KiB or 1 MiB?";
    f.e.participantSay(f.scope, "agent", question, "code-reviewer", "sol-high", "1");
    const asked = f.task.session.at(-1)!;
    expect(asked.inputIndex).toBe(1);
    const read = await f.c.call("task.conversation", { taskId: f.task.id, messageId: asked.id });
    expect(items(read)[0]).toMatchObject({
      text: question,
      mayChange: true,
      recording: {
        originalLength: question.length,
        recordedLength: question.length,
        complete: true,
        state: "finished",
      },
    });
    expect(asked.recording!.reason).toBeUndefined();
    for (const [role, text] of [
      ["release-manager", "The release is ready."],
      ["researcher", "The notes are ready.\n• The checks passed."],
      ["code-reviewer", "A report with pictures."],
    ]) {
      f.e.participantSay(f.scope, "agent", text!, role!, "sol-high", undefined);
      expect(f.task.session.at(-1)!.recording).toMatchObject({
        complete: true,
        state: "finished",
        originalLength: text!.length,
      });
    }
    const body = "A generated summary. ".repeat(1500);
    f.e.say(f.scope, "agent", `${body}\`\`\`petrina\n{"private":"result"}`, "researcher", "sol-high");
    const summary = f.task.session.at(-1)!;
    expect(summary.text.length).toBe(2400);
    expect(f.e.store.publicText.read(f.task.id, summary).text).toBe(body);
    expect(summary.recording).toMatchObject({
      complete: true,
      originalLength: body.length,
      recordedLength: body.length,
    });
    f.e.commitNow(f.task);
    const restarted = await owner.restart(f.e, f.home, ENGINE_OPTIONS);
    restarted.setPoolPaused(true);
    restarted.schedule = () => {};
    await owner.run(restarted, async () => {
      await restarted.waitUntilReady();
      await completeAll([...restarted.backgroundWork]);
    });
    expect(restarted.publicMessage(f.task.id, asked.id)!.recording).toEqual(asked.recording!);
    expect(restarted.publicMessage(f.task.id, summary.id, body.length - 10)!.text).toBe(body.slice(-10));
  }));

it.each([
  "I checked the files and will hand back my result now.",
  "As asked, I end with a ```petrina block containing my result.",
  "An unfinished code example:\n```typescript\nconst value = 1;",
])("accepts the real agent runner's result after %s", (opening) =>
  engineCases.use("petrina-public-runner-", async (owner) => {
    const f = await setupCase(owner);
    const fake = new Fakes(join(owner.root, "fake"));
    fake.scenario({
      nativeRetry: [
        {
          role: "researcher",
          steps: [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: opening } } }],
        },
      ],
    });
    let run: AgentRun | undefined;
    const stopRun = owner.onStop(async () => {
      await run?.stop();
    });
    run = await owner.prepare(() =>
      AgentRun.start({
        profile: { id: "sol-high", toolId: "codex", model: "opus", effort: "high" },
        cwd: owner.root,
        browser: false,
        command: [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fake.dir],
        signal: owner.signal,
        callbacks: {
          onMessage: f.e["turns"]["messageStream"](f.scope, "researcher", "sol-high", undefined),
          onActivity() {},
          onPlanStep() {},
          onPermission: async () => "deny",
        },
      }),
    );
    try {
      const reply = await owner.prepare(() => run!.prompt("You are the Researcher in Petrina. Your role: Researcher"));
      expect(parseResult(reply.text, NotesResult)).toEqual({
        ok: true,
        value: { summary: "Notes from the researcher.", notes: ["A note from the researcher"] },
      });
      expect(JSON.stringify(f.task.session)).not.toContain('"notes":');
    } finally {
      await stopRun();
    }
  }),
);

it("pages one source through the app, CLI, MCP and task read, including an earlier streaming parallel seat", () =>
  engineCases.use("petrina-public-pages-", async (owner) => {
    const f = await setupCase(owner);
    const publicText = "Opening paragraph.\n\n" + "😀 Public detail. ".repeat(3500) + "\n\nThe saved ending.";
    const slow = f.stream();
    const peer = f.stream("1");
    slow.push(publicText.slice(0, 10_000), "slow");
    slow.flush();
    peer.push("A nearby short message.", "peer");
    peer.boundary();
    const [line, other] = f.task.session.filter((entry) => entry.from === "agent");
    expect([line!.inputIndex, other!.inputIndex]).toEqual([0, 1]);
    const first = await f.c.call("task.conversation", { taskId: f.task.id, nodeId: "node", limit: 12 });
    slow.push(publicText.slice(10_000), "slow");
    slow.flush();
    expect(line!.text.length).toBe(2400);
    const changed = await f.c.call("task.conversation", {
      taskId: f.task.id,
      nodeId: "node",
      limit: 12,
      ifRevision: first.revision,
    });
    expect(changed.unchanged).toBe(false);
    expect(changed.activeMessages).not.toEqual(first.activeMessages);
    const live = await f.c.call("task.conversation", { taskId: f.task.id, messageId: line!.id, limit: 23 });
    expect(items(live)[0]).toMatchObject({
      total: publicText.length,
      mayChange: true,
      recording: { complete: true, originalLength: publicText.length },
    });
    slow.boundary();
    const finished = await f.c.call("task.conversation", {
      taskId: f.task.id,
      messageId: line!.id,
      ifRevision: live.revision,
      limit: 23,
    });
    expect(finished.unchanged).toBe(false);
    expect(items(finished)[0]).toMatchObject({ mayChange: true, recording: { state: "finished" } });
    // Finishing capture does not finish the participant, which may still ask or continue on this start.
    f.task.journey![0]!.agentResults = [
      { roleId: "code-reviewer", profileId: "sol-high", at: 2, inputIndex: 0, value: {} },
    ];
    const handedBack = await f.c.call("task.conversation", {
      taskId: f.task.id,
      messageId: line!.id,
      ifRevision: finished.revision,
      limit: 23,
    });
    expect(handedBack.unchanged).toBe(false);
    expect(items(handedBack)[0]!.mayChange).toBe(false);
    let backward = "";
    let cursor: string | undefined;
    do {
      const read = await f.c.call("task.conversation", {
        taskId: f.task.id,
        messageId: line!.id,
        limit: 31999,
        ...(cursor ? { cursor } : {}),
      });
      const page = items(read)[0]!;
      expect(page.text.length).toBeLessThanOrEqual(32000);
      backward = page.text + backward;
      cursor = read.next as string | undefined;
    } while (cursor);
    expect(backward).toBe(publicText);
    let forward = "";
    let offset = 0;
    for (;;) {
      const page = f.e.publicMessage(f.task.id, line!.id, offset, 31999)!;
      forward += page.text;
      if (page.next === undefined) break;
      offset = page.next;
    }
    expect(forward).toBe(publicText);
    let json = "";
    cursor = undefined;
    do {
      const read = await f.c.call("task.read", {
        taskId: f.task.id,
        section: "conversation",
        limit: 32000,
        ...(cursor ? { cursor } : {}),
      });
      expect(String(read.text).length).toBeLessThanOrEqual(32000);
      json += read.text;
      cursor = read.next as string | undefined;
    } while (cursor);
    const saved = JSON.parse(json) as SessionLine[];
    expect(saved[0]!.text).toBe(publicText);
    expect(saved[0]!.recording).toEqual(f.e.publicMessage(f.task.id, line!.id)!.recording);
    expect(JSON.stringify(f.e.taskDetails(f.task.id))).not.toContain("The saved ending");
    expect(JSON.stringify(f.e.windowState())).not.toContain("Opening paragraph");

    let server: ReturnType<typeof serve> | undefined;
    const stopServer = owner.onStop(() => server?.stop(true));
    server = serve(f.e, { port: 0, token: "private-fixture-key" });
    writeConnection(f.home, {
      api: `http://127.0.0.1:${server.port}`,
      url: `ws://127.0.0.1:${server.port}/ws`,
      token: "private-fixture-key",
      pid: process.pid,
    });
    const client = new EngineClient(f.home, () => {
      throw new Error("Never launch an engine from this test");
    });
    try {
      const args = { taskId: f.task.id, messageId: line!.id, limit: 32000 };
      const output = spyOn(console, "log").mockImplementation(() => {});
      let cli: Result;
      try {
        expect(
          await coordinationCli(
            ["task", "conversation", f.task.id, "--message-id", line!.id, "--limit", "32000", "--json"],
            client,
          ),
        ).toBe(0);
        cli = JSON.parse(String(output.mock.calls.at(-1)![0]));
      } finally {
        output.mockRestore();
      }
      const mcp = await mcpRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "petrina_task_conversation", arguments: args } },
        client,
      );
      expect(JSON.stringify(mcp)).toContain("The saved ending");
      expect(items(cli)[0]!.text).toBe(items(await client.call("task.conversation", args))[0]!.text);
    } finally {
      await stopServer();
    }

    const unicode = f.stream("1");
    const unicodeText = `😀${"x".repeat(31_999)}`;
    unicode.push(unicodeText);
    unicode.boundary();
    const unicodeId = f.task.session.at(-1)!.id;
    const unicodePage = await f.c.call("task.conversation", {
      taskId: f.task.id,
      messageId: unicodeId,
      limit: 32_000,
    });
    expect(items(unicodePage)[0]!.text).toHaveLength(31_999);
    const unicodeStart = await f.c.call("task.conversation", {
      taskId: f.task.id,
      messageId: unicodeId,
      limit: 32_000,
      cursor: unicodePage.next,
    });
    expect(items(unicodeStart)[0]!.text + items(unicodePage)[0]!.text).toBe(unicodeText);
  }));

it("recovers batched words after an interrupted snapshot, keeps distinct attempts, and retains History", () =>
  engineCases.use("petrina-public-recovery-", async (owner) => {
    const f = await setupCase(owner);
    f.e.commitNow(f.task);
    const stream = f.stream();
    stream.push("Before restart. ".repeat(400), "first");
    stream.flush();
    const line = f.task.session.find((entry) => entry.from === "agent")!;
    const original = f.e.publicMessage(f.task.id, line.id)!.recording.originalLength;
    // Recover a saved body that predates the already durable public batch.
    const fresh = f.e.store.loadActive()!;
    const recovered = fresh.tasks.find((task) => task.id === f.task.id)!.session.find((saved) => saved.id === line.id)!;
    expect(recovered.recording).toMatchObject({ state: "interrupted", complete: false, originalLength: original });
    expect(f.e.store.publicText.read(f.task.id, recovered).text).toBe("Before restart. ".repeat(400));
    stream.boundary(true);
    line.images = [{ id: "saved-report-picture", caption: "A report picture attached after capture" }];
    f.e.commitNow(f.task);
    const next = await owner.restart(f.e, f.home, ENGINE_OPTIONS);
    next.setPoolPaused(true);
    next.schedule = () => {};
    await owner.run(next, async () => {
      await next.waitUntilReady();
      await completeAll([...next.backgroundWork]);
    });
    const task = next.task(f.task.id)!;
    expect(task.session.filter((saved) => saved.id === line.id)).toHaveLength(1);
    expect(task.session.find((saved) => saved.id === line.id)!.images).toEqual(line.images);
    expect(next.publicMessage(task.id, line.id)!.recording).toMatchObject({ complete: false, reason: "interrupted" });
    next["turns"]["recordProse"](
      executionOf(task),
      "code-reviewer",
      "sol-high",
      "0",
      "A separate completed reply. ".repeat(200),
    );
    const separate = task.session.at(-1)!;
    expect(separate.id).not.toBe(line.id);
    next["turns"]["keepWords"](executionOf(task), "code-reviewer", "sol-high", "1", {
      said: `${"A failed turn's public words. ".repeat(200)}\`\`\`petrina\nPRIVATE`,
      streamed: false,
    });
    const failed = task.session.at(-1)!;
    expect(next.publicMessage(task.id, failed.id)!.recording).toMatchObject({ complete: false, reason: "interrupted" });
    expect(next.store.publicText.read(task.id, failed).text).not.toContain("PRIVATE");
    task.state = "cancelled";
    next.commitNow(task);
    expect(next.historyPage({}).items.some((item) => item.id === task.id)).toBe(true);
    const history = await owner.restart(next, f.home, ENGINE_OPTIONS);
    history.setPoolPaused(true);
    history.schedule = () => {};
    await owner.run(history, async () => {
      await history.waitUntilReady();
      await completeAll([...history.backgroundWork]);
    });
    expect(history.publicMessage(task.id, separate.id)!.recording.complete).toBe(true);
    expect(
      history.store.publicText.read(
        task.id,
        history.task(task.id)!.session.find((entry) => entry.id === separate.id)!,
      ).text,
    ).toBe("A separate completed reply. ".repeat(200));
  }));

it("flushes cancellation before ignoring late chunks, leaves private thinking out, and never replays a reopened conversation", () =>
  engineCases.use("petrina-public-cancel-", async (owner) => {
    const f = await setupCase(owner);
    const fake = new Fakes(join(owner.root, "fake"));
    const text = "Native long update. ".repeat(700);
    fake.scenario({
      reopen: "load",
      nativeRetry: [
        {
          role: "researcher",
          steps: [
            { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PRIVATE THINKING" } } },
            { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
            { mark: "long-message" },
            { wait: "finish" },
          ],
        },
      ],
    });
    const controller = new AbortController();
    let run: AgentRun | undefined;
    let pending: Promise<unknown> | undefined;
    const stopRun = owner.onStop(async () => {
      controller.abort();
      await run?.stop();
      await pending;
    });
    try {
      run = await owner.prepare(() =>
        AgentRun.start({
          profile: { id: "sol-high", toolId: "codex", model: "opus", effort: "high" },
          cwd: owner.root,
          browser: false,
          command: [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fake.dir],
          signal: controller.signal,
          callbacks: {
            onMessage: f.e["turns"]["messageStream"](f.scope, "code-reviewer", "sol-high", "0", controller.signal),
            onActivity() {},
            onPlanStep() {},
            onPermission: async () => "deny",
          },
        }),
      );
      pending = owner.prepare(() =>
        run!.prompt("You are the Researcher in Petrina. Your role: Researcher").catch(() => undefined),
      );
      await waitFor(() => fake.marked("long-message"), "the long native message before cancellation");
      controller.abort();
      await run.stop();
      await pending;
      const line = f.task.session.find((entry) => entry.from === "agent")!;
      expect(f.e.store.publicText.read(f.task.id, line).text).toBe(text);
      expect(line.recording).toMatchObject({ state: "interrupted", complete: false, originalLength: text.length });
      expect(JSON.stringify(f.task.session)).not.toContain("PRIVATE THINKING");
      const sessionId = run.sessionId;
      run = await owner.prepare(() =>
        AgentRun.start({
          profile: { id: "sol-high", toolId: "codex", model: "opus", effort: "high" },
          cwd: owner.root,
          browser: false,
          command: [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fake.dir],
          reopen: sessionId,
          signal: owner.signal,
          callbacks: {
            onMessage: f.e["turns"]["messageStream"](f.scope, "code-reviewer", "sol-high", "0"),
            onActivity() {},
            onPlanStep() {},
            onPermission: async () => "deny",
          },
        }),
      );
      expect(run.reopened).toBe("load");
      expect(f.task.session.filter((entry) => entry.from === "agent")).toHaveLength(1);
    } finally {
      await stopRun();
    }
  }));
