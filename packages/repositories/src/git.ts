// Local Git operations. Every command is an argument array: nothing goes through a shell.
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
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CLEANUP_WORDS } from "@petrina/core";
import { REMOTE, githubRepoOf, isRefName, isBranchName, isSha } from "./identity.js";
export { githubRepoOf, githubRepo, sameRepo, isRefName, isRepoName, isBranchName, isSha } from "./identity.js";
export { copyFolderName } from "./copy-name.js";

import { withGitConfig, withoutCredentials } from "@petrina/platform/process-environment";
import { completeAll } from "@petrina/core";
import { EXIT_GRACE_MS, lostExit } from "@petrina/platform/process-tree";
import { localFiles, type FileOperations } from "@petrina/platform/file-operations";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command did not finish as far as Petrina can tell: stopped at its time limit, or its exit was never reported. */
  timedOut?: boolean;
  /** The process was observed gone or defunct, but its exit was never reported; its result is unknown. */
  exitUnreported?: boolean;
  /** No program started. Exit numbers alone cannot distinguish this from a program's own answer. */
  startFailure?: StartFailure;
}

export interface StartFailure {
  kind: "missing-executable" | "temporary-directory" | "working-directory" | "permission" | "other";
  message: string;
  systemCode?: string;
}

export { EXIT_GRACE_MS } from "@petrina/platform/process-tree";
export const EXIT_UNREPORTED = "Git finished, but the system did not report its exit";
export const OUTPUT_INCOMPLETE = "Git finished, but its output did not finish arriving";
export const OUTPUT_UNREADABLE = "Git's output could not be read";

/** The `gh` command to run. A host can provide an explicit scripted GitHub peer. */
export type Gh = readonly string[];

/**
 * Where Petrina fetches from and publishes to: the product's saved address. `local`: a test
 * stand-in for GitHub (a folder), explicitly provided by the host.
 */
export interface Remote {
  url: string;
  local?: boolean;
}

/** An answer from GitHub, or why there is none. "Not there" and "could not ask" never look alike. */
export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

/** Full or abbreviated native object ids, for either Git object format. */
const SHA = /^[0-9a-f]{7,64}$/i;

let empty: string | undefined;
/** Empty folders for "no hooks", "no gh login" and "no grafts", made once per process. */
function emptyDir(name: "hooks" | "gh" | "grafts"): string {
  if (!empty) {
    // Test engines already have their own disposable home. Keep their helpers there too, so
    // the parent fixture removes them after a forced stop instead of filling the shared temp folder.
    const parent = process.env.PETRINA_HOME ? join(process.env.PETRINA_HOME, "runtime-tmp") : tmpdir();
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const owned = mkdtempSync(join(parent, "petrina-none-"));
    empty = owned;
    process.once("exit", () => {
      try { rmSync(owned, { recursive: true, force: true }); } catch { /* The system can reclaim an inaccessible empty folder. */ }
    });
  }
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
  // Replace objects could make a commit Petrina pinned show different content, and a grafts file (info/grafts,
  // read in place of one that never exists) different parents, hiding commits from history Petrina checks.
  return { ...withGitConfig(base, settings), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: join(emptyDir("grafts"), "none"), ...(credentials ? { GH_PROMPT_DISABLED: "1" } : {}) };
}

/** The hooks git runs when it commits, in the order it runs them. */
export const COMMIT_HOOKS = ["pre-commit", "commit-msg"] as const;
export type CommitHook = (typeof COMMIT_HOOKS)[number];


/** How long Petrina waits for GitHub before giving up on a lookup or a fetch. */
export const FETCH_TIMEOUT_MS = 30_000;

function systemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Only an absent file is evidence of a missing program; unreadable files are not. */
function absent(path: string): boolean {
  try { statSync(path); return false; }
  catch (error) { return ["ENOENT", "ENOTDIR"].includes(systemCode(error) ?? ""); }
}

function launchFailure(error: unknown, command: string | undefined, cwd: string): StartFailure["kind"] {
  const code = systemCode(error);
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "ENOENT" || code === "ENOTDIR") {
    const message = error instanceof Error ? error.message : String(error);
    const file = command && (command.includes("/") || (process.platform === "win32" && command.includes("\\")));
    if ((file && absent(resolve(cwd, command))) || (!file && code === "ENOENT" && message.startsWith("Executable not found in $PATH:"))) return "missing-executable";
    try { if (!statSync(cwd).isDirectory()) return "working-directory"; }
    catch (cause) { if (["ENOENT", "ENOTDIR"].includes(systemCode(cause) ?? "")) return "working-directory"; }
  }
  return "other";
}

