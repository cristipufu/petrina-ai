// First run and the tools check. The engine checks the tools on this machine; the first run,
// the Library and Stuck items show the same statuses and the same fixes, kept here in one place
// so they never drift apart. Install and login commands change over time: each fix links to the
// tool's official guide.

import type { Id, InboxItem, State } from "./model.js";

/** What Petrina checks: the agent tools, the GitHub CLI, and what Petrina itself needs. */
export type CheckId = "claude-code" | "codex" | "grok" | "antigravity" | "gh" | "git" | "node";

/** The two starter tools, in the order the squad prefers them; Grok joins once its check finds it (see agentTools). */
export const AGENT_TOOLS = ["claude-code", "codex"] as const;

/**
 * - `unchecked`: no answer yet.
 * - `unknown`: the check gave no clear answer in time ("Couldn't check"). Petrina still tries the tool.
 */
export type CheckStatus = "unchecked" | "ready" | "not-installed" | "logged-out" | "unknown";

export interface ToolCheck {
  id: CheckId;
  status: CheckStatus;
  /** A check is running; `status` is the last answer until it ends. */
  checking?: boolean;
  /** The GitHub CLI: the account that is logged in. */
  account?: string;
  /** What the tool said when the answer was not clear. Shown only behind Details. */
  detail?: string;
  at?: number;
}

export type Platform = "darwin" | "win32" | "linux";

/** A GitHub clone found on this machine. */
export interface Clone {
  path: string;
  /** owner/name on GitHub. */
  repo: string;
  /** When it last changed, in milliseconds. */
  changedAt: number;
}

export type SetupStep = "welcome" | "tools" | "product" | "task";

export const SETUP_STEPS: readonly { id: SetupStep; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "tools", label: "Tools" },
  { id: "product", label: "Product" },
  { id: "task", label: "First task" },
];

/** First run, as the engine keeps it. An install that already had products or tasks starts done. */
export interface Setup {
  /** Finished or skipped: first run never shows again. */
  done: boolean;
  /** The furthest screen reached, so closing Petrina partway reopens there. */
  step?: SetupStep;
  platform: Platform;
  checks: readonly ToolCheck[];
  /** The task first run started: the board's one-time tip follows its "Show me the plan first". */
  firstTaskId?: Id;
  tipDismissed?: boolean;
}

export const CHECK_NAMES: Record<CheckId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  grok: "Grok",
  antigravity: "Antigravity",
  gh: "GitHub CLI",
  git: "Git",
  node: "Node.js",
};

export const CHECK_LABELS: Record<CheckStatus, string> = {
  unchecked: "Checking",
  ready: "Ready",
  "not-installed": "Not installed",
  "logged-out": "Not logged in",
  unknown: "Couldn't check",
};

export interface Fix {
  /** Exactly one plain sentence. */
  sentence: string;
  /** One command to copy into Terminal. */
  command: string;
  /** The official guide, a web link. */
  guide: string;
}

type PerPlatform = string | Readonly<Record<Platform, string>>;

const GUIDES: Record<CheckId, { install: string; login?: string }> = {
  "claude-code": { install: "https://code.claude.com/docs/en/setup", login: "https://code.claude.com/docs/en/setup#authentication" },
  codex: { install: "https://developers.openai.com/codex/cli", login: "https://developers.openai.com/codex/auth" },
  grok: { install: "https://docs.x.ai/build/overview", login: "https://docs.x.ai/build/cli/reference" },
  antigravity: { install: "https://antigravity.google/docs/cli/install/", login: "https://antigravity.google/docs/ide/extensions/zed" },
  gh: { install: "https://github.com/cli/cli#installation", login: "https://cli.github.com/manual/gh_auth_login" },
  git: { install: "https://git-scm.com/downloads" },
  node: { install: "https://nodejs.org/en/download" },
};

const INSTALL: Record<CheckId, PerPlatform> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  grok: "npm install -g @xai-official/grok",
  antigravity: "bun run petrina antigravity install",
  gh: { darwin: "brew install gh", win32: "winget install --id GitHub.cli", linux: "sudo apt install gh" },
  git: { darwin: "xcode-select --install", win32: "winget install --id Git.Git -e", linux: "sudo apt install git" },
  node: { darwin: "brew install node", win32: "winget install OpenJS.NodeJS.LTS", linux: "sudo apt install nodejs npm" },
};

