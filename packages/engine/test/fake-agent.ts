// A scripted ACP agent for tests. It reads which role it is from the prompt and answers
// like that role would, so the engine can be tested end to end without spending tokens.
//
// bun fake-agent.ts [dir]: with a dir (the restart tests), it records every prompt it gets in
// dir/prompts.jsonl, keeps its conversations in dir/conversations so the next engine can reopen
// them, notes how each was opened in dir/opens.jsonl and every setting it was given in
// dir/config.jsonl, follows dir/scenario.json, and drops marker files there at the moments a test
// waits for. With "--script=<file>", the builder and the Release Manager follow the AgentScript in that file.
//
// With --tool=claude-code or --tool=codex (the work-log tests), it also reports usage, settings and
// limits the way that tool's adapter does. With FAKE_BARE_ACK set, it acknowledges a settings change
// without saying what the session ended up on.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface Scenario {
  /** "short": build and one reviewer. "tester-after": build, one reviewer, then a tester. */
  planner?: "short" | "tester-after" | "tester-first" | "limits" | "claude-build" | "two-opus";
  /** Scheduling tests: each fresh agent waits for its own release file before answering. */
  controlled?: boolean;
  /**
   * "restart": ask a question, then work until cancelled, then finish once the step restarts. "plain": no questions.
   * "work": draft a file and work (through interruptions) until the step restarts `restarts` times.
   * "fail-once": the first builder never hands back a result, so the task gets stuck; the next one finishes.
   */
  builder?: "restart" | "plain" | "work" | "fail-once";
  /**
   * "commit": commit a stray file, read-only as it is, then work until the step restarts.
   * "work": the first reviewer to start works until the coordinator takes over and hands back; later ones pass.
   */
  /**
   * "important": in the first round the reviewer on Opus raises one Important finding, the others a nit.
   * "important-twice": every reviewer raises it, each in its own words. Later rounds pass.
   */
  reviewer?: "commit" | "work" | "important" | "important-twice" | "move-branch" | "confirm";
  /** "change of mind": the Guide keeper finds the coordinator's note was not a miss. "broken": it never hands back a usable result. */
  guide?: "change of mind" | "broken";
  /** How the planner rates the task's risk (unrated by default). */
  risk?: "low" | "high";
  /** The verifier's verdict on every finding it is given (default "real"). */
  verifier?: "real" | "not-a-bug";
  /** "work": the first tester works until the coordinator takes over and hands back; later ones pass. */
  tester?: "work" | "fail-once";
  /** "hang": the first Release Manager works until cancelled. Later ones write the notes as usual. */
  releaseManager?: "hang";
  /**
   * How it reopens a conversation: "resume" (it offers load too), "load" (it replays the conversation
   * first), or "stall" (it offers resume and never answers). Unset: it cannot reopen conversations.
   */
  reopen?: "resume" | "load" | "stall";
  /** What the Check finder hands back: a passing check (default), a failing one, one that changes a tracked file, or one that commits. "broken": never a usable result. */
  checks?: "pass" | "fail" | "writes" | "commits" | "slow" | "broken";
  /** "work" builder: how many restarts it works through before it finishes (default 1). */
  restarts?: number;
  /** "change": fixing review findings changes the code (by default the fix leaves it as it was). */
  fixes?: "change";
  /** The first build writes a name the repository's pre-commit hook blocks; fixing removes it. */
  leak?: boolean;
  /** The first build merges main into the branch itself, which builders are told never to do. */
  mergesMain?: boolean;
  /** The builder's commit title. */
  title?: string;
  /** The builder and the code reviewers pass on what they learned about the repository (one lesson twice). */
  learnings?: boolean;
  /**
   * Agents on these models run out of usage: the first time one gets a turn it does some work, says so and fails
   * the turn, and every agent on that model fails the same way until `resetsInMs` (default an hour) later. A
   * Claude model reports a rejected rate limit of kind `type` (default "five_hour") first; "gpt-6.1-sol" fails the
   * way Codex does, with a message. Only agents with this `role` when it is set.
   */
  limited?: { model: string; role?: string; type?: string; resetsInMs?: number; spendCap?: boolean }[];
  /** Every turn of an agent on this model first reports its usage, the way Claude Code does. */
  usage?: { model: string; status: "allowed" | "allowed_warning" | "rejected"; utilization?: number; type?: string; resetsAt?: number; overage?: boolean }[];
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
  /** The model Petrina chose for it ("opus", "gpt-6.1-sol"). */
  model?: string;
  /** "fail-once": this conversation never hands back a result. */
  failing?: boolean;
  /** The session's settings as the tool keeps them. */
  options: ConfigOption[];
}

