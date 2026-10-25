import type { RepositoryObservationQueries } from "@petrina/orchestrator";
import * as git from "./git.js";

/** Native reads close over the workspace once; later task metadata cannot redirect them. */
export const repositoryObservationQueries: RepositoryObservationQueries = {
  bind({ work }) {
    const path = work.worktree;
    if (!path) return;
    return {
      async committed() {
        const { head, tree } = await git.commitVersion(path);
        return head && tree ? { head, tree } : undefined;
      },
      change: (base, head) => git.patchId(path, base, head),
    };
  },
};
