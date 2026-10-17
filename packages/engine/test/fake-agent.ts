// A scripted ACP agent for tests. It reads which role it is from the prompt and answers
// like that role would, so the engine can be tested end to end without spending tokens.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

// Scenarios ride in the task description: "[disagree]" makes the design reviewer object every round,
// "[no-check]" leaves the design check out of the plan, "[screens]" puts Screens between the design and
// its check, and "[two-checks]" adds Screens and a second design check after the first. With "--hold=<file>",
// the architect stops halfway through following a call for as long as that file exists.
const sessions = new Map<string, { cwd: string; turns: number }>();
const block = (value: unknown, prose = "Done.") => `${prose}\n\n\`\`\`petrina\n${JSON.stringify(value)}\n\`\`\``;
const brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [] };

function roleOf(text: string): string {
  return /You are the ([A-Za-z ]+) in Petrina/.exec(text)?.[1]?.trim().toLowerCase() ?? "";
}

/** The body of a `## title` section of the prompt. */
function section(text: string, title: string): string | undefined {
  const start = text.indexOf(`## ${title}\n`);
  if (start < 0) return undefined;
  const body = text.slice(start + title.length + 4);
  const end = body.indexOf("\n## ");
  return (end < 0 ? body : body.slice(0, end)).trim();
}

const NOTES = "The coordinator's notes on this task (follow them; where they conflict with the brief or each other, the latest wins)";
const check = { kind: "gate", title: "Your design check", roleId: "architect", gate: "design" };
const screens = { kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] };
const objectionIds = (text: string) => [...text.matchAll(/^- \[([^\]]+)\]/gm)].map((match) => match[1]!);
const hold = process.argv.find((arg) => arg.startsWith("--hold="))?.slice("--hold=".length);

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
          ...(text.includes("[no-check]") ? [] : text.includes("[screens]") ? [screens, check] : text.includes("[two-checks]") ? [check, screens, check] : [check]),
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 },
        ],
      });
    case "architect": {
      // Asked again for objections it left out: answer those in its own name.
      if (text.includes("Your result block could not be used")) {
        return block({ ...brief, answers: objectionIds(text).map((id) => ({ id, status: "accepted", byCall: false, answer: "Added it to the brief." })) });
      }
      const call = section(text, "The coordinator's call (final, exact words)");
      const settled = section(text, "Objections answered after the call (answer every one again by id)");
      if (call !== undefined && settled !== undefined) {
        // Changes asked for at the check: the note says the call was misread, so the first answer loses its
        // "Your call" tag and the others get it. Every note is rewritten to match the updated brief.
        const ids = objectionIds(settled);
        const answers = ids.map((id, index) => (index === 0 ? { id, status: "accepted", byCall: false, answer: "Kept it in the brief after your note." } : { id, status: "accepted", byCall: true, answer: "Added it to the brief, as the call says." }));
        return block({ ...brief, answers }, `Revising: ${ids.join(", ")}. Latest note: ${section(text, NOTES)?.split("\n").at(-1) ?? "none"}`);
      }
      if (call !== undefined) {
        await say("Reading your call");
        while (hold && existsSync(hold)) await Bun.sleep(50);
        // Following the call: the first open objection is the call's to reject; the last one is left out on purpose.
        const open = objectionIds(section(text, "Objections still open (answer every one by id)") ?? "");
        const answers = open.slice(0, open.length > 1 ? -1 : undefined).map((id, index) => (index === 0 ? { id, status: "rejected", byCall: true, answer: "Removed it from the brief, as the call says." } : { id, status: "accepted", byCall: false, answer: "Added it to the brief." }));
        return block({ ...brief, answers }, `Call: ${call}. Final: ${text.includes("The call is final") ? "yes" : "no"}. Open: ${open.join(", ")}.`);
      }
      if (!text.includes("The coordinator answered")) return block({ needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] } });
      return block({ ...brief, answers: [] });
    }
    case "design reviewer":
      if (text.includes("[disagree]")) {
        return block({ objections: [{ text: "The brief does not say who sees the greeting.", blocking: true }, { text: "Consider a greeting per language.", blocking: false }] });
      }
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
