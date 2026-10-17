// A scripted ACP agent for tests. It reads which role it is from the prompt and answers
// like that role would, so the engine can be tested end to end without spending tokens.
//
// bun fake-agent.ts [dir]: with a dir (the restart tests), it records every prompt it gets in
// dir/prompts.jsonl, keeps its conversations in dir/conversations so the next engine can reopen
// them, notes how each was opened in dir/opens.jsonl and every setting it was given in
// dir/config.jsonl, follows dir/scenario.json, and drops marker files there at the moments a test
// waits for. With "--script=<file>", the shipper follows the ShipperScript in that file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /**
   * "important": in the first round the reviewer on Opus raises one Important finding, the others a nit.
   * "important-twice": every reviewer raises it, each in its own words. Later rounds pass.
   */
  reviewer?: "commit" | "work" | "important" | "important-twice" | "move-branch";
  /** "change of mind": the Guide keeper finds the coordinator's note was not a miss. */
  guide?: "change of mind";
  /** How the planner rates the task's risk (unrated by default). */
  risk?: "low" | "high";
  /** The verifier's verdict on every finding it is given (default "real"). */
  verifier?: "real" | "not-a-bug";
  /** "work": the first tester works until the coordinator takes over and hands back; later ones pass. */
  tester?: "work";
  /** "hang": the first shipper works until cancelled. Later ones get it ready as usual. */
  shipper?: "hang";
  /**
   * How it reopens a conversation: "resume" (it offers load too), "load" (it replays the conversation
   * first), or "stall" (it offers resume and never answers). Unset: it cannot reopen conversations.
   */
  reopen?: "resume" | "load" | "stall";
  /** What the Check finder hands back: a passing check (default), a failing one, one that changes a tracked file, or one that commits. */
  checks?: "pass" | "fail" | "writes" | "commits";
  /** "work" builder: how many restarts it works through before it finishes (default 1). */
  restarts?: number;
  /** "change": fixing review findings changes the code (by default the fix leaves it as it was). */
  fixes?: "change";
  /** The first build writes a name the repository's pre-commit hook blocks; fixing removes it. */
  leak?: boolean;
  /** The builder's commit title. */
  title?: string;
  /** The builder and the code reviewers pass on what they learned about the repository (one lesson twice). */
  learnings?: boolean;
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
}

// Scenarios ride in the task description: "[disagree]" makes the design reviewer object every round,
// "[no-check]" leaves the design check out of the plan, "[screens]" puts Screens between the design and
// its check, and "[two-checks]" adds Screens and a second design check after the first. "[quick]" plans just a
// build and one review. With "--hold=<file>", the architect stops halfway through following a call for as long
// as that file exists.
const dir = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
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
const scriptPath = process.argv.find((arg) => arg.startsWith("--script="))?.slice("--script=".length);

/** What the shipper (and, for a submodule, the builder) does, read before every run and counted down as it goes. */
export interface ShipperScript {
  /** Hand back "failed" the next N times. */
  fail?: number;
  /** Leave a file behind the next N times, so Petrina sends the handoff back. */
  leftover?: number;
  /** Once: commit a file for a pull request, which needs only its text. */
  commit?: boolean;
  /** Right after getting it ready, move the default branch in this git folder the next N times, like a teammate. */
  moveMain?: { times: number; gitDir: string };
  /** Right after getting it ready, once: a teammate publishes this release (main moves, the tag and release appear). */
  releaseMeanwhile?: { gitDir: string; ghState: string; tag: string };
  /** Once: get it ready on a side branch, or on no branch, and hand that back; the task branch stays behind until Petrina sends it back. */
  offBranch?: "side" | "detached";
  /** Version files left out of the version change until Petrina sends the handoff back. */
  forgetVersionIn?: string[];
  /** What Petrina said when it last sent a handoff back. */
  sentBack?: string;
  /** For the task with this title, the shipper waits while `file` exists (`file`.reached once waiting). */
  hold?: { title: string; file: string };
  /** The builder points this submodule at this commit, in its work. */
  gitlink?: { path: string; sha: string };
  title?: string;
  body?: string;
  notes?: string;
  /** Write the logins the shipper could see here. */
  envOut?: string;
  /** How many times a shipper started. */
  runs?: number;
}

