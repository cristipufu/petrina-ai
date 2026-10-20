import type { WorkChoice } from "@petrina/core";
// A scripted ACP agent for tests. It reads which role it is from the prompt and answers
// like that role would, so the engine can be tested end to end without spending tokens.
//
// bun fake-agent.ts [dir] [--record-tool=<id>]: with a dir (the restart tests), it records every prompt it
// gets in dir/prompts.jsonl, keeps its conversations in dir/conversations so the next engine can
// reopen them, notes how each was opened (as which tool, with which logins and sandbox settings) in
// dir/opens.jsonl and every setting it was given in dir/config.jsonl, follows dir/scenario.json, and
// drops marker files there at the moments a test waits for. With "--script=<file>", the builder and
// the Release Manager follow the AgentScript in that file.
//
// With --tool=claude-code or --tool=codex (the work-log tests), it also reports usage, settings and
// limits the way that tool's adapter does. With FAKE_BARE_ACK set, it acknowledges a settings change
// without saying what the session ended up on. --record-tool only labels openings, keeping the generic choices.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { testGitEnv } from "./test-git-env.js";
import * as acp from "@agentclientprotocol/sdk";

export interface Scenario {
  affectedProducts?: string[];
  /** Mix a correctly assigned review finding with one left under Together. */
  unassignedFinding?: boolean;
  pictures?: "valid" | "repair";
  /** Shutdown tests: never answer the initial handshake. */
  silent?: boolean;
  /** A real ACP internal-error wrapper with a provider diagnostic for one role. */
  failure?: { role: string; message: string; httpStatus: number };
  /** "short": build and one reviewer. "parallel": two reviewers at once. "pair": build, then two reviewers at once, one on each tool. "tester-after": build, one reviewer, then a tester. */
  worksOn?: WorkChoice[];
  /** An added Security specialist passes instead of blocking once. */
  addedReviewer?: "pass";
  /** Retain scenarios used by source-start and screen coverage. */
  planner?: "short" | "parallel" | "tester-after" | "tester-first" | "tester-with-design" | "research-first" | "limits" | "claude-build" | "two-opus" | "roles" | "copy" | "mixed-review" | "pair" | "build-review" | "source-roles" | "source-brief";
  notes?: "work";
  /** The architect leaves product changes for the engine to save, in rounds and after a call. */
  architect?: "writes";
  /** The second design brief changes a behavior so a resumed reviewer must receive it. */
  reviseBrief?: boolean;
  /** Scheduling tests: each fresh agent waits for its own release file before answering. */
  controlled?: boolean;
  /**
   * "restart": ask a question, then work until cancelled, then finish once the step restarts. "plain": no questions.
   * "work": draft a file and work (through interruptions) until the step restarts `restarts` times.
   * "fail-once": the first builder never hands back a result, so the task gets stuck; the next one finishes.
   * "todo": keep a to-do list while acting under it, then work until the step restarts; after a restart, wait for
   * go-todo before naming its own item and for go-finish before finishing. A second attempt finishes at once.
   */
  builder?: "restart" | "plain" | "work" | "fail-once" | "todo";
  /** Native Grok ACP calls omit the top-level kind and locations, and supply tool metadata instead. */
  activity?: "grok";
  /**
   * "commit": commit a stray file, read-only as it is, then work until the step restarts.
   * "work": the first reviewer to start works until the coordinator takes over and hands back; later ones pass.
   */
  /**
   * "important": in the first round the reviewer on Opus raises one Important finding, the others a nit.
   * "important-twice": every reviewer raises it, each in its own words. Later rounds pass.
   */
  reviewTodo?: boolean;
  reviewer?: "commit" | "work" | "important" | "important-twice" | "move-branch" | "confirm" | "confirm-fixed" | "confirm-fixed-one-tool" | "confirm-dismissed" | "question";
  reviewRounds?: number;
  reopenedEvidence?: string;
  /** The first claim has only an old id; its correction either accepts the fix or supplies new proof. */
  reviewConfirmation?: { role: string; correction: "omit" | "evidence"; duplicate?: boolean };
  /** "change of mind": the Guide keeper finds the coordinator's note was not a miss. "broken": it never hands back a usable result. */
  guide?: "change of mind" | "broken";
  /** How the planner rates the task's risk (unrated by default). */
  risk?: "low" | "high";
  /** The verifier's verdict (default "real"). "split": the first voter says real, later voters not-a-bug. "hold": wait until released. */
  verifier?: "real" | "not-a-bug" | "hold" | "split" | "after-fix-not-a-bug";
  /** The follow-up identity check. "same": one bug. "unsure": cannot tell. Anything else, including omitting it, cannot be used. */
  followUpMatch?: "same" | "unsure" | "down";
  /** Voting regressions: independent tools can disagree, or stop after a partial report. */
  verifierByModel?: Record<string, "real" | "not-a-bug" | "nit" | "pre-existing">;
  partialVerification?: boolean;
  limitAfterPartial?: boolean;
  /** Repair a partial ballot with a revised first verdict; the remaining findings are not bugs. */
  correctPartialVerification?: "real" | "not-a-bug";
  /** "work": the first tester works until the coordinator takes over and hands back; later ones pass. */
  tester?: "work" | "fail-once" | "writes" | "always-fail" | "omit-once" | "blocked" | "no-evidence";
  /** "hang": the first Release Manager works until cancelled. Later ones write the notes as usual. */
  releaseManager?: "hang";
  /**
   * The builder drafts in the background, then asks for the screen. Once it may use it, "ask" finishes
   * right away and "hold" stays on the screen until the test drops screen-release-<conversation> in dir.
   * Either way it drops on-screen-<conversation> when it gets the screen.
   */
  screen?: "ask" | "hold";
  /** The screen builder waits for screen-ask-<conversation> in dir before it asks, so a test can send a message first. */
  screenLate?: boolean;
  /** Other roles ask for the screen, keeping their usual result after it is granted. */
  screenRoles?: string[];
  screenModels?: string[];
  screenRoleHold?: boolean;
  /**
   * How it reopens a conversation: "resume" (it offers load too), "load" (it replays the conversation
   * first), or "stall" (it offers resume and never answers). Unset: it cannot reopen conversations.
   */
  reopen?: "resume" | "load" | "stall";
  /** "unavailable": Claude Code's sandbox cannot start, so any conversation asked to open in it is refused, as Claude Code does. */
  sandbox?: "unavailable";
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
  learnings?: boolean | "tester";
  /** Public updates with message ids, held before the result so tests can observe them live. */
  liveMessageRoles?: string[];
  /**
   * Agents on these models run out of usage: the first time one gets a turn it does some work, says so and fails
   * the turn, and every agent on that model fails the same way until `resetsInMs` (default an hour) later. A
   * Claude model reports a rejected rate limit of kind `type` (default "five_hour") first; "gpt-6.1-sol" fails the
   * way Codex does, with a message. Only agents with this `role` when it is set.
   */
  limited?: { model: string; role?: string; type?: string; resetsInMs?: number; spendCap?: boolean; afterRelease?: boolean; onScreen?: boolean }[];
  /** Every turn of an agent on this model first reports its usage, the way Claude Code does. */
  usage?: { model: string; status: "allowed" | "allowed_warning" | "rejected"; utilization?: number; type?: string; resetsAt?: number; overage?: boolean }[];
}

