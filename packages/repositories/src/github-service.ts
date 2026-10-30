import type { GitHubService } from "@petrina/orchestrator";
import { commitChecks } from "./commit-checks.js";
import * as github from "./github.js";
import * as source from "./source-github.js";

/** Native GitHub remains the default; hosts may explicitly supply another complete service. */
export function githubService(command: github.GitHubCommand = ["gh"]): GitHubService {
  return {
    prState: (repo, number) => github.prState(repo, number, command),
    pullRequests: (repo, branch) => github.pullRequests(repo, branch, command),
    openPullRequest: (repo, pr) => github.openPullRequest(repo, pr, command),
    latestRelease: repo => github.latestRelease(repo, command),
    findRelease: (repo, tag) => github.findRelease(repo, tag, command),
    createRelease: (repo, tag, notes) => github.createRelease(repo, tag, notes, command),
    sourcePr: (repo, number) => source.sourcePr(repo, number, command),
    background: (repo, pr) => source.background(repo, pr, command),
    requireBranch: (repo, branch) => source.branchExists(repo, branch, command),
    repository: repo => source.repository(repo, command),
    comments: async (repo, number) => (await source.api(repo, `issues/${number}/comments?per_page=100`, command)).flat() as { body?: string }[],
    async comment(repo, number, body) {
      const result = await github.gh(command, repo, ["pr", "comment", String(number), "--body-file", "-"], body);
      if (result.code) throw new Error(result.stderr || "Could not confirm the companion comment.");
    },
    async description(repo, number) {
      const result = await github.gh(command, repo, ["pr", "view", String(number), "--json", "body"]);
      if (result.code) throw new Error("Could not read the companion links. Check again.");
      const body: unknown = JSON.parse(result.stdout).body;
      if (typeof body !== "string") throw new Error("GitHub did not return the pull request description.");
      return body;
    },
    async editDescription(repo, number, body) {
      const result = await github.gh(command, repo, ["pr", "edit", String(number), "--body-file", "-"], body);
      if (result.code) throw new Error(result.stderr || "Could not finish companion links.");
    },
    commitChecks: (repo, sha) => commitChecks(repo, sha, command),
  };
}
