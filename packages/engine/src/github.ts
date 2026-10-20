// GitHub CLI requests pinned to the approved product, outside working copies.
import { tmpdir } from "node:os";
import { run, commandFailure, isRefName, isRepoName, FETCH_TIMEOUT_MS, type Gh, type Check, type RunResult } from "./git.js";
const GH: Gh = ["gh"];

/** gh with the coordinator's login, pinned to the product's repository and run outside any working copy. */
export async function gh(cmd: Gh, repo: string, args: readonly string[], input?: string): Promise<RunResult> {
  if (!isRepoName(repo)) return { code: 2, stdout: "", stderr: `not a GitHub repository: ${repo}` };
  return run([...cmd, ...args, "--repo", repo], tmpdir(), input, { credentials: true, timeoutMs: FETCH_TIMEOUT_MS });
}

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
  if (!isRepoName(repo)) return { ok: false, error: `not a GitHub repository: ${repo}` };
  const result = await run([...cmd, "repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], tmpdir(), undefined, { credentials: true, timeoutMs: FETCH_TIMEOUT_MS });
  if (result.code !== 0) return { ok: false, error: `your GitHub login cannot see ${repo} (${commandFailure(result).error})` };
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
  if (!isRefName(branch)) return { ok: false, error: "not a branch Petrina looks up" };
  const result = await gh(cmd, repo, ["pr", "list", "--head", branch, "--state", "all", "--limit", String(LIST_LIMIT), "--json", "number,url,state,headRefName,baseRefName,headRefOid,isCrossRepository"]);
  if (result.code !== 0) return commandFailure(result);
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
  if (!isRefName(pr.head) || !isRefName(pr.base)) return { ok: false, exists: false, error: "not a branch Petrina publishes" };
  const result = await gh(cmd, repo, ["pr", "create", "--head", pr.head, "--base", pr.base, `--title=${pr.title}`, "--body-file", "-"], pr.body);
  return created(result);
}

function created(result: RunResult): Created {
  if (result.code === 0) return { ok: true, url: result.stdout.split("\n").find((line) => line.startsWith("https://")) ?? result.stdout };
  return { ok: false, exists: /already exists/i.test(`${result.stderr}\n${result.stdout}`), error: commandFailure(result).error };
}

/** The latest published release's tag; undefined only when the login sees the repository and it has none. */
export async function latestRelease(repo: string, cmd: Gh = GH): Promise<Check<string | undefined>> {
  const result = await gh(cmd, repo, ["release", "view", "--json", "tagName"]);
  if (result.code !== 0) return noRelease(result) ? notThere(repo, cmd) : commandFailure(result);
  try {
    const tag = (JSON.parse(result.stdout) as { tagName?: unknown }).tagName;
    return typeof tag === "string" ? { ok: true, value: tag } : { ok: false, error: "GitHub's answer was not readable" };
  } catch {
    return { ok: false, error: "GitHub's answer was not readable" };
  }
}

/** The release for a tag; undefined only when the login sees the repository and it has none. */
export async function findRelease(repo: string, tag: string, cmd: Gh = GH): Promise<Check<{ tag: string; url: string; draft: boolean } | undefined>> {
  if (!isRefName(tag)) return { ok: false, error: "not a tag Petrina looks up" };
  const result = await gh(cmd, repo, ["release", "view", tag, "--json", "tagName,url,isDraft"]);
  if (result.code !== 0) return noRelease(result) ? notThere(repo, cmd) : commandFailure(result);
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
  if (!isRefName(tag)) return { ok: false, exists: false, error: "not a tag Petrina publishes" };
  const result = await gh(cmd, repo, ["release", "create", tag, "--verify-tag", `--title=${tag}`, "--notes-file", "-"], notes);
  return created(result);
}
