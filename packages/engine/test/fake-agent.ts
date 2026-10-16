// A scripted ACP agent for tests. It reads which role it is from the prompt and answers
// like that role would, so the engine can be tested end to end without spending tokens.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<string, { cwd: string; turns: number }>();
const block = (value: unknown) => "Done.\n\n```petrina\n" + JSON.stringify(value) + "\n```";

function roleOf(text: string): string {
  return /You are the ([A-Za-z ]+) in Petrina/.exec(text)?.[1]?.trim().toLowerCase() ?? "";
}

let currentRole = "";

async function answer(sessionId: string, text: string, client: acp.AgentContext): Promise<string> {
  const session = sessions.get(sessionId)!;
  session.turns += 1;
  if (roleOf(text)) currentRole = roleOf(text);
  const say = (line: string) => client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "plan", entries: [{ content: line, status: "in_progress", priority: "medium" }] } });

  switch (currentRole) {
    case "planner":
      await say("Sizing the work");
      return block({
        rationale: "A small feature: agree on a design, build it, two reviewers.",
        stages: [
          { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
          { kind: "gate", title: "Your design check", roleId: "architect", gate: "design" },
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 },
        ],
      });
    case "architect":
      if (!text.includes("The coordinator answered")) return block({ needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] } });
      return block({ summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [], answers: [] });
    case "design reviewer":
      return block({ objections: [] });
    case "builder": {
      await say("Writing the greeting");
      const permission = (await client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: `call-${session.turns}`, title: "npm install left-pad", kind: "execute", status: "pending", rawInput: { command: "npm install left-pad" } },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      })) as acp.RequestPermissionResponse;
      const allowed = permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow";
      writeFileSync(join(session.cwd, "greeting.txt"), allowed ? "Hello (with left-pad)\n" : "Hello\n");
      return block({ summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed" });
    }
    case "code reviewer":
      return block({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "suggestion" }], confirms: [], disputes: [] });
    case "shipper": {
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: session.cwd }).toString().trim();
      const root = dirname(common);
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: session.cwd }).toString().trim();
      execFileSync("git", ["merge", "--ff-only", branch], { cwd: root });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
      return block({ summary: "Committed to main.", sha });
    }
    default:
      return block({ summary: "Nothing to do.", notes: [] });
  }
}

acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
  .onRequest("session/new", (ctx) => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cwd: ctx.params.cwd, turns: 0 });
    return { sessionId };
  })
  .onRequest("session/prompt", async (ctx) => {
    const text = ctx.params.prompt.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const reply = await answer(ctx.params.sessionId, text, ctx.client);
    await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => undefined)
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