const LOGIN: Partial<Record<CheckId, string>> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  grok: "grok login",
  antigravity: "bun run petrina antigravity login",
  gh: "gh auth login",
};

/** What Git and Node.js are for, at the start of the sentence that asks for them. */
const NEEDED_FOR: Partial<Record<CheckId, string>> = {
  git: "Petrina needs Git to add products and give each task its own working copy",
  node: "Petrina needs Node.js to start its agents",
};

/** The guides Petrina links to: the only pages it opens for the coordinator. */
export function isGuide(url: string): boolean {
  return Object.values(GUIDES).some((guide) => guide.install === url || guide.login === url);
}

const pick = (value: PerPlatform, platform: Platform) => (typeof value === "string" ? value : value[platform]);

/** The fix for a check that is not Ready: one sentence, one command and the official guide, for this operating system. */
export function fixFor(id: CheckId, status: CheckStatus, platform: Platform): Fix | undefined {
  const name = CHECK_NAMES[id];
  const guides = GUIDES[id];
  const login = LOGIN[id];
  const terminal = platform === "win32" ? "a terminal" : "Terminal";
  switch (status) {
    case "ready":
    case "unchecked":
      return undefined;
    case "not-installed":
      return {
        sentence: id === "antigravity" ? `Install Antigravity CLI from the official guide, then run this in Petrina's folder to install Google's connector.` : NEEDED_FOR[id] ? `${NEEDED_FOR[id]}, so install it by running this in ${terminal}, then come back to Petrina.` : `Install ${name} by running this in ${terminal}, then come back to Petrina.`,
        command: pick(INSTALL[id], platform),
        guide: guides.install,
      };
    case "logged-out":
      return { sentence: `${name} is installed but not logged in, so run this in ${terminal} to log in, then come back to Petrina.`, command: login ?? pick(INSTALL[id], platform), guide: guides.login ?? guides.install };
    case "unknown":
      return login
        ? { sentence: `If ${name} doesn't work, run this in ${terminal} to log in again, then come back to Petrina.`, command: login, guide: guides.login ?? guides.install }
        : { sentence: `If ${name} doesn't work, install it again by running this in ${terminal}, then come back to Petrina.`, command: pick(INSTALL[id], platform), guide: guides.install };
  }
}

/** The program behind each check, to see whether it runs at all. */
const PROGRAM: Record<CheckId, string> = { "claude-code": "claude", codex: "codex", grok: "grok", antigravity: "agy", gh: "gh", git: "git", node: "node" };

/** The fix shown on a Stuck item for a tool that would not start, when its check found nothing wrong. */
export function wontStartFix(id: CheckId, platform: Platform): Fix {
  const guides = GUIDES[id];
  return {
    sentence: `Run this in ${platform === "win32" ? "a terminal" : "Terminal"} to see whether ${CHECK_NAMES[id]} works, then press Retry.`,
    command: `${PROGRAM[id]} --version`,
    guide: guides.install,
  };
}

export function checkOf(checks: readonly ToolCheck[] | undefined, id: CheckId): ToolCheck {
  return checks?.find((check) => check.id === id) ?? { id, status: "unchecked" };
}

/** Present: Ready, or Petrina couldn't tell. Only the checks that decide wait for an answer; slower rows never hold Continue. */
const present = (status: CheckStatus) => status === "ready" || status === "unknown";

/**
 * The agent tools on this machine's list: Claude Code and Codex always, and Grok once its check has
 * found it installed. The squad can run a whole task on any one of them.
 */
export function agentTools(checks: readonly ToolCheck[] | undefined): CheckId[] {
  const extras = (["grok", "antigravity"] as const).filter(id => checks?.some(check => check.id === id && check.status !== "not-installed"));
  return [...AGENT_TOOLS, ...extras];
}

/**
 * The agent tools the squad may use: those that are Ready, or if none is, those Petrina couldn't
 * check (an answer still on its way counts as couldn't check). Never one that is Not installed or
 * Not logged in. Empty when no tool is usable.
 */
export function usableAgentTools(checks: readonly ToolCheck[] | undefined): CheckId[] {
  const agents = agentTools(checks);
  const ready = agents.filter((id) => checkOf(checks, id).status === "ready");
  if (ready.length) return ready;
  return agents.filter((id) => ["unknown", "unchecked"].includes(checkOf(checks, id).status));
}