function neverStarted(error: unknown, kind: StartFailure["kind"]): RunResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = systemCode(error);
  // Preserve the legacy number and message for callers that handle all command failures alike.
  return { code: 127, stdout: "", stderr: message, startFailure: { kind, message, ...(code ? { systemCode: code } : {}) } };
}

/** Private native launch boundary for command-lifecycle contracts, retaining real process handles and pipes. */
export type RunStart = (command: readonly string[], options: {
  cwd: string;
  stdin: "ignore" | Blob;
  stdout: "pipe";
  stderr: "pipe";
  env: NodeJS.ProcessEnv;
  windowsHide: true;
}) => ReturnType<typeof Bun.spawn>;

export async function run(cmd: readonly string[], cwd: string, input?: string, options: { credentials?: boolean; local?: boolean; timeoutMs?: number; ownHooks?: boolean; index?: string; rawOutput?: boolean; start?: RunStart } = {}): Promise<RunResult> {
  let env: NodeJS.ProcessEnv;
  try {
    env = { ...gitEnv(options.credentials === true, { local: options.local === true, ownHooks: options.ownHooks === true }), ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) };
  } catch (error) {
    return neverStarted(error, "temporary-directory");
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    const settings = {
      cwd,
      stdin: input === undefined ? "ignore" as const : new Blob([input]),
      stdout: "pipe" as const,
      stderr: "pipe" as const,
      env,
      windowsHide: true as const,
    };
    proc = options.start ? options.start([...cmd], settings) : Bun.spawn([...cmd], settings);
  } catch (error) {
    return neverStarted(error, launchFailure(error, cmd[0], cwd));
  }
  // Read while the process writes: a saved file can exceed the pipe's capacity before Git exits.
  const readers = [proc.stdout, proc.stderr].map(stream => (stream as ReadableStream<Uint8Array>).getReader());
  const captured = ["", ""];
  const output = Promise.all(readers.map(async (reader, index) => {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: options.rawOutput === true && index === 0 });
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        captured[index] += decoder.decode(next.value, { stream: true });
      }
      captured[index] += decoder.decode();
    } finally { reader.releaseLock(); }
  }));
  // The deadline covers both exit and output. An exited parent's helper can retain a pipe; a
  // lost runtime notification can leave BOTH its exit and its output pending. Watch process state
  // independently of pipe completion, and never infer success from closed pipes or a dead process.
  const watch = new AbortController();
  const lost = typeof proc.pid === "number" ? lostExit(proc.pid, watch.signal) : new Promise<never>(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const deadline = options.timeoutMs ? new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), options.timeoutMs))) : undefined;
  const complete = Promise.all([proc.exited, output]).then(([code]) => ({ code }), error => ({ error }));
  const drainDeadline = proc.exited.then(() => new Promise<"output-incomplete">((resolve) => {
    if (!settled) drainTimer = setTimeout(() => resolve("output-incomplete"), EXIT_GRACE_MS);
  }), () => new Promise<never>(() => {}));
  const first = await Promise.race([complete, lost, drainDeadline, ...(deadline ? [deadline] : [])]);
  settled = true;
  watch.abort();
  clearTimeout(timer);
  clearTimeout(drainTimer);
  const out = () => options.rawOutput ? captured[0]! : captured[0]!.trim();
  if (typeof first !== "object" || "error" in first) {
    // A process already observed ended needs no signal; a collected PID can belong to somebody else.
    if (first !== "lost" && first !== "output-incomplete" && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* Already gone. */ }
    }
    for (const reader of readers) void reader.cancel().catch(() => undefined);
    const reason = first === "lost" ? EXIT_UNREPORTED : first === "output-incomplete" ? OUTPUT_INCOMPLETE : typeof first === "object" ? `${OUTPUT_UNREADABLE}: ${String(first.error)}` : "timed out";
    return { code: 124, stdout: out(), stderr: [captured[1]!.trim(), reason].filter(Boolean).join("\n"), timedOut: true, ...(first === "lost" ? { exitUnreported: true } : {}) };
  }
  return { code: first.code, stdout: out(), stderr: captured[1]!.trim() };
}

