// Git and GitHub operations. Every command is an argument array: nothing goes through a shell.
//
// Agents can change a working copy's git settings (worktrees share them with the main clone), so
// Petrina's own git steps never run hooks or the file monitor, and only the steps that talk to
// GitHub (fetch, push, gh) get the coordinator's credentials. Those name the product's saved
// address, never a remote, and run only when the repository's settings pass the allowlist.
// Anything else a repository's settings start (filters, signing) runs with no credentials at all.
// Nothing here merges a pull request, force-pushes or deletes anything on GitHub.
//
// GitHub lookups are pinned to the product's repository and run outside any working copy, so an
// agent that rewrites a remote cannot change what Petrina reads.

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withGitConfig, withoutCredentials } from "./env.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command was stopped at its time limit. */
  timedOut?: boolean;
}

/** The `gh` command to run. Tests stand in a fake GitHub through the Engine's constructor. */
export type Gh = readonly string[];
const GH: Gh = ["gh"];

/**
 * Where Petrina fetches from and publishes to: the product's saved address. `local`: a test
 * stand-in for GitHub (a folder), given only through the Engine's constructor.
 */
export interface Remote {
  url: string;
  local?: boolean;
}

/** An answer from GitHub, or why there is none. "Not there" and "could not ask" never look alike. */
export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

const SHA = /^[0-9a-f]{7,40}$/i;
/** A whole commit id, as pushes and handoffs name commits. */
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
/** Branch and tag names Petrina passes to git and gh: no leading dash, no "..", no "//". */
const NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._\-/]+$/;

export const isSha = (value: string): boolean => FULL_SHA.test(value);

let empty: string | undefined;
/** Empty folders for "no hooks" and "no gh login", made once per engine. */
function emptyDir(name: "hooks" | "gh"): string {
  empty ??= mkdtempSync(join(tmpdir(), "petrina-none-"));
  const dir = join(empty, name);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** Settings that can make a credentialed fetch or push run a program: only normal https and ssh remotes. */
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

function gitEnv(credentials: boolean, options: { local?: boolean; ownHooks?: boolean } = {}): NodeJS.ProcessEnv {
  const base = credentials ? process.env : withoutCredentials(process.env, emptyDir("gh"));
  const transport = credentials ? [...SAFE_TRANSPORT, ...(options.local ? ([["protocol.file.allow", "always"]] as const) : [])] : [];
  // `ownHooks` only for finding the repository's own hooks: never with credentials, never running a git step.
  const hooks = options.ownHooks && !credentials ? [] : [["core.hooksPath", emptyDir("hooks")] as const];
  const settings = [...hooks, ["core.fsmonitor", "false"] as const, ...transport];
  // Replace objects could make a commit Petrina pinned show different content.
  return { ...withGitConfig(base, settings), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", ...(credentials ? { GH_PROMPT_DISABLED: "1" } : {}) };
}

/** The hooks git runs when it commits, in the order it runs them. */
export const COMMIT_HOOKS = ["pre-commit", "commit-msg"] as const;
export type CommitHook = (typeof COMMIT_HOOKS)[number];

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** How long Petrina waits for GitHub before giving up on a lookup or a fetch. */
export const FETCH_TIMEOUT_MS = 30_000;

/** gh with the coordinator's login, pinned to the product's repository and run outside any working copy. */
async function gh(cmd: Gh, repo: string, args: readonly string[], input?: string): Promise<RunResult> {
  if (!REPO.test(repo)) return { code: 2, stdout: "", stderr: `not a GitHub repository: ${repo}` };
  return run([...cmd, ...args, "--repo", repo], tmpdir(), input, { credentials: true, timeoutMs: FETCH_TIMEOUT_MS });
}

export async function run(cmd: readonly string[], cwd: string, input?: string, options: { credentials?: boolean; local?: boolean; timeoutMs?: number; ownHooks?: boolean; index?: string; rawOutput?: boolean } = {}): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...cmd], {
      cwd,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...gitEnv(options.credentials === true, { local: options.local === true, ownHooks: options.ownHooks === true }), ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) },
      windowsHide: true,
    });
  } catch (error) {
    // The program is not installed (no gh, say): report it like a failed command.
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  // Read while the process writes: a saved file can exceed the pipe's capacity before Git exits.
  const stdout = proc.stdout as ReadableStream;
  const stderr = proc.stderr as ReadableStream;
  const output = Promise.all([
    options.rawOutput ? new Response(stdout).arrayBuffer().then((bytes) => Buffer.from(bytes).toString("utf8")) : new Response(stdout).text(),
    new Response(stderr).text(),
  ]);
  void output.catch(() => undefined);
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
  const [[out, err], code] = await Promise.all([output, proc.exited]);
  return { code, stdout: options.rawOutput ? out : out.trim(), stderr: err.trim() };
}