/**
 * Whether the Tools screen may go on, what is missing in one sentence, and the notes under Continue,
 * one sentence each. Continue needs Git, Node.js and one agent tool (Claude Code, Codex, or Grok when
 * it is installed) that is Ready or that Petrina couldn't check. The notes describe what the squad will
 * really use (see usableAgentTools).
 */
export function toolsGate(checks: readonly ToolCheck[] | undefined): { ok: boolean; missing?: string; notes: string[] } {
  const status = (id: CheckId) => checkOf(checks, id).status;
  const name = (id: CheckId) => CHECK_NAMES[id];
  const tools = agentTools(checks);
  const lacking = (["git", "node"] as const).filter((id) => !present(status(id)));
  const agents = tools.filter((id) => present(status(id)));
  const notes: string[] = [];
  if (lacking.length || !agents.length) {
    const parts = [...lacking.map(name), ...(agents.length ? [] : [list(tools.map(name), "or")])];
    const waiting = [...lacking, ...(agents.length ? [] : tools)].some((id) => status(id) === "unchecked");
    return {
      ok: false,
      missing: waiting && parts.length ? `Waiting for the check of ${list(parts)}.` : `To go on, Petrina needs ${list(parts)}, and the fix is above.`,
      notes,
    };
  }
  // What the squad will use: the Ready tools, or if none is, the ones Petrina couldn't check.
  const used = usableAgentTools(checks);
  const ready = used.filter((id) => status(id) === "ready");
  const others = tools.filter((id) => id !== used[0]);
  // A single tool once the others' first answers are in: never a note that the next answer takes back.
  if (used.length === 1 && others.every((id) => status(id) !== "unchecked")) {
    const only = name(used[0]!);
    const unsure = others.filter((id) => status(id) === "unknown");
    notes.push(
      unsure.length
        ? `Petrina couldn't confirm ${list(unsure.map(name))}, so agents will review each other's work on ${only} alone until ${unsure.length === 1 ? name(unsure[0]!) : "one of them"} checks out as Ready.`
        : `Only ${only} is set up, so agents will review each other's work on the same tool, and setting up ${list(others.map(name), "or")} gives a second opinion.`,
    );
  }
  if (!ready.length) notes.push(`Petrina couldn't confirm ${list(agents.map(name))}, so it will try ${agents.length === 1 ? "it" : "them"} and tell you if ${agents.length === 1 ? "it can't" : "one can't"} start.`);
  if (status("gh") !== "ready") notes.push("You can set up the GitHub CLI later, but Petrina needs it logged in before it opens your first pull request.");
  return { ok: true, notes };
}

function list(items: readonly string[], joiner: "and" | "or" = "and"): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}` : (items[0] ?? "");
}

/**
 * The board's one-time tip about the first task, or nothing once there is nothing to say. It follows
 * the task as it is: stuck, it says so and promises no plan; otherwise it follows "Show me the plan
 * first" (the plan comes to Needs you for approval, or the squad has started and the card shows it).
 */
export function firstTaskTip(state: State): { text: string; toInbox: boolean } | undefined {
  const setup = state.setup;
  const task = state.tasks.find((entry) => entry.id === setup?.firstTaskId);
  if (!setup || setup.tipDismissed || !task || ["done", "cancelled", "pr-open"].includes(task.state)) return undefined;
  const asks = (kind: InboxItem["kind"]) => state.inbox.some((item) => item.taskId === task.id && item.kind === kind);
  const title = `“${task.title}”`;
  if (task.state === "failed" || asks("stuck")) return { text: `${title} is stuck. Needs you says why and how to fix it, and Retry picks it up from there.`, toInbox: true };
  if (!task.approvePlan) return { text: `The squad has started on ${title}. Follow its plan on the card: each step lights up as it starts.`, toInbox: false };
  if (asks("plan")) return { text: `The plan for ${title} is waiting in Needs you for your approval. Nothing starts until you approve it.`, toInbox: true };
  if (task.stageIndex >= 0) return { text: `You approved the plan for ${title}. Follow it on the card: each step lights up as it starts.`, toInbox: false };
  return { text: `The planner is writing a plan for ${title}. It will arrive in Needs you for your approval before anyone starts work.`, toInbox: true };
}

/** Three small, safe first tasks: each fills in the title with one click. */
export const STARTER_IDEAS: readonly string[] = [
  "Add a short “How to run it” section to the README",
  "Fix typos and unclear sentences in the docs",
  "Add a test for a part of the code that has none",
];
