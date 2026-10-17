// A scripted ACP agent for tests. It reads which role it is from the prompt and answers
// like that role would, so the engine can be tested end to end without spending tokens.
//
// bun fake-agent.ts [dir]: with a dir (the restart tests), it records every prompt it gets in
// dir/prompts.jsonl, keeps its conversations in dir/conversations so the next engine can reopen
// them, notes how each was opened in dir/opens.jsonl and every setting it was given in
// dir/config.jsonl, follows dir/scenario.json, drops marker files there at the moments a test
// waits for, and uses the fake GitHub in dir/github.json.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface Scenario {
  /** "short": build and one reviewer. "tester-after": build, one reviewer, then a tester. */
  planner?: "short" | "tester-after" | "limits";
  /** Scheduling tests: each fresh agent waits for its own release file before answering. */
  controlled?: boolean;
  /**
   * "restart": ask a question, then work until cancelled, then finish once the step restarts. "plain": no questions.
   * "work": draft a file and work (through interruptions) until the step restarts `restarts` times.
   */
  builder?: "restart" | "plain" | "work";
  /**
   * "commit": commit a stray file, read-only as it is, then work until the step restarts.
   * "work": the first reviewer to start works until the coordinator takes over and hands back; later ones pass.
   */
  /** "important": the first round's reviewers raise one Important finding (the second in other words); later rounds pass. */
  reviewer?: "commit" | "work" | "important";
  /** "change of mind": the Guide keeper finds the coordinator's note was not a miss. */
  guide?: "change of mind";
  /** How the planner rates the task's risk (unrated by default). */
  risk?: "low" | "high";
  /** The verifier's verdict on every finding it is given (default "real"). */
  verifier?: "real" | "not-a-bug";
  /** "work": the first tester works until the coordinator takes over and hands back; later ones pass. */
  tester?: "work";
  /** How the shipper behaves until the engine tells it an earlier attempt was interrupted. */
  shipper?: "finish" | "hang" | "deliver-then-hang" | "push-then-hang" | "bad-tag";
  /**
   * How it reopens a conversation: "resume" (it offers load too), "load" (it replays the conversation
   * first), or "stall" (it offers resume and never answers). Unset: it cannot reopen conversations.
   */
  /** "silent": the first handshake after it is set never answers at all (later ones do). */
  reopen?: "resume" | "load" | "stall" | "silent";
  /** What the Check finder hands back: a passing check (default) or a failing one. */
  checks?: "pass" | "fail";
  /** "work" builder: how many restarts it works through before it finishes (default 1). */
  restarts?: number;
}

/** A conversation, kept on disk so a fake started by the next engine can reopen it. */
interface Conversation {
  cwd: string;
  role: string;
  turns: number;
  /** How many times it was told Petrina restarted. */
  restarts: number;
  /** Everything it sent and was sent, for load to replay. */
  history: acp.SessionNotification["update"][];
  /** Turns the coordinator added in the tool's own app, in their terminal (see fake-cli.ts). */
  terminal?: number;
}

// Scenarios ride in the task description: "[disagree]" makes the design reviewer object every round,
// "[no-check]" leaves the design check out of the plan, "[screens]" puts Screens between the design and
// its check, and "[two-checks]" adds Screens and a second design check after the first. With "--hold=<file>",
// the architect stops halfway through following a call for as long as that file exists.
const dir = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const sessions = new Map<string, Conversation>();
const cancels = new Map<string, () => void>();
const block = (value: unknown, prose = "Done.") => `${prose}\n\n\`\`\`petrina\n${JSON.stringify(value)}\n\`\`\``;
const brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [] };
const scenario = (): Scenario => (dir && existsSync(join(dir, "scenario.json")) ? (JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario) : {});
const mark = (name: string) => dir && writeFileSync(join(dir, name), String(Date.now()));
const marked = (name: string) => !!dir && existsSync(join(dir, name));
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const gh = (cwd: string, ...args: string[]) => execFileSync(process.execPath, [join(import.meta.dir, "fake-gh.ts"), join(dir!, "github.json"), ...args], { cwd }).toString().trim();

type Reply = { text: string; stop?: "cancelled" };