const readScript = (): ShipperScript => (scriptPath && existsSync(scriptPath) ? (JSON.parse(readFileSync(scriptPath, "utf8")) as ShipperScript) : {});

/** A teammate's empty commit on main: main moves, its files stay the same. */
function teammate(gitDir: string): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: "Teammate", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Teammate", GIT_COMMITTER_EMAIL: "t@example.com" };
  const moved = execFileSync("git", ["--git-dir", gitDir, "commit-tree", "main^{tree}", "-p", "main", "-m", "A teammate's change"], { env }).toString().trim();
  execFileSync("git", ["--git-dir", gitDir, "update-ref", "refs/heads/main", moved]);
  return moved;
}

/** The last handoff in this conversation, handed back again after cleaning up. */
const last: { branch?: string; extra?: Record<string, string> } = {};

/** Set the version in the project's JSON version files, but not in `except`. True when one changed. */
function setVersion(cwd: string, version: string, except: readonly string[] = []): boolean {
  let changed = false;
  for (const file of run(cwd, "ls-files").split("\n")) {
    // Like the instructions say: not in dependencies or test fixtures.
    if (!/(^|\/)(package|tauri\.conf)\.json$/.test(file) || /(^|\/)(node_modules|fixtures)\//.test(file) || except.includes(file)) continue;
    const json = JSON.parse(readFileSync(join(cwd, file), "utf8"));
    if (typeof json.version !== "string" || json.version === version) continue;
    writeFileSync(join(cwd, file), `${JSON.stringify({ ...json, version }, null, 2)}\n`);
    changed = true;
  }
  return changed;
}

/** The shipper gets the delivery ready: the text, and for a release the version commit. Petrina publishes. */
function shipper(cwd: string, text: string): string {
  const script = readScript();
  const save = () => scriptPath && writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  if (text.includes("Your result block could not be used")) {
    script.sentBack = text;
    save();
    // Sent back: back on the task branch, clean up what was left behind, finish the version change, and hand back again.
    if (last.branch && run(cwd, "rev-parse", "--abbrev-ref", "HEAD") !== last.branch) {
      const prepared = run(cwd, "rev-parse", "HEAD");
      run(cwd, "switch", "--quiet", last.branch);
      run(cwd, "merge", "--quiet", "--ff-only", prepared);
    }
    const reset = /git reset --hard ([0-9a-f]{40})/.exec(text)?.[1];
    if (reset) run(cwd, "reset", "--quiet", "--hard", reset);
    rmSync(join(cwd, "test-output.log"), { force: true });
    const version = last.extra?.version;
    if (version && setVersion(cwd, version)) run(cwd, "commit", "--quiet", "--amend", "--no-edit", "-a");
    return block({ status: "ready", summary: "Cleaned up.", ...(version ? { tested: run(cwd, "rev-parse", "HEAD") } : {}), ...last.extra });
  }
  script.runs = (script.runs ?? 0) + 1;
  if (script.envOut) {
    let helper = "(none)";
    try {
      helper = execFileSync("git", ["config", "--get-all", "credential.helper"], { cwd }).toString();
    } catch {}
    const names = ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_PROFILE", "GH_CONFIG_DIR", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "GH_PROMPT_DISABLED", "BROWSER", "PETRINA_AGENT"];
    writeFileSync(script.envOut, JSON.stringify({ ...Object.fromEntries(names.map((name) => [name, process.env[name]])), helper }));
  }
  const version = /Set the version to (\d+\.\d+\.\d+) in the product's main version files/.exec(text)?.[1];
  last.branch = run(cwd, "symbolic-ref", "--short", "HEAD");
  if (script.offBranch) {
    run(cwd, "switch", "--quiet", ...(script.offBranch === "side" ? ["-c", "getting-ready"] : ["--detach"]));
    delete script.offBranch;
  }
  if (script.fail) {
    script.fail -= 1;
    save();
    return block({ status: "failed", summary: "The release notes could not be written." });
  }
  if (version && setVersion(cwd, version, script.forgetVersionIn)) run(cwd, "commit", "--quiet", "-am", `Version ${version}`);
  if (script.moveMain?.times) {
    script.moveMain.times -= 1;
    teammate(script.moveMain.gitDir);
  }
  if (script.releaseMeanwhile) {
    const { gitDir, ghState, tag } = script.releaseMeanwhile;
    delete script.releaseMeanwhile;
    const moved = teammate(gitDir);
    execFileSync("git", ["--git-dir", gitDir, "update-ref", `refs/tags/${tag}`, moved]);
    const github = JSON.parse(readFileSync(ghState, "utf8"));
    github.releases.push({ tagName: tag, url: `https://github.com/${github.repo}/releases/tag/${tag}`, publishedAt: new Date().toISOString(), isDraft: false, name: tag, body: "A teammate's release." });
    writeFileSync(ghState, JSON.stringify(github, null, 2));
  }
  if (script.leftover) {
    script.leftover -= 1;
    writeFileSync(join(cwd, "test-output.log"), "12 passed\n");
  }
  if (script.commit && !version) {
    delete script.commit;
    writeFileSync(join(cwd, "extra.txt"), "Not for a pull request\n");
    run(cwd, "add", "extra.txt");
    run(cwd, "commit", "--quiet", "-m", "Something extra");
  }
  save();
  last.extra = version ? { version, notes: script.notes ?? "People see a greeting." } : { title: script.title ?? "Add a greeting", body: script.body ?? "People see a greeting." };
  return block({ status: "ready", summary: "Got it ready.", ...(version ? { tested: run(cwd, "rev-parse", "HEAD") } : {}), ...last.extra });
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
      return done({ ...brief, answers: [] });
    }
    case "check finder":
      return done({
        summary: "Checked with git, which every test machine has.",
        checks:
          plan.checks === "fail"
            ? [{ name: "Tests", argv: ["git", "no-such-subcommand-petrina"], why: "A check that fails, for tests" }]
            : plan.checks === "writes"
              ? [{ name: "Format", argv: ["git", "mv", "README.md", "README.txt"], why: "A check that changes a tracked file, for tests" }]
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
      if (plan.fixes === "change" && text.includes("You are fixing the review findings")) writeFileSync(join(session.cwd, "welcome.txt"), "Hello\n");
      if (plan.leak && !text.includes("You are fixing the review findings")) writeFileSync(join(session.cwd, "greeting.txt"), "Hello from internal-db-07\n");
      // The work points a submodule at a commit only this computer has.
      const gitlink = readScript().gitlink;
      if (gitlink && run(session.cwd, "rev-parse", `HEAD:${gitlink.path}`) !== gitlink.sha) {
        run(session.cwd, "update-index", "--cacheinfo", `160000,${gitlink.sha},${gitlink.path}`);
        run(session.cwd, "add", "greeting.txt");
        run(session.cwd, "commit", "--quiet", "-m", "Bring the submodule up to date");
      }
      return done({ ...(plan.title ? { title: plan.title } : {}), summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(text) });
    }
    case "code reviewer":
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
    case "shipper": {
      if (plan.shipper === "hang" && !marked("shipper-started")) return hang(sessionId, "shipper-started");
      await say("Writing what goes out with it");
      const script = readScript();
      if (script.hold && text.includes(script.hold.title) && existsSync(script.hold.file)) {
        writeFileSync(`${script.hold.file}.reached`, "");
        while (existsSync(script.hold.file)) await Bun.sleep(30);
      }
      return { text: shipper(session.cwd, text) };
    }
    default:
      return done({ summary: "Nothing to do.", notes: [] });
  }
}

acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", async () => {
    const how = scenario().reopen;
    if (silent) await new Promise(() => undefined);
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
    const session = sessions.get(ctx.params.sessionId);
    if (session && ctx.params.configId === "model") session.model = String(ctx.params.value);
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