/** A conversation, kept on disk so a fake started by the next engine can reopen it. */
interface Conversation {
  captures?: string;
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
  effort?: string;
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
const tool = process.argv.find((arg) => arg.startsWith("--tool="))?.slice("--tool=".length) as "claude-code" | "codex" | "grok" | "antigravity" | undefined;
const recordedTool = process.argv.find((arg) => arg.startsWith("--record-tool="))?.slice("--record-tool=".length) ?? tool ?? "";
const sessions = new Map<string, Conversation>();
const cancels = new Map<string, () => void>();
const block = (value: unknown, prose = "Done.") => `${prose}\n\n\`\`\`petrina\n${JSON.stringify(value)}\n\`\`\``;
const scenario = (): Scenario => (dir && existsSync(join(dir, "scenario.json")) ? (JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario) : {});
const mark = (name: string) => dir && writeFileSync(join(dir, name), String(Date.now()));
const marked = (name: string) => !!dir && existsSync(join(dir, name));
/**
 * "--silent": this process never answers its handshake. A test hands it to one process only (the engine asks
 * for the command for each one), so a slow machine killing it before the handshake even arrives cannot pass
 * the silence on to the fresh agent that starts next.
 */
const silent = process.argv.includes("--silent") || scenario().silent === true;
if (dir) appendFileSync(join(dir, "processes"), `${process.pid}\n`);
/** The agent's own git: none of the programs a security test plants. */
const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: testGitEnv(), stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

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
function reopen(sessionId: string, how: "resume" | "load", meta: unknown): Conversation {
  refuseSandbox(sessionId, how, meta);
  const file = conversationFile(sessionId);
  const found = sessions.get(sessionId) ?? (file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Conversation) : undefined);
  if (!found) throw new Error(`No conversation ${sessionId}`);
  sessions.set(sessionId, found);
  opened(sessionId, how, meta);
  return found;
}

/** The stand-in logins the test engines run with (see engineEnv in support.ts). */
const TEST_GH_TOKEN = "petrina-test-gh-login";
/** Git settings passed down through the environment, as [key, value]. */
const gitSettings = () =>
  Object.keys(process.env)
    .filter((name) => name.startsWith("GIT_CONFIG_KEY_"))
    .map((name) => [process.env[name], process.env[name.replace("_KEY_", "_VALUE_")]] as const);
/** The coordinator's logins, untouched: their GitHub token, SSH agent, git credential helpers and gh config. */
const logins = () => process.env.GH_TOKEN === TEST_GH_TOKEN && !!process.env.SSH_AUTH_SOCK && !process.env.GIT_SSH_COMMAND && !process.env.GH_CONFIG_DIR && !gitSettings().some(([key]) => key === "credential.helper");
/**
 * Nothing waits for a typed answer or opens a sign-in window: git (no terminal prompt, no askpass program, also
 * none from core.askPass), gh, ssh and Git Credential Manager.
 */
const quiet = () =>
  process.env.GIT_TERMINAL_PROMPT === "0" &&
  process.env.GH_PROMPT_DISABLED === "1" &&
  process.env.GCM_INTERACTIVE === "never" &&
  process.env.SSH_ASKPASS_REQUIRE === "never" &&
  !process.env.GIT_ASKPASS &&
  !process.env.SSH_ASKPASS &&
  gitSettings().some(([key, value]) => key === "core.askPass" && value === "");
/** Claude Code's sandbox settings, where its adapter takes them. */
const sandboxOf = (meta: unknown) => (meta as { claudeCode?: { options?: { sandbox?: unknown } } } | undefined)?.claudeCode?.options?.sandbox;

function opened(sessionId: string, how: "new" | "resume" | "load", meta: unknown, refused = false): void {
  // The agents' environment: in the background, the coordinator's logins, nothing that asks; and the sandbox settings it was sent.
  const sandbox = sandboxOf(meta);
  const autoMode = (meta as { autoMode?: unknown } | undefined)?.autoMode === true;
  const background = process.env.PETRINA_AGENT === "1" && process.env.BROWSER === "none";
  if (dir) appendFileSync(join(dir, "opens.jsonl"), `${JSON.stringify({ session: sessionId, how, tool: recordedTool, background, logins: logins(), quiet: quiet(), ...(sandbox ? { sandbox } : {}), ...(autoMode ? { autoMode } : {}), ...(refused ? { refused } : {}) })}\n`);
}

/** Claude Code's own report, word for word, when its required sandbox cannot start (the connector passes it on). */
const SANDBOX_UNAVAILABLE =
  "Claude Code returned an error result: Sandbox required but unavailable: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed · install missing tools (e.g. apt install bubblewrap socat) or see https://code.claude.com/docs/en/sandboxing. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.";

/** A conversation asked to open in a sandbox that cannot start is refused, new or reopened, before anything else. */
function refuseSandbox(sessionId: string, how: "new" | "resume" | "load", meta: unknown): void {
  if (scenario().sandbox !== "unavailable" || !sandboxOf(meta)) return;
  opened(sessionId, how, meta, true);
  throw acp.RequestError.internalError({ details: SANDBOX_UNAVAILABLE });
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
  if (tool === "antigravity") return [select("model", ["gemini-4-argon", "gemini-3.8-flash"], ["Gemini 4 Argon", "Gemini 3.8 Flash"]), select("thinking_level", ["low", "medium", "high"]), select("mode", ["default", "auto_edit", "yolo"])];
  return [select("model", ["default", "opus", "sonnet", "gpt-6.1-sol", "grok-4.7", "gemini-4-argon", "gemini-3.8-flash"]), select("effort", ["high", "xhigh"]), select("reasoning_effort", ["high", "xhigh"]), select("thinking_level", ["low", "medium", "high"]), select("mode", ["default", "auto", "agent", "auto_edit"])];
};