/** A file as committed at `ref`, read straight from git's objects: no filters, no links followed. Undefined when absent. */
export async function fileAt(root: string, ref: string, path: string, timeoutMs = 30_000): Promise<string | undefined> {
  if (ref.startsWith("-") || path.startsWith("-")) return undefined;
  const result = await run(["git", "cat-file", "blob", `${ref}:${path}`], root, undefined, { timeoutMs, rawOutput: true });
  if (result.timedOut) throw new Error("Git did not finish reading the repository's saved files");
  if (result.code === 127) throw new Error("Git could not read the repository's saved files");
  return result.code === 0 ? result.stdout : undefined;
}

async function must(cmd: readonly string[], cwd: string, input?: string): Promise<string> {
  const result = await run(cmd, cwd, input);
  if (result.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const failed = (result: RunResult): { ok: false; error: string } => ({ ok: false, error: (result.stderr || result.stdout || `exit ${result.code}`).slice(0, 300) });

export interface RepoInfo {
  root: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** The origin address exactly as configured, with no address rewrites applied. */
  remote?: string;
  /** Its origin is a repository on GitHub. */
  github: boolean;
}

const REMOTE = /^(?:(?:ssh|git|https?):\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/;

/** The origin address exactly as configured: `git remote get-url` would apply address rewrites. */
export async function remoteAddress(root: string): Promise<string | undefined> {
  const result = await run(["git", "config", "--get", "remote.origin.url"], root);
  return result.code === 0 && result.stdout ? result.stdout : undefined;
}

/**
 * The owner/name a GitHub address points to. Web and git-protocol addresses must be github.com
 * (http and git:// as well as https, the same ones clone discovery accepts). SSH may use a host
 * nickname from the coordinator's SSH settings (git@github-work:owner/name).
 */
export function githubRepoOf(address: string): string | undefined {
  if (address.startsWith("-")) return undefined;
  const web = /^(?:https?|git):\/\/(?:[^@/]+@)?(?:(?:www|ssh)\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(address);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?[^/:@]+(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(address);
  const scp = /^(?:[^@/:]+@)?[^/:@]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(address);
  const match = web ?? ssh ?? (address.includes("://") ? null : scp);
  if (!match) return undefined;
  const repo = `${match[1]}/${match[2]}`;
  return REPO.test(repo) ? repo : undefined;
}

/** Does this address point to the product's repository on GitHub? */
export function sameRepo(address: string, repo: string): boolean {
  return githubRepoOf(address)?.toLowerCase() === repo.toLowerCase();
}

/** owner/name when a remote's address is a repository on github.com. */
export function githubRepo(url: string): string | undefined {
  const match = REMOTE.exec(url.trim());
  if (!match || !/^(www\.|ssh\.)?github\.com(:\d+)?$/i.test(match[1]!)) return undefined;
  const repo = match[2]!.split("/").filter(Boolean).join("/");
  return REPO.test(repo) ? repo : undefined;
}

/** Read what Petrina needs about a local clone, from the folder or any folder inside it. */
export async function repoInfo(path: string): Promise<RepoInfo> {
  const root = await must(["git", "rev-parse", "--show-toplevel"], path);
  const remote = await remoteAddress(root);
  // A folder on this computer (C:\ or C:/ on Windows included) has no host: the product goes by its own folder.
  const local = /^(?:[A-Za-z]:[\\/]|[\\/]|file:)/.test(remote ?? "");
  const match = local ? null : REMOTE.exec(remote ?? "");
  const segments = match?.[2]?.split("/").filter(Boolean) ?? [];
  const name = segments.at(-1) ?? root.split("/").at(-1) ?? "repo";
  const owner = segments.slice(0, -1).join("/") || "local";
  const head = (await run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)).stdout;
  const defaultBranch = head.startsWith("origin/") ? head.slice("origin/".length) : (await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], root)).stdout || "main";
  return { root, owner, name, defaultBranch, ...(remote ? { remote } : {}), github: !local && remote !== undefined && githubRepoOf(remote) !== undefined };
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
 * The repository-level settings a fetch or push with the coordinator's login may run under. An
 * allowlist: anything else (agents can change these settings) means no credentialed step. Hooks
 * are listed because Petrina's git steps switch them off anyway. Remote names are plain words, so
 * no remote section can be named after the address Petrina uses.
 */
const SAFE_SETTING = new RegExp(
  [
    "core\\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|hookspath)",
    "extensions\\.(worktreeconfig|objectformat)",
    "remote\\.[^.:/@]+\\.(url|fetch|pushurl|tagopt|prune)",
    "branch\\..+\\.(remote|merge|rebase|pushremote|description)",
    "submodule\\..+\\.(url|active)",
    "user\\.(name|email)",
    "(gc\\.auto|gc\\.autodetach|pull\\.rebase|pull\\.ff|push\\.default|push\\.autosetupremote|fetch\\.prune|fetch\\.prunetags|lfs\\.repositoryformatversion)",
  ]
    .map((pattern) => `^${pattern}$`)
    .join("|"),
  "i",
);

/** The repository's own settings (agents can change them) that are not known to be safe for a credentialed step. */
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

export type Fetched = { ok: true; sha: string } | { ok: false; error: string; risky?: string[]; timedOut?: boolean };

/**
 * Fetch the default branch from the saved address into `origin/<branch>`. Fail closed: never with
 * the coordinator's login while the repository's settings could misuse it.
 */
export async function fetchBranch(root: string, remote: Remote, branch: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Fetched> {
  if (!NAME.test(branch) || remote.url.startsWith("-")) return { ok: false, error: "not a branch Petrina fetches" };
  const risky = await riskySettings(root);
  if (risky.length) return { ok: false, error: "unsafe git settings", risky };
  const fetched = await run(["git", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", remote.url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], root, undefined, {
    credentials: true,
    local: remote.local === true,
    timeoutMs,
  });
  if (fetched.timedOut) return { ok: false, error: "timed out", timedOut: true };
  if (fetched.code !== 0) return failed(fetched);
  const sha = await revParse(root, `refs/remotes/origin/${branch}`);
  return sha ? { ok: true, sha } : { ok: false, error: `no ${branch} after fetching` };
}

/** What GitHub has for these exact ref names (annotated tags also as `<ref>^{}`), asked of GitHub itself. */
export async function remoteRefs(root: string, remote: Remote, refs: readonly string[]): Promise<Check<Map<string, string>>> {
  if (refs.some((ref) => !NAME.test(ref)) || remote.url.startsWith("-")) return { ok: false, error: "not a ref Petrina looks up" };
  const risky = await riskySettings(root);
  if (risky.length) return { ok: false, error: `the repository's git settings include ${risky.slice(0, 3).join(", ")}` };
  const listed = await run(["git", "ls-remote", "--", remote.url, ...refs], root, undefined, { credentials: true, local: remote.local === true, timeoutMs: FETCH_TIMEOUT_MS });
  if (listed.code !== 0) return failed(listed);
  const found = new Map<string, string>();
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t");
    // ls-remote matches name endings: keep only the exact names asked for.
    if (sha && ref && FULL_SHA.test(sha) && refs.some((wanted) => ref === wanted || ref === `${wanted}^{}`)) found.set(ref, sha);
  }
  return { ok: true, value: found };
}

/**
 * Push exact commits to exact refs at the saved address. Never forced, so it only moves a branch
 * forward and refuses an existing tag; with `atomic`, all refs or none. Nothing else travels: no
 * tags followed, no submodules pushed, whatever the coordinator's settings say.
 */
export async function push(root: string, remote: Remote, updates: readonly { sha: string; ref: string }[], atomic = false): Promise<Check<void>> {
  if (!updates.length || updates.some((update) => !FULL_SHA.test(update.sha) || !/^refs\/(heads|tags)\//.test(update.ref) || !NAME.test(update.ref)) || remote.url.startsWith("-")) {
    return { ok: false, error: "not a push Petrina makes" };
  }
  const risky = await riskySettings(root);
  if (risky.length) return { ok: false, error: `the repository's git settings include ${risky.slice(0, 3).join(", ")}` };
  const pushed = await run(
    ["git", "push", "--quiet", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", ...(atomic ? ["--atomic"] : []), "--", remote.url, ...updates.map((update) => `${update.sha}:${update.ref}`)],
    root,
    undefined,
    { credentials: true, local: remote.local === true, timeoutMs: 5 * 60_000 },
  );
  return pushed.code === 0 ? { ok: true, value: undefined } : failed(pushed);
}

/** Create (or reuse) the task's worktree on its own branch, starting from `base`. */
export async function ensureWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  if (existsSync(path) && (await run(["git", "rev-parse", "--is-inside-work-tree"], path)).code === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await oneAtATime(root, async () => {
    const branchExists = (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).code === 0;
    if (branchExists) await must(["git", "worktree", "add", path, branch], root);
    else await must(["git", "worktree", "add", "-b", branch, path, base], root);
  });
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

/** Uncommitted work, one line per file. `tracked`: leave out files git does not track. */
export async function changes(path: string, tracked = false): Promise<string[]> {
  const result = await run(["git", "status", "--porcelain", ...(tracked ? ["--untracked-files=no"] : [])], path);
  if (result.code !== 0) return ["unreadable working copy"];
  return result.stdout.split("\n").filter(Boolean);
}

export async function mergeInProgress(path: string): Promise<boolean> {
  return (await run(["git", "rev-parse", "--verify", "--quiet", "MERGE_HEAD"], path)).code === 0;
}

/** The hooks git runs when committing, as the repository has them (core.hooksPath honoured): the ones that exist and git would run. */
export async function commitHooks(path: string): Promise<CommitHook[]> {
  const found: CommitHook[] = [];
  for (const name of COMMIT_HOOKS) {
    const where = await run(["git", "rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`], path, undefined, { ownHooks: true });
    if (where.code !== 0 || !where.stdout) continue;
    const mode = await stat(where.stdout).then((info) => (info.isFile() ? info.mode : undefined)).catch(() => undefined);
    // Git skips a hook it cannot execute, except on Windows, where it runs every hook through its own shell.
    if (mode !== undefined && (process.platform === "win32" || (mode & 0o111) !== 0)) found.push(name);
  }
  return found;
}

/**
 * Where a hook sees the task's whole change as about to be committed: the working copy's HEAD detached at
 * `base`, with its files and index left as they are. `reattach` puts it back on its branch.
 */
export async function detachAt(path: string, base: string): Promise<void> {
  if (!SHA.test(base)) throw new Error("Not a commit");
  await must(["git", "update-ref", "--no-deref", "HEAD", base], path);
}

/** The working copy back on its branch, with whatever a hook changed in files git tracks undone. */
export async function reattach(path: string, branch: string): Promise<void> {
  await must(["git", "symbolic-ref", "HEAD", `refs/heads/${branch}`], path);
  await run(["git", "reset", "--hard", "--quiet"], path);
}

/** The message of the working copy's last commit. */
export async function message(path: string): Promise<string> {
  return (await run(["git", "log", "-1", "--format=%B", "HEAD"], path)).stdout;
}

/** Whether files git tracks changed in the working copy (new files aside). */
export async function trackedChanged(path: string): Promise<boolean> {
  return (await run(["git", "status", "--porcelain", "--untracked-files=no"], path)).stdout !== "";
}

/** Put the files git tracks back as committed, leaving new files alone. */
export async function restoreTracked(path: string): Promise<void> {
  await run(["git", "reset", "--hard", "--quiet"], path);
}

/** Undo anything a read-only agent changed in its working copy. Also ends an unfinished merge. */
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

/** The tree a commit holds: the same code, whichever commit carries it. */
export async function treeOf(path: string, ref = "HEAD"): Promise<string | undefined> {
  const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{tree}`], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/**
 * The branch's work as one commit on top of where it forked from `base`, with the same code and `message`.
 * Returns how many commits it folded: 0 when it already was one commit with that message, or had none.
 */
export async function squash(path: string, base: string, message: string): Promise<number> {
  const fork = await mergeBase(path, "HEAD", base);
  if (!fork) return 0;
  const count = Number((await run(["git", "rev-list", "--count", `${fork}..HEAD`], path)).stdout);
  if (!(count > 0)) return 0;
  if (count === 1 && (await run(["git", "log", "-1", "--format=%B", "HEAD"], path)).stdout === message.trim()) return 0;
  // The commit is made first and the branch moves to it last, so a failure leaves the branch as it was.
  const sha = await must(["git", "commit-tree", "HEAD^{tree}", "-p", fork, "-F", "-"], path, message);
  if (!SHA.test(sha)) return 0;
  await must(["git", "reset", "--soft", "--quiet", sha], path);
  return count;
}

/** Where two commits' histories meet. */
export async function mergeBase(path: string, a: string, b: string): Promise<string | undefined> {
  const result = await run(["git", "merge-base", a, b], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/**
 * An exact fingerprint of the change from `from` to `to`: its whole diff, every character and space of it,
 * with only what moves when the same change sits on another commit left out (line numbers and blob ids).
 * Unlike git's patch-id it never ignores whitespace, which is meaning in Python, YAML or a Makefile.
 * "empty" for no change.
 */
export async function patchId(path: string, from: string, to: string): Promise<string | undefined> {
  const diff = await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--binary", "--full-index", "-U3", "--src-prefix=a/", "--dst-prefix=b/", from, to], path);
  if (diff.code !== 0) return undefined;
  if (!diff.stdout) return "empty";
  const placed = diff.stdout.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, "index").replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, "@@");
  return createHash("sha256").update(placed).digest("hex");
}

/**
 * This branch's change applied on top of `onto`, as a tree, without touching the working copy: a three-way
 * merge from where the two met. Conflicting files keep git's conflict markers in the tree.
 */
export async function mergeTree(path: string, onto: string, ref = "HEAD"): Promise<{ tree: string; conflicts: string[]; notes: string[] } | undefined> {
  const result = await run(["git", "merge-tree", "--write-tree", "--name-only", "-z", onto, ref], path);
  if (result.code !== 0 && result.code !== 1) return undefined;
  // -z: the tree, the conflicting files, an empty field, then each note as its path count, paths, kind and message.
  const fields = result.stdout.split("\0");
  const tree = fields[0] ?? "";
  if (!SHA.test(tree)) return undefined;
  const conflicts: string[] = [];
  let index = 1;
  for (; index < fields.length && fields[index] !== ""; index += 1) conflicts.push(fields[index]!);
  const notes: string[] = [];
  for (index += 1; index < fields.length; ) {
    const count = Number(fields[index]);
    if (!Number.isInteger(count) || count < 0) break;
    const message = fields[index + count + 2];
    if (message) notes.push(message.trim());
    index += count + 3;
  }
  return { tree, conflicts: [...new Set(conflicts)], notes: notes.filter((note) => note.startsWith("CONFLICT")) };
}

/** A commit of `tree` on top of `parent`, made without hooks and without touching any working copy. */
export async function commitTree(path: string, tree: string, parent: string, message: string): Promise<string> {
  const sha = await must(["git", "commit-tree", tree, "-p", parent, "-F", "-"], path, message);
  if (!SHA.test(sha)) throw new Error("git commit-tree did not return a commit");
  return sha;
}

/** Move the working copy's branch to `sha`. It refuses, changing nothing, rather than lose a change in the way. */
export async function moveTo(path: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error("Not a commit");
  await must(["git", "reset", "--keep", "--quiet", sha], path);
}

/**
 * The branch on `onto`, with the working copy and index holding `tree` (a merge's result, conflict markers
 * and all) as changes not committed yet: what an agent resolves and Petrina then commits.
 */
export async function openOn(path: string, onto: string, tree: string): Promise<void> {
  if (!SHA.test(onto) || !SHA.test(tree)) throw new Error("Not a commit or tree");
  await must(["git", "reset", "--soft", "--quiet", onto], path);
  await must(["git", "read-tree", "-u", "--reset", tree], path);
}

/** Files that still hold git's conflict markers, out of `paths`. */
export async function withMarkers(path: string, paths: readonly string[]): Promise<string[]> {
  const marked: string[] = [];
  for (const file of paths) {
    const text = await readFile(join(path, file), "utf8").catch(() => "");
    if (/^(<{7}|>{7})( |$)/m.test(text) || /^={7}$/m.test(text)) marked.push(file);
  }
  return marked;
}

export async function resetTo(path: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) return;
  await run(["git", "reset", "--hard", "--quiet", sha], path);
}

export async function head(path: string): Promise<string> {
  return must(["git", "rev-parse", "HEAD"], path);
}

/** The branch a working copy has open, or undefined when it has none (a detached copy). */
export async function currentBranch(path: string): Promise<string | undefined> {
  const result = await run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], path);
  return result.code === 0 && result.stdout ? result.stdout : undefined;
}

/** Open an existing local branch in a working copy. */
export async function switchTo(path: string, branch: string): Promise<Check<void>> {
  if (!NAME.test(branch)) return { ok: false, error: "not a branch Petrina opens" };
  const switched = await run(["git", "switch", "--quiet", "--no-guess", branch], path);
  return switched.code === 0 ? { ok: true, value: undefined } : failed(switched);
}

/** The commit a ref or sha names, or undefined when there is none. */
export async function revParse(path: string, ref: string): Promise<string | undefined> {
  if (ref.startsWith("-")) return undefined;
  const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/** Does `descendant` contain `ancestor`? */
export async function contains(path: string, descendant: string, ancestor: string): Promise<boolean> {
  if (!SHA.test(descendant) || !SHA.test(ancestor)) return false;
  return (await run(["git", "merge-base", "--is-ancestor", ancestor, descendant], path)).code === 0;
}

export async function parents(path: string, sha: string): Promise<string[]> {
  if (!SHA.test(sha)) return [];
  return (await run(["git", "rev-list", "--parents", "--max-count=1", sha], path)).stdout.split(/\s+/).filter(Boolean).slice(1);
}

/** Files that differ between two commits. */
export async function changedFiles(path: string, from: string, to: string): Promise<string[]> {
  if (!SHA.test(from) || !SHA.test(to)) return [];
  return (await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from, to], path)).stdout.split("\0").filter(Boolean);
}

/**
 * The commits in `range` (`from..to`, or everything up to `to`), oldest first, with their messages: the `max` most
 * recent at most. Merge commits are left out: the commits they bring in are listed themselves.
 */
export async function commitMessages(path: string, range: string, max: number): Promise<{ sha: string; message: string }[]> {
  const [from, to] = range.includes("..") ? range.split("..") : [undefined, range];
  if (!SHA.test(to ?? "") || (from !== undefined && !SHA.test(from))) return [];
  const listed = await run(["git", "log", "--no-merges", "--reverse", `--max-count=${max}`, "--format=%H%x1f%B%x1e", range], path);
  if (listed.code !== 0) return [];
  return listed.stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, message] = entry.split("\x1f");
      return { sha: sha!.trim(), message: (message ?? "").trim() };
    });
}

/** The working copies where `branch` is checked out. */
export async function checkedOut(root: string, branch: string): Promise<string[]> {
  const listed = await run(["git", "worktree", "list", "--porcelain", "-z"], root);
  const places: string[] = [];
  let at = "";
  for (const line of listed.stdout.split("\0")) {
    if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) places.push(at);
  }
  return places;
}

/**
 * Move a local branch forward from `from` to `to`, with no network and never a merge commit. The
 * branch moves only if it is still at `from`, in one step, so a branch that moved meanwhile is
 * refused. Checked out in `root`, its files then follow with git's own fast-forward of the files from
 * `from` to `to`, which refuses to overwrite any change; when it cannot, the branch goes back.
 *
 * Throughout, Petrina holds git's own lock on the main copy's staging area, the one every switch,
 * commit and add takes first: the copy cannot switch branches halfway, so the update never lands
 * on another branch. A copy that switched just before is refused, and nothing changes.
 */
export async function fastForward(root: string, branch: string, from: string, to: string, checkedOutHere: boolean): Promise<Check<void>> {
  if (!NAME.test(branch) || !FULL_SHA.test(from) || !FULL_SHA.test(to)) return { ok: false, error: "not an update Petrina makes" };
  if (!(await contains(root, to, from))) return { ok: false, error: `${to.slice(0, 7)} is not ahead of ${from.slice(0, 7)}` };
  const ref = `refs/heads/${branch}`;
  const located = await run(["git", "rev-parse", "--git-path", "index"], root);
  if (located.code !== 0) return failed(located);
  const index = resolve(root, located.stdout);
  const lock = `${index}.lock`;
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    return { ok: false, error: "another git command was working in the main copy at that moment" };
  }
  let installed = false;
  try {
    if (((await currentBranch(root)) === branch) !== checkedOutHere) return { ok: false, error: `the main copy switched branches at that moment, so ${branch} stays where it was` };
    if (checkedOutHere) {
      // The staging area as it is, in the lock: nothing staged, and no switch left half done.
      writeFileSync(lock, readFileSync(index));
      if ((await run(["git", "diff-index", "--cached", "--quiet", from, "--"], root, undefined, { index: lock })).code !== 0) {
        return { ok: false, error: `the main copy's staging area is not ${branch}'s, so ${branch} stays where it was` };
      }
    }
    const moved = await run(["git", "update-ref", "-m", "Delivered by Petrina", ref, to, from], root);
    if (moved.code !== 0) return failed(moved);
    if (!checkedOutHere) return { ok: true, value: undefined };
    await run(["git", "update-index", "-q", "--refresh"], root, undefined, { index: lock });
    const files = await run(["git", "read-tree", "-m", "-u", from, to], root, undefined, { index: lock });
    // A switch already past the staging area before the lock: its files go back, and so does the branch.
    const stayed = files.code === 0 && (await currentBranch(root)) === branch;
    if (!stayed) {
      if (files.code === 0) await run(["git", "read-tree", "-m", "-u", to, from], root, undefined, { index: lock });
      await run(["git", "update-ref", "-m", "Petrina could not update the files", ref, from, to], root);
      return files.code === 0 ? { ok: false, error: `the main copy switched branches at that moment, so ${branch} stays where it was` } : failed(files);
    }
    renameSync(lock, index);
    installed = true;
    return { ok: true, value: undefined };
  } finally {
    if (!installed) rmSync(lock, { force: true });
  }
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

/** How many commits `to` (the working copy's branch, unless given) has on top of `sha`. */
export async function commitsSince(path: string, sha: string, to = "HEAD"): Promise<number> {
  if (!SHA.test(sha)) return 0;
  return Number((await run(["git", "rev-list", "--count", `${sha}..${to}`], path)).stdout) || 0;
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

export async function removeWorktree(root: string, path: string): Promise<void> {
  await oneAtATime(root, () => run(["git", "worktree", "remove", "--force", path], root));
}

/**
 * A working copy of one commit for one agent alone (a reviewer working beside others): detached, so it
 * shares no branch, index or HEAD with the task's own copy. Nothing is installed in it.
 */
export async function addCopy(root: string, path: string, sha: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await oneAtATime(root, () => must(["git", "worktree", "add", "--detach", "--quiet", path, sha], root));
}

/** Remove every copy in a folder, and git's record of them, whatever state they were left in. */
export async function removeCopies(root: string, folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  await oneAtATime(root, async () => {
    for (const name of names) await run(["git", "worktree", "remove", "--force", join(folder, name)], root);
    await rm(folder, { recursive: true, force: true });
    await run(["git", "worktree", "prune"], root);
  });
}

// ── GitHub, through gh pinned to the product's repository ──────────────────

export interface PullRequestInfo {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  head: string;
  base: string;
  /** The latest commit of its branch, as GitHub has it (kept after the branch is deleted). */
  commit: string;
  /** Opened from a fork: not this repository's branch. */
  fork: boolean;
}

const LIST_LIMIT = 100;
/**
 * gh's answer for a release that is not there. GitHub gives the same answer for a repository the
 * login cannot see, so it only counts once `canSee` says the login sees the repository.
 */
const noRelease = (result: RunResult) => /^release not found$/im.test(result.stderr);

/**
 * Does the coordinator's GitHub login see the product's repository? Asked before any "not there"
 * counts: GitHub answers "not found" alike for a missing release and a repository the login cannot see.
 */
export async function canSee(repo: string, cmd: Gh = GH): Promise<Check<void>> {
  if (!REPO.test(repo)) return { ok: false, error: `not a GitHub repository: ${repo}` };
  const result = await run([...cmd, "repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], tmpdir(), undefined, { credentials: true, timeoutMs: FETCH_TIMEOUT_MS });
  if (result.code !== 0) return { ok: false, error: `your GitHub login cannot see ${repo} (${failed(result).error})` };
  return result.stdout.toLowerCase() === repo.toLowerCase() ? { ok: true, value: undefined } : { ok: false, error: `GitHub answered for ${result.stdout || "another repository"}, not ${repo}` };
}

/** "Not there", once the login is known to see the repository; otherwise why GitHub could not say. */
async function notThere<T>(repo: string, cmd: Gh): Promise<Check<T | undefined>> {
  const seen = await canSee(repo, cmd);
  return seen.ok ? { ok: true, value: undefined } : seen;
}

const stateOf = (value: unknown): "open" | "merged" | "closed" => {
  const state = String(value ?? "").toLowerCase();
  return state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
};

export async function prState(repo: string, number: number, cmd: Gh = GH): Promise<"open" | "merged" | "closed" | undefined> {
  const result = await gh(cmd, repo, ["pr", "view", String(number), "--json", "state", "--jq", ".state"]);
  if (result.code !== 0) return undefined;
  return stateOf(result.stdout);
}

/**
 * Every pull request from this branch, open, closed or merged. A listing that may be cut short does
 * not count, and an empty one only once the login is known to see the repository.
 */
export async function pullRequests(repo: string, branch: string, cmd: Gh = GH): Promise<Check<PullRequestInfo[]>> {
  if (!NAME.test(branch)) return { ok: false, error: "not a branch Petrina looks up" };
  const result = await gh(cmd, repo, ["pr", "list", "--head", branch, "--state", "all", "--limit", String(LIST_LIMIT), "--json", "number,url,state,headRefName,baseRefName,headRefOid,isCrossRepository"]);
  if (result.code !== 0) return failed(result);
  try {
    const list = JSON.parse(result.stdout) as Record<string, unknown>[];
    if (!Array.isArray(list)) return { ok: false, error: "GitHub's answer was not readable" };
    if (list.length >= LIST_LIMIT) return { ok: false, error: "GitHub listed too many pull requests to check them all" };
    const prs: PullRequestInfo[] = [];
    for (const entry of list) {
      if (typeof entry.number !== "number" || typeof entry.url !== "string" || typeof entry.headRefName !== "string" || typeof entry.baseRefName !== "string" || typeof entry.headRefOid !== "string") {
        return { ok: false, error: "GitHub's answer was not readable" };
      }
      prs.push({ number: entry.number, url: entry.url, state: stateOf(entry.state), head: entry.headRefName, base: entry.baseRefName, commit: entry.headRefOid, fork: entry.isCrossRepository === true });
    }
    if (!prs.length) {
      const seen = await canSee(repo, cmd);
      if (!seen.ok) return seen;
    }
    return { ok: true, value: prs };
  } catch {
    return { ok: false, error: "GitHub's answer was not readable" };
  }
}

export type Created = { ok: true; url: string } | { ok: false; exists: boolean; error: string };

/** Open a pull request from an already pushed branch. The title and body stay text: arguments and standard input, never a shell. */
export async function openPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string }, cmd: Gh = GH): Promise<Created> {
  if (!NAME.test(pr.head) || !NAME.test(pr.base)) return { ok: false, exists: false, error: "not a branch Petrina publishes" };
  const result = await gh(cmd, repo, ["pr", "create", "--head", pr.head, "--base", pr.base, `--title=${pr.title}`, "--body-file", "-"], pr.body);
  return created(result);
}

function created(result: RunResult): Created {
  if (result.code === 0) return { ok: true, url: result.stdout.split("\n").find((line) => line.startsWith("https://")) ?? result.stdout };
  return { ok: false, exists: /already exists/i.test(`${result.stderr}\n${result.stdout}`), error: failed(result).error };
}

/** The latest published release's tag; undefined only when the login sees the repository and it has none. */
export async function latestRelease(repo: string, cmd: Gh = GH): Promise<Check<string | undefined>> {
  const result = await gh(cmd, repo, ["release", "view", "--json", "tagName"]);
  if (result.code !== 0) return noRelease(result) ? notThere(repo, cmd) : failed(result);
  try {
    const tag = (JSON.parse(result.stdout) as { tagName?: unknown }).tagName;
    return typeof tag === "string" ? { ok: true, value: tag } : { ok: false, error: "GitHub's answer was not readable" };
  } catch {
    return { ok: false, error: "GitHub's answer was not readable" };
  }
}

/** The release for a tag; undefined only when the login sees the repository and it has none. */
export async function findRelease(repo: string, tag: string, cmd: Gh = GH): Promise<Check<{ tag: string; url: string; draft: boolean } | undefined>> {
  if (!NAME.test(tag)) return { ok: false, error: "not a tag Petrina looks up" };
  const result = await gh(cmd, repo, ["release", "view", tag, "--json", "tagName,url,isDraft"]);
  if (result.code !== 0) return noRelease(result) ? notThere(repo, cmd) : failed(result);
  try {
    const parsed = JSON.parse(result.stdout) as { tagName?: unknown; url?: unknown; isDraft?: unknown };
    if (typeof parsed.tagName !== "string" || typeof parsed.url !== "string") return { ok: false, error: "GitHub's answer was not readable" };
    return { ok: true, value: { tag: parsed.tagName, url: parsed.url, draft: parsed.isDraft === true } };
  } catch {
    return { ok: false, error: "GitHub's answer was not readable" };
  }
}

/** Publish the release on a tag already on GitHub: it can never create or pick another tag. */
export async function createRelease(repo: string, tag: string, notes: string, cmd: Gh = GH): Promise<Created> {
  if (!NAME.test(tag)) return { ok: false, exists: false, error: "not a tag Petrina publishes" };
  const result = await gh(cmd, repo, ["release", "create", tag, "--verify-tag", `--title=${tag}`, "--notes-file", "-"], notes);
  return created(result);
}
