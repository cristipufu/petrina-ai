import type { SourceQueries, SourceSelectionEffects, GitHubService } from "@petrina/orchestrator";
import * as git from "./git.js";
import { githubService } from "./github-service.js";

/** CLI parsing and native Git validation stay on the adapter side of the contract. */
export function sourceQueries(dataDir: string, gh: git.Gh | GitHubService = ["gh"]): SourceQueries & Pick<SourceSelectionEffects, "repository"> {
  const service = "requireBranch" in gh ? gh : githubService(gh);
  return {
    async validBranch(name) {
      if (!git.isBranchName(name)) return false;
      if (git.isSimpleValidBranchName(name)) return true;
      return (await git.run(["git", "check-ref-format", "--branch", name], dataDir)).code === 0;
    },
    requireBranch: (repo, branch) => service.requireBranch(repo, branch),
    pullRequest: (repo, number) => service.sourcePr(repo, number),
    repository: repo => service.repository(repo),
  };
}
