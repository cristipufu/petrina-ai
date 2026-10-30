import type { GitHubService } from "@petrina/orchestrator";
import { githubService } from "@petrina/repositories/github-service";
import { extractFakeGhRepo, fakeGitHubRequest } from "./fake-gh.js";

export interface GitHubFixtureRepository { state: string; remote: string }

/** Explicit GitHub service over private script state and real local Git remotes; no GitHub CLI child. */
export function scriptedGitHub(products: Readonly<Record<string, GitHubFixtureRepository>>): GitHubService {
  return githubService({ async request(args, input) {
    const repo = extractFakeGhRepo(args);
    const target = products[repo ?? ""];
    if (!target) return { code: 1, stdout: "", stderr: `The scripted GitHub service has no repository ${repo ?? "(unspecified)"}` };
    try {
      const result = await fakeGitHubRequest(target.state, target.remote, args, input);
      // Native run returns decoded, trimmed output; the same parser consumes both transports.
      return { ...result, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    } catch (error) {
      return { code: 1, stdout: "", stderr: `fake gh could not answer: ${error instanceof Error ? error.message : String(error)}` };
    }
  } });
}
