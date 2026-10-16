// Git and GitHub operations. Every command is an argument array: nothing goes through a shell.
// GitHub calls take the `gh` command to run, so tests can stand in a fake GitHub.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The `gh` command to run. */
export type Gh = readonly string[];
const GH: Gh = ["gh"];
const SHA = /^[0-9a-f]{7,40}$/i;
/** Branch and tag names Petrina passes to git and gh: no leading dash, no "..". */
const TAG = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\-/]+$/;

export async function run(cmd: readonly string[], cwd: string, input?: string): Promise<RunResult> {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(cmd, cwd, input);
  } catch (error) {
    // The program is not installed (no gh, say): report it like a failed command.
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function spawnPiped(cmd: readonly string[], cwd: string, input?: string) {
  return Bun.spawn([...cmd], {
    cwd,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
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
  await run(["git", "fetch", "--quiet", "origin", defaultBranch], root);
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
  if (!SHA.test(sha)) return;
  await run(["git", "reset", "--hard", "--quiet", sha], path);
}

export async function head(path: string): Promise<string> {
  return must(["git", "rev-parse", "HEAD"], path);
}

export async function diffStat(path: string, base: string): Promise<{ files: number; additions: number; deletions: number }> {
  const out = (await run(["git", "diff", "--numstat", `${base}...HEAD`], path)).stdout;
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
  const deleted = (await run(["git", "diff", "--name-only", "--diff-filter=D", `${base}...HEAD`], path)).stdout.split("\n").filter(Boolean);
  for (const file of deleted) if (TEST_FILE.test(file)) problems.push(`A test file was deleted: ${file}`);
  const patch = (await run(["git", "diff", "--unified=0", `${base}...HEAD`], path)).stdout;
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (SKIP_MARKERS.test(line)) problems.push(`A test was skipped or narrowed in ${file}`);
  }
  return [...new Set(problems)];
}

export async function prState(path: string, number: number, gh: Gh = GH): Promise<"open" | "merged" | "closed" | undefined> {
  const result = await run([...gh, "pr", "view", String(number), "--json", "state", "--jq", ".state"], path);
  if (result.code !== 0) return undefined;
  const state = result.stdout.toLowerCase();
  return state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
}

/** Verify a pull request the shipper says it opened. */
export async function findPr(path: string, branch: string, gh: Gh = GH): Promise<{ number: number; url: string } | undefined> {
  const result = await run([...gh, "pr", "view", branch, "--json", "number,url"], path);
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { number?: unknown; url?: unknown };
    return typeof parsed.number === "number" && typeof parsed.url === "string" ? { number: parsed.number, url: parsed.url } : undefined;
  } catch {
    return undefined;
  }
}

/** Verify a release the shipper says it published. */
export async function findRelease(path: string, tag: string, gh: Gh = GH): Promise<{ tag: string; url: string } | undefined> {
  if (!TAG.test(tag)) return undefined;
  const result = await run([...gh, "release", "view", tag, "--json", "tagName,url"], path);
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
  if (!SHA.test(sha) || !TAG.test(branch)) return false;
  return (await run(["git", "merge-base", "--is-ancestor", sha, `refs/heads/${branch}`], root)).code === 0;
}

// ── Checks after an interrupted delivery ───────────────────────────────────
// Each tells "not there" apart from "could not ask", so Petrina never guesses.

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

const failed = (result: RunResult): { ok: false; error: string } => ({ ok: false, error: (result.stderr || result.stdout || `exit ${result.code}`).slice(0, 300) });

export async function revParse(path: string, ref: string): Promise<string | undefined> {
  const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/** The pull request opened for a branch, whatever its state. */
export async function prForBranch(path: string, branch: string, gh: Gh = GH): Promise<Check<{ number: number; url: string; state: "open" | "merged" | "closed" } | undefined>> {
  if (!TAG.test(branch)) return { ok: true, value: undefined };
  const result = await run([...gh, "pr", "view", branch, "--json", "number,url,state"], path);
  if (result.code !== 0) return /no (open )?pull requests? found/i.test(result.stderr) ? { ok: true, value: undefined } : failed(result);
  try {
    const parsed = JSON.parse(result.stdout) as { number?: unknown; url?: unknown; state?: unknown };
    if (typeof parsed.number !== "number" || typeof parsed.url !== "string") return { ok: false, error: "GitHub's answer was not readable" };
    const state = String(parsed.state ?? "").toLowerCase();
    return { ok: true, value: { number: parsed.number, url: parsed.url, state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open" } };
  } catch {
    return { ok: false, error: "GitHub's answer was not readable" };
  }
}

/** The latest published release's tag, or undefined when there is none or GitHub does not answer. */
export async function latestRelease(path: string, gh: Gh = GH): Promise<string | undefined> {
  const result = await run([...gh, "release", "view", "--json", "tagName"], path);
  if (result.code !== 0) return undefined;
  try {
    const tag = (JSON.parse(result.stdout) as { tagName?: unknown }).tagName;
    return typeof tag === "string" && TAG.test(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** Releases published at or after `since` (milliseconds), newest first. Drafts do not count. */
export async function releasesSince(path: string, since: number, gh: Gh = GH): Promise<Check<string[]>> {
  const result = await run([...gh, "release", "list", "--limit", "30", "--json", "tagName,publishedAt,isDraft"], path);
  if (result.code !== 0) return failed(result);
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

/** The commit a branch points to on origin, asked of origin itself. undefined: origin has no such branch. */
export async function remoteBranch(path: string, branch: string): Promise<Check<string | undefined>> {
  if (!TAG.test(branch)) return { ok: true, value: undefined };
  const result = await run(["git", "ls-remote", "--heads", "origin", `refs/heads/${branch}`], path);
  if (result.code !== 0) return failed(result);
  const sha = result.stdout.split(/\s+/)[0];
  return { ok: true, value: sha && SHA.test(sha) ? sha : undefined };
}

/** Fetch a branch or tag from origin and say whether it contains `sha`. */
export async function originContains(path: string, ref: { branch: string } | { tag: string }, sha: string): Promise<Check<boolean>> {
  const name = "branch" in ref ? ref.branch : ref.tag;
  if (!SHA.test(sha) || !TAG.test(name)) return { ok: true, value: false };
  const fetched = await run(["git", "fetch", "--quiet", "--no-tags", "origin", "branch" in ref ? `refs/heads/${name}` : `refs/tags/${name}`], path);
  if (fetched.code !== 0) return failed(fetched);
  return { ok: true, value: (await run(["git", "merge-base", "--is-ancestor", sha, "FETCH_HEAD"], path)).code === 0 };
}

export async function removeWorktree(root: string, path: string): Promise<void> {
  await run(["git", "worktree", "remove", "--force", path], root);
}
