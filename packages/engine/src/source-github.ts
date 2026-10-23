// Read-only GitHub background. `pr view` uses --repo; API reads use the same exact
// repository in their endpoint (gh api has no --repo option). All run outside repositories.
import { tmpdir } from "node:os";
import * as github from "./github.js";
import * as git from "./git.js";

const GH = ["gh"];
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export interface SourcePr {
  number: number; url: string; state: "open" | "closed" | "merged"; title: string; body: string;
  branch: string; headRepo: string; head: string;
}

export function prNumber(value: string, repo: string): number {
  const link = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i.exec(value);
  if (link && link[1]!.toLowerCase() !== repo.toLowerCase()) throw new Error(`That pull request belongs to ${link[1]}, not ${repo}. Choose the matching product or correct the link.`);
  const number = Number(link?.[2] ?? (/^#?\d+$/.test(value) ? value.replace("#", "") : NaN));
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Enter a pull request number or a GitHub pull request link.");
  return number;
}

export async function sourcePr(repo: string, number: number, cmd: git.Gh = GH): Promise<SourcePr> {
  const read = await github.gh(cmd, repo, ["pr", "view", String(number), "--json", "number,url,state,title,body,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository"]);
  if (read.code) throw new Error(`Could not read PR #${number} in ${repo}: ${read.stderr || read.stdout}. Retry when it is accessible.`);
  const data = JSON.parse(read.stdout);
  const headRepo = data.headRepository?.nameWithOwner ?? (data.headRepositoryOwner?.login && data.headRepository?.name ? `${data.headRepositoryOwner.login}/${data.headRepository.name}` : data.isCrossRepository === false ? repo : undefined);
  if (data.number !== number || !REPO.test(headRepo ?? "") || !git.isBranchName(data.headRefName ?? "") || !git.isSha(data.headRefOid ?? "") || typeof data.title !== "string" || typeof data.body !== "string" || prNumber(data.url ?? "", repo) !== number) throw new Error(`GitHub's details for PR #${number} are incomplete, including its working repository or branch. Retry when they are available.`);
  return { number, url: data.url, state: String(data.state).toLowerCase() as SourcePr["state"], title: data.title, body: data.body, branch: data.headRefName, headRepo, head: data.headRefOid };
}

/** Every page, with no truncation; pull review comments includes replies across all threads. */
export async function api(repo: string, endpoint: string, cmd: git.Gh = GH): Promise<unknown[]> {
  if (!REPO.test(repo)) throw new Error("This is not a GitHub repository.");
  const read = github.inGitHubTerms(await git.run([...cmd, "api", `repos/${repo}/${endpoint}`, "--paginate", "--slurp"], tmpdir(), undefined, { credentials: true, timeoutMs: git.FETCH_TIMEOUT_MS }));
  if (read.code) throw new Error(`Could not refresh pull request background in ${repo} (${read.stderr || read.stdout}). Earlier background has not been refreshed. Retry when GitHub is accessible.`);
  const pages: unknown = JSON.parse(read.stdout);
  if (!Array.isArray(pages)) throw new Error("GitHub returned unreadable background. Retry to read it again.");
  return pages;
}

export async function branchExists(repo: string, branch: string, cmd: git.Gh = GH): Promise<void> {
  if (!REPO.test(repo)) throw new Error("This is not a GitHub repository.");
  const unavailable = `The branch ${branch} is unavailable in ${repo}. Correct the choice or retry.`;
  // A missing branch is not a failed pull request refresh. Read it directly so that explanation can be shown.
  const read = github.inGitHubTerms(await git.run([...cmd, "api", `repos/${repo}/branches/${encodeURIComponent(branch)}`, "--paginate", "--slurp"], tmpdir(), undefined, { credentials: true, timeoutMs: git.FETCH_TIMEOUT_MS }));
  const detail = read.stderr || read.stdout;
  if (read.code) {
    // Only GitHub's own answer says the branch is missing: words from a request that never finished do not.
    if (!read.timedOut && /\b404\b|not found/i.test(detail)) throw new Error(unavailable);
    throw new Error(`The branch ${branch} in ${repo} could not be checked (${detail}). Retry when GitHub is accessible.`);
  }
  let pages: unknown;
  try { pages = JSON.parse(read.stdout); } catch { throw new Error(`The branch ${branch} in ${repo} could not be checked. Retry when GitHub is accessible.`); }
  const first = Array.isArray(pages) ? pages[0] as { commit?: { sha?: string } } | undefined : undefined;
  if (!first?.commit?.sha) throw new Error(unavailable);
}

export async function background(repo: string, pr: SourcePr, cmd: git.Gh = GH): Promise<string> {
  const [reviewPages, discussionPages, filePages, runPages, statusPages] = await Promise.all([
    api(repo, `pulls/${pr.number}/reviews?per_page=100`, cmd),
    api(repo, `issues/${pr.number}/comments?per_page=100`, cmd),
    api(repo, `pulls/${pr.number}/comments?per_page=100`, cmd),
    api(repo, `commits/${pr.head}/check-runs?per_page=100`, cmd),
    api(repo, `commits/${pr.head}/status?per_page=100`, cmd),
  ]);
  const reviews = reviewPages.flat() as any[], discussion = discussionPages.flat() as any[], files = filePages.flat() as any[];
  const runs = runPages.flatMap((page: any) => {
    if (!Array.isArray(page?.check_runs)) throw new Error("GitHub returned unreadable check results. Retry to refresh them.");
    return page.check_runs;
  });
  const statuses = statusPages.flatMap((page: any) => {
    if (!Array.isArray(page?.statuses)) throw new Error("GitHub returned unreadable status results. Retry to refresh them.");
    return page.statuses;
  });
  const author = (entry: any) => entry.user?.login ?? "Unavailable author";
  const words = (entry: any) => typeof entry.body === "string" ? entry.body : "Text unavailable";
  const lines = [`PR #${pr.number}: ${pr.title}`, pr.body || "No description.", `Working branch: ${pr.headRepo} · ${pr.branch}`, `Current version: ${pr.head}`, "Review summaries:"];
  for (const review of reviews) lines.push(`- ${author(review)}: ${review.state ?? "State unavailable"}, version ${review.commit_id ?? "unavailable"}\n${words(review)}`);
  if (!reviews.length) lines.push("No reviews.");
  lines.push("Discussion comments:");
  for (const comment of discussion) lines.push(`- ${author(comment)}:\n${words(comment)}`);
  if (!discussion.length) lines.push("No discussion comments.");
  lines.push("File comments and replies:");
  for (const comment of files) {
    const location = comment.line != null ? `line ${comment.line}${comment.start_line ? ` (starting at ${comment.start_line})` : ""}` : comment.original_line != null ? `older location, original line ${comment.original_line}` : "line unavailable";
    lines.push(`- ${author(comment)} on ${comment.path ?? "file unavailable"}, ${location}, version ${comment.commit_id ?? comment.original_commit_id ?? "unavailable"}${comment.in_reply_to_id ? `, reply to comment ${comment.in_reply_to_id}` : ""} (comment ${comment.id ?? "unavailable"}):\n${words(comment)}`);
  }
  if (!files.length) lines.push("No file comments.");
  lines.push(`Latest checks for version ${pr.head}:`);
  // GitHub can return previous attempts. Keep the newest result for each name/context.
  const latest = (entries: any[], name: string) => [...new Map(entries.sort((a, b) => String(a.completed_at ?? a.updated_at ?? a.started_at ?? a.created_at ?? "").localeCompare(String(b.completed_at ?? b.updated_at ?? b.started_at ?? b.created_at ?? "")) || Number(a.id ?? 0) - Number(b.id ?? 0)).map((entry) => [name === "name" ? `${entry.app?.id ?? ""}:${entry.check_suite?.id ?? ""}:${entry[name]}` : entry[name], entry])).values()];
  for (const check of latest(runs, "name")) lines.push(`- ${check.name ?? "Unnamed check"}: ${check.status === "completed" ? check.conclusion ?? "result unavailable" : check.status ?? "state unavailable"}; version ${check.head_sha ?? "unavailable"}${check.head_sha && check.head_sha !== pr.head ? " (older version)" : ""}`);
  for (const status of latest(statuses, "context")) lines.push(`- ${status.context ?? "Unnamed status"}: ${status.state ?? "state unavailable"}; version ${pr.head}${status.description ? `; ${status.description}` : ""}`);
  if (!runs.length && !statuses.length) lines.push("No check results reported for this version.");
  return lines.join("\n\n");
}