interface ConfigOption {
  id: string;
  name: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string }[];
}

// Like the real tools' connectors, it reports the login it runs on right after it starts.
// "--logged-out": it reports no login, and every new conversation is refused until the tool is logged in.
// "--not-logged-in": it reports no login but opens conversations, and asks for a login only at the first
// message, as Claude Code does. "--silent-login": it never says whether it is logged in.
// "--wont-start": it exits at once. "--hang": it starts but never opens a conversation. "--stubborn": it
// ignores being told to stop, and writes its process id to "pids".
// Scenarios ride in the task description: "[disagree]" makes the design reviewer object every round,
// "[no-check]" leaves the design check out of the plan, "[screens]" puts Screens between the design and
// its check, and "[two-checks]" adds Screens and a second design check after the first. "[quick]" plans just a
// build and one review. With "--hold=<file>", the architect stops halfway through following a call for as long
// as that file exists.
const dir = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const tool = process.argv.find((arg) => arg.startsWith("--tool="))?.slice("--tool=".length) as "claude-code" | "codex" | undefined;
const sessions = new Map<string, Conversation>();
const cancels = new Map<string, () => void>();
const block = (value: unknown, prose = "Done.") => `${prose}\n\n\`\`\`petrina\n${JSON.stringify(value)}\n\`\`\``;
const brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [] };
const scenario = (): Scenario => (dir && existsSync(join(dir, "scenario.json")) ? (JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario) : {});
const mark = (name: string) => dir && writeFileSync(join(dir, name), String(Date.now()));
const marked = (name: string) => !!dir && existsSync(join(dir, name));
/**
 * "--silent": this process never answers its handshake. A test hands it to one process only (the engine asks
 * for the command for each one), so a slow machine killing it before the handshake even arrives cannot pass
 * the silence on to the fresh agent that starts next.
 */
const silent = process.argv.includes("--silent");
/** The agent's own git: none of the programs a security test plants. */
const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

interface Reply {
  text: string;
  stop?: "cancelled";
  /** Leave the usage out entirely. */
  silent?: boolean;
  /** Claude Code: the per-model breakdown. */
  models?: { model: string; input: number; cached: number; write: number; output: number }[];
}

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
  // Whether this agent runs in the agents' environment: the coordinator's logins, in the background.
  if (dir) appendFileSync(join(dir, "opens.jsonl"), `${JSON.stringify({ session: sessionId, how, background: process.env.PETRINA_AGENT === "1" && process.env.BROWSER === "none" })}\n`);
}

/** Send an update and keep it in the conversation's history. */
async function send(client: acp.AgentContext, sessionId: string, update: acp.SessionNotification["update"]): Promise<void> {
  sessions.get(sessionId)?.history.push(update);
  keep(sessionId);
  await client.notify(acp.methods.client.session.update, { sessionId, update });
}

