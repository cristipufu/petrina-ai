// Git and GitHub operations. Every command is an argument array: nothing goes through a shell.
//
// Agents can change a working copy's git settings (worktrees share them with the main clone), so
// Petrina's own git steps never run hooks or the file monitor, and only the steps that talk to
// GitHub (fetch, gh) get the coordinator's credentials. Anything else a repository's settings
// start (filters, signing) runs with no credentials, like an agent.

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentEnv, withGitConfig } from "./env.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let empty: string | undefined;
/** Empty folders for "no hooks" and "no gh login", made once per engine. */
function emptyDir(name: "hooks" | "gh"): string {
  empty ??= mkdtempSync(join(tmpdir(), "petrina-none-"));
  const dir = join(empty, name);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function gitEnv(credentials: boolean): NodeJS.ProcessEnv {
  const base = credentials ? process.env : agentEnv(process.env, emptyDir("gh"));
  return { ...withGitConfig(base, [["core.hooksPath", emptyDir("hooks")], ["core.fsmonitor", "false"]]), GIT_TERMINAL_PROMPT: "0" };
}

export async function run(cmd: readonly string[], cwd: string, input?: string, options: { credentials?: boolean } = {}): Promise<RunResult> {
  const proc = Bun.spawn([...cmd], {
    cwd,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv(options.credentials === true),
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
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

/** Create (or reuse) the task's worktree on its own branch, based on the latest default branch. */
export async function ensureWorktree(root: string, path: string, branch: string, defaultBranch: string): Promise<{ base: string }> {
  await run(["git", "fetch", "--quiet", "origin", defaultBranch], root, undefined, { credentials: true });
  const remoteBase = `origin/${defaultBranch}`;
  const hasRemote = (await run(["git", "rev-parse", "--verify", "--quiet", remoteBase], root)).code === 0;
  const base = hasRemote ? remoteBase : defaultBranch;
  if (existsSync(path) && (await run(["git", "rev-parse", "--is-inside-work-tree"], path)).code === 0) return { base };
  await mkdir(dirname(path), { recursive: true });
  const branchExists = (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).code === 0;
  if (branchExists) await must(["git", "worktree", "add", path, branch], root);
  else await must(["git", "worktree", "add", "-b", branch, path, base], root);
  return { base };
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
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return;
  await run(["git", "reset", "--hard", "--quiet", sha], path);
}

export async function head(path: string): Promise<string> {
  return must(["git", "rev-parse", "HEAD"], path);
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

export async function prState(path: string, number: number): Promise<"open" | "merged" | "closed" | undefined> {
  const result = await run(["gh", "pr", "view", String(number), "--json", "state", "--jq", ".state"], path, undefined, { credentials: true });
  if (result.code !== 0) return undefined;
  const state = result.stdout.toLowerCase();
  return state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
}

/** Verify a pull request the shipper says it opened. */
export async function findPr(path: string, branch: string): Promise<{ number: number; url: string } | undefined> {
  const result = await run(["gh", "pr", "view", branch, "--json", "number,url"], path, undefined, { credentials: true });
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { number?: unknown; url?: unknown };
    return typeof parsed.number === "number" && typeof parsed.url === "string" ? { number: parsed.number, url: parsed.url } : undefined;
  } catch {
    return undefined;
  }
}

/** Verify a release the shipper says it published. */
export async function findRelease(path: string, tag: string): Promise<{ tag: string; url: string } | undefined> {
  if (!/^[A-Za-z0-9._\-/]+$/.test(tag)) return undefined;
  const result = await run(["gh", "release", "view", tag, "--json", "tagName,url"], path, undefined, { credentials: true });
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { tagName?: unknown; url?: unknown };
    return typeof parsed.tagName === "string" && typeof parsed.url === "string" ? { tag: parsed.tagName, url: parsed.url } : undefined;
  } catch {
    return undefined;
  }
}

/** Is `sha` on the local default branch of the product's clone? */
export async function landedOn(root: string, branch: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  return (await run(["git", "merge-base", "--is-ancestor", sha, branch], root)).code === 0;
}

export async function removeWorktree(root: string, path: string): Promise<void> {
  await run(["git", "worktree", "remove", "--force", path], root);
}
