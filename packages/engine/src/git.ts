// Git and GitHub operations. Every command is an argument array: nothing goes through a shell.
//
// Agents can change a working copy's git settings (worktrees share them with the main clone), so
// Petrina's own git steps never run hooks or the file monitor, and only the steps that talk to
// GitHub (fetch, gh) get the coordinator's credentials. Anything else a repository's settings
// start (filters, signing) runs with no credentials, like an agent.
//
// GitHub lookups are pinned to the product's repository and run outside any working copy, so an
// agent that rewrites a remote cannot change what Petrina reads. They take the `gh` command to run,
// so tests can stand in a fake GitHub.

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { agentEnv, withGitConfig } from "./env.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command was stopped at its time limit. */
  timedOut?: boolean;
}

/** The `gh` command to run. */
export type Gh = readonly string[];
const GH: Gh = ["gh"];
const SHA = /^[0-9a-f]{7,40}$/i;
/** Branch and tag names Petrina passes to git and gh: no leading dash, no "..". */
const TAG = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\-/]+$/;

let empty: string | undefined;
/** Empty folders for "no hooks" and "no gh login", made once per engine. */
function emptyDir(name: "hooks" | "gh"): string {
  empty ??= mkdtempSync(join(tmpdir(), "petrina-none-"));
  const dir = join(empty, name);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** Settings that can make a credentialed fetch run a program: only normal https and ssh remotes. */
const SAFE_TRANSPORT: readonly (readonly [string, string])[] = [
  ["protocol.allow", "never"],
  ["protocol.https.allow", "always"],
  ["protocol.ssh.allow", "always"],
  ["protocol.ext.allow", "never"],
  ["protocol.file.allow", "never"],
  ["protocol.git.allow", "never"],
  ["remote.origin.uploadpack", "git-upload-pack"],
  ["fetch.recurseSubmodules", "false"],
  // A connection slower than 1 KB/s for 20 seconds gives up, so nothing lingers after a time limit.
  ["http.lowSpeedLimit", "1000"],
  ["http.lowSpeedTime", "20"],
];

function gitEnv(credentials: boolean): NodeJS.ProcessEnv {
  const base = credentials ? process.env : agentEnv(process.env, emptyDir("gh"));
  const settings = [["core.hooksPath", emptyDir("hooks")], ["core.fsmonitor", "false"], ...(credentials ? SAFE_TRANSPORT : [])] as const;
  return { ...withGitConfig(base, settings), GIT_TERMINAL_PROMPT: "0" };
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** How long Petrina waits for GitHub before giving up on a lookup or a fetch. */
export const FETCH_TIMEOUT_MS = 30_000;

/** gh with the coordinator's login, pinned to the product's repository and run outside any working copy. */
async function gh(repo: string, args: readonly string[], command: Gh = GH): Promise<RunResult | undefined> {
  if (!REPO.test(repo)) return undefined;
  return run([...command, ...args, "--repo", repo], tmpdir(), undefined, { credentials: true, timeoutMs: FETCH_TIMEOUT_MS });
}

/** GitHub's API for the product's repository, the same way: `path` is below repos/<owner>/<name>/. */
async function ghApi(repo: string, path: string, jq: string, command: Gh = GH): Promise<RunResult | undefined> {
  if (!REPO.test(repo)) return undefined;
  return run([...command, "api", `repos/${repo}/${path}`, "--jq", jq], tmpdir(), undefined, { credentials: true, timeoutMs: FETCH_TIMEOUT_MS });
}

export async function run(cmd: readonly string[], cwd: string, input?: string, options: { credentials?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(cmd, cwd, input, options.credentials === true);
  } catch (error) {
    // The program is not installed (no gh, say): report it like a failed command.
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  if (options.timeoutMs) {
    // Race the exit, not the output: git's network helpers can keep the pipes open after git is killed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), options.timeoutMs)));
    const first = await Promise.race([proc.exited, deadline]);
    clearTimeout(timer);
    if (first === "timeout") {
      proc.kill("SIGKILL");
      return { code: 124, stdout: "", stderr: "timed out", timedOut: true };
    }
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function spawnPiped(cmd: readonly string[], cwd: string, input: string | undefined, credentials: boolean) {
  return Bun.spawn([...cmd], {
    cwd,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv(credentials),
    windowsHide: true,
  });
}

/** A file as committed at `ref`, read straight from git's objects: no filters, no links followed. Undefined when absent. */
export function fileAt(root: string, ref: string, path: string): string | undefined {
  const result = Bun.spawnSync(["git", "cat-file", "blob", `${ref}:${path}`], { cwd: root, env: gitEnv(false), stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

async function must(cmd: readonly string[], cwd: string, input?: string): Promise<string> {
  const result = await run(cmd, cwd, input);
  if (result.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export interface RepoInfo {
  root: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

const REMOTE = /^(?:(?:ssh|git|https?):\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/;

/** Read what Petrina needs about a local clone. */
export async function repoInfo(path: string): Promise<RepoInfo> {
  const root = await must(["git", "rev-parse", "--show-toplevel"], path);
  const remote = (await run(["git", "remote", "get-url", "origin"], root)).stdout;
  const match = REMOTE.exec(remote);
  const segments = match?.[2]?.split("/").filter(Boolean) ?? [];
  const name = segments.at(-1) ?? root.split("/").at(-1) ?? "repo";
  const owner = segments.slice(0, -1).join("/") || "local";
  const head = (await run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)).stdout;
  const defaultBranch = head.startsWith("origin/") ? head.slice("origin/".length) : (await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], root)).stdout || "main";
  return { root, owner, name, defaultBranch };
}

/** Branch names come from an allowlist, never from raw task text. */
export function branchName(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  const suffix = taskId.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  return `petrina/${slug || "task"}-${suffix}`;
}

/**
 * The repository-level settings a fetch with the coordinator's login may run under. An allowlist:
 * anything else (agents can change these settings) means no credentialed fetch. Hooks are listed
 * because Petrina's git steps switch them off anyway.
 */
const SAFE_SETTING = new RegExp(
  [
    "core\\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|hookspath)",
    "extensions\\.(worktreeconfig|objectformat)",
    "remote\\.[^.]+\\.(url|fetch|pushurl|tagopt|prune)",
    "branch\\..+\\.(remote|merge|rebase|pushremote|description)",
    "submodule\\..+\\.(url|active)",
    "user\\.(name|email)",
    "(gc\\.auto|gc\\.autodetach|pull\\.rebase|pull\\.ff|push\\.default|push\\.autosetupremote|fetch\\.prune|fetch\\.prunetags|lfs\\.repositoryformatversion)",
  ]
    .map((pattern) => `^${pattern}$`)
    .join("|"),
  "i",
);

/** The repository's own settings (agents can change them) that are not known to be safe for a credentialed fetch. */
export async function riskySettings(root: string): Promise<string[]> {
  const listed = await run(["git", "config", "--list", "--show-scope", "--name-only", "-z"], root);
  if (listed.code !== 0) return ["unreadable git settings"];
  // -z: scope and key alternate, each ending in NUL, so no key can be misread.
  const fields = listed.stdout.split("\0");
  const risky: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [scope, key] = [fields[index]!, fields[index + 1]!];
    if ((scope === "local" || scope === "worktree") && !SAFE_SETTING.test(key)) risky.push(key);
  }
  return [...new Set(risky)];
}

/** Create (or reuse) the task's worktree on its own branch, based on the latest default branch. */
export async function ensureWorktree(
  root: string,
  path: string,
  branch: string,
  defaultBranch: string,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ base: string; skippedFetch?: string[]; fetchTimedOut?: boolean }> {
  // Fail closed: never fetch with the coordinator's login while the repository's settings could misuse it.
  const risky = await riskySettings(root);
  const fetched = risky.length ? undefined : await run(["git", "fetch", "--quiet", "origin", defaultBranch], root, undefined, { credentials: true, timeoutMs: fetchTimeoutMs });
  // A stalled network never holds a task: after the time limit it works from the local copy.
  const timedOut = fetched?.timedOut === true;
  const remoteBase = `origin/${defaultBranch}`;
  const hasRemote = (await run(["git", "rev-parse", "--verify", "--quiet", remoteBase], root)).code === 0;
  const base = hasRemote ? remoteBase : defaultBranch;
  const skipped = { ...(risky.length ? { skippedFetch: risky } : {}), ...(timedOut ? { fetchTimedOut: true } : {}) };
  if (existsSync(path) && (await run(["git", "rev-parse", "--is-inside-work-tree"], path)).code === 0) return { base, ...skipped };
  await mkdir(dirname(path), { recursive: true });
  await oneAtATime(root, async () => {
    const branchExists = (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).code === 0;
    if (branchExists) await must(["git", "worktree", "add", path, branch], root);
    else await must(["git", "worktree", "add", "-b", branch, path, base], root);
  });
  return { base, ...skipped };
}

/**
 * Git trips over a worktree another one is still creating ("failed to read .git/worktrees/…/commondir"),
 * so tasks starting together add and remove one repository's worktrees one at a time.
 */
const worktreeTurns = new Map<string, Promise<void>>();
function oneAtATime<T>(root: string, work: () => Promise<T>): Promise<T> {
  const turn = (worktreeTurns.get(root) ?? Promise.resolve()).then(work);
  worktreeTurns.set(
    root,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
  return turn;
}

export async function isClean(path: string): Promise<boolean> {
  return (await run(["git", "status", "--porcelain"], path)).stdout === "";
}

/** Undo anything a read-only agent changed in its working copy. */
export async function discardChanges(path: string): Promise<void> {
  await run(["git", "reset", "--hard", "--quiet"], path);
  await run(["git", "clean", "-fd", "--quiet"], path);
}

/** Commit everything in the worktree. Returns the new sha, or undefined when there was nothing to commit. */
export async function commitAll(path: string, message: string): Promise<string | undefined> {
  await must(["git", "add", "-A"], path);
  if ((await run(["git", "diff", "--cached", "--quiet"], path)).code === 0) return undefined;
  await must(["git", "commit", "--quiet", "-F", "-"], path, message);
  return must(["git", "rev-parse", "HEAD"], path);
}

export async function resetTo(path: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) return;
  await run(["git", "reset", "--hard", "--quiet", sha], path);
}

export async function head(path: string): Promise<string> {
  return must(["git", "rev-parse", "HEAD"], path);
}

export interface FileChange {
  change: "added" | "changed" | "removed";
  file: string;
}

/** Files added, changed or removed in the working copy since a commit, committed or not. */
export async function changedSince(path: string, sha: string): Promise<FileChange[]> {
  if (!SHA.test(sha)) return [];
  const [tracked, untracked] = await Promise.all([
    run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", sha], path),
    run(["git", "ls-files", "--others", "--exclude-standard", "-z"], path),
  ]);
  const changes: FileChange[] = [];
  const fields = tracked.code === 0 ? tracked.stdout.split("\0") : [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const file = fields[index + 1]!;
    if (file) changes.push({ change: status.startsWith("A") ? "added" : status.startsWith("D") ? "removed" : "changed", file });
  }
  for (const file of untracked.code === 0 ? untracked.stdout.split("\0") : []) {
    if (file && !changes.some((entry) => entry.file === file)) changes.push({ change: "added", file });
  }
  return changes;
}

/** How many commits the working copy's branch has on top of `sha`. */
export async function commitsSince(path: string, sha: string): Promise<number> {
  if (!SHA.test(sha)) return 0;
  return Number((await run(["git", "rev-list", "--count", `${sha}..HEAD`], path)).stdout) || 0;
}

const HALF_DONE: readonly (readonly [string, string])[] = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
];

/** The branch a working copy is on (undefined when it is on none), and a merge, rebase, cherry-pick or revert left half done. */
export async function workingState(path: string): Promise<{ branch?: string; busy?: string }> {
  const branch = await run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], path);
  for (const [marker, what] of HALF_DONE) {
    const where = await run(["git", "rev-parse", "--git-path", marker], path);
    if (where.code === 0 && where.stdout && existsSync(resolve(path, where.stdout))) return { ...(branch.code === 0 ? { branch: branch.stdout } : {}), busy: what };
  }
  return branch.code === 0 && branch.stdout ? { branch: branch.stdout } : {};
}

export async function diffStat(path: string, base: string): Promise<{ files: number; additions: number; deletions: number }> {
  const out = (await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--numstat", `${base}...HEAD`], path)).stdout;
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const [add, del] = line.split("\t");
    files += 1;
    additions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  return { files, additions, deletions };
}

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$/i;
const SKIP_MARKERS = /^\+.*(\b(it|test|describe)\.(skip|only)\(|\bxit\(|\bxdescribe\(|@(Disabled|Ignore)\b|pytest\.mark\.skip|#\[ignore\]|\.todo\()/;

/** A mechanical check before review: deleted test files and newly skipped tests block the change. */
export async function tamperCheck(path: string, base: string): Promise<string[]> {
  const problems: string[] = [];
  const deleted = (await run(["git", "diff", "--no-ext-diff", "--name-only", "--diff-filter=D", `${base}...HEAD`], path)).stdout.split("\n").filter(Boolean);
  for (const file of deleted) if (TEST_FILE.test(file)) problems.push(`A test file was deleted: ${file}`);
  const patch = (await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--unified=0", `${base}...HEAD`], path)).stdout;
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (SKIP_MARKERS.test(line)) problems.push(`A test was skipped or narrowed in ${file}`);
  }
  return [...new Set(problems)];
}

export async function prState(repo: string, number: number, command: Gh = GH): Promise<"open" | "merged" | "closed" | undefined> {
  const result = await gh(repo, ["pr", "view", String(number), "--json", "state", "--jq", ".state"], command);
  if (!result || result.code !== 0) return undefined;
  const state = result.stdout.toLowerCase();
  return state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
}

/** Verify a pull request the shipper says it opened. */
export async function findPr(repo: string, branch: string, command: Gh = GH): Promise<{ number: number; url: string } | undefined> {
  const result = await gh(repo, ["pr", "view", branch, "--json", "number,url"], command);
  if (!result || result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { number?: unknown; url?: unknown };
    return typeof parsed.number === "number" && typeof parsed.url === "string" ? { number: parsed.number, url: parsed.url } : undefined;
  } catch {
    return undefined;
  }
}

/** Verify a release the shipper says it published. */
export async function findRelease(repo: string, tag: string, command: Gh = GH): Promise<{ tag: string; url: string } | undefined> {
  if (!TAG.test(tag)) return undefined;
  const result = await gh(repo, ["release", "view", tag, "--json", "tagName,url"], command);
  if (!result || result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { tagName?: unknown; url?: unknown };
    return typeof parsed.tagName === "string" && typeof parsed.url === "string" ? { tag: parsed.tagName, url: parsed.url } : undefined;
  } catch {
    return undefined;
  }
}

/** Is `sha` on the local default branch of the product's clone? */
export async function landedOn(root: string, branch: string, sha: string): Promise<boolean> {
  if (!SHA.test(sha) || !TAG.test(branch)) return false;
  return (await run(["git", "merge-base", "--is-ancestor", sha, `refs/heads/${branch}`], root)).code === 0;
}

// ── Checks after an interrupted delivery ───────────────────────────────────
// Each tells "not there" apart from "could not ask", so Petrina never guesses.

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

const failed = (result: RunResult | undefined): { ok: false; error: string } => ({ ok: false, error: result ? (result.stderr || result.stdout || `exit ${result.code}`).slice(0, 300) : "not a GitHub repository" });
/** GitHub answered "there is no such thing", as opposed to not answering. */
const notFound = (result: RunResult) => /HTTP 404|Not Found/i.test(result.stderr);

export async function revParse(path: string, ref: string): Promise<string | undefined> {
  const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/** The pull request opened for a branch of the product's repository, whatever its state. One from a fork does not count. */
export async function prForBranch(repo: string, branch: string, command: Gh = GH): Promise<Check<{ number: number; url: string; state: "open" | "merged" | "closed" } | undefined>> {
  if (!TAG.test(branch)) return { ok: true, value: undefined };
  const result = await gh(repo, ["pr", "view", branch, "--json", "number,url,state,isCrossRepository"], command);
  if (!result || result.code !== 0) return result && /no (open )?pull requests? found/i.test(result.stderr) ? { ok: true, value: undefined } : failed(result);
  try {
    const parsed = JSON.parse(result.stdout) as { number?: unknown; url?: unknown; state?: unknown; isCrossRepository?: unknown };
    if (typeof parsed.number !== "number" || typeof parsed.url !== "string") return { ok: false, error: "GitHub's answer was not readable" };
    if (parsed.isCrossRepository === true) return { ok: true, value: undefined };
    const state = String(parsed.state ?? "").toLowerCase();
    return { ok: true, value: { number: parsed.number, url: parsed.url, state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open" } };
  } catch {
    return { ok: false, error: "GitHub's answer was not readable" };
  }
}

/** The latest published release's tag, or undefined when there is none or GitHub does not answer. */
export async function latestRelease(repo: string, command: Gh = GH): Promise<string | undefined> {
  const result = await gh(repo, ["release", "view", "--json", "tagName"], command);
  if (!result || result.code !== 0) return undefined;
  try {
    const tag = (JSON.parse(result.stdout) as { tagName?: unknown }).tagName;
    return typeof tag === "string" && TAG.test(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** Releases published at or after `since` (milliseconds), newest first. Drafts do not count. */
export async function releasesSince(repo: string, since: number, command: Gh = GH): Promise<Check<string[]>> {
  const result = await gh(repo, ["release", "list", "--limit", "30", "--json", "tagName,publishedAt,isDraft"], command);
  if (!result || result.code !== 0) return failed(result);
  try {
    const list = JSON.parse(result.stdout) as { tagName?: unknown; publishedAt?: unknown; isDraft?: unknown }[];
    const tags = list
      .filter((entry) => !entry.isDraft && typeof entry.tagName === "string" && TAG.test(entry.tagName) && Date.parse(String(entry.publishedAt)) >= since)
      .sort((a, b) => Date.parse(String(b.publishedAt)) - Date.parse(String(a.publishedAt)))
      .map((entry) => entry.tagName as string);
    return { ok: true, value: tags };
  } catch {
    return { ok: false, error: "GitHub's answer was not readable" };
  }
}

/** The commit a branch points to on GitHub. undefined: GitHub has no such branch. */
export async function branchOnGitHub(repo: string, branch: string, command: Gh = GH): Promise<Check<string | undefined>> {
  if (!TAG.test(branch)) return { ok: true, value: undefined };
  const result = await ghApi(repo, `git/ref/heads/${branch}`, ".object.sha", command);
  if (!result || result.code !== 0) return result && notFound(result) ? { ok: true, value: undefined } : failed(result);
  return { ok: true, value: SHA.test(result.stdout) ? result.stdout : undefined };
}

/** Does a branch or tag on GitHub contain `sha`? False when GitHub has neither. */
export async function onGitHub(repo: string, ref: string, sha: string, command: Gh = GH): Promise<Check<boolean>> {
  if (!SHA.test(sha) || !TAG.test(ref)) return { ok: true, value: false };
  const result = await ghApi(repo, `compare/${sha}...${ref}?per_page=1`, ".status", command);
  if (!result || result.code !== 0) return result && notFound(result) ? { ok: true, value: false } : failed(result);
  // "ahead": the ref has `sha` and more; "behind" and "diverged": it does not have it.
  return { ok: true, value: result.stdout === "ahead" || result.stdout === "identical" };
}

export async function removeWorktree(root: string, path: string): Promise<void> {
  await oneAtATime(root, () => run(["git", "worktree", "remove", "--force", path], root));
}