/** A turn that only ends when the engine cancels it, or the engine goes away. */
function hang(sessionId: string, marker: string): Promise<Reply> {
  mark(marker);
  return new Promise((resolve) => cancels.set(sessionId, () => resolve({ text: "", stop: "cancelled" })));
}

function roleOf(text: string): string {
  return /You are the ([A-Za-z ]+) in Petrina/.exec(text)?.[1]?.trim().toLowerCase() ?? "";
}

function addedId(text: string, name: string): string {
  const id = new RegExp(`^- (added-[a-z0-9-]+) \\(${name}\\):`, "m").exec(text)?.[1];
  if (!id) throw new Error(`The planner's list has no ${name}`);
  return id;
}

const slug = (role: string) => role.replace(/[^a-z0-9]+/g, "-");
/** A security finding the added Security reviewer blocks on once. */
const SECURITY_FINDING = "Anyone can ask for the greeting as often as they like.";
/** Why the added Security reviewer disputes the code reviewer's suggestion, once Petrina asks for a reason. */
const DISPUTE_REASON = "The greeting's wording is the copywriter's call, not a review finding.";
/** The finding an added reviewer disputed without a reason, by conversation, until it gives one. */
const undisputed = new Map<string, string>();

/** The body of a `## title` section of the prompt. */
function section(text: string, title: string): string | undefined {
  const start = text.indexOf(`## ${title}\n`);
  if (start < 0) return undefined;
  const body = text.slice(start + title.length + 4);
  const end = body.indexOf("\n## ");
  return (end < 0 ? body : body.slice(0, end)).trim();
}

/** What the screen builder needs the screen for (tests repeat it: importing this file would start a fake agent). */
const SCREEN_REASON = "Check that the quick note window opens from the menu bar";

/** The finding ids listed in a section of the prompt. */
function findingIds(text: string, title: string): string[] {
  return [...(section(text, title) ?? "").matchAll(/^- \[([^\]]+)\]/gm)].map((match) => match[1]!);
}

/** The planner's risk rating, when the scenario sets one. */
function riskOf(plan: Scenario) {
  return { ...(plan.worksOn ? { worksOn: plan.worksOn } : {}), ...(plan.risk ? { risk: { level: plan.risk, why: plan.risk === "high" ? "It changes how people sign in." : "Only the greeting's words change." } } : {}) };
}

/** A builder in a fix round answers every finding it was given, by id. */
function answersTo(text: string) {
  return findingIds(text, "Review findings (answer every one by id; fix every Important one)").map((id) => ({ id, fixed: true, text: "Fixed it." }));
}

const NOTES = "The coordinator's notes on this task (preserve product decisions; read each instruction in its original step)";
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
  /** The Release Manager first asks for the screen, which it may not. */
  releaseManagerScreen?: boolean;
  /** What the Check finder hands back, instead of its scenario's checks. */
  checks?: { name: string; argv: string[]; why: string }[];
  /** Every builder installs packages and builds: folders the repository ignores, with a link to this shared cache. */
  installs?: { cache: string };
  /** For the task with this title, the build output keeps a read-only folder, until the test unlocks it. */
  locked?: string;
  /**
   * For the task with this title, the builder starts a build in a process group of its own, which keeps writing
   * build output for seconds and takes a moment to stop. Its process id goes to `pids`.
   */
  background?: { title: string; pids: string };
}

/** Installed packages and build output, the way package managers and compilers leave them. */
function installs(cwd: string, cache: string): void {
  mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(cwd, "node_modules", "left-pad", "index.js"), "module.exports = (text) => text;\n");
  mkdirSync(join(cwd, "target", "debug"), { recursive: true });
  writeFileSync(join(cwd, "target", "debug", "greeting.bin"), "build output\n");
  if (!existsSync(join(cwd, "node_modules", ".cache"))) symlinkSync(cache, join(cwd, "node_modules", ".cache"), process.platform === "win32" ? "junction" : "dir");
}