/** A file as committed at `ref`, read straight from git's objects: no filters, no links followed. Undefined when absent. */
export async function fileAt(root: string, ref: string, path: string, timeoutMs = 30_000): Promise<string | undefined> {
  if (ref.startsWith("-") || path.startsWith("-")) return undefined;
  const result = await run(["git", "cat-file", "blob", `${ref}:${path}`], root, undefined, { timeoutMs, rawOutput: true });
  if (result.timedOut) throw new Error("Git did not finish reading the repository's saved files");
  if (result.startFailure) throw new Error(`Git could not read the repository's saved files: ${result.startFailure.message}`, { cause: result.startFailure });
  if (result.code === 127) throw new Error("Git could not read the repository's saved files");
  return result.code === 0 ? result.stdout : undefined;
}

async function must(cmd: readonly string[], cwd: string, input?: string): Promise<string> {
  const result = await run(cmd, cwd, input);
  if (result.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export const commandFailure = (result: RunResult): { ok: false; error: string } => ({ ok: false, error: (result.stderr || result.stdout || `exit ${result.code}`).slice(0, 300) });

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



/** The origin address exactly as configured: `git remote get-url` would apply address rewrites. */
export async function remoteAddress(root: string): Promise<string | undefined> {
  const result = await run(["git", "config", "--get", "remote.origin.url"], root);
  return result.code === 0 && result.stdout ? result.stdout : undefined;
}

/** Read what Petrina needs about a local clone, from the folder or any folder inside it. */
export async function repoInfo(path: string): Promise<RepoInfo> {
  const root = await must(["git", "rev-parse", "--show-toplevel"], path);
  const [remote, branch] = await Promise.all([
    remoteAddress(root), run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root),
  ]);
  // A folder on this computer (C:\ or C:/ on Windows included) has no host: the product goes by its own folder.
  const local = /^(?:[A-Za-z]:[\\/]|[\\/]|file:)/.test(remote ?? "");
  const match = local ? null : REMOTE.exec(remote ?? "");
  const segments = match?.[2]?.split("/").filter(Boolean) ?? [];
  const name = segments.at(-1) ?? root.split("/").at(-1) ?? "repo";
  const owner = segments.slice(0, -1).join("/") || "local";
  const head = branch.stdout;
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
  if (!isRefName(branch) || remote.url.startsWith("-")) return { ok: false, error: "not a branch Petrina fetches" };
  return fetchRef(root, remote, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`, timeoutMs);
}

/** Fetch an approved source, including a fork PR through the product repository’s PR reference. */
export async function fetchRef(root: string, remote: Remote, from: string, to: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Fetched> {
  if (!isRefName(from) || !isRefName(to) || remote.url.startsWith("-")) return { ok: false, error: "not a source Petrina fetches" };
  const risky = await riskySettings(root);
  if (risky.length) return { ok: false, error: "unsafe git settings", risky };
  const fetched = await run(["git", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", remote.url, `+${from}:${to}`], root, undefined, {
    credentials: true,
    local: remote.local === true,
    timeoutMs,
  });
  if (fetched.timedOut) return { ok: false, error: "timed out", timedOut: true };
  if (fetched.code !== 0) return commandFailure(fetched);
  const sha = await revParse(root, to);
  return sha ? { ok: true, sha } : { ok: false, error: `no ${from} after fetching` };
}

/** What GitHub has for these exact ref names (annotated tags also as `<ref>^{}`), asked of GitHub itself. */
export async function remoteRefs(root: string, remote: Remote, refs: readonly string[]): Promise<Check<Map<string, string>>> {
  if (refs.some((ref) => !isRefName(ref)) || remote.url.startsWith("-")) return { ok: false, error: "not a ref Petrina looks up" };
  const risky = await riskySettings(root);
  if (risky.length) return { ok: false, error: `the repository's git settings include ${risky.slice(0, 3).join(", ")}` };
  const listed = await run(["git", "ls-remote", "--", remote.url, ...refs], root, undefined, { credentials: true, local: remote.local === true, timeoutMs: FETCH_TIMEOUT_MS });
  if (listed.code !== 0) return commandFailure(listed);
  const found = new Map<string, string>();
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t");
    // ls-remote matches name endings: keep only the exact names asked for.
    if (sha && ref && isSha(sha) && refs.some((wanted) => ref === wanted || ref === `${wanted}^{}`)) found.set(ref, sha);
  }
  return { ok: true, value: found };
}

/**
 * Push exact commits to exact refs at the saved address. Never forced, so it only moves a branch
 * forward and refuses an existing tag; with `atomic`, all refs or none. Nothing else travels: no
 * tags followed, no submodules pushed, whatever the coordinator's settings say.
 */
export async function push(root: string, remote: Remote, updates: readonly { sha: string; ref: string }[], atomic = false): Promise<Check<void>> {
  if (!updates.length || updates.some((update) => !isSha(update.sha) || !/^refs\/(heads|tags)\//.test(update.ref) || !isRefName(update.ref)) || remote.url.startsWith("-")) {
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
  return pushed.code === 0 ? { ok: true, value: undefined } : commandFailure(pushed);
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

/** One status process supplies both the checked-out commit and tracked/untracked cleanliness. */
export async function worktreeStatus(path: string): Promise<{ head?: string; clean: boolean; trackedChanged: boolean }> {
  const text = await must(["git", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"], path);
  const lines = text.split("\n").filter(Boolean);
  const head = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13);
  const changes = lines.filter((line) => !line.startsWith("#"));
  return { ...(head && SHA.test(head) ? { head } : {}), clean: !changes.length, trackedChanged: changes.some((line) => !line.startsWith("? ")) };
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
  return (await commitHookFiles(path)).map((hook) => hook.name);
}

/** The executable hook files, including local hooks outside the committed tree. */
export async function commitHookFiles(path: string): Promise<{ name: CommitHook; path: string }[]> {
  const where = await run(["git", "rev-parse", "--path-format=absolute", ...COMMIT_HOOKS.flatMap((name) => ["--git-path", `hooks/${name}`])], path, undefined, { ownHooks: true });
  if (where.code !== 0) return [];
  const paths = where.stdout.split("\n");
  const hooks = await Promise.all(COMMIT_HOOKS.map(async (name, index) => {
    const file = paths[index];
    if (!file) return [];
    const mode = await stat(file).then(info => info.isFile() ? info.mode : undefined).catch(() => undefined);
    // Git requires executable hooks, except on Windows where its shell runs them.
    return mode !== undefined && (process.platform === "win32" || (mode & 0o111) !== 0) ? [{ name, path: file }] : [];
  }));
  return hooks.flat();
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

/** The message at a captured commit, or the working copy's current HEAD. */
export async function message(path: string, ref = "HEAD"): Promise<string> {
  return (await run(["git", "log", "-1", "--format=%B", ref], path)).stdout;
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

/** Resolve HEAD once, returning the commit and the tree it actually holds. */
export async function commitVersion(path: string): Promise<{ head?: string; tree?: string }> {
  const result = await run(["git", "show", "--no-patch", "--format=%H%n%T", "HEAD"], path);
  if (result.code !== 0) return {};
  const [head, tree] = result.stdout.split("\n");
  return head && tree && SHA.test(head) && SHA.test(tree) ? { head, tree } : {};
}

/** The tree a commit holds: the same code, whichever commit carries it. */
export async function treeOf(path: string, ref = "HEAD"): Promise<string | undefined> {
  const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{tree}`], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/** Observe all committable contents without changing the real staging area. */
export async function contentTree(path: string): Promise<string | undefined> {
  const status = await worktreeStatus(path);
  if (status.clean && status.head) return treeOf(path, status.head);
  const folder = mkdtempSync(join(tmpdir(), "petrina-content-tree-"));
  const options = { index: join(folder, "index") };
  try {
    if ((await run(["git", "read-tree", "HEAD"], path, undefined, options)).code !== 0) return;
    if ((await run(["git", "add", "-A"], path, undefined, options)).code !== 0) return;
    const tree = await run(["git", "write-tree"], path, undefined, options);
    return tree.code === 0 && SHA.test(tree.stdout) ? tree.stdout : undefined;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/**
 * The branch's work as one commit on top of its resolved fork, with the same code and `message`.
 * The caller resolves the fork first. Return the exact resulting commit/tree without another observation.
 */
export async function squash(path: string, fork: string, message: string): Promise<{ head: string; tree: string }> {
  if (!isSha(fork)) throw new Error("Not a complete fork commit");
  // Read recorded parents rather than the optional commit graph. A direct single parent proves
  // there is already exactly one task commit, without walking/counting the whole branch.
  const [head, tree, parents, ...body] = (await must(["git", "-c", "core.commitGraph=false", "show", "--no-patch", "--format=%H%n%T%n%P%n%B", "HEAD"], path)).split("\n");
  if (!head || !tree || !isSha(head) || !isSha(tree)) throw new Error("The task's current commit could not be read");
  if (head === fork || (parents === fork && body.join("\n").trim() === message.trim())) return { head, tree };
  // The commit is made first and the branch moves to it last, so a failure leaves the branch as it was.
  const sha = await must(["git", "commit-tree", tree, "-p", fork, "-F", "-"], path, message);
  if (!isSha(sha)) throw new Error("The folded task commit could not be created");
  await must(["git", "reset", "--soft", "--quiet", sha], path);
  return { head: sha, tree };
}

/**
 * Parents as the commits themselves record them, for reads a decision about history rests on. Git's commit index
 * (commit-graph) is an optional cache of each commit's parents, and an edited one can report others.
 */
const FROM_COMMITS = ["-c", "core.commitGraph=false"] as const;

/** Where two commits' histories meet. */
export async function mergeBase(path: string, a: string, b: string, fromCommits = false): Promise<string | undefined> {
  const result = await run(["git", ...(fromCommits ? FROM_COMMITS : []), "merge-base", a, b], path);
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

/** A file at the root of `ref`'s tree, with its mode, when it is a plain file there (not a link, folder or submodule). */
export async function plainFileAt(path: string, ref: string, name: string): Promise<{ mode: string; text: string } | undefined> {
  if (ref.startsWith("-") || name.startsWith("-") || name.includes("/")) return undefined;
  const listed = await run(["git", "ls-tree", "-z", ref, "--", name], path, undefined, { rawOutput: true });
  const entry = /^(100644|100755) blob [0-9a-f]+\t([^\0]*)\0$/.exec(listed.stdout);
  if (listed.code !== 0 || !entry || entry[2] !== name) return undefined;
  const text = await fileAt(path, ref, name);
  return text === undefined ? undefined : { mode: entry[1]!, text };
}

/**
 * Every version of the root file `name` in the commits `to` has and `from` has not, merged branches included, with
 * the versions they changed it from. Each commit is compared with every parent, from the trees and the commits
 * themselves, so a version whose saved copy is unavailable fails the read rather than passing for a commit without
 * the file. A shallow copy may lack some of those commits, so it fails too.
 */
export async function versionsBetween(path: string, from: string, to: string, name: string): Promise<string[]> {
  if (!SHA.test(from) || !SHA.test(to) || name.startsWith("-") || name.includes("/")) throw new Error("Not a commit or a root file");
  if ((await must(["git", "rev-parse", "--is-shallow-repository"], path)) !== "false") throw new Error("Part of the history is not in this copy");
  const commits = await must(["git", ...FROM_COMMITS, "rev-list", `${from}..${to}`], path);
  if (!commits) return [];
  const changes = await must(["git", ...FROM_COMMITS, "diff-tree", "--stdin", "-m", "--root", "--no-renames", "--raw", "--", name], path, `${commits}\n`);
  const blobs = new Set(changes.split("\n").flatMap((line) => /^:\d{6} \d{6} ([0-9a-f]+) ([0-9a-f]+) /.exec(line)?.slice(1) ?? []).filter((oid) => !/^0+$/.test(oid)));
  const versions: string[] = [];
  // One at a time: a file changed many times should not start a burst of processes.
  for (const blob of blobs) {
    const read = await run(["git", "cat-file", "blob", blob], path, undefined, { rawOutput: true });
    if (read.code !== 0) throw new Error(`git cat-file failed: ${read.stderr}`);
    versions.push(read.stdout);
  }
  return versions;
}

/** `tree` with the root file `name` holding `text`, written without touching any working copy or its staging area. */
export async function withRootFile(path: string, tree: string, name: string, mode: string, text: string): Promise<string> {
  if (!SHA.test(tree) || !/^100(644|755)$/.test(mode) || name.includes("/")) throw new Error("Not a tree or a plain file");
  const blob = await must(["git", "hash-object", "-w", "--stdin"], path, text);
  if (!SHA.test(blob)) throw new Error("git hash-object did not return a file");
  const folder = mkdtempSync(join(tmpdir(), "petrina-file-tree-"));
  const options = { index: join(folder, "index") };
  try {
    for (const cmd of [["git", "read-tree", tree], ["git", "update-index", "--add", "--cacheinfo", `${mode},${blob},${name}`]]) {
      const result = await run(cmd, path, undefined, options);
      if (result.code !== 0) throw new Error(`${cmd.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    const written = await run(["git", "write-tree"], path, undefined, options);
    if (written.code !== 0 || !SHA.test(written.stdout)) throw new Error(`git write-tree failed: ${written.stderr || written.stdout}`);
    return written.stdout;
  } finally { rmSync(folder, { recursive: true, force: true }); }
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
  const marked = await Promise.all(paths.map(async file => {
    const text = await readFile(join(path, file), "utf8").catch(() => "");
    return /^(<{7}|>{7})( |$)/m.test(text) || /^={7}$/m.test(text);
  }));
  return paths.filter((_, index) => marked[index]);
}

export async function resetTo(path: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error("Could not restore the product: the saved version is invalid.");
  await must(["git", "reset", "--hard", "--quiet", sha], path);
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
  if (!isRefName(branch)) return { ok: false, error: "not a branch Petrina opens" };
  const switched = await run(["git", "switch", "--quiet", "--no-guess", branch], path);
  return switched.code === 0 ? { ok: true, value: undefined } : commandFailure(switched);
}

/** The commit a ref or sha names, or undefined when there is none. */
export async function revParse(path: string, ref: string): Promise<string | undefined> {
  if (ref.startsWith("-")) return undefined;
  const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/** Does `descendant` contain `ancestor`? */
export async function contains(path: string, descendant: string, ancestor: string, fromCommits = false): Promise<boolean> {
  if ((descendant !== "HEAD" && !SHA.test(descendant)) || !SHA.test(ancestor)) return false;
  return (await run(["git", ...(fromCommits ? FROM_COMMITS : []), "merge-base", "--is-ancestor", ancestor, descendant], path)).code === 0;
}

export async function parents(path: string, sha: string): Promise<string[]> {
  if (!SHA.test(sha)) return [];
  return (await run(["git", "rev-list", "--parents", "--max-count=1", sha], path)).stdout.split(/\s+/).filter(Boolean).slice(1);
}

/** Files that differ between two commits or trees. A failed read cannot establish that nothing changed. */
export async function changedFiles(path: string, from: string, to: string): Promise<string[]> {
  if (!SHA.test(from) || !SHA.test(to)) throw new Error("Could not compare product changes: the saved version is invalid.");
  return (await must(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from, to], path)).split("\0").filter(Boolean);
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
  if (!isRefName(branch) || !isSha(from) || !isSha(to)) return { ok: false, error: "not an update Petrina makes" };
  if (!(await contains(root, to, from))) return { ok: false, error: `${to.slice(0, 7)} is not ahead of ${from.slice(0, 7)}` };
  return moveLocalBranch(root, branch, from, to, checkedOutHere);
}

/** Replace only Petrina's exact unpushed task commit after carrying it onto newer source commits. */
export async function replaceLocalDelivery(root: string, branch: string, from: string, to: string, checkedOutHere: boolean): Promise<Check<void>> {
  if (!isRefName(branch) || !isSha(from) || !isSha(to)) return { ok: false, error: "not a delivery Petrina replaces" };
  const base = await revParse(root, `${from}^`);
  if (!base || !(await contains(root, to, base))) return { ok: false, error: "the new delivery does not preserve the previous source commits" };
  return moveLocalBranch(root, branch, from, to, checkedOutHere);
}

async function moveLocalBranch(root: string, branch: string, from: string, to: string, checkedOutHere: boolean): Promise<Check<void>> {
  const ref = `refs/heads/${branch}`;
  const located = await run(["git", "rev-parse", "--git-path", "index"], root);
  if (located.code !== 0) return commandFailure(located);
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
    if (moved.code !== 0) return commandFailure(moved);
    if (!checkedOutHere) return { ok: true, value: undefined };
    await run(["git", "update-index", "-q", "--refresh"], root, undefined, { index: lock });
    const files = await run(["git", "read-tree", "-m", "-u", from, to], root, undefined, { index: lock });
    // A switch already past the staging area before the lock: its files go back, and so does the branch.
    const stayed = files.code === 0 && (await currentBranch(root)) === branch;
    if (!stayed) {
      if (files.code === 0) await run(["git", "read-tree", "-m", "-u", to, from], root, undefined, { index: lock });
      await run(["git", "update-ref", "-m", "Petrina could not update the files", ref, from, to], root);
      return files.code === 0 ? { ok: false, error: `the main copy switched branches at that moment, so ${branch} stays where it was` } : commandFailure(files);
    }
    renameSync(lock, index);
    installed = true;
    return { ok: true, value: undefined };
  } finally {
    if (!installed) rmSync(lock, { force: true });
  }
}

/** Create only an absent local destination, without checking out or touching its files. */
export async function createBranchAt(root: string, branch: string, sha: string): Promise<Check<void>> {
  if (!isBranchName(branch) || !isSha(sha)) return { ok: false, error: "not a local branch Petrina creates" };
  const result = await run(["git", "update-ref", `refs/heads/${branch}`, sha, "0".repeat(sha.length)], root);
  return result.code === 0 ? { ok: true, value: undefined } : commandFailure(result);
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

/** Tracked files the working copy changed since `sha` (its checked-out commit when omitted), committed or not; untracked files are left out. */
export async function trackedChangesSince(path: string, sha?: string): Promise<string[]> {
  if (sha !== undefined && !SHA.test(sha)) return [];
  const result = await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", sha ?? "HEAD"], path);
  return result.code === 0 ? result.stdout.split("\0").filter(Boolean) : [];
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
  const [branch, where] = await Promise.all([
    run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], path),
    run(["git", "rev-parse", ...HALF_DONE.flatMap(([marker]) => ["--git-path", marker])], path),
  ]);
  const paths = where.stdout.split("\n");
  for (const [index, [, what]] of HALF_DONE.entries()) {
    if (where.code === 0 && paths[index] && existsSync(resolve(path, paths[index]!))) return { ...(branch.code === 0 ? { branch: branch.stdout } : {}), busy: what };
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
  // Keep structured deletion names (including binary tests) rather than inferring them from patch prose.
  const [removed, diff] = await Promise.all([
    run(["git", "diff", "--no-ext-diff", "--name-only", "-z", "--diff-filter=D", `${base}...HEAD`], path),
    run(["git", "diff", "--no-ext-diff", "--no-textconv", "--unified=0", `${base}...HEAD`], path),
  ]);
  const deleted = removed.stdout.split("\0").filter(Boolean);
  for (const file of deleted) if (TEST_FILE.test(file)) problems.push(`A test file was deleted: ${file}`);
  const patch = diff.stdout;
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (SKIP_MARKERS.test(line)) problems.push(`A test was skipped or narrowed in ${file}`);
  }
  return [...new Set(problems)];
}

/** A reason a working copy could not be removed, in plain words for the timeline. */
class Reason extends Error {}

/** How long Petrina waits for git while removing a working copy. */
const CLEANUP_GIT_TIMEOUT_MS = 60_000;

/** A path with its links resolved, also when its last parts no longer exist. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    // Native resolution also expands Windows short names, which Git reports in their full form.
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

/** Resolve aliases in a folder's parent, but never follow the working-copy folder itself if it became a link. */
function worktreeLocation(path: string): string {
  const absolute = resolve(path);
  return join(canonical(dirname(absolute)), basename(absolute));
}

/** The working copies the repository keeps a record of, other than its main clone, as git lists them. */
export async function linkedWorktrees(root: string): Promise<string[]> {
  const listed = await run(["git", "worktree", "list", "--porcelain", "-z"], root, undefined, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  if (listed.code !== 0) throw new Reason("the product's repository could not be read");
  const paths = listed.stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice("worktree ".length));
  return paths.slice(1);
}

/** The main clone a working copy belongs to, read from the copy itself (for a product no longer in Petrina). */
export async function mainClone(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const common = await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  return common.code === 0 && common.stdout ? dirname(common.stdout) : undefined;
}

/**
 * Remove a task's working copy: the folder with everything in it (ignored packages and build output
 * too), then the repository's record of it. Branches stay. Petrina deletes the folder itself, which
 * never follows a link out of it, so shared caches and the files they link to stay. Safe to run again
 * after a failure or an interruption. Throws a plain-language reason; returns false when nothing was left.
 */
export function removeWorktree(root: string, path: string, files: Pick<FileOperations, "removeTree"> = localFiles): Promise<boolean> {
  return removeKnownWorktree(root, path, undefined, files);
}

/** Batch cleanup shares one registration observation, then verifies the complete batch. */
async function removeKnownWorktree(root: string, path: string, known?: readonly string[], files: Pick<FileOperations, "removeTree"> = localFiles): Promise<boolean> {
  try {
    if (!existsSync(root)) {
      const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      if (!entry) return false;
      throw new Reason("the product's folder could not be found");
    }
    const target = worktreeLocation(path);
    const main = canonical(root);
    if (resolve(path) === resolve(root) || target === main || main.startsWith(target + sep)) throw new Reason("that folder holds the product itself");
    const recorded = async () => (known ?? await linkedWorktrees(root)).find((entry) => worktreeLocation(entry) === target);
    const record = await recorded();
    const there = () =>
      lstat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    const folder = await there();
    if (!folder && !record) return false;
    if (folder) await files.removeTree(path);
    if (await there()) throw new Reason("its folder could not be deleted");
    // With the folder gone, git only drops its record. Forced twice: also when the copy was locked.
    if (record) await oneAtATime(root, () => run(["git", "worktree", "remove", "--force", "--force", record], root, undefined, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS }));
    if (record && !known && await recorded()) throw new Reason("the repository still lists it as a working copy");
    if (record && await there()) throw new Reason("its folder could not be deleted");
    return folder || record !== undefined;
  } catch (error) {
    if (error instanceof Reason) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "";
    throw new Reason(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code) ? CLEANUP_WORDS.locked : "its folder could not be deleted");
  }
}

/**
 * A working copy of one commit for one agent alone (a reviewer working beside others): detached, so it
 * shares no branch, index or HEAD with the task's own copy. Nothing is installed in it.
 */
export async function addCopy(root: string, path: string, sha: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await oneAtATime(root, () => must(["git", "worktree", "add", "--detach", "--quiet", path, sha], root));
}

/** A finished task has no reviewer left to resume. Recover both folders and records left by a crash. */
export async function removeFinishedCopies(root: string, folder: string, files: Pick<FileOperations, "removeTree"> = localFiles): Promise<boolean> {
  const entry = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existsSync(root)) {
    if (!entry) return false;
    throw new Reason("the product's folder could not be found");
  }
  // Unlink a replacement before inspecting children; never follow it into somebody else's copy.
  if (entry && !entry.isDirectory()) await files.removeTree(folder);
  const names = entry?.isDirectory() ? await readdir(folder) : [];
  const location = worktreeLocation(folder);
  const recorded = (await linkedWorktrees(root)).filter((copy) => worktreeLocation(dirname(copy)) === location);
  const copies = [...new Set([...names.map((name) => join(folder, name)), ...recorded])];
  await completeAll(copies.map(copy => removeKnownWorktree(root, copy, recorded, files)));
  if (recorded.length && (await linkedWorktrees(root)).some(copy => worktreeLocation(dirname(copy)) === location)) throw new Reason("the repository still lists it as a working copy");
  await files.removeTree(folder);
  return entry !== undefined || recorded.length > 0;
}

/** Remove copies and git's records, keeping only conversations that are waiting for the screen. */
export async function removeCopies(root: string, folder: string, keep: readonly string[] = []): Promise<void> {
  const kept = new Set(keep);
  await oneAtATime(root, async () => {
    const entry = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    // A replaced parent is unlinked, never traversed into another task's working copies.
    if (entry && !entry.isDirectory()) await rm(folder, { force: true });
    else if (!kept.size) await rm(folder, { recursive: true, force: true });
    else if (entry) {
      const names = await readdir(folder);
      await completeAll(names.map((name) => join(folder, name)).filter((copy) => !kept.has(copy))
        .map((copy) => rm(copy, { recursive: true, force: true })));
    }
    // These copies are detached: one prune drops all missing unlocked registrations.
    const pruned = await run(["git", "worktree", "prune"], root, undefined, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
    if (pruned.code !== 0) throw new Reason(`the repository's review-copy records could not be cleaned: ${pruned.stderr || pruned.stdout || `exit ${pruned.code}`}`);
  });
}
