import type { SourceBackgroundPullRequest } from "../source-background.js";

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type GitHubCreated = { ok: true; url: string } | { ok: false; exists: boolean; error: string };
export interface GitHubPullRequestInfo {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  head: string;
  base: string;
  commit: string;
  fork: boolean;
}

/** Repository-scoped GitHub effects. Transport, credentials and response parsing belong to the adapter. */
export interface GitHubService {
  prState(repo: string, number: number): Promise<GitHubPullRequestInfo["state"] | undefined>;
  pullRequests(repo: string, branch: string): Promise<GitHubResult<GitHubPullRequestInfo[]>>;
  openPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<GitHubCreated>;
  latestRelease(repo: string): Promise<GitHubResult<string | undefined>>;
  findRelease(repo: string, tag: string): Promise<GitHubResult<{ tag: string; url: string; draft: boolean } | undefined>>;
  createRelease(repo: string, tag: string, notes: string): Promise<GitHubCreated>;
  sourcePr(repo: string, number: number): Promise<SourceBackgroundPullRequest>;
  background(repo: string, pr: SourceBackgroundPullRequest): Promise<string>;
  requireBranch(repo: string, branch: string): Promise<void>;
  repository(repo: string): Promise<{ repo: string; defaultBranch: string }>;
  comments(repo: string, number: number): Promise<readonly { body?: string }[]>;
  comment(repo: string, number: number, body: string): Promise<void>;
  description(repo: string, number: number): Promise<string>;
  editDescription(repo: string, number: number, body: string): Promise<void>;
}
