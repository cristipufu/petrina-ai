// Pure repository addresses and Git reference identities; no process or filesystem access.
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Git ref names, passed only as individual arguments. Unicode and punctuation valid in git are preserved. */
const NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))(?!.*[/.]$)(?!@$)[^\x00-\x20\x7f~^:?*\[\\]+$/;

export const isRefName = (value: string): boolean => NAME.test(value);
export const isRepoName = (value: string): boolean => REPO.test(value);

export const isBranchName = (value: string): boolean => NAME.test(value) && !value.endsWith(".lock") && !value.includes("@{") && !value.startsWith(".");

export { isGitObjectId as isSha } from "@petrina/core";


export const REMOTE = /^(?:(?:ssh|git|https?):\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/;

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
