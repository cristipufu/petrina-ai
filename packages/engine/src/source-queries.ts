import type { SourceQueries, SourceSelectionEffects } from "@petrina/orchestrator";
import * as git from "./git.js";
import * as github from "./github.js";
import { branchExists, sourcePr } from "./source-github.js";

/** CLI parsing and native Git validation stay on the adapter side of the contract. */
export function sourceQueries(dataDir: string, gh: git.Gh = ["gh"]): SourceQueries & Pick<SourceSelectionEffects, "repository"> {
  return {
    async validBranch(name) {
      return git.isBranchName(name) && (await git.run(["git", "check-ref-format", "--branch", name], dataDir)).code === 0;
    },
    requireBranch: (repo, branch) => branchExists(repo, branch, gh),
    pullRequest: (repo, number) => sourcePr(repo, number, gh),
    async repository(repo) {
      const read = await github.gh(gh, repo, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
      if (read.code) throw new Error(`Could not check ${repo} on GitHub. Retry when it is accessible.`);
      const data = JSON.parse(read.stdout);
      if (typeof data?.nameWithOwner !== "string" || data.nameWithOwner.toLowerCase() !== repo.toLowerCase() || typeof data?.defaultBranchRef?.name !== "string" || !data.defaultBranchRef.name) throw new Error(`GitHub did not confirm ${repo} and its default branch.`);
      return { repo: data.nameWithOwner, defaultBranch: data.defaultBranchRef.name };
    },
  };
}
