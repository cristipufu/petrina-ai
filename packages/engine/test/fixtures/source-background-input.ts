import { SourceBackground, type RepositoryContext } from "@petrina/orchestrator";
import { sourcePr, api, background, type SourceApiRequest } from "@petrina/repositories/source-github-policy";

/** Declared GitHub transport replies, consumed by the real pagination, background and input owners. */
export function sourceBackgroundInput(scope: RepositoryContext, now: () => number) {
  const source = scope.work.source;
  if (source?.start.kind !== "pull-request") throw new Error("Background input requires its declared approved PR source");
  const start = source.start, repo = source.product.repo;
  const head = "a".repeat(40), earlier = "0".repeat(40);
  let offline = false;
  const calls: string[][] = [];
  const pages: Record<string, unknown> = {
    [`pulls/${start.number}/reviews?per_page=100`]: [
      [{ user: { login: "Reviewer" }, state: "CHANGES_REQUESTED", body: "Review summary", commit_id: head }],
      [{ user: { login: "Second reviewer" }, body: "Last review page" }],
    ],
    [`issues/${start.number}/comments?per_page=100`]: [
      [{ user: { login: "Author" }, body: "First discussion page" }],
      [{ body: "Last discussion page" }],
    ],
    [`pulls/${start.number}/comments?per_page=100`]: [
      [{ id: 1, user: { login: "Reviewer" }, path: "checkout.ts", line: 42, body: "First file comment", commit_id: head }],
      [{ id: 2, in_reply_to_id: 1, path: "checkout.ts", original_line: 39, body: "Reply on the final page", original_commit_id: earlier }],
    ],
    [`commits/${head}/check-runs?per_page=100`]: [
      {
        check_runs: [
          { name: "Tests", status: "in_progress", head_sha: head },
          { name: "Old lint", status: "completed", conclusion: "failure", head_sha: earlier },
        ],
      },
      {
        check_runs: [
          { name: "Build", status: "completed", conclusion: "success", head_sha: head },
          { name: "Shared", app: { id: 1 }, check_suite: { id: 10 }, status: "completed", conclusion: "failure", head_sha: head },
          { name: "Shared", app: { id: 2 }, check_suite: { id: 20 }, status: "completed", conclusion: "success", head_sha: head },
        ],
      },
    ],
    [`commits/${head}/status?per_page=100`]: [
      { statuses: [{ context: "Preview", state: "pending", description: "Waiting for preview" }] },
    ],
  };
  const transport: { request: SourceApiRequest } = {
    async request(args) {
      calls.push([...args]);
      if (offline) return { code: 1, stdout: "", stderr: "Controlled GitHub background refusal" };
      if (args[0] === "pr" && args[1] === "view" && args[2] === String(start.number) && args.at(-2) === "--repo" && args.at(-1) === repo) {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            number: start.number,
            url: `https://github.com/${repo}/pull/${start.number}`,
            state: "OPEN",
            title: "Original PR title",
            body: "Original description",
            headRefName: start.branch,
            headRefOid: head,
            headRepository: { nameWithOwner: start.headRepo },
          }),
        };
      }
      const prefix = `repos/${repo}/`;
      if (args[0] !== "api" || !args[1]?.startsWith(prefix) || args[2] !== "--paginate" || args[3] !== "--slurp") {
        throw new Error(`Unexpected background request: ${JSON.stringify(args)}`);
      }
      const endpoint = args[1].slice(prefix.length);
      if (!Object.hasOwn(pages, endpoint)) throw new Error(`No declared background page for ${endpoint}`);
      return { code: 0, stderr: "", stdout: JSON.stringify(pages[endpoint]) };
    },
  };
  const checkpoints: number[] = [];
  const owner = new SourceBackground({
    serial: (_id, read) => read(),
    readPullRequest: (repo, number) => sourcePr(repo, number, (owner, args) => transport.request([...args, "--repo", owner])),
    background: (repo, pr) => background(repo, pr, (owner, endpoint) => api(owner, endpoint, args => transport.request(args))),
    now,
    checkpoint: current => {
      if (current.work !== scope.work) throw new Error("Foreign source background");
      checkpoints.push(now());
    },
  });
  return { owner, calls, checkpoints, head, earlier, pages,
    offline(value: boolean) { offline = value; },
    refresh: () => owner.refresh(scope, true),
  };
}