/** A build that writes its output every 100 ms for seconds, outlives the agent unless stopped, and writes once more as it stops. */
function backgroundBuild(cwd: string, pids: string): void {
  const script = `const { mkdirSync, writeFileSync } = require("node:fs"); const dir = process.env.OUT; const end = Date.now() + 8000;
    const write = () => { mkdirSync(dir, { recursive: true }); writeFileSync(dir + "/out.bin", "x"); };
    process.on("SIGTERM", () => setTimeout(() => { write(); process.exit(0); }, 300));
    const tick = () => { write(); if (Date.now() < end) setTimeout(tick, 100); }; tick();`;
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", env: { ...process.env, OUT: join(cwd, "target", "background") } });
  child.unref();
  if (child.pid) appendFileSync(pids, `${child.pid}\n`);
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
  if (script.releaseManagerScreen && roleOf(text)) return block({ needsScreen: { reason: "Look at the released app on screen" } });
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
  if (limit.model.startsWith("grok")) {
    throw acp.RequestError.internalError({ message: "API error (status 402 Payment Required): Grok Build usage balance exhausted", http_status: 402 });
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
  const captures = /Browser output belongs only in (.+), outside product files\./.exec(text)?.[1]
    ?? /Browser capture folder for this turn: (.+)\. Earlier pages/.exec(text)?.[1];
  if (captures) session.captures = captures;
  // The restart line of a reopened conversation, or the summary a fresh one starts with.
  const restarted = text.includes("Petrina restarted");
  if (restarted) session.restarts += 1;
  // Saved before it works on the turn: the engine may stop while it does.
  keep(sessionId);
  if (dir) appendFileSync(join(dir, "prompts.jsonl"), `${JSON.stringify({ role: session.role, session: sessionId, text })}\n`);
  const say = (line: string) => send(client, sessionId, { sessionUpdate: "plan", entries: [{ content: line, status: "in_progress", priority: "medium" }] });
  const learned = scenario().learnings === "tester"
    ? (session.role === "tester" ? ["Check the welcome page from the guest view."] : [])
    : scenario().learnings ? (session.role === "builder" ? ["Run the tests with bun test: they take a second.", "Greetings live at the repository root."] : session.role === "code reviewer" ? [scenario().reviewTodo ? "Check the greeting from the guest view." : "Greetings live at the repository root!"] : []) : [];
  const plan = scenario();
  if (plan.failure?.role === session.role) throw acp.RequestError.internalError({ message: plan.failure.message, http_status: plan.failure.httpStatus });
  if (plan.liveMessageRoles?.includes(session.role) && dir) {
    await send(client, sessionId, { sessionUpdate: "agent_message_chunk", messageId: "opening", content: { type: "text", text: "I'm checking " } });
    await send(client, sessionId, { sessionUpdate: "agent_message_chunk", messageId: "opening", content: { type: "text", text: "the nearby cases." } });
    await send(client, sessionId, { sessionUpdate: "agent_message_chunk", messageId: "progress", content: { type: "text", text: "I'm tracing the shared flow." } });
    await send(client, sessionId, { sessionUpdate: "tool_call", toolCallId: "progress-read", kind: "read", status: "completed", title: "Read" });
    mark(`public-update-${session.role.replaceAll(" ", "-")}-${sessionId}`);
    while (!existsSync(join(dir, "public-update-release"))) await Bun.sleep(20);
    await send(client, sessionId, { sessionUpdate: "agent_message_chunk", messageId: "result", content: { type: "text", text: "The change is ready.\n" } });
  }
  const done = (value: unknown, prose?: string): Reply => {
    const ids = plan.affectedProducts;
    if (ids && value && typeof value === "object") {
      const report = value as { findings?: Record<string, unknown>[]; checks?: Record<string, unknown>[] };
      if (report.findings) {
        report.findings = report.findings.map((finding) => ({ ...finding, productIds: ids }));
        if (plan.unassignedFinding && report.findings.some((finding) => finding.severity === "important")) report.findings.push({ text: "The shared ownership needs a coordinator decision.", severity: "important" });
      }
      if (report.checks && session.role === "tester") report.checks = report.checks.map((check) => ({ ...check, productIds: ids, ...(typeof check.pass === "boolean" ? { result: check.pass ? "pass" : "fail", pass: undefined } : {}) }));
    }
    let result = learned.length && value && typeof value === "object" && !("needsInput" in value) ? { ...value, learnings: learned } : value;
    if (plan.pictures && ["builder", "code reviewer", "security reviewer", "ux designer", "tester"].includes(session.role) && session.captures && dir) {
      writeFileSync(join(session.captures, "chosen.png"), readFileSync(join(dir, "picture.png")));
      writeFileSync(join(session.captures, "unchosen.png"), readFileSync(join(dir, "picture.png")));
      const path = plan.pictures === "repair" && session.turns === 1 ? join(dir, "picture.png") : "chosen.png";
      result = { ...result as object, images: [{ path, caption: `${session.role} checked the page` }] };
    }
    return { text: block(result, prose) };
  };
  if (text.includes("Which older reports are the same bug")) {
    const keys = [...text.matchAll(/^- Report \[([^\]]+)\]/gm)].map((match) => match[1]!);
    if (plan.followUpMatch === "same") return done({ groups: [{ keys }], uncertain: [] });
    if (plan.followUpMatch === "unsure") return done({ groups: [], uncertain: keys });
    return { text: "could not tell" };
  }
  for (const report of plan.usage ?? []) if (report.model === session.model) await send(client, sessionId, usageUpdate(report.status, report.type ?? "seven_day", report.utilization, report.resetsAt, report.overage));
  const limit = (plan.limited ?? []).find((entry) => entry.model === session.model && (!entry.role || entry.role === session.role) && (!entry.onScreen || text.includes("You may now use the screen for")));
  const until = limit && outOfUsage(limit);
  if (limit && until && !limit.afterRelease) await runOut(limit, until, session, sessionId, client);
  if (plan.reviewTodo && dir && ["code reviewer", "security reviewer", "verifier"].includes(session.role)) {
    const tag = `${session.role.replaceAll(" ", "-")}-${session.model}-${session.effort}`;
    const gate = async (name: string) => { while (!existsSync(join(dir, `${name}-${tag}`))) await Bun.sleep(20); };
    if (session.turns === 1) {
      const attemptFile = join(dir, `summary-attempt-${tag}`);
      const attempt = existsSync(attemptFile) ? Number(readFileSync(attemptFile, "utf8")) + 1 : 1;
      writeFileSync(attemptFile, String(attempt));
      mark(`summary-ready-${tag}-${attempt}`);
      await gate(`publish-${attempt}`);
      await say(session.role === "verifier" ? "Checking the reported problem" : session.role === "security reviewer" ? "Checking access to the greeting" : "Checking the greeting");
      await gate(`action-${attempt}`);
      await send(client, sessionId, { sessionUpdate: "tool_call", toolCallId: "summary-read", kind: "read", status: "completed", title: "Read" });
      mark(`summary-action-${tag}-${attempt}`);
      await gate(`result-${attempt}`);
      if (existsSync(join(dir, `ask-question-${tag}`))) return done({ needsInput: { question: "Should I check the guest view?", options: ["Yes"] } });
      if (existsSync(join(dir, `ask-permission-${tag}`))) {
        const count = existsSync(join(dir, `ask-permission-twice-${tag}`)) ? 2 : 1;
        await Promise.all(Array.from({ length: count }, (_, index) => client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: `summary-permission-${index}`, title: index ? "Check the signed-in view" : "Check the guest view", kind: "execute", status: "pending" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
        })));
      }
    } else {
      // The question's next turn still uses the original review instructions and finding ids.
      const original = session.history.find((entry) => entry.sessionUpdate === "user_message_chunk" && entry.content.type === "text");
      if (original?.sessionUpdate === "user_message_chunk" && original.content.type === "text") text = `${original.content.text}\n${text}`;
    }
    await gate("finish");
  }
  if (plan.controlled && session.turns === 1 && dir) {
    await say(`${session.role} is working`);
    while (!existsSync(join(dir, `release-${sessionId}`))) await Bun.sleep(20);
  }
  if (limit?.afterRelease && until) await runOut(limit, until, session, sessionId, client);
  if (plan.screenRoles?.includes(session.role) && (!plan.screenModels || plan.screenModels.includes(session.model ?? ""))) {
    if (text.includes("You may now use the screen for")) {
      mark(`on-screen-${sessionId}`);
      if (plan.screenRoleHold && dir) while (!existsSync(join(dir, `screen-release-${sessionId}`))) await Bun.sleep(20);
      // Like a real reopened conversation, the fake still knows the original job and finding ids.
      const first = session.history.find((update) => update.sessionUpdate === "user_message_chunk");
      if (first?.sessionUpdate === "user_message_chunk" && first.content.type === "text") text = `${first.content.text}\n${text}`;
    } else if (roleOf(text)) {
      await say("Finished the background checks");
      return done({ needsScreen: { reason: SCREEN_REASON } });
    }
    if (text.includes("handed it back")) {
      const first = session.history.find((update) => update.sessionUpdate === "user_message_chunk");
      if (first?.sessionUpdate === "user_message_chunk" && first.content.type === "text") text = `${first.content.text}\n${text}`;
    }
  }
  if (plan.reviewConfirmation?.role === session.role) {
    const original = session.history.find((entry) => entry.sessionUpdate === "user_message_chunk" && entry.content.type === "text");
    const opening = original?.sessionUpdate === "user_message_chunk" && original.content.type === "text" ? original.content.text : text;
    const earlier = section(opening, "Findings so far (confirm or dispute by id)") ?? "";
    if (earlier.includes("(fixed)")) {
      const correction = text.includes("Your result block could not be used");
      const ids = findingIds(opening, "Findings so far (confirm or dispute by id)");
      if (plan.reviewConfirmation.duplicate) return done({ verdict: "fail", confirms: [], disputes: [], findings: [{ text: "The GREETING is missing on the welcome page!", severity: "important", ...(correction ? { evidence: plan.reopenedEvidence } : {}) }] });
      const confirms = !correction ? ids : plan.reviewConfirmation.correction === "omit" ? [] : ids.map((id) => ({ id, evidence: plan.reopenedEvidence ?? "On current code, the guest welcome page still omits the greeting; the signed-in control shows it." }));
      return done({ verdict: confirms.length ? "fail" : "pass", findings: [], confirms, disputes: [] });
    }
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
      if (plan.planner === "research-first") return done({
        rationale: "Research it, build it, then review it.",
        stages: [
          { kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] },
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
        ],
      });
      if (plan.planner === "tester-first")
        return done({
          rationale: "Build it, try it, then two reviewers.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] },
            { kind: "do", title: "Try it like a user", roleId: "tester", profileIds: ["opus-high"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-xhigh", "sol-xhigh"], maxRounds: 2 },
          ],
        });
      if (plan.planner === "mixed-review") return done({
        rationale: "Build it, then a code reviewer and the added Security specialist review it together.",
        stages: [
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], roleIds: ["code-reviewer", addedId(text, "Security specialist")], maxRounds: 2 },
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
      if (plan.planner === "pair")
        return done({
          rationale: "Build it, then two reviewers at once, one on each tool.",
          ...riskOf(plan),
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 1 },
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
      if (plan.planner === "build-review")
        return done({
          rationale: "Build it, then two reviewers.",
          ...riskOf(plan),
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 1 },
          ],
        });
      if (plan.planner === "source-brief")
        return done({
          rationale: "Build it, then a review with the security reviewer.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], roleIds: ["code-reviewer", addedId(text, "Security specialist")], maxRounds: 1 },
          ],
        });
      if (plan.planner === "source-roles")
        return done({
          rationale: "Build it, then the copywriter, a review with the security reviewer, and a fact check.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], roleIds: ["code-reviewer", addedId(text, "Security specialist")], maxRounds: 1 },
            { kind: "do", title: "Copy", roleId: addedId(text, "Copywriter"), profileIds: ["opus-high"] },
            { kind: "do", title: "Fact check", roleId: addedId(text, "Fact checker"), profileIds: ["opus-high"] },
          ],
        });
      if (plan.planner === "roles")
        return done({
          rationale: "Research, a design, a build, then a review with the security reviewer you added.",
          ...riskOf(plan),
          stages: [
            { kind: "do", title: "Research", roleId: "researcher", profileIds: ["sol-high"] },
            { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
            check,
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], roleIds: ["code-reviewer", addedId(text, "Security specialist")], maxRounds: 2 },
            { kind: "do", title: "Copy", roleId: addedId(text, "Copywriter"), profileIds: ["opus-high"] },
            { kind: "do", title: "Fact check", roleId: addedId(text, "Fact checker"), profileIds: ["opus-high"] },
          ],
        });
      if (plan.planner === "copy")
        return done({
          rationale: "Build it, then the copywriter you added, then one reviewer.",
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "do", title: "Copy", roleId: addedId(text, "Copywriter"), profileIds: ["opus-high"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
          ],
        });
      if (plan.planner === "short" || plan.planner === "parallel")
        return done({
          rationale: "A small change: build it, one reviewer.",
          ...riskOf(plan),
          stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: plan.planner === "parallel" ? ["opus-high", "sol-high"] : ["opus-high"], maxRounds: plan.reviewRounds ?? 1 },
          ],
        });
      return done({
        rationale: "A small feature: agree on a design, build it, two reviewers.",
        ...riskOf(plan),
        stages: [
          { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
          ...(text.includes("[no-check]") ? [] : text.includes("[screens]") ? [screens, check] : text.includes("[two-checks]") ? [check, screens, check] : [check]),
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          ...(plan.planner === "tester-with-design" ? [{ kind: "do", title: "Try acceptance", roleId: "tester", profileIds: ["opus-high"] }] : []),
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: plan.reviewRounds ?? 2 },
        ],
      });
    case "architect": {
      const revised = plan.reviseBrief && session.history.some((entry) => entry.sessionUpdate === "user_message_chunk" && entry.content.type === "text" && entry.content.text.includes("## Objections so far"));
      const brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: [revised ? "Greeting, visible to everyone after the review" : "Greeting"], acceptance: ["A greeting file exists"], risks: [] };
      if (handedBack) return done({ ...brief, answers: [] }, terminal);
      // Asked again for objections it left out: answer those in its own name.
      if (text.includes("Your result block could not be used")) {
        return done({ ...brief, answers: objectionIds(text).map((id) => ({ id, status: "accepted", byCall: false, answer: "Added it to the brief." })) });
      }
      const call = section(text, "The coordinator's call (final, exact words)");
      const settled = section(text, "Objections answered after the call (answer every one again by id)");
      if (plan.architect === "writes") writeFileSync(join(session.cwd, "architecture.txt"), call === undefined ? "Before the design review" : settled === undefined ? "After the coordinator's call" : "After the design check");
      if (call !== undefined && settled !== undefined) {
        // Changes asked for at the check: the note says the call was misread, so the first answer loses its
        // "Your call" tag and the others get it. Every note is rewritten to match the updated brief.
        const ids = objectionIds(settled);
        const answers = ids.map((id, index) => (index === 0 ? { id, status: "accepted", byCall: false, answer: "Kept it in the brief after your note." } : { id, status: "accepted", byCall: true, answer: "Added it to the brief, as the call says." }));
        return done({ ...brief, answers }, `Revising: ${ids.join(", ")}. Latest note: - ${section(text, NOTES)?.split("\n").at(-1) ?? "none"}`);
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
      if (plan.screen) {
        if (text.includes("You may now use the screen for")) {
          mark(`on-screen-${sessionId}`);
          if (plan.screen === "hold" && dir) while (!existsSync(join(dir, `screen-release-${sessionId}`))) await Bun.sleep(20);
          writeFileSync(join(session.cwd, "greeting.txt"), "Hello\n");
          return done({ summary: "Added a quick note window and checked it on screen.", changes: ["A quick note window"], tests: "Clicked through it on screen" });
        }
        if (roleOf(text)) {
          writeFileSync(join(session.cwd, "notes.txt"), "A first draft\n");
          await say("Checking the window offscreen");
          if (plan.screenLate && dir) while (!existsSync(join(dir, `screen-ask-${sessionId}`))) await Bun.sleep(20);
          return done({ needsScreen: { reason: SCREEN_REASON } }, "Everything else is done in the background.");
        }
        return done({ summary: "Took your message into account.", changes: [], tests: "1 passed" });
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
      if (plan.builder === "todo" && dir) {
        const waitFor = async (name: string) => {
          while (!existsSync(join(dir, name))) await Bun.sleep(20);
        };
        const tool = (id: string, update: Record<string, unknown>) => send(client, sessionId, { sessionUpdate: "tool_call", toolCallId: `${id}-${session.turns}`, status: "completed", ...update } as acp.SessionNotification["update"]);
        if (restarted) {
          mark("builder-back");
          await waitFor("go-todo");
          await say("Finishing the greeting");
          mark("builder-renamed");
          await waitFor("go-finish");
        } else if (!existsSync(join(dir, "builder-todo"))) {
          // Formatting marks, two items in progress (the first one counts) and tool activity under it.
          await send(client, sessionId, {
            sessionUpdate: "plan",
            entries: [
              { content: "- **Drafting** the `greeting` file", status: "in_progress", priority: "high" },
              { content: "Checking the greeting", status: "in_progress", priority: "medium" },
              { content: "Writing it up", status: "pending", priority: "low" },
            ],
          });
          if (plan.activity === "grok") {
            const call = (name: string, kind: string, rawInput: unknown) => tool(name, { title: name, rawInput, _meta: { "x.ai/tool": { version: 1, name, kind, namespace: "grok_build" } } });
            await call("grep", "search", { pattern: "greeting", glob: "*.txt" });
            await call("read_file", "read", { target_file: join(session.cwd, "notes.txt") });
            await call("run_terminal_command", "execute", { command: "bun test" });
            await call("todo_write", "plan", { todos: [] });
            await call("run_terminal_command", "execute", { command: "ls -la" });
          } else {
            await tool("edit", { title: "Edit notes.txt", kind: "edit", locations: [{ path: join(session.cwd, "notes.txt") }] });
            await tool("read", { title: "ls", kind: "execute", rawInput: { command: "ls -la" } });
          }
          // Nothing in progress any more: the last item stays.
          await send(client, sessionId, {
            sessionUpdate: "plan",
            entries: [
              { content: "Drafting the greeting file", status: "completed", priority: "high" },
              { content: "Checking the greeting", status: "completed", priority: "medium" },
            ],
          });
          await Bun.sleep(50);
          return hang(sessionId, "builder-todo");
        }
        writeFileSync(join(session.cwd, "greeting.txt"), "Hello\n");
        return done({ summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(text) });
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
      const setup = readScript();
      const named = /^# The task: (.+)$/m.exec(text)?.[1];
      if (setup.installs) installs(session.cwd, setup.installs.cache);
      if (setup.locked && named === setup.locked) {
        mkdirSync(join(session.cwd, "target", "locked"), { recursive: true });
        writeFileSync(join(session.cwd, "target", "locked", "output.bin"), "in use\n");
        chmodSync(join(session.cwd, "target", "locked"), 0o555);
      }
      if (setup.background && named === setup.background.title) backgroundBuild(session.cwd, setup.background.pids);
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
        execFileSync("git", ["add", "-A"], { cwd: session.cwd, env: testGitEnv() });
        execFileSync("git", ["-c", "user.email=fake@example.com", "-c", "user.name=Fake", "commit", "-q", "-m", "Builder's own commit"], { cwd: session.cwd, env: testGitEnv() });
        execFileSync("git", ["-c", "user.email=fake@example.com", "-c", "user.name=Fake", "merge", "-q", "--no-edit", "main"], { cwd: session.cwd, env: testGitEnv() });
      }
      const script = readScript();
      const taskTitle = /^# The task: (.+)$/m.exec(text)?.[1];
      if (script.ownFiles && taskTitle) writeFileSync(join(session.cwd, `${taskTitle.toLowerCase().replace(/\W+/g, "-")}.txt`), `${taskTitle}\n`);
      await held("builder", text);
      if (script.envOut) {
        let helper = "(none)";
        try {
          helper = execFileSync("git", ["config", "--get-all", "credential.helper"], { cwd: session.cwd, env: testGitEnv() }).toString();
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
      if (plan.reviewer === "confirm-dismissed") {
        const original = session.history.find((entry) => entry.sessionUpdate === "user_message_chunk" && entry.content.type === "text");
        const opening = original?.sessionUpdate === "user_message_chunk" && original.content.type === "text" ? original.content.text : text;
        const ids = session.model === "opus" ? [] : findingIds(opening, "Findings so far (confirm or dispute by id)");
        const confirms = text.startsWith("Your result block could not be used") ? ids.map((id) => ({ id, evidence: plan.reopenedEvidence })) : ids;
        return done({ verdict: ids.length ? "fail" : "pass", findings: [], confirms, disputes: [] });
      }
      if (plan.reviewer === "confirm") return done({ verdict: text.includes("This is review round") ? "pass" : "fail", findings: [], confirms: text.includes("This is review round") ? [] : findingIds(text, "Findings so far (confirm or dispute by id)"), disputes: [] });
      if (handedBack) return done({ verdict: "pass", findings: [], confirms: [], disputes: [] }, terminal);
      if (plan.reviewer === "question" && session.model === "opus" && (session.turns === 1 || (text.includes("You may now use the screen for") && !text.includes("The coordinator answered")))) return done({ needsInput: { question: "Should the window keep its size?", options: ["Yes", "No"] } });
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
      if (plan.reviewer === "confirm-fixed" && text.includes("This is review round")) return done({ verdict: "fail", findings: [], confirms: findingIds(text, "Findings so far (confirm or dispute by id)").map((id) => ({ id, evidence: plan.reopenedEvidence ?? "On current code, the guest welcome page still omits the greeting; the signed-in control shows it." })), disputes: [] });
      if (plan.reviewer === "confirm-fixed-one-tool" && text.includes("This is review round")) return done({ verdict: session.model === "opus" ? "fail" : "pass", findings: [], confirms: session.model === "opus" ? findingIds(text, "Findings so far (confirm or dispute by id)").map((id) => ({ id, evidence: plan.reopenedEvidence ?? "On current code, the guest welcome page still omits the greeting; the signed-in control shows it." })) : [], disputes: [] });
      if ((plan.reviewer === "important" || plan.reviewer === "important-twice" || plan.reviewer === "confirm-fixed" || plan.reviewer === "confirm-fixed-one-tool") && !text.includes("This is review round") && !(plan.fixes === "change" && existsSync(join(session.cwd, "welcome.txt")))) {
        const opus = session.model === "opus";
        if ((plan.reviewer === "important" || plan.reviewer === "confirm-fixed-one-tool") && !opus) return done({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit" }], confirms: [], disputes: [] });
        return done({ verdict: "fail", findings: [{ text: opus ? "The greeting is missing on the welcome page." : "The GREETING is missing on the welcome page!", where: "greeting.txt", severity: "important", evidence: "Opened the welcome page" }], confirms: [], disputes: [] });
      }
      if (tool === "claude-code") {
        // A fallback: Claude Code switches the session's model and says so with a config update.
        session.options.find((option) => option.id === "model")!.currentValue = "sonnet";
        await send(client, sessionId, { sessionUpdate: "config_option_update", configOptions: session.options } as acp.SessionNotification["update"]);
      } else if (tool === "codex") {
        await send(client, sessionId, { sessionUpdate: "notice", severity: "info", title: "Model rerouted", description: "Switched from gpt-6.1 to gpt-6.1-mini (high demand)." } as unknown as acp.SessionNotification["update"]);
      }
      return done({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit", evidence: "On the current welcome page the greeting is still terse; a warmer greeting would be friendlier." }], confirms: [], disputes: [] });
    case "security reviewer":
      return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });
    case "guide keeper":
      if (plan.guide === "broken") return { text: "I could not tell what the reviewers missed." };
      return done(
        plan.guide === "change of mind"
          ? { missed: false, line: "", why: "The note asks for a new colour: a change of mind, not a miss." }
          : { missed: true, line: "Every greeting also shows on the welcome page.", why: "The reviewers checked the greeting only where it was added." },
      );
    case "verifier": {
      const correction = plan.partialVerification && session.turns > 1 ? plan.correctPartialVerification : undefined;
      if (plan.partialVerification && session.turns > 1 && !correction) {
        if (plan.limitAfterPartial) await runOut({ model: session.model!, spendCap: true }, Date.now() + 3_600_000, session, sessionId, client);
        return hang(sessionId, "partial-verification");
      }
      if (correction) {
        const opening = session.history.flatMap((update) => update.sessionUpdate === "user_message_chunk" && update.content.type === "text" ? [update.content.text] : [])[0]!;
        return done({ verdicts: findingIds(opening, "Important findings to check (a verdict on every one, by id)").map((id, index) => {
          const verdict = index === 0 ? correction : "not-a-bug";
          return { id, verdict, reason: `After checking every finding, this one ${verdict === "real" ? "is a real problem" : "is not a bug"}.` };
        }) });
      }
      let notABug = plan.verifier === "not-a-bug";
      if (plan.verifier === "split" && dir) {
        // An atomic claim keeps the two replies different even when both run on the same model.
        try { writeFileSync(join(dir, "first-vote"), sessionId, { flag: "wx" }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          notABug = true;
        }
      }
      if (plan.verifier === "hold" && dir) {
        mark("verifier-voting");
        while (!existsSync(join(dir, "release-vote"))) await Bun.sleep(20);
      }
      const ids = findingIds(text, "Important findings to check (a verdict on every one, by id)");
      const verdict = plan.verifierByModel?.[session.model ?? ""] ?? (plan.verifier === "after-fix-not-a-bug" ? (text.includes("  The builder: fixed.") ? "not-a-bug" : "real") : plan.verifier === "split" ? (notABug ? "not-a-bug" : "real") : plan.verifier === "hold" ? "real" : plan.verifier) ?? "real";
      return done({
        verdicts: (plan.partialVerification ? ids.slice(0, 1) : ids).map((id) => ({
          id,
          verdict,
          reason: verdict === "not-a-bug" ? "The welcome page shows the greeting already." : "The welcome page has no greeting: confirmed by opening it.",
        })),
      });
    }
    case "tester":
      if (plan.tester === "no-evidence") return done({ summary: "It looks fine.", checks: [{ text: "A greeting file exists", result: "pass" }] });
      if (plan.tester === "omit-once" && !marked("tester-omitted")) {
        mark("tester-omitted");
        return done({ summary: "It looks fine.", checks: [] });
      }
      if (handedBack) return done({ summary: "Tried it after the hand back.", checks: [] }, terminal);
      if (plan.tester === "writes") {
        const final = marked("tester-passed-once");
        writeFileSync(join(session.cwd, "tester-edit.txt"), final ? "After the review\n" : "Before the review\n");
        if (final) {
          run(session.cwd, "add", "tester-edit.txt");
          run(session.cwd, "commit", "--quiet", "-m", "Tester commits after the review");
        }
      }
      if (plan.tester === "work" && !marked("tester-worked")) {
        mark("tester-worked");
        await say("Trying it out");
        return hang(sessionId, "tester-working");
      }
      // "fail-once": the second tester pass (the one on the final code) fails an acceptance item, once.
      if (plan.tester === "blocked") return done({ summary: "I could not open the live session because its account limit is exhausted.", checks: [{ text: "A greeting file exists", result: "blocked", reason: "The Claude Code weekly limit prevents opening a live session." }] });
      if (plan.tester === "always-fail") return done({ summary: "The greeting still does not appear.", checks: [{ text: "A greeting file exists", pass: false, evidence: "The scripted guest welcome page has no greeting; expected the greeting to be visible." }] });
      if (plan.tester === "fail-once" && marked("tester-passed-once") && !marked("tester-failed-once")) {
        mark("tester-failed-once");
        return done({ summary: "Tried it: the greeting is missing on the welcome page.", checks: [{ text: "A greeting file exists", pass: false, evidence: "The scripted guest welcome page has no greeting; expected the greeting to be visible." }] });
      }
      mark("tester-passed-once");
      return done({ summary: "Tried it: it works.", checks: [{ text: "A greeting file exists", pass: true, evidence: "The scripted greeting check returned the expected result." }] });
    case "release manager": {
      if (plan.releaseManager === "hang" && !marked("release-manager-started")) return hang(sessionId, "release-manager-started");
      await say("Writing the release notes");
      await held("release manager", text);
      return { text: releaseManager(session.cwd, text) };
    }
    default: {
      // Source-start tests only need the added reviewer to see the brief. Blocking would open a vote and a fix round.
      if (plan.addedReviewer === "pass" && roleOf(text) === "security specialist") return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });
      // A reviewer the coordinator added answers in the review's shape: it blocks once, then passes.
      // The first time, it disputes the code reviewer's suggestion without a reason, then gives one when Petrina refuses that.
      const blocks = { verdict: "fail", findings: [{ text: SECURITY_FINDING, where: "greeting.txt:1", severity: "important", evidence: "Nothing limits it." }], confirms: [] };
      const disputed = undisputed.get(sessionId);
      if (disputed && text.includes("Your result block could not be used")) {
        undisputed.delete(sessionId);
        return done({ ...blocks, disputes: disputed === "a-finding-that-is-not-listed" ? [] : [{ id: disputed, reason: DISPUTE_REASON }] });
      }
      if (text.includes('"verdict": "pass"')) {
        if (text.includes(SECURITY_FINDING)) return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });
        const suggestion = /^- \[([^\]]+)\] nit \(open\): Consider a friendlier greeting\./m.exec(text)?.[1];
        const disputedId = suggestion ?? "a-finding-that-is-not-listed";
        undisputed.set(sessionId, disputedId);
        return done({ ...blocks, disputes: [disputedId] });
      }
      if (plan.notes === "work" && session.role !== "researcher" && session.restarts < 1) {
        if (roleOf(text)) writeFileSync(join(session.cwd, `${slug(session.role)}.txt`), "A first draft\n");
        await say("Drafting");
        return hang(sessionId, `working-${slug(session.role)}`);
      }
      if (text.includes("[roles]") && session.role !== "researcher" && roleOf(text)) {
        // Notes roles the coordinator added write a file. A read-only one commits it too, which Petrina undoes.
        const name = slug(session.role);
        const held = dir && join(dir, `hold-${name}`);
        if (held && existsSync(held)) {
          mark(`working-${name}`);
          while (existsSync(held)) await Bun.sleep(50);
        }
        const readOnly = text.includes("you are read-only") || text.includes("You are read-only");
        writeFileSync(join(session.cwd, `${name}.txt`), `Written while ${readOnly ? "read-only" : "changing the product"}\n`);
        if (readOnly) {
          run(session.cwd, "add", `${name}.txt`);
          run(session.cwd, "commit", "--quiet", "-m", `${session.role} commits anyway`);
        }
      }
      return done({ summary: `Notes from the ${session.role}.`, notes: [`A note from the ${session.role}`] });
    }
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
  if (tool === "grok") {
    const counts = { inputTokens: 1100, outputTokens: 50, cachedReadTokens: 1000, cacheCreationTokens: 0, reasoningTokens: 20, totalTokens: 1150 };
    return { stopReason, _meta: { totalTokens: 50000, inputTokens: 100, outputTokens: 5, usage: { ...counts, modelUsage: { "grok-4.7-build": counts } } } };
  }
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
    const holdOpen = process.argv.find((arg) => arg.startsWith("--hold-open="))?.slice("--hold-open=".length);
    if (holdOpen) {
      writeFileSync(`${holdOpen}.reached`, "");
      while (existsSync(holdOpen)) await Bun.sleep(20);
    }
    const sessionId = crypto.randomUUID();
    refuseSandbox(sessionId, "new", ctx.params._meta);
    sessions.set(sessionId, { cwd: ctx.params.cwd, role: "", model: "default", effort: "high", turns: 0, restarts: 0, history: [], options: configOptions() });
    keep(sessionId);
    opened(sessionId, "new", ctx.params._meta);
    return { sessionId, configOptions: sessions.get(sessionId)!.options };
  })
  .onRequest("session/resume", async (ctx) => {
    // A tool that never answers: Petrina gives up and starts a fresh conversation.
    if (scenario().reopen === "stall") await new Promise(() => undefined);
    return { configOptions: reopen(ctx.params.sessionId, "resume", ctx.params._meta).options };
  })
  .onRequest("session/load", async (ctx) => {
    const conversation = reopen(ctx.params.sessionId, "load", ctx.params._meta);
    // Load streams the whole conversation back before it answers.
    for (const update of conversation.history) await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
    return { configOptions: conversation.options };
  })
  .onRequest("session/set_config_option", (ctx) => {
    const session = sessions.get(ctx.params.sessionId)!;
    if (ctx.params.configId === "model") session.model = String(ctx.params.value);
    if (["effort", "reasoning_effort", "thinking_level"].includes(ctx.params.configId)) session.effort = String(ctx.params.value);
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
    // Like Google's native slash command: handled locally, never an AI prompt or turn.
    if (text === "/usage") {
      if (process.argv.includes("--usage-hang")) await new Promise(() => undefined);
      const turns = sessions.get(sessionId)!.turns;
      const argonReset = new Date(Date.now() + 7 * 86_400_000).toUTCString();
      if (dir) appendFileSync(join(dir, "native-usage.jsonl"), `${JSON.stringify({ sessionId, pid: process.pid })}\n`);
      const value = `### Session Usage\n- **Session total:** ${turns * 110} tokens (prompt: ${turns * 100}, completion: ${turns * 10})\n\n### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 81% remaining (resets Oct 26, 2026, 16:50 UTC)\n  - **Five Hour Limit Remaining:** 60% remaining (resets Oct 19, 2026, 21:50 UTC)\n- **Gemini 4 Argon**\n  - **Gemini 4 Argon Weekly Limit:** ${process.argv.includes("--argon-empty") ? 0 : 98}% remaining (resets ${argonReset})`;
      await ctx.client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } });
      return { stopReason: "end_turn" };
    }
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
