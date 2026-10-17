// A scripted ACP agent for tests. It reads which role it is from the prompt and answers
// like that role would, so the engine can be tested end to end without spending tokens.
//
// bun fake-agent.ts [dir]: with a dir (the restart tests), it records every prompt it gets in
// dir/prompts.jsonl, follows dir/scenario.json, drops marker files there at the moments a test
// waits for, and uses the fake GitHub in dir/github.json.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface Scenario {
  /** "short": build and one reviewer. */
  planner?: "short";
  /** "restart": ask a question, then work until cancelled, then finish once the step restarts. "plain": no questions. */
  builder?: "restart" | "plain";
  /** How the shipper behaves until the engine tells it an earlier attempt was interrupted. */
  shipper?: "finish" | "hang" | "deliver-then-hang" | "push-then-hang" | "bad-tag";
}

// Scenarios ride in the task description: "[disagree]" makes the design reviewer object every round,
// "[no-check]" leaves the design check out of the plan, "[screens]" puts Screens between the design and
// its check, and "[two-checks]" adds Screens and a second design check after the first. With "--hold=<file>",
// the architect stops halfway through following a call for as long as that file exists.
const dir = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const sessions = new Map<string, { cwd: string; turns: number }>();
const cancels = new Map<string, () => void>();
const block = (value: unknown, prose = "Done.") => `${prose}\n\n\`\`\`petrina\n${JSON.stringify(value)}\n\`\`\``;
const brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [] };
const scenario = (): Scenario => (dir && existsSync(join(dir, "scenario.json")) ? (JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario) : {});
const mark = (name: string) => dir && writeFileSync(join(dir, name), String(Date.now()));
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const gh = (cwd: string, ...args: string[]) => execFileSync(process.execPath, [join(import.meta.dir, "fake-gh.ts"), join(dir!, "github.json"), ...args], { cwd }).toString().trim();

type Reply = { text: string; stop?: "cancelled" };

/** A turn that only ends when the engine cancels it, or the engine goes away. */
function hang(sessionId: string, marker: string): Promise<Reply> {
  mark(marker);
  return new Promise((resolve) => cancels.set(sessionId, () => resolve({ text: "", stop: "cancelled" })));
}

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

async function answer(sessionId: string, text: string, client: acp.AgentContext): Promise<Reply> {
  const session = sessions.get(sessionId)!;
  session.turns += 1;
  if (roleOf(text)) currentRole = roleOf(text);
  if (dir) appendFileSync(join(dir, "prompts.jsonl"), `${JSON.stringify({ role: currentRole, text })}\n`);
  const say = (line: string) => client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "plan", entries: [{ content: line, status: "in_progress", priority: "medium" }] } });
  const done = (value: unknown, prose?: string): Reply => ({ text: block(value, prose) });
  const plan = scenario();

  switch (currentRole) {
    case "planner":
      await say("Sizing the work");
      if (plan.planner === "short")
        return done({
          rationale: "A small change: build it, one reviewer.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
          ],
        });
      return done({
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
        return done({ ...brief, answers: objectionIds(text).map((id) => ({ id, status: "accepted", byCall: false, answer: "Added it to the brief." })) });
      }
      const call = section(text, "The coordinator's call (final, exact words)");
      const settled = section(text, "Objections answered after the call (answer every one again by id)");
      if (call !== undefined && settled !== undefined) {
        // Changes asked for at the check: the note says the call was misread, so the first answer loses its
        // "Your call" tag and the others get it. Every note is rewritten to match the updated brief.
        const ids = objectionIds(settled);
        const answers = ids.map((id, index) => (index === 0 ? { id, status: "accepted", byCall: false, answer: "Kept it in the brief after your note." } : { id, status: "accepted", byCall: true, answer: "Added it to the brief, as the call says." }));
        return done({ ...brief, answers }, `Revising: ${ids.join(", ")}. Latest note: ${section(text, NOTES)?.split("\n").at(-1) ?? "none"}`);
      }
      if (call !== undefined) {
        await say("Reading your call");
        while (hold && existsSync(hold)) await Bun.sleep(50);
        // Following the call: the first open objection is the call's to reject; the last one is left out on purpose.
        const open = objectionIds(section(text, "Objections still open (answer every one by id)") ?? "");
        const answers = open.slice(0, open.length > 1 ? -1 : undefined).map((id, index) => (index === 0 ? { id, status: "rejected", byCall: true, answer: "Removed it from the brief, as the call says." } : { id, status: "accepted", byCall: false, answer: "Added it to the brief." }));
        return done({ ...brief, answers }, `Call: ${call}. Final: ${text.includes("The call is final") ? "yes" : "no"}. Open: ${open.join(", ")}.`);
      }
      if (!text.includes("The coordinator answered")) return done({ needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] } });
      return done({ ...brief, answers: [] });
    }
    case "design reviewer":
      if (text.includes("[disagree]")) {
        return done({ objections: [{ text: "The brief does not say who sees the greeting.", blocking: true }, { text: "Consider a greeting per language.", blocking: false }] });
      }
      return done({ objections: [] });
    case "builder": {
      if (plan.builder === "restart" && !text.includes("in an earlier attempt at this step")) {
        if (roleOf(text)) return done({ needsInput: { question: "Which colour should the greeting be?", options: ["Blue", "Green"] } });
        if (text.includes("The coordinator answered")) return hang(sessionId, "builder-answered");
        return hang(sessionId, "builder-interrupted");
      }
      await say("Writing the greeting");
      let allowed = true;
      if (!plan.builder) {
        const permission = (await client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: `call-${session.turns}`, title: "npm install left-pad", kind: "execute", status: "pending", rawInput: { command: "npm install left-pad" } },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        })) as acp.RequestPermissionResponse;
        allowed = permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow";
      }
      writeFileSync(join(session.cwd, "greeting.txt"), allowed ? "Hello (with left-pad)\n" : "Hello\n");
      return done({ summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed" });
    }
    case "code reviewer":
      return done({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "suggestion" }], confirms: [], disputes: [] });
    case "shipper":
      return ship(sessionId, session.cwd, text, plan.shipper ?? "finish");
    default:
      return done({ summary: "Nothing to do.", notes: [] });
  }
}