const conversationFile = (sessionId: string) => dir && join(dir, "conversations", `${sessionId}.json`);

function keep(sessionId: string): void {
  const file = conversationFile(sessionId);
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(sessions.get(sessionId)));
}

/** A conversation from this process or an earlier one, or an error like a tool that lost it. */
function reopen(sessionId: string, how: "resume" | "load"): Conversation {
  const file = conversationFile(sessionId);
  const found = sessions.get(sessionId) ?? (file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Conversation) : undefined);
  if (!found) throw new Error(`No conversation ${sessionId}`);
  sessions.set(sessionId, found);
  opened(sessionId, how);
  return found;
}

function opened(sessionId: string, how: "new" | "resume" | "load"): void {
  // Whether this agent got the coordinator's GitHub login (only a shipper delivering to GitHub does).
  if (dir) appendFileSync(join(dir, "opens.jsonl"), `${JSON.stringify({ session: sessionId, how, github: process.env.GIT_SSH_COMMAND !== "petrina-ssh-disabled" })}\n`);
}

/** Send an update and keep it in the conversation's history. */
async function send(client: acp.AgentContext, sessionId: string, update: acp.SessionNotification["update"]): Promise<void> {
  sessions.get(sessionId)?.history.push(update);
  keep(sessionId);
  await client.notify(acp.methods.client.session.update, { sessionId, update });
}

/** The settings Petrina sets: model, effort (each tool's name for it) and the automatic safety mode. */
const select = (id: string, values: string[]) => ({ type: "select" as const, id, name: id, currentValue: values[0]!, options: values.map((value) => ({ value, name: value })) });
const configOptions = () => [select("model", ["default", "opus", "gpt-6.1-sol"]), select("effort", ["high", "xhigh"]), select("reasoning_effort", ["high", "xhigh"]), select("mode", ["default", "auto", "agent"])];

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

/** The finding ids listed in a section of the prompt. */
function findingIds(text: string, title: string): string[] {
  return [...(section(text, title) ?? "").matchAll(/^- \[([^\]]+)\]/gm)].map((match) => match[1]!);
}

/** The planner's risk rating, when the scenario sets one. */
function riskOf(plan: Scenario) {
  return plan.risk ? { risk: { level: plan.risk, why: plan.risk === "high" ? "It changes how people sign in." : "Only the greeting's words change." } } : {};
}

/** A builder in a fix round answers every finding it was given, by id. */
function answersTo(text: string) {
  return findingIds(text, "Review findings (answer every one by id; fix every Important one)").map((id) => ({ id, fixed: true, text: "Fixed it." }));
}

const NOTES = "The coordinator's notes on this task (follow them; where they conflict with the brief or each other, the latest wins)";
const check = { kind: "gate", title: "Your design check", roleId: "architect", gate: "design" };
const screens = { kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] };
const objectionIds = (text: string) => [...text.matchAll(/^- \[([^\]]+)\]/gm)].map((match) => match[1]!);
const hold = process.argv.find((arg) => arg.startsWith("--hold="))?.slice("--hold=".length);

