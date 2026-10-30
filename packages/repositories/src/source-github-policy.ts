// Exact GitHub source protocol and background projection; callers own transport and native lifecycle.
import { completeAll, prNumber } from "@petrina/core";
import { isBranchName, isSha } from "./identity.js";
import type { RunResult } from "./git.js";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export type SourcePrRequest = (repo: string, args: readonly string[]) => Promise<RunResult>;
export type SourceApiRequest = (args: readonly string[]) => Promise<RunResult>;
export type SourcePagesRequest = (repo: string, endpoint: string) => Promise<unknown[]>;

export interface SourcePr {
  number: number; url: string; state: "open" | "closed" | "merged"; title: string; body: string;
  branch: string; headRepo: string; head: string;
}

interface GitHubPrPayload {
  readonly number?: unknown;
  readonly url?: unknown;
  readonly state?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly headRefName?: unknown;
  readonly headRefOid?: unknown;
  readonly headRepository?: { readonly nameWithOwner?: string; readonly name?: string } | null;
  readonly headRepositoryOwner?: { readonly login?: string } | null;
  readonly isCrossRepository?: boolean;
}

interface GitHubAuthored {
  readonly user?: { readonly login?: string | null } | null;
  readonly body?: unknown;
}

interface GitHubReviewEntry extends GitHubAuthored {
  readonly state?: string | null;
  readonly commit_id?: string | null;
}

interface GitHubFileCommentEntry extends GitHubAuthored {
  readonly id?: number | string | null;
  readonly path?: string | null;
  readonly line?: number | null;
  readonly start_line?: number | null;
  readonly original_line?: number | null;
  readonly commit_id?: string | null;
  readonly original_commit_id?: string | null;
  readonly in_reply_to_id?: number | string | null;
}

interface GitHubTimestampedEntry {
  readonly id?: number | string | null;
  readonly completed_at?: string | null;
  readonly updated_at?: string | null;
  readonly started_at?: string | null;
  readonly created_at?: string | null;
}

interface GitHubCheckRunEntry extends GitHubTimestampedEntry {
  readonly name?: string | null;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly head_sha?: string | null;
  readonly app?: { readonly id?: number | string | null } | null;
  readonly check_suite?: { readonly id?: number | string | null } | null;
}

interface GitHubStatusEntry extends GitHubTimestampedEntry {
  readonly context?: string | null;
  readonly state?: string | null;
  readonly description?: string | null;
}

export async function sourcePr(repo: string, number: number, readRequest: SourcePrRequest): Promise<SourcePr> {
  const read = await readRequest(
    repo,
    [
    "pr",
    "view",
    String(number),
    "--json",
    "number,url,state,title,body,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository"
  ]
  );
  if (read.code) throw new Error(`Could not read PR #${number} in ${repo}: ${read.stderr || read.stdout}. Retry when it is accessible.`);
  const data = JSON.parse(read.stdout) as GitHubPrPayload;
  const headRepo = data.headRepository?.nameWithOwner ?? (data.headRepositoryOwner?.login && data.headRepository?.name ? `${data.headRepositoryOwner.login}/${data.headRepository.name}` : data.isCrossRepository === false ? repo : undefined);
  if (
    data.number !== number
    || typeof headRepo !== "string"
    || !REPO.test(headRepo)
    || typeof data.headRefName !== "string"
    || !isBranchName(data.headRefName)
    || typeof data.headRefOid !== "string"
    || !isSha(data.headRefOid)
    || typeof data.title !== "string"
    || typeof data.body !== "string"
    || typeof data.url !== "string"
    || prNumber(data.url, repo) !== number
  ) {
    throw new Error(`GitHub's details for PR #${number} are incomplete, including its working repository or branch. Retry when they are available.`);
  }
  return {
    number,
    url: data.url,
    state: String(data.state).toLowerCase() as SourcePr["state"],
    title: data.title,
    body: data.body,
    branch: data.headRefName,
    headRepo,
    head: data.headRefOid
  };
}

