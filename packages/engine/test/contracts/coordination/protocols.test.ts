import { coordinatorCommand } from "../../fixtures/coordinator-process.js";

import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { EngineClient } from "../../client.js";
import { EngineLifecycle } from "../../../src/lifecycle.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { serve } from "../../../src/server.js";
import { writeConnection } from "../../../src/instance.js";
import { mcpRequest } from "../../../src/mcp.js";
import { mcpTools } from "../../../src/mcp-catalog.js";

import { CLI, engineProcessCases, tempDir } from "../../support.js";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
const { fixture } = owners;
afterAll(() => owners.close());
const peerCases = engineProcessCases();
afterEach(() => peerCases.close());

describe("the shared terminal and MCP connection", () => {
it("uses typed discoverable tools and the same engine for both interfaces without exposing its key", async () => {
    const peerRoot = tempDir("petrina-coordination-peer-");
    return peerCases.use(peerRoot, async peers => {
      const { e, home, taskId, offer, inspect } = await fixture(),
        store = new LifecycleStore(home);
      let life: EngineLifecycle | undefined, server: ReturnType<typeof serve> | undefined;
      const token = "coordination-key-0123456789012345";
      try {
      life = new EngineLifecycle(e, store, async () => {});
      server = serve(e, { port: 0, token, lifecycle: life });
      writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, token, pid: process.pid });
      const client = new EngineClient(home, () => {
        throw new Error("Unexpected launch");
      });
      const cli = async (...args: string[]) => {
        const { stdout: out, stderr: err, code } = await coordinatorCommand(home, [CLI, ...args, "--json"]);
        expect(out + err).not.toContain(token);
        return { result: JSON.parse(out), code };
      };
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
        const proc = peers.command(home, [CLI, "mcp"]);
        try {
          proc.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
          expect(JSON.parse(await proc.line()).result.capabilities).toHaveProperty("tools");
          proc.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
          const listed = JSON.parse(await proc.line()).result.tools;
          expect(listed.length).toBe(tools.length);
          for (const tool of listed) {
            expect(tool.annotations).not.toHaveProperty("destructiveHint", false);
            expect(tool.annotations).not.toHaveProperty("openWorldHint", false);
          }
          const callTool = async (name: string, args: Record<string, unknown>) => {
            proc.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }) + "\n");
            const response = JSON.parse(await proc.line());
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
          try { proc.endInput(); await proc.wait(); } finally { await proc.close(); }
        }
      } finally {
        try { life?.close(); }
        finally { try { store.close(); } finally { await server?.stop(true); } }
      }
    });
  });
});