/** The settings Petrina sets: model, effort (each tool's name for it) and the automatic safety mode. */
const select = (id: string, values: string[], names: string[] = values): ConfigOption => ({ type: "select", id, name: id, currentValue: values[0]!, options: values.map((value, index) => ({ value, name: names[index]! })) });
/** With --tool, that tool's own choices: Claude Code offers Opus and Sonnet; this Codex only gpt-6.1, at up to high effort. */
const configOptions = (): ConfigOption[] => {
  if (tool === "codex") return [select("mode", ["read-only", "agent"]), select("model", ["gpt-6.1"]), { ...select("reasoning_effort", ["low", "medium", "high"]), currentValue: "medium" }];
  if (tool === "claude-code") return [select("mode", ["default", "auto"]), { ...select("model", ["opus", "sonnet"], ["Opus 5.5", "Sonnet 5.5"]), currentValue: "sonnet" }, { ...select("effort", ["low", "medium", "high", "xhigh"]), currentValue: "medium" }];
  return [select("model", ["default", "opus", "sonnet", "gpt-6.1-sol", "grok-4.7"]), select("effort", ["high", "xhigh"]), select("reasoning_effort", ["high", "xhigh"]), select("mode", ["default", "auto", "agent"])];
};

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
const loggedOut = process.argv.includes("--logged-out");
const notLoggedIn = loggedOut || process.argv.includes("--not-logged-in");
const silentLogin = process.argv.includes("--silent-login");
const hangs = process.argv.includes("--hang");
const stubborn = process.argv.includes("--stubborn");
if (stubborn) {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1000);
  if (dir) appendFileSync(join(dir, "pids"), `${process.pid}\n`);
}
if (process.argv.includes("--wont-start")) process.exit(3);
const scriptPath = process.argv.find((arg) => arg.startsWith("--script="))?.slice("--script=".length);

/** What the fake agents do for one test, read before every run. */
export interface AgentScript {
  /** For the task with this title, the builder (or `role`) waits while `file` exists (`file`.reached once waiting). */
  hold?: { title: string; file: string; role?: "builder" | "release manager" };
  /** The builder points this submodule at this commit, in its work. */
  gitlink?: { path: string; sha: string };
  /** Each task's builder also adds a file named after the task, so no two tasks make the same change. */
  ownFiles?: boolean;
  /** The builder's commit (and pull request) title, and its pull request description. */
  title?: string;
  description?: string;
  /** Write the logins the builder could see here. */
  envOut?: string;
  /** The Release Manager commits a file of its own, which Petrina must undo. */
  releaseManagerCommits?: boolean;
  /** What the Release Manager was given, every time it ran. */
  releaseManagerPrompts?: string[];
  /** What the Check finder hands back, instead of its scenario's checks. */
  checks?: { name: string; argv: string[]; why: string }[];
}

const readScript = (): AgentScript => (scriptPath && existsSync(scriptPath) ? (JSON.parse(readFileSync(scriptPath, "utf8")) as AgentScript) : {});
const saveScript = (script: AgentScript) => scriptPath && writeFileSync(scriptPath, JSON.stringify(script, null, 2));

/** Wait while the test holds this role on this task. */
async function held(role: "builder" | "release manager", text: string): Promise<void> {
  const held = readScript().hold;
  if (!held || (held.role ?? "builder") !== role || !text.includes(held.title) || !existsSync(held.file)) return;
  writeFileSync(`${held.file}.reached`, "");
  while (existsSync(held.file)) await Bun.sleep(30);
}