/** Every page, with no truncation; pull review comments includes replies across all threads. */
export async function api(repo: string, endpoint: string, readRequest: SourceApiRequest): Promise<unknown[]> {
  if (!REPO.test(repo)) throw new Error("This is not a GitHub repository.");
  const read = await readRequest(["api", `repos/${repo}/${endpoint}`, "--paginate", "--slurp"]);
  if (read.code) throw new Error(`Could not refresh pull request background in ${repo} (${read.stderr || read.stdout}). Earlier background has not been refreshed. Retry when GitHub is accessible.`);
  const pages: unknown = JSON.parse(read.stdout);
  if (!Array.isArray(pages)) throw new Error("GitHub returned unreadable background. Retry to read it again.");
  return pages;
}

export async function background(repo: string, pr: SourcePr, readPages: SourcePagesRequest): Promise<string> {
  const [reviewPages, discussionPages, filePages, runPages, statusPages] = await completeAll([
    readPages(repo, `pulls/${pr.number}/reviews?per_page=100`),
    readPages(repo, `issues/${pr.number}/comments?per_page=100`),
    readPages(repo, `pulls/${pr.number}/comments?per_page=100`),
    readPages(repo, `commits/${pr.head}/check-runs?per_page=100`),
    readPages(repo, `commits/${pr.head}/status?per_page=100`),
  ]);
  const reviews = reviewPages!.flat() as GitHubReviewEntry[];
  const discussion = discussionPages!.flat() as GitHubAuthored[];
  const files = filePages!.flat() as GitHubFileCommentEntry[];
  const runs = runPages!.flatMap((page): GitHubCheckRunEntry[] => {
    const record = page as { readonly check_runs?: unknown } | null | undefined;
    if (!Array.isArray(record?.check_runs)) throw new Error("GitHub returned unreadable check results. Retry to refresh them.");
    return record.check_runs as GitHubCheckRunEntry[];
  });
  const statuses = statusPages!.flatMap((page): GitHubStatusEntry[] => {
    const record = page as { readonly statuses?: unknown } | null | undefined;
    if (!Array.isArray(record?.statuses)) throw new Error("GitHub returned unreadable status results. Retry to refresh them.");
    return record.statuses as GitHubStatusEntry[];
  });
  const author = (entry: GitHubAuthored) => entry.user?.login ?? "Unavailable author";
  const words = (entry: GitHubAuthored) => typeof entry.body === "string" ? entry.body : "Text unavailable";
  const lines = [
    `PR #${pr.number}: ${pr.title}`,
    pr.body || "No description.",
    `Working branch: ${pr.headRepo} · ${pr.branch}`,
    `Current version: ${pr.head}`,
    "Review summaries:"
  ];
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
  const latest = <T extends GitHubTimestampedEntry>(entries: T[], keyOf: (entry: T) => unknown): T[] =>
    [...new Map(
      entries
        .sort((a, b) =>
          String(a.completed_at ?? a.updated_at ?? a.started_at ?? a.created_at ?? "")
            .localeCompare(String(b.completed_at ?? b.updated_at ?? b.started_at ?? b.created_at ?? ""))
          || Number(a.id ?? 0) - Number(b.id ?? 0),
        )
        .map((entry) => [keyOf(entry), entry]),
    ).values()];
  for (const check of latest(runs, (entry) => `${entry.app?.id ?? ""}:${entry.check_suite?.id ?? ""}:${entry.name}`)) {
    lines.push(`- ${check.name ?? "Unnamed check"}: ${check.status === "completed" ? check.conclusion ?? "result unavailable" : check.status ?? "state unavailable"}; version ${check.head_sha ?? "unavailable"}${check.head_sha && check.head_sha !== pr.head ? " (older version)" : ""}`);
  }
  for (const status of latest(statuses, (entry) => entry.context)) {
    lines.push(`- ${status.context ?? "Unnamed status"}: ${status.state ?? "state unavailable"}; version ${pr.head}${status.description ? `; ${status.description}` : ""}`);
  }
  if (!runs.length && !statuses.length) lines.push("No check results reported for this version.");
  return lines.join("\n\n");
}