async function ship(sessionId: string, cwd: string, text: string, plan: NonNullable<Scenario["shipper"]>): Promise<Reply> {
  const again = text.includes("An earlier attempt to ship this was interrupted");
  const first = !again;
  if (plan === "hang" && first) return hang(sessionId, "shipper-started");
  const root = dirname(run(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const branch = run(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const finish = (value: Record<string, unknown>): Promise<Reply> | Reply => (plan === "deliver-then-hang" && first ? hang(sessionId, "delivered") : { text: block({ summary: "Delivered.", ...value }) });

  if (text.includes("Deliver it as a pull request")) {
    run(cwd, "push", "--quiet", "origin", branch);
    const url = gh(cwd, "pr", "create", "--head", branch, "--title", "A greeting");
    return finish({ prNumber: Number(url.split("/").at(-1)), prUrl: url });
  }
  if (text.includes("Deliver it as a release")) {
    // The interrupted attempt already pushed its version change: finish that one, no new version.
    if (!(again && text.includes("was pushed to main"))) {
      const [major, minor, patch] = readFileSync(join(cwd, "VERSION"), "utf8").trim().split(".").map(Number);
      writeFileSync(join(cwd, "VERSION"), `${major}.${minor}.${patch! + 1}\n`);
      run(cwd, "commit", "--quiet", "-am", "Bump version");
      run(cwd, "push", "--quiet", "origin", "HEAD:main");
    }
    if (plan === "push-then-hang" && first) return hang(sessionId, "pushed");
    const tag = `v${readFileSync(join(cwd, "VERSION"), "utf8").trim()}`;
    run(cwd, "tag", tag);
    run(cwd, "push", "--quiet", "origin", tag);
    gh(cwd, "release", "create", tag, "--target", "main", "--notes", "A greeting");
    return finish({ tag: plan === "bad-tag" ? "v9.9.9" : tag });
  }
  run(root, "merge", "--quiet", "--ff-only", branch);
  return finish({ sha: run(root, "rev-parse", "HEAD") });
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
    const reply = await answer(ctx.params.sessionId, text, ctx.client).catch((error: Error & { stderr?: Buffer }) => {
      // Kept for whoever debugs a test: the engine only sees "Internal error".
      if (dir) appendFileSync(join(dir, "errors.log"), `${error.stack}\n${error.stderr?.toString() ?? ""}\n`);
      throw error;
    });
    if (reply.text) await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.text } } });
    return { stopReason: reply.stop ?? "end_turn" };
  })
  .onNotification("session/cancel", (ctx) => {
    cancels.get(ctx.params.sessionId)?.();
    cancels.delete(ctx.params.sessionId);
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));

// The engine went away (quit, or killed): so does the agent.
process.stdin.on("end", () => process.exit(0));
