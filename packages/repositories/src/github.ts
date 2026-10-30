// GitHub CLI requests pinned to the approved product, outside working copies.
import { tmpdir } from "node:os";
import {
  run,
  commandFailure,
  isRefName,
  isRepoName,
  EXIT_UNREPORTED,
  FETCH_TIMEOUT_MS,
  OUTPUT_INCOMPLETE,
  OUTPUT_UNREADABLE,
  type Gh,
  type Check,
  type RunResult
} from "./git.js";
const GH: Gh = ["gh"];

/** Explicit transport for a host-supplied service; native commands retain their existing bounded lifecycle. */
export interface GitHubRequests { request(args: readonly string[], input?: string): Promise<RunResult> }
export type GitHubCommand = Gh | GitHubRequests;
export function request(command: GitHubCommand, args: readonly string[], input?: string): Promise<RunResult> {
  return "request" in command ? command.request(args, input)
    : run([...command, ...args], tmpdir(), input, { credentials: true, timeoutMs: FETCH_TIMEOUT_MS });
}

/** gh with the coordinator's login, pinned to the product's repository and run outside any working copy. */
export async function gh(cmd: GitHubCommand, repo: string, args: readonly string[], input?: string): Promise<RunResult> {
  if (!isRepoName(repo)) return { code: 2, stdout: "", stderr: `not a GitHub repository: ${repo}` };
  return inGitHubTerms(await request(cmd, [...args, "--repo", repo], input));
}

const UNFINISHED: readonly (readonly [string, string])[] = [
  [EXIT_UNREPORTED, "the GitHub command ended, but the system did not report its exit, so GitHub's answer is unknown"],
  [OUTPUT_INCOMPLETE, "the GitHub command ended, but GitHub's answer did not finish arriving"],
  ["timed out", `GitHub did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds`],
];

/**
 * A GitHub request that never finished: `run` words why for Git, so say it as GitHub's missing
 * answer instead. The reason comes first so a shortened message keeps it; gh's own words follow.
 */
export function inGitHubTerms(result: RunResult): RunResult {
  if (!result.timedOut) return result;
  const { stderr } = result;
  let own = stderr;
  let why = "GitHub's answer is unknown";
  const known = UNFINISHED.find(([reason]) => stderr === reason || stderr.endsWith(`\n${reason}`));
  const unreadable = stderr.lastIndexOf(`${OUTPUT_UNREADABLE}: `);
  if (known) [own, why] = [stderr.slice(0, -known[0].length), known[1]];
  else if (unreadable === 0 || stderr[unreadable - 1] === "\n") {
    own = stderr.slice(0, unreadable);
    why = `GitHub's answer could not be read: ${stderr.slice(unreadable + OUTPUT_UNREADABLE.length + 2)}`;
  }
  return { ...result, stderr: [why, own.trim()].filter(Boolean).join("\n") };
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
 * login cannot see, so it only counts once `canSee` says the login sees the repository. Words from
 * a request that never finished are no answer.
 */
const noRelease = (result: RunResult) => !result.timedOut && /^release not found$/im.test(result.stderr);

/**
 * Does the coordinator's GitHub login see the product's repository? Asked before any "not there"
 * counts: GitHub answers "not found" alike for a missing release and a repository the login cannot see.
 * Only GitHub's own answer says the login cannot see it: no answer leaves that unknown, never visible.
 */
export async function canSee(repo: string, cmd: GitHubCommand = GH): Promise<Check<void>> {
  if (!isRepoName(repo)) return { ok: false, error: `not a GitHub repository: ${repo}` };
  const result = inGitHubTerms(await request(cmd, ["repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]));
  if (result.startFailure) return { ok: false, error: `Petrina couldn't start the repository check for ${repo} (${commandFailure(result).error})` };
  if (result.timedOut) return { ok: false, error: `Petrina could not confirm whether your GitHub login can see ${repo} (${commandFailure(result).error})` };
  if (result.code !== 0) return { ok: false, error: `your GitHub login cannot see ${repo} (${commandFailure(result).error})` };
  return result.stdout.toLowerCase() === repo.toLowerCase() ? {
    ok: true,
    value: undefined
  } : {
    ok: false,
    error: `GitHub answered for ${result.stdout || "another repository"}, not ${repo}`
  };
}

/** "Not there", once the login is known to see the repository; otherwise why GitHub could not say. */
async function notThere<T>(repo: string, cmd: GitHubCommand): Promise<Check<T | undefined>> {
  const seen = await canSee(repo, cmd);
  return seen.ok ? { ok: true, value: undefined } : seen;
}

const stateOf = (value: unknown): "open" | "merged" | "closed" => {
  const state = String(value ?? "").toLowerCase();
  return state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
};

export async function prState(repo: string, number: number, cmd: GitHubCommand = GH): Promise<"open" | "merged" | "closed" | undefined> {
  const result = await gh(cmd, repo, ["pr", "view", String(number), "--json", "state", "--jq", ".state"]);
  if (result.code !== 0) return undefined;
  return stateOf(result.stdout);
}

/**
 * Every pull request from this branch, open, closed or merged. A listing that may be cut short does
 * not count, and an empty one only once the login is known to see the repository.
 */
export async function pullRequests(repo: string, branch: string, cmd: GitHubCommand = GH): Promise<Check<PullRequestInfo[]>> {
  if (!isRefName(branch)) return { ok: false, error: "not a branch Petrina looks up" };
  const result = await gh(
    cmd,
    repo,
    [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    String(LIST_LIMIT),
    "--json",
    "number,url,state,headRefName,baseRefName,headRefOid,isCrossRepository"
  ]
  );
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
      prs.push({
        number: entry.number,
        url: entry.url,
        state: stateOf(entry.state),
        head: entry.headRefName,
        base: entry.baseRefName,
        commit: entry.headRefOid,
        fork: entry.isCrossRepository === true
      });
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
export async function openPullRequest(repo: string, pr: {
  head: string;
  base: string;
  title: string;
  body: string
}, cmd: GitHubCommand = GH): Promise<Created> {
  if (!isRefName(pr.head) || !isRefName(pr.base)) return { ok: false, exists: false, error: "not a branch Petrina publishes" };
  const result = await gh(cmd, repo, ["pr", "create", "--head", pr.head, "--base", pr.base, `--title=${pr.title}`, "--body-file", "-"], pr.body);
  return created(result);
}

function created(result: RunResult): Created {
  if (result.code === 0) return { ok: true, url: result.stdout.split("\n").find((line) => line.startsWith("https://")) ?? result.stdout };
  return { ok: false, exists: /already exists/i.test(`${result.stderr}\n${result.stdout}`), error: commandFailure(result).error };
}

/** The latest published release's tag; undefined only when the login sees the repository and it has none. */
export async function latestRelease(repo: string, cmd: GitHubCommand = GH): Promise<Check<string | undefined>> {
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
export async function findRelease(repo: string, tag: string, cmd: GitHubCommand = GH): Promise<Check<{
  tag: string;
  url: string;
  draft: boolean
} | undefined>> {
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
export async function createRelease(repo: string, tag: string, notes: string, cmd: GitHubCommand = GH): Promise<Created> {
  if (!isRefName(tag)) return { ok: false, exists: false, error: "not a tag Petrina publishes" };
  const result = await gh(cmd, repo, ["release", "create", tag, "--verify-tag", `--title=${tag}`, "--notes-file", "-"], notes);
  return created(result);
}
