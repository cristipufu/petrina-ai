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

const dir = process.argv[2];
const sessions = new Map<string, { cwd: string; turns: number }>();
const cancels = new Map<string, () => void>();
const block = (value: unknown) => "Done.\n\n```petrina\n" + JSON.stringify(value) + "\n```";
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

let currentRole = "";

async function answer(sessionId: string, text: string, client: acp.AgentContext): Promise<Reply> {
  const session = sessions.get(sessionId)!;
  session.turns += 1;
  if (roleOf(text)) currentRole = roleOf(text);
  if (dir) appendFileSync(join(dir, "prompts.jsonl"), `${JSON.stringify({ role: currentRole, text })}\n`);
  const say = (line: string) => client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "plan", entries: [{ content: line, status: "in_progress", priority: "medium" }] } });
  const done = (value: unknown): Reply => ({ text: block(value) });
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
          { kind: "gate", title: "Your design check", roleId: "architect", gate: "design" },
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 },
        ],
      });
    case "architect":
      if (!text.includes("The coordinator answered")) return done({ needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] } });
      return done({ summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [], answers: [] });
    case "design reviewer":
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
