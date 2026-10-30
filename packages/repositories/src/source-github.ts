// Native GitHub source requests retain the existing default command and bounded lifecycle.
import * as github from "./github.js";
import * as policy from "./source-github-policy.js";
export type { SourcePr } from "./source-github-policy.js";
const GH = ["gh"];
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function sourcePr(repo: string, number: number, cmd: github.GitHubCommand = GH): Promise<policy.SourcePr> {
  return policy.sourcePr(repo, number, (owner, args) => github.gh(cmd, owner, [...args]));
}

/** Every page, with no truncation; transport failures retain GitHub wording. */
export function api(repo: string, endpoint: string, cmd: github.GitHubCommand = GH): Promise<unknown[]> {
  return policy.api(repo, endpoint, async args => github.inGitHubTerms(await github.request(cmd, args)));
}

export async function branchExists(repo: string, branch: string, cmd: github.GitHubCommand = GH): Promise<void> {
  if (!REPO.test(repo)) throw new Error("This is not a GitHub repository.");
  const unavailable = `The branch ${branch} is unavailable in ${repo}. Correct the choice or retry.`;
  // A missing branch is not a failed pull request refresh. Read it directly so that explanation can be shown.
  const read = github.inGitHubTerms(await github.request(cmd, ["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`, "--paginate", "--slurp"]));
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

export function background(repo: string, pr: policy.SourcePr, cmd: github.GitHubCommand = GH): Promise<string> {
  return policy.background(repo, pr, (owner, endpoint) => api(owner, endpoint, cmd));
}

/** The repository identity and default branch returned by GitHub, never inferred from a local clone. */
export async function repository(repo: string, cmd: github.GitHubCommand = GH): Promise<{ repo: string; defaultBranch: string }> {
  const read = await github.gh(cmd, repo, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
  if (read.code) throw new Error(`Could not check ${repo} on GitHub. Retry when it is accessible.`);
  const data = JSON.parse(read.stdout);
  if (typeof data?.nameWithOwner !== "string" || data.nameWithOwner.toLowerCase() !== repo.toLowerCase() || typeof data?.defaultBranchRef?.name !== "string" || !data.defaultBranchRef.name) throw new Error(`GitHub did not confirm ${repo} and its default branch.`);
  return { repo: data.nameWithOwner, defaultBranch: data.defaultBranchRef.name };
}