async function answer(sessionId: string, text: string, client: acp.AgentContext): Promise<Reply> {
  const session = sessions.get(sessionId)!;
  session.turns += 1;
  if (roleOf(text)) session.role = roleOf(text);
  // The restart line of a reopened conversation, or the summary a fresh one starts with.
  const restarted = text.includes("Petrina restarted");
  if (restarted) session.restarts += 1;
  // Saved before it works on the turn: the engine may stop while it does.
  keep(sessionId);
  if (dir) appendFileSync(join(dir, "prompts.jsonl"), `${JSON.stringify({ role: session.role, session: sessionId, text })}\n`);
  const say = (line: string) => send(client, sessionId, { sessionUpdate: "plan", entries: [{ content: line, status: "in_progress", priority: "medium" }] });
  const done = (value: unknown, prose?: string): Reply => ({ text: block(value, prose) });
  const plan = scenario();
  if (plan.controlled && session.turns === 1 && dir) {
    await say(`${session.role} is working`);
    while (!existsSync(join(dir, `release-${sessionId}`))) await Bun.sleep(20);
  }
  const earlierAttempt = text.includes("in an earlier attempt at this step");
  // The coordinator drove this step in their terminal and handed it back: on this conversation, or in a fresh one.
  const handedBack = text.includes("handed it back");
  const terminal = `Terminal turns: ${session.terminal ?? 0}.`;

  switch (session.role) {
    case "planner":
      await say("Sizing the work");
      if (plan.planner === "tester-after")
        return done({
          rationale: "Build it, one reviewer, then try it out.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
            { kind: "do", title: "Test", roleId: "tester", profileIds: ["opus-high"] },
          ],
        });
      if (plan.planner === "limits") return done({
        rationale: "Exercise same-tool handoffs, design rounds and a mixed-tool review chain.",
        stages: [
          { kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] },
          { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "opus-xhigh", "sol-high"], maxRounds: 2 },
        ],
      });
      if (plan.planner === "short")
        return done({
          rationale: "A small change: build it, one reviewer.",
          ...riskOf(plan),
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
          ],
        });
      return done({
        rationale: "A small feature: agree on a design, build it, two reviewers.",
        ...riskOf(plan),
        stages: [
          { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
          ...(text.includes("[no-check]") ? [] : text.includes("[screens]") ? [screens, check] : text.includes("[two-checks]") ? [check, screens, check] : [check]),
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 },
        ],
      });
    case "architect": {
      if (handedBack) return done({ ...brief, answers: [] }, terminal);
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
    case "check finder":
      return done({
        summary: "Checked with git, which every test machine has.",
        checks: plan.checks === "fail" ? [{ name: "Tests", argv: ["git", "no-such-subcommand-petrina"], why: "A check that fails, for tests" }] : [{ name: "Version", argv: ["git", "--version"], why: "A check that passes, for tests" }],
      });
    case "design reviewer":
      if (plan.planner === "limits" && !text.includes("Objections so far")) return done({ objections: [{ text: "Explain who sees the greeting.", blocking: true }] });
      // "[follow-up]": only a non-blocking suggestion, so the design settles with it undecided.
      if (text.includes("[follow-up]")) return done({ objections: [{ text: "Follow-up: name the greeting's colour later.", blocking: false }] });
      if (text.includes("[disagree]")) {
        return done({ objections: [{ text: "The brief does not say who sees the greeting.", blocking: true }, { text: "Consider a greeting per language.", blocking: false }] });
      }
      return done({ objections: [] });
    case "builder": {
      if (handedBack) {
        writeFileSync(join(session.cwd, "greeting.txt"), "Hello\n");
        return done({ summary: "Finished the greeting after the hand back.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(text) }, terminal);
      }
      if (plan.builder === "restart" && !earlierAttempt && !restarted) {
        if (roleOf(text)) return done({ needsInput: { question: "Which colour should the greeting be?", options: ["Blue", "Green"] } });
        if (text.includes("The coordinator answered")) return hang(sessionId, "builder-answered");
        return hang(sessionId, "builder-interrupted");
      }
      if (plan.builder === "work" && !earlierAttempt && session.restarts < (plan.restarts ?? 1)) {
        if (roleOf(text)) {
          writeFileSync(join(session.cwd, "notes.txt"), "A first draft\n");
          await send(client, sessionId, { sessionUpdate: "tool_call", toolCallId: `edit-${session.turns}`, title: "Edit notes.txt", kind: "edit", status: "completed", locations: [{ path: join(session.cwd, "notes.txt") }] });
          await Bun.sleep(20);
          await say("Drafting the greeting");
          return hang(sessionId, "builder-working");
        }
        return hang(sessionId, session.restarts ? `builder-restart-${session.restarts}` : "builder-heard");
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
      return done({ summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(text) });
    }
    case "code reviewer":
      if (handedBack) return done({ verdict: "pass", findings: [], confirms: [], disputes: [] }, terminal);
      if (plan.reviewer === "work" && !marked("reviewer-worked")) {
        mark("reviewer-worked");
        await say("Reading the change");
        return hang(sessionId, "reviewer-working");
      }
      if (plan.reviewer === "commit" && !restarted && !earlierAttempt) {
        writeFileSync(join(session.cwd, "stray.txt"), "Not for this task\n");
        run(session.cwd, "add", "stray.txt");
        run(session.cwd, "commit", "--quiet", "-m", "A stray commit");
        return hang(sessionId, "reviewer-committed");
      }
      if (plan.reviewer === "important" && !text.includes("This is review round")) {
        // The second reviewer repeats the first one's finding in other words: Petrina keeps it once.
        const again = text.includes("Findings so far");
        return done({ verdict: "fail", findings: [{ text: again ? "The GREETING is missing on the welcome page!" : "The greeting is missing on the welcome page.", where: "greeting.txt", severity: "important", evidence: "Opened the welcome page" }], confirms: [], disputes: [] });
      }
      return done({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit" }], confirms: [], disputes: [] });
    case "security reviewer":
      return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });
    case "guide keeper":
      return done(
        plan.guide === "change of mind"
          ? { missed: false, line: "", why: "The note asks for a new colour: a change of mind, not a miss." }
          : { missed: true, line: "Every greeting also shows on the welcome page.", why: "The reviewers checked the greeting only where it was added." },
      );
    case "verifier":
      return done({
        verdicts: findingIds(text, "Important findings to check (a verdict on every one, by id)").map((id) => ({
          id,
          verdict: plan.verifier ?? "real",
          reason: plan.verifier === "not-a-bug" ? "The welcome page shows the greeting already." : "The welcome page has no greeting: confirmed by opening it.",
        })),
      });
    case "tester":
      if (handedBack) return done({ summary: "Tried it after the hand back.", checks: [] }, terminal);
      if (plan.tester === "work" && !marked("tester-worked")) {
        mark("tester-worked");
        await say("Trying it out");
        return hang(sessionId, "tester-working");
      }
      return done({ summary: "Tried it: it works.", checks: [] });
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
  .onRequest("initialize", async () => {
    const how = scenario().reopen;
    if (how === "silent" && dir && !existsSync(join(dir, "silent-stalled"))) {
      mark("silent-stalled");
      await new Promise(() => undefined);
    }
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: how === "resume" || how === "load", ...(how === "resume" || how === "stall" ? { sessionCapabilities: { resume: {} } } : {}) } };
  })
  .onRequest("session/new", (ctx) => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cwd: ctx.params.cwd, role: "", turns: 0, restarts: 0, history: [] });
    keep(sessionId);
    opened(sessionId, "new");
    return { sessionId, configOptions: configOptions() };
  })
  .onRequest("session/resume", async (ctx) => {
    // A tool that never answers: Petrina gives up and starts a fresh conversation.
    if (scenario().reopen === "stall") await new Promise(() => undefined);
    reopen(ctx.params.sessionId, "resume");
    return { configOptions: configOptions() };
  })
  .onRequest("session/load", async (ctx) => {
    const conversation = reopen(ctx.params.sessionId, "load");
    // Load streams the whole conversation back before it answers.
    for (const update of conversation.history) await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
    return { configOptions: configOptions() };
  })
  .onRequest("session/set_config_option", (ctx) => {
    if (dir) appendFileSync(join(dir, "config.jsonl"), `${JSON.stringify({ session: ctx.params.sessionId, configId: ctx.params.configId, value: ctx.params.value })}\n`);
    return { configOptions: configOptions() };
  })
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId } = ctx.params;
    const text = ctx.params.prompt.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    sessions.get(sessionId)?.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    const reply = await answer(sessionId, text, ctx.client).catch((error: Error & { stderr?: Buffer }) => {
      // Kept for whoever debugs a test: the engine only sees "Internal error".
      if (dir) appendFileSync(join(dir, "errors.log"), `${error.stack}\n${error.stderr?.toString() ?? ""}\n`);
      throw error;
    });
    if (reply.text) await send(ctx.client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.text } });
    return { stopReason: reply.stop ?? "end_turn" };
  })
  .onNotification("session/cancel", (ctx) => {
    cancels.get(ctx.params.sessionId)?.();
    cancels.delete(ctx.params.sessionId);
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));

// The engine went away (quit, or killed): so does the agent.
process.stdin.on("end", () => process.exit(0));