/** The Release Manager writes the notes from the commits it was given: every title it got, one line each. */
function releaseManager(cwd: string, text: string): string {
  const script = readScript();
  script.releaseManagerPrompts = [...(script.releaseManagerPrompts ?? []), text];
  if (script.releaseManagerCommits) {
    delete script.releaseManagerCommits;
    writeFileSync(join(cwd, "notes-draft.md"), "Not for the release\n");
    run(cwd, "add", "notes-draft.md");
    run(cwd, "commit", "--quiet", "-m", "A draft of the notes");
  }
  saveScript(script);
  const titles = [...text.matchAll(/^### (.+)$/gm)].map((match) => match[1]!);
  return block({ summary: `Wrote the notes on ${titles.length} change${titles.length === 1 ? "" : "s"}.`, notes: `## What's new\n${titles.map((title) => `- ${title}`).join("\n")}` });
}

/** A usage report the way Claude Code sends it: a usage update that carries the rate limit in its notes. */
const usageUpdate = (status: string, kind: string, utilization?: number, resetsAt?: number, overage?: boolean): acp.SessionNotification["update"] =>
  ({ sessionUpdate: "usage_update", used: 100, size: 1000, _meta: { "_claude/rateLimit": { status, rateLimitType: kind, ...(utilization !== undefined ? { utilization } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}), ...(overage ? { isUsingOverage: true } : {}) } } }) as acp.SessionNotification["update"];

/** Whether this model is out of usage now. The first time asks, the limit starts. */
function outOfUsage(limit: NonNullable<Scenario["limited"]>[number]): number | undefined {
  if (!dir) return undefined;
  const file = join(dir, `limit-${limit.model}`);
  if (!existsSync(file)) writeFileSync(file, String(Date.now() + (limit.resetsInMs ?? 3_600_000)));
  const until = Number(readFileSync(file, "utf8"));
  return Date.now() < until ? until : undefined;
}

/** Some work, a word about it, then the tool says it is out of usage and the turn fails. */
async function runOut(limit: NonNullable<Scenario["limited"]>[number], until: number, session: Conversation, sessionId: string, client: acp.AgentContext): Promise<never> {
  if (session.turns === 1) {
    writeFileSync(join(session.cwd, "notes.txt"), "A first draft\n");
    await send(client, sessionId, { sessionUpdate: "tool_call", toolCallId: `edit-${session.turns}`, title: "Edit notes.txt", kind: "edit", status: "completed", locations: [{ path: join(session.cwd, "notes.txt") }] });
    await Bun.sleep(20);
    await send(client, sessionId, { sessionUpdate: "plan", entries: [{ content: "Drafting the greeting", status: "in_progress", priority: "medium" }] });
  }
  if (limit.model.startsWith("gpt")) {
    const at = new Date(until);
    await send(client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `You've hit your usage limit. Try again at ${at.getHours() % 12 || 12}:${String(at.getMinutes()).padStart(2, "0")} ${at.getHours() < 12 ? "AM" : "PM"}.` } });
    throw acp.RequestError.internalError({ codexErrorInfo: "usageLimitExceeded", category: "quota_exhausted" }, "Internal error");
  }
  await send(client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I drafted notes.txt and started on the greeting file before running out." } });
  if (limit.spendCap) {
    // The session window is open, but the separate spend cap is exhausted in the same update.
    await send(client, sessionId, { sessionUpdate: "usage_update", used: 100, size: 1000, _meta: { "_claude/model": "claude-opus-5-5", "_claude/rateLimit": { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, overageStatus: "rejected", overageResetsAt: Math.ceil(until / 1000) } } } as acp.SessionNotification["update"]);
  } else {
    await send(client, sessionId, usageUpdate("rejected", limit.type ?? "five_hour", 1, Math.ceil(until / 1000)));
  }
  throw new Error("Claude usage limit reached");
}

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
  const learned = scenario().learnings ? (session.role === "builder" ? ["Run the tests with bun test: they take a second.", "Greetings live at the repository root."] : session.role === "code reviewer" ? ["Greetings live at the repository root!"] : []) : [];
  const done = (value: unknown, prose?: string): Reply => ({ text: block(learned.length && value && typeof value === "object" && !("needsInput" in value) ? { ...value, learnings: learned } : value, prose) });
  const plan = scenario();
  for (const report of plan.usage ?? []) if (report.model === session.model) await send(client, sessionId, usageUpdate(report.status, report.type ?? "seven_day", report.utilization, report.resetsAt, report.overage));
  const limit = (plan.limited ?? []).find((entry) => entry.model === session.model && (!entry.role || entry.role === session.role));
  const until = limit && outOfUsage(limit);
  if (limit && until) await runOut(limit, until, session, sessionId, client);
  if (plan.controlled && session.turns === 1 && dir) {
    await say(`${session.role} is working`);
    while (!existsSync(join(dir, `release-${sessionId}`))) await Bun.sleep(20);
  }
  const earlierAttempt = text.includes("in an earlier attempt at this step");
  // The coordinator drove this step in their terminal and handed it back: on this conversation, or in a fresh one.
  const handedBack = text.includes("handed it back");
  const terminal = `Terminal turns: ${session.terminal ?? 0}.`;

  if (text.includes("HANG-FOREVER")) {
    await say("Thinking for a very long time");
    await new Promise(() => undefined);
  }
  if (text.includes("SWITCH-THEN-STOP")) {
    // The tool confirms a switch to Sonnet at low effort, then stops before it replies.
    for (const [id, value] of [["model", "sonnet"], ["effort", "low"]] as const) session.options.find((option) => option.id === id)!.currentValue = value;
    await send(client, sessionId, { sessionUpdate: "config_option_update", configOptions: session.options } as acp.SessionNotification["update"]);
    setTimeout(() => process.exit(3), 200);
    await new Promise(() => undefined);
  }

  switch (session.role) {
    case "planner":
      await say("Sizing the work");
      if (tool === "claude-code" && !plan.controlled) {
        // Claude Code's limit notice rides on a context update, next to a dollar figure Petrina ignores.
        await send(client, sessionId, {
          sessionUpdate: "usage_update",
          used: 12_000,
          size: 200_000,
          cost: { amount: 1.2345, currency: "USD" },
          _meta: { "_claude/model": "claude-opus-5-5", "_claude/rateLimit": { status: "allowed", rateLimitType: "five_hour", utilization: 0.81, resetsAt: Math.round(Date.now() / 1000) + 7200 } },
        } as acp.SessionNotification["update"]);
      }
      if (plan.planner === "tester-first")
        return done({
          rationale: "Build it, try it, then two reviewers.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] },
            { kind: "do", title: "Try it like a user", roleId: "tester", profileIds: ["opus-high"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-xhigh", "sol-xhigh"], maxRounds: 2 },
          ],
        });
      if (plan.planner === "tester-after")
        return done({
          rationale: "Build it, one reviewer, then try it out.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
            { kind: "do", title: "Test", roleId: "tester", profileIds: ["opus-high"] },
          ],
        });
      if (plan.planner === "claude-build")
        return done({
          rationale: "Build it on Claude Code, one reviewer on Codex.",
          ...riskOf(plan),
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: plan.reviewer === "confirm" ? 2 : 1 },
          ],
        });
      if (plan.planner === "two-opus")
        return done({
          rationale: "Build it, then two reviewers on Claude Code.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "opus-xhigh"], maxRounds: 1 },
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
      if (text.includes("[quick]"))
        return done({
          rationale: "A small change: build it, one reviewer.",
          ...riskOf(plan),
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
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
      return {
        ...done({ ...brief, answers: [] }),
        // A helper agent ran on Haiku: Claude Code's breakdown already includes it.
        models: [
          { model: "claude-opus-5-5", input: 150, cached: 1500, write: 30, output: 70 },
          { model: "claude-haiku-5-5", input: 40, cached: 240, write: 0, output: 20 },
        ],
      };
    }
    case "check finder":
      if (plan.checks === "broken") return { text: "I could not work out how this product is checked." };
      if (readScript().checks) return done({ summary: "Checked the way this test asks.", checks: readScript().checks });
      return done({
        summary: "Checked with git, which every test machine has.",
        checks:
          plan.checks === "fail"
            ? [{ name: "Tests", argv: ["git", "no-such-subcommand-petrina"], why: "A check that fails, for tests" }]
            : plan.checks === "writes"
              ? [{ name: "Format", argv: ["git", "mv", "README.md", "README.txt"], why: "A check that changes a tracked file, for tests" }]
              : plan.checks === "slow"
                ? [{ name: "Slow", argv: [process.execPath, "-e", "await Bun.sleep(1500)"], why: "A check that takes a moment, for tests" }]
                : plan.checks === "commits"
                ? [{ name: "Sneaky", argv: ["git", "commit", "-q", "--allow-empty", "-m", "Not reviewed"], why: "A check that commits, for tests" }]
                : [{ name: "Version", argv: ["git", "--version"], why: "A check that passes, for tests" }],
      });
    case "design reviewer":
      if (plan.planner === "limits" && !text.includes("Objections so far")) return done({ objections: [{ text: "Explain who sees the greeting.", blocking: true }] });
      // "[follow-up]": only a non-blocking suggestion, so the design settles with it undecided.
      if (text.includes("[follow-up]")) return done({ objections: [{ text: "Follow-up: name the greeting's colour later.", blocking: false }] });
      if (text.includes("[disagree]")) {
        return done({ objections: [{ text: "The brief does not say who sees the greeting.", blocking: true }, { text: "Consider a greeting per language.", blocking: false }] });
      }
      // This turn reports no usage at all.
      return { ...done({ objections: [] }), silent: true };
    case "builder": {
      if (plan.builder === "fail-once" && dir) {
        if (roleOf(text) && !existsSync(join(dir, "builder-failed"))) {
          session.failing = true;
          mark("builder-failed");
        }
        if (session.failing) return { text: "Something went wrong, so there is no result this time." };
      }
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
      // Codex starting a helper agent shows up as a spawnAgent tool call.
      if (tool) await send(client, sessionId, { sessionUpdate: "tool_call", toolCallId: `spawn-${session.turns}`, title: "spawnAgent", kind: "other", status: "completed", rawInput: { receiverThreadIds: ["child-thread"], senderThreadId: sessionId } });
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
      if (plan.fixes === "change" && text.includes("You are fixing the review findings")) writeFileSync(join(session.cwd, "welcome.txt"), `Hello ${Date.now()}\n`);
      if (plan.leak && !text.includes("You are fixing the review findings")) writeFileSync(join(session.cwd, "greeting.txt"), "Hello from internal-db-07\n");
      if (plan.mergesMain && !text.includes("You are fixing the review findings")) {
        execFileSync("git", ["add", "-A"], { cwd: session.cwd });
        execFileSync("git", ["-c", "user.email=fake@example.com", "-c", "user.name=Fake", "commit", "-q", "-m", "Builder's own commit"], { cwd: session.cwd });
        execFileSync("git", ["-c", "user.email=fake@example.com", "-c", "user.name=Fake", "merge", "-q", "--no-edit", "main"], { cwd: session.cwd });
      }
      const script = readScript();
      const taskTitle = /^# The task: (.+)$/m.exec(text)?.[1];
      if (script.ownFiles && taskTitle) writeFileSync(join(session.cwd, `${taskTitle.toLowerCase().replace(/\W+/g, "-")}.txt`), `${taskTitle}\n`);
      await held("builder", text);
      if (script.envOut) {
        let helper = "(none)";
        try {
          helper = execFileSync("git", ["config", "--get-all", "credential.helper"], { cwd: session.cwd }).toString();
        } catch {}
        const names = ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_PROFILE", "GH_CONFIG_DIR", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "GH_PROMPT_DISABLED", "BROWSER", "PETRINA_AGENT"];
        writeFileSync(script.envOut, JSON.stringify({ ...Object.fromEntries(names.map((name) => [name, process.env[name]])), helper }));
      }
      // The work points a submodule at a commit only this computer has.
      const gitlink = script.gitlink;
      if (gitlink && run(session.cwd, "rev-parse", `HEAD:${gitlink.path}`) !== gitlink.sha) {
        run(session.cwd, "update-index", "--cacheinfo", `160000,${gitlink.sha},${gitlink.path}`);
        run(session.cwd, "add", "greeting.txt");
        run(session.cwd, "commit", "--quiet", "-m", "Bring the submodule up to date");
      }
      const title = script.title ?? plan.title;
      const description = script.description ?? (text.includes('"description"') ? "Adds a greeting file.\n\nTested with the greeting test." : undefined);
      return done({ ...(title ? { title } : {}), ...(description ? { description } : {}), summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(text) });
    }
    case "code reviewer":
      if (plan.reviewer === "confirm") return done({ verdict: text.includes("This is review round") ? "pass" : "fail", findings: [], confirms: text.includes("This is review round") ? [] : findingIds(text, "Findings so far (confirm or dispute by id)"), disputes: [] });
      if (handedBack) return done({ verdict: "pass", findings: [], confirms: [], disputes: [] }, terminal);
      // Only the reviewer on Opus: with reviewers starting at once, which one works on stays certain.
      if (plan.reviewer === "work" && session.model === "opus" && !marked("reviewer-worked")) {
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
      if (plan.reviewer === "move-branch" && session.model === "opus" && !marked("branch-moved")) {
        // From its own copy, a misled reviewer rewinds the task's branch: the branches are shared.
        mark("branch-moved");
        const branch = /on branch (\S+?)\./.exec(text)?.[1];
        if (branch) run(session.cwd, "update-ref", `refs/heads/${branch}`, "HEAD~1");
      }
      if ((plan.reviewer === "important" || plan.reviewer === "important-twice") && !text.includes("This is review round")) {
        const opus = session.model === "opus";
        if (plan.reviewer === "important" && !opus) return done({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit" }], confirms: [], disputes: [] });
        return done({ verdict: "fail", findings: [{ text: opus ? "The greeting is missing on the welcome page." : "The GREETING is missing on the welcome page!", where: "greeting.txt", severity: "important", evidence: "Opened the welcome page" }], confirms: [], disputes: [] });
      }
      if (tool === "claude-code") {
        // A fallback: Claude Code switches the session's model and says so with a config update.
        session.options.find((option) => option.id === "model")!.currentValue = "sonnet";
        await send(client, sessionId, { sessionUpdate: "config_option_update", configOptions: session.options } as acp.SessionNotification["update"]);
      } else if (tool === "codex") {
        await send(client, sessionId, { sessionUpdate: "notice", severity: "info", title: "Model rerouted", description: "Switched from gpt-6.1 to gpt-6.1-mini (high demand)." } as unknown as acp.SessionNotification["update"]);
      }
      return done({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit" }], confirms: [], disputes: [] });
    case "security reviewer":
      return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });
    case "guide keeper":
      if (plan.guide === "broken") return { text: "I could not tell what the reviewers missed." };
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
      // "fail-once": the second tester pass (the one on the final code) fails an acceptance item, once.
      if (plan.tester === "fail-once" && marked("tester-passed-once") && !marked("tester-failed-once")) {
        mark("tester-failed-once");
        return done({ summary: "Tried it: the greeting is missing on the welcome page.", checks: [{ text: "A greeting file exists", pass: false }] });
      }
      mark("tester-passed-once");
      return done({ summary: "Tried it: it works.", checks: [{ text: "A greeting file exists", pass: true }] });
    case "release manager": {
      if (plan.releaseManager === "hang" && !marked("release-manager-started")) return hang(sessionId, "release-manager-started");
      await say("Writing the release notes");
      await held("release manager", text);
      return { text: releaseManager(session.cwd, text) };
    }
    default:
      return done({ summary: "Nothing to do.", notes: [] });
  }
}

const tokenCount = (row: { input: number; cached: number; write: number; output: number }) => ({
  inputTokens: row.input,
  cachedInputTokens: row.cached,
  cachedWriteTokens: row.write,
  outputTokens: row.output,
  reasoningOutputTokens: 0,
  totalTokens: row.input + row.cached + row.write + row.output,
});

/** The prompt response each adapter sends: ACP usage plus `_meta.quota.model_usage`. */
function responseFor(reply: Reply, session: Conversation) {
  const stopReason = reply.stop ?? ("end_turn" as const);
  if (reply.silent) return { stopReason };
  const main = { input: 100, cached: 1000, write: 20, output: 50 };
  if (tool === "codex") {
    const model = session.options.find((option) => option.id === "model")!.currentValue;
    const count = { ...tokenCount({ ...main, write: 0 }), reasoningOutputTokens: 20, cacheWriteInputTokens: 0 };
    return {
      stopReason,
      usage: { inputTokens: 100, cachedReadTokens: 1000, cachedWriteTokens: 0, outputTokens: 50, thoughtTokens: 20, totalTokens: 1150 },
      _meta: { quota: { token_count: count, model_usage: [{ model, token_count: count }] } },
    };
  }
  // Claude Code: the main figure counts the main agent loop only; the breakdown is the fuller picture.
  const rows = reply.models ?? [{ model: "claude-opus-5-5", ...main }];
  return {
    stopReason,
    usage: { inputTokens: main.input, cachedReadTokens: main.cached, cachedWriteTokens: main.write, outputTokens: main.output, totalTokens: 1170 },
    _meta: { quota: { token_count: tokenCount(main), model_usage: rows.map((row) => ({ model: row.model, token_count: tokenCount(row) })) } },
  };
}

acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", async (ctx) => {
    // After the answer, never before it: the login it runs on, or "none".
    if (!silentLogin) setImmediate(() => void ctx.client.notify("_auth/status_update", { authStatus: notLoggedIn ? { kind: "none", label: "Not logged in" } : { kind: "account", label: "Fake plan" } }).catch(() => undefined));
    const how = scenario().reopen;
    if (silent) await new Promise(() => undefined);
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: how === "resume" || how === "load", ...(how === "resume" || how === "stall" ? { sessionCapabilities: { resume: {} } } : {}) } };
  })
  .onRequest("session/new", async (ctx) => {
    if (loggedOut) throw acp.RequestError.authRequired();
    if (hangs) await new Promise(() => undefined);
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cwd: ctx.params.cwd, role: "", turns: 0, restarts: 0, history: [], options: configOptions() });
    keep(sessionId);
    opened(sessionId, "new");
    return { sessionId, configOptions: sessions.get(sessionId)!.options };
  })
  .onRequest("session/resume", async (ctx) => {
    // A tool that never answers: Petrina gives up and starts a fresh conversation.
    if (scenario().reopen === "stall") await new Promise(() => undefined);
    return { configOptions: reopen(ctx.params.sessionId, "resume").options };
  })
  .onRequest("session/load", async (ctx) => {
    const conversation = reopen(ctx.params.sessionId, "load");
    // Load streams the whole conversation back before it answers.
    for (const update of conversation.history) await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
    return { configOptions: conversation.options };
  })
  .onRequest("session/set_config_option", (ctx) => {
    const session = sessions.get(ctx.params.sessionId)!;
    if (ctx.params.configId === "model") session.model = String(ctx.params.value);
    if (dir) appendFileSync(join(dir, "config.jsonl"), `${JSON.stringify({ session: ctx.params.sessionId, configId: ctx.params.configId, value: ctx.params.value })}\n`);
    const option = session.options.find((entry) => entry.id === ctx.params.configId);
    const value = (ctx.params as { value?: unknown }).value;
    if (option && typeof value === "string" && option.options.some((entry) => entry.value === value)) option.currentValue = value;
    keep(ctx.params.sessionId);
    // The protocol asks for the options back; a bare acknowledgement is what a tool that skips them sends.
    return (process.env.FAKE_BARE_ACK ? {} : { configOptions: session.options }) as acp.SetSessionConfigOptionResponse;
  })
  .onRequest("session/prompt", async (ctx) => {
    if (notLoggedIn) throw acp.RequestError.authRequired();
    const { sessionId } = ctx.params;
    const text = ctx.params.prompt.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    sessions.get(sessionId)?.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    const reply = await answer(sessionId, text, ctx.client).catch((error: Error & { stderr?: Buffer }) => {
      // Kept for whoever debugs a test: the engine only sees "Internal error".
      if (dir) appendFileSync(join(dir, "errors.log"), `${error.stack}\n${error.stderr?.toString() ?? ""}\n`);
      throw error;
    });
    if (reply.text) await send(ctx.client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.text } });
    return tool ? responseFor(reply, sessions.get(sessionId)!) : { stopReason: reply.stop ?? "end_turn" };
  })
  .onNotification("session/cancel", (ctx) => {
    cancels.get(ctx.params.sessionId)?.();
    cancels.delete(ctx.params.sessionId);
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));

// The engine went away (quit, or killed): so does the agent, unless it is stubborn.
process.stdin.on("end", () => {
  if (!stubborn) process.exit(0);
});
