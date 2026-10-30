import { describe, expect, it } from "bun:test";
import { prStates, type GitHubRequests } from "../../../src/github.js";

describe("batched per-repository GitHub pull request state lookups", () => {
  it("short-circuits empty and single-PR lookups without issuing GraphQL batch requests", async () => {
    const calls: string[][] = [];
    const transport: GitHubRequests = {
      async request(args) {
        calls.push([...args]);
        return { code: 0, stderr: "", stdout: "MERGED" };
      },
    };

    expect(await prStates("acme/demo", [], transport)).toEqual(new Map());
    expect(await prStates("acme/demo", [0, -4, Number.NaN], transport)).toEqual(new Map());
    expect(calls).toHaveLength(0);

    expect(await prStates("acme/demo", [42, 42], transport)).toEqual(new Map([[42, "merged"]]));
    expect(calls).toEqual([["pr", "view", "42", "--json", "state", "--jq", ".state", "--repo", "acme/demo"]]);
  });

  it("chunks >50 pull requests into 50-PR GraphQL queries and retains confirmed states on partial errors", async () => {
    const calls: string[][] = [];
    const numbers = Array.from({ length: 65 }, (_, index) => index + 1);
    const transport: GitHubRequests = {
      async request(args) {
        calls.push([...args]);
        const query = args.find((arg) => arg.startsWith("query=")) ?? "";
        const repository: Record<string, { state: string } | null> = {};
        let hasMissing = false;
        for (const match of query.matchAll(/(pr_\d+):\s*pullRequest\(number:\s*(\d+)\)/g)) {
          const alias = match[1]!;
          const n = Number(match[2]!);
          if (n === 13) {
            repository[alias] = null;
            hasMissing = true;
          } else {
            repository[alias] = { state: n % 3 === 0 ? "MERGED" : n % 3 === 1 ? "OPEN" : "CLOSED" };
          }
        }
        return {
          code: hasMissing ? 1 : 0,
          stderr: hasMissing ? "Could not resolve to a PullRequest with the number of 13." : "",
          stdout: JSON.stringify({
            data: { repository },
            ...(hasMissing ? { errors: [{ type: "NOT_FOUND", message: "Missing #13" }] } : {}),
          }),
        };
      },
    };

    const result = await prStates("acme/demo", numbers, transport);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.slice(0, 6)).toEqual(["api", "graphql", "-F", "owner=acme", "-F", "name=demo"]);
    expect(result.size).toBe(64);
    expect(result.has(13)).toBe(false);
    expect(result.get(1)).toBe("open");
    expect(result.get(2)).toBe("closed");
    expect(result.get(3)).toBe("merged");
    expect(result.get(65)).toBe("closed");
  });

  it("omits unconfirmed pull requests on invalid repositories, timeouts, or unreadable responses", async () => {
    const timedOut: GitHubRequests = {
      async request() {
        return { code: 124, stdout: '{"data":{"repository":{"pr_0":{"state":"MERGED"}}}}', stderr: "timed out", timedOut: true };
      },
    };
    expect(await prStates("not a repo", [1, 2], timedOut)).toEqual(new Map());
    expect(await prStates("acme/demo", [1, 2], timedOut)).toEqual(new Map());
  });
});
