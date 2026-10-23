// First run's checks: is each tool installed and logged in, and which GitHub clones are on this
// machine. Every check has a time limit and runs outside any product's folder. A login check opens
// a conversation the way an agent's starts (same command, same environment), takes the login the
// tool itself reports, and closes it before any message is sent, so it uses none of the
// coordinator's subscription. The clone finder only
// reads files: it runs nothing inside the folders it looks at and never follows a link out of them.
// On a Mac it stays out of the folders the system guards with a permission window (Documents and the like).

import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix, sep, win32 } from "node:path";
import type { AgentProfile, CheckStatus, Clone, Platform } from "@petrina/core";
import { AgentRun } from "./acp-run.js";
import { githubRepo, run, type Gh, type RunResult, type StartFailure } from "./git.js";
import { adapterEntry, type ToolAdapter } from "./tools.js";

export interface CheckResult {
  status: CheckStatus;
  account?: string;
  detail?: string;
}

/** Where a program is on the PATH, or null. Tests stand in their own. */
export type Which = (name: string) => string | null;

/** How long one check may take before it counts as "Couldn't check". */
export const CHECK_TIMEOUT_MS = 8_000;
/** Native agents open a full session; cold startup can exceed a simple command's deadline. */
export const AGENT_CHECK_TIMEOUT_MS = 30_000;

const tail = (text: string) => text.trim().slice(-400);

const START_REASONS: Record<Exclude<StartFailure["kind"], "missing-executable">, string> = {
  "temporary-directory": "Petrina couldn't prepare the temporary folder it uses for checks.",
  "working-directory": "The folder this check runs from is unavailable.",
  permission: "The system refused permission to start this check.",
  other: "Petrina couldn't start this check.",
};

/** A failed launch says nothing about installation unless the executable itself is missing. */
function startCheckResult(result: RunResult): CheckResult | undefined {
  const failure = result.startFailure;
  if (!failure) return undefined;
  if (failure.kind === "missing-executable") return { status: "not-installed" };
  return { status: "unknown", detail: `${START_REASONS[failure.kind]}\n${failure.message}`.slice(0, 400) };
}

/** The JSON-RPC code ACP uses for "log in first". */
export function isAuthRequired(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === -32000;
}

/**
 * Is an agent tool installed and logged in? Opens a conversation in an empty folder with the same
 * command and environment its agents get, then closes it: no message reaches the AI. Ready needs the
 * tool's own word, given the way that tool gives it (its adapter's `login`). Claude Code and Codex
 * open a conversation while logged out (Claude Code asks for a login only at the first message), so
 * their connectors' report of the login they run on decides, where "none" is Not logged in. Grok sends
 * no report: it signs in as the conversation opens and refuses with ACP's "log in first" error when it
 * can't, so opening is its word. A tool that says nothing within the time limit is "Couldn't check",
 * never assumed Ready. The answer never waits past the time limit, even for a tool that ignores being
 * stopped: it is forced to stop afterwards, and `onGone` hears when it has.
 */
