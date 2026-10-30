import { describe, expect, it } from "bun:test";
import { commitChecks } from "../../../src/commit-checks.js";
import type { GitHubRequests } from "../../../src/github.js";

describe("exact-commit GitHub check-run and status adapter", () => {
  const sha = "a".repeat(40);

  it("reads paginated check-runs and commit statuses for an exact repository and commit SHA", async () => {
    const calls: string[][] = [];
    const transport: GitHubRequests = {
      async request(args) {
        calls.push([...args]);
        if (args[1]?.endsWith("/check-runs?per_page=100")) {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                check_runs: [
                  {
                    id: 11,
                    name: "Tests",
                    status: "completed",
                    conclusion: "success",
                    head_sha: sha,
                    app: { id: 1 },
                    check_suite: { id: 100 },
                    completed_at: "2026-10-30T12:00:00Z",
                  },
                ],
              },
              {
                check_runs: [
                  {
                    id: 12,
                    name: "Lint",
                    status: "in_progress",
                    conclusion: null,
                    head_sha: sha,
                    started_at: "2026-10-30T12:01:00Z",
                  },
                ],
              },
            ]),
          };
        }
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify([
            {
              statuses: [
                {
                  id: 21,
                  context: "Preview",
                  state: "success",
                  description: "Ready",
                  updated_at: "2026-10-30T12:02:00Z",
                },
              ],
            },
          ]),
        };
      },
    };

    const result = await commitChecks("acme/demo", sha, transport);
    expect(result).toEqual({
      ok: true,
      value: {
        sha,
        checkRuns: [
          {
            id: 11,
            name: "Tests",
            status: "completed",
            conclusion: "success",
            headSha: sha,
            appId: 1,
            suiteId: 100,
            timestamp: "2026-10-30T12:00:00Z",
          },
          {
            id: 12,
            name: "Lint",
            status: "in_progress",
            conclusion: null,
            headSha: sha,
            appId: undefined,
            suiteId: undefined,
            timestamp: "2026-10-30T12:01:00Z",
          },
        ],
        statuses: [
          {
            id: 21,
            context: "Preview",
            state: "success",
            description: "Ready",
            timestamp: "2026-10-30T12:02:00Z",
          },
        ],
      },
    });
    expect(calls).toEqual([
      ["api", `repos/acme/demo/commits/${sha}/check-runs?per_page=100`, "--paginate", "--slurp"],
      ["api", `repos/acme/demo/commits/${sha}/status?per_page=100`, "--paginate", "--slurp"],
    ]);
  });

  it("rejects invalid repository or commit identifiers and reports transport or payload failures cleanly", async () => {
    const unused: GitHubRequests = {
      async request() {
        throw new Error("Transport should not be called for invalid arguments");
      },
    };
    expect(await commitChecks("not a repo", sha, unused)).toEqual({
      ok: false,
      error: "not a GitHub repository: not a repo",
    });
    expect(await commitChecks("acme/demo", "not-a-sha", unused)).toEqual({
      ok: false,
      error: "invalid Git commit identifier",
    });

    const malformed: GitHubRequests = {
      async request() {
        return { code: 0, stderr: "", stdout: JSON.stringify([{ unexpected: true }]) };
      },
    };
    expect(await commitChecks("acme/demo", sha, malformed)).toEqual({
      ok: false,
      error: "GitHub returned unreadable check-run results",
    });
  });
});