export async function checkAgentTool(options: {
  adapter: ToolAdapter;
  profile: AgentProfile;
  /** The command agents run with, when it is not the tool's own adapter (tests). */
  command?: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  which: Which;
  timeoutMs?: number;
  onGone?: (gone: Promise<void>) => void;
  /** Quitting Petrina also stops probes that have not finished checking yet. */
  signal?: AbortSignal;
  /** Explicit coordinator sign-in only; ordinary checks never open the browser. */
  authenticate?: string;
}): Promise<CheckResult> {
  const { adapter } = options;
  if (!options.command) {
    try {
      if (!adapter.command) adapterEntry(adapter);
    } catch {
      return { status: "not-installed", detail: `Petrina's connector for ${adapter.name} is missing. Run bun install in Petrina's folder.` };
    }
    if (!options.which(adapter.cli)) return { status: "not-installed" };
    if (adapter.installed && !adapter.installed()) return { status: "not-installed", detail: `${adapter.name}'s connector is missing. Run bun run petrina antigravity install.` };
  }
  const limit = options.timeoutMs ?? AGENT_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), limit);
  let said = "";
  let login: string | undefined;
  let reported: () => void = () => undefined;
  const heard = new Promise<void>((done) => (reported = done));
  const late = new Promise<void>((done) => controller.signal.addEventListener("abort", () => done(), { once: true }));
  try {
    const agent = await AgentRun.start({
      probe: true,
      ...(options.authenticate ? { authenticate: options.authenticate } : {}),
      profile: options.profile,
      cwd: options.cwd,
      env: options.env,
      signal: controller.signal,
      startTimeoutMs: limit,
      ...(options.command ? { command: options.command } : {}),
      ...(options.onGone ? { onGone: options.onGone } : {}),
      callbacks: {
        onActivity: () => undefined,
        onPlanStep: () => undefined,
        onPermission: async () => "deny",
        onLog: (text) => (said = `${said}${text}`.slice(-2000)),
        onAuthStatus: (kind) => {
          login = kind;
          reported();
        },
      },
    });
    // A tool that signs in as the conversation opens has answered by opening it. Otherwise the report
    // can come before the conversation opens, or a moment after.
    if (adapter.login === "open") login ??= "opened";
    else await Promise.race([heard, late]);
    void agent.stop(2_000);
    if (login === undefined) return { status: "unknown", detail: `${adapter.name} started but did not say whether it is logged in within ${Math.round(limit / 1000)} seconds.` };
    return { status: login === "none" ? "logged-out" : "ready" };
  } catch (error) {
    if (isAuthRequired(error)) return { status: "logged-out" };
    const message = controller.signal.aborted ? `${adapter.name} did not answer within ${Math.round(limit / 1000)} seconds.` : error instanceof Error ? error.message : String(error);
    // Keep the cause first: a verbose connector must never displace it with debug output.
    return { status: "unknown", detail: [message.slice(0, 400), tail(said)].filter(Boolean).join("\n") };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** Is the GitHub CLI installed and logged in to github.com, and as whom? */
export async function checkGh(gh: Gh, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckResult> {
  const result = await run([...gh, "auth", "status", "--hostname", "github.com"], tmpdir(), undefined, { credentials: true, timeoutMs });
  const said = `${result.stdout}\n${result.stderr}`;
  const failedStart = startCheckResult(result);
  if (failedStart) return failedStart;
  if (result.timedOut) return { status: "unknown", detail: `The GitHub CLI did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
  const account = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(said)?.[1];
  if (result.code === 0) return { status: "ready", ...(account ? { account } : {}) };
  if (/not logged in|gh auth login|token .* is (invalid|expired)/i.test(said)) return { status: "logged-out", detail: tail(said) };
  return { status: "unknown", detail: tail(said) };
}

/**
 * Is Git there? On a Mac without Apple's developer tools, /usr/bin/git is a stand-in that opens
 * their installer when it runs, so that case is told apart without running it.
 */
export async function checkGit(which: Which, platform: Platform, options: { timeoutMs?: number; developerTools?: () => Promise<DeveloperToolsResult> } = {}): Promise<CheckResult> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const path = which("git");
  if (!path) return { status: "not-installed" };
  if (platform === "darwin" && path === "/usr/bin/git") {
    const tools = await (options.developerTools ?? (() => developerTools(timeoutMs)))();
    if (tools.kind === "unknown") return { status: "unknown", detail: tools.detail };
    if (tools.kind === "missing" || !existsSync(join(tools.path, "usr", "bin", "git"))) return { status: "not-installed" };
  }
  return versionCheck([path, "--version"], timeoutMs);
}

/** Where Apple's developer tools are. xcode-select -p only prints it; it never offers to install them. */
export type DeveloperToolsResult = { kind: "found"; path: string } | { kind: "missing" } | { kind: "unknown"; detail: string };

async function developerTools(timeoutMs: number): Promise<DeveloperToolsResult> {
  const result = await run(["/usr/bin/xcode-select", "-p"], tmpdir(), undefined, { timeoutMs });
  const failedStart = startCheckResult(result);
  if (failedStart) return failedStart.status === "not-installed" ? { kind: "missing" } : { kind: "unknown", detail: failedStart.detail! };
  if (result.timedOut) return { kind: "unknown", detail: "Apple's developer tools lookup did not answer in time." };
  if (result.code !== 0) return { kind: "missing" };
  return result.stdout ? { kind: "found", path: result.stdout } : { kind: "unknown", detail: "Apple's developer tools lookup gave no answer." };
}

/** Is Node.js there? Agents' connectors run on it. */
export async function checkNode(which: Which, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckResult> {
  const path = which("node");
  if (!path) return { status: "not-installed" };
  return versionCheck([path, "--version"], timeoutMs);
}

async function versionCheck(command: readonly string[], timeoutMs: number): Promise<CheckResult> {
  const result = await run(command, tmpdir(), undefined, { timeoutMs });
  const failedStart = startCheckResult(result);
  if (failedStart) return failedStart;
  if (result.code === 0) return { status: "ready" };
  return { status: "unknown", detail: tail(result.timedOut ? "It did not answer in time." : `${result.stderr}\n${result.stdout}`) };
}

// ── Clones on this machine ──────────────────────────────────────────────

/** Where people usually keep their code, below their home folder. */
export const CODE_FOLDERS: readonly string[] = [
  "code",
  "Code",
  "dev",
  "Developer",
  "src",
  "projects",
  "Projects",
  "repos",
  "git",
  "GitHub",
  "workspace",
  "work",
  "Sites",
  join("Documents", "GitHub"),
  join("source", "repos"),
];

/**
 * On a Mac, reading these folders makes the system ask the coordinator for permission in a window
 * of its own, so the scan leaves them out. A clone in one can still be pasted.
 */
const MAC_PROTECTED: readonly string[] = ["Desktop", "Documents", "Downloads"];

/** The code folders the scan reads on this operating system. */
export function codeFolders(platform: NodeJS.Platform = process.platform): string[] {
  return CODE_FOLDERS.filter((folder) => platform !== "darwin" || !MAC_PROTECTED.includes(folder.split(sep)[0]!));
}

/** At most this many entries are read from one folder. */
const MAX_ENTRIES = 400;

/**
 * GitHub clones in the usual code folders, two levels deep at most, most recently changed first.
 * Only reads files: nothing runs inside these folders, and links are never followed. Stops after
 * `budgetMs` with what it found so far.
 */
export async function findClones(options: { home?: string; folders?: readonly string[]; platform?: NodeJS.Platform; skip?: (path: string) => boolean; limit?: number; budgetMs?: number } = {}): Promise<Clone[]> {
  const home = options.home ?? homedir();
  const deadline = Date.now() + (options.budgetMs ?? 2_000);
  const seen = new Set<string>();
  const found: Clone[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (Date.now() > deadline) return;
    // lstat: a link is never a folder here, so nothing outside is followed.
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory()) return;
    // The same folder by two names (code and Code on a Mac) is read once.
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) return;
    seen.add(key);
    const clone = await readClone(dir);
    if (clone) {
      found.push(clone);
      return;
    }
    if (depth >= 2) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await visit(join(dir, entry.name), depth + 1);
    }
  };

  for (const folder of options.folders ?? codeFolders(options.platform)) if (await linkFree(home, folder)) await visit(join(home, folder), 0);
  return found
    .filter((clone) => !options.skip?.(clone.path))
    .sort((a, b) => b.changedAt - a.changedAt)
    .slice(0, options.limit ?? 6);
}

/**
 * A code folder below the home folder with no link anywhere on the way (Documents in Documents/GitHub
 * as well as GitHub itself), so a shortcut never leads the scan out of the folders it means to read.
 */
async function linkFree(home: string, folder: string): Promise<boolean> {
  let path = home;
  for (const part of folder.split(sep)) {
    path = join(path, part);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory()) return false;
  }
  return true;
}

/** A folder whose own .git folder has a GitHub "origin". A .git file (a worktree or submodule) is not a clone. */
async function readClone(dir: string): Promise<Clone | undefined> {
  const gitDir = join(dir, ".git");
  const info = await lstat(gitDir).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  const config = join(gitDir, "config");
  const file = await lstat(config).catch(() => undefined);
  if (!file?.isFile() || file.size > 64 * 1024) return undefined;
  const repo = githubRepo(originUrl(await readFile(config, "utf8").catch(() => "")) ?? "");
  if (!repo) return undefined;
  let changedAt = info.mtimeMs;
  // Each step is stated on its own. Stating "logs/HEAD" in one go would follow a shortcut logs,
  // and a newer file outside the code folders would change which clone is suggested first.
  for (const parts of [["index"], ["HEAD"], ["FETCH_HEAD"], ["logs", "HEAD"]] as const) {
    const stamp = await fileStamp(gitDir, parts);
    if (stamp !== undefined) changedAt = Math.max(changedAt, stamp);
  }
  return { path: dir, repo, changedAt };
}

/**
 * The date of a file under `dir`, or nothing when any step is missing or a shortcut. `lstat` of a
 * whole path still follows every shortcut but the last, so each step is checked on its own.
 */
async function fileStamp(dir: string, parts: readonly string[]): Promise<number | undefined> {
  let path = dir;
  for (let index = 0; index < parts.length; index += 1) {
    path = join(path, parts[index]!);
    const stamp = await lstat(path).catch(() => undefined);
    if (!stamp || stamp.isSymbolicLink()) return undefined;
    if (index === parts.length - 1) return stamp.isFile() ? stamp.mtimeMs : undefined;
    if (!stamp.isDirectory()) return undefined;
  }
  return undefined;
}

/** The url of the "origin" remote in a git config file. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line);
    else if (inOrigin) {
      const match = /^url\s*=\s*(.+)$/.exec(line);
      if (match) return match[1]!.trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return undefined;
}

// ── Paths and links ─────────────────────────────────────────────────────

/** A pasted folder path: quotes and escaped spaces from a terminal undone, ~ meaning the home folder. */
export function expandPath(input: string, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix;
  let path = input.trim();
  const quoted = /^(["'])(.*)\1$/.exec(path);
  if (quoted) path = quoted[2]!;
  else if (platform !== "win32") path = path.replace(/\\(.)/g, "$1");
  if (path === "~") path = home;
  else if (path.startsWith(`~/`) || path.startsWith(`~${paths.sep}`)) path = paths.join(home, path.slice(2));
  return paths.isAbsolute(path) ? paths.resolve(path) : paths.resolve(home, path);
}

/** How to open a web page in the default browser, outside the app. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
}
