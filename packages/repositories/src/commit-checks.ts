// Exact-commit GitHub check-run and commit-status inspection over paginated GitHub API endpoints.
import {
  completeAll,
  type RemoteCheckRunEntry,
  type RemoteCommitChecks,
  type RemoteCommitStatusEntry,
} from "@petrina/core";
import type { GitHubResult } from "@petrina/orchestrator";
import { commandFailure, isRepoName, isSha } from "./git.js";
import { inGitHubTerms, request, type GitHubCommand } from "./github.js";

interface RawCheckRun {
  readonly id?: number | string | null;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
  readonly head_sha?: unknown;
  readonly app?: { readonly id?: number | string | null } | null;
  readonly check_suite?: { readonly id?: number | string | null } | null;
  readonly completed_at?: unknown;
  readonly updated_at?: unknown;
  readonly started_at?: unknown;
  readonly created_at?: unknown;
}

interface RawCommitStatus {
  readonly id?: number | string | null;
  readonly context?: unknown;
  readonly state?: unknown;
  readonly description?: unknown;
  readonly updated_at?: unknown;
  readonly created_at?: unknown;
}

function asOptionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  return typeof value === "string" ? value : undefined;
}

async function readApiPages(
  cmd: GitHubCommand,
  repo: string,
  endpoint: string,
): Promise<GitHubResult<unknown[]>> {
  const result = inGitHubTerms(
    await request(cmd, ["api", `repos/${repo}/${endpoint}`, "--paginate", "--slurp"]),
  );
  if (result.code !== 0 || result.startFailure || result.timedOut) {
    return { ok: false, error: commandFailure(result).error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: "GitHub returned unreadable check results" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "GitHub returned unreadable check results" };
  }
  return { ok: true, value: parsed };
}

export async function commitChecks(
  repo: string,
  sha: string,
  cmd: GitHubCommand = ["gh"],
): Promise<GitHubResult<RemoteCommitChecks>> {
  if (!isRepoName(repo)) return { ok: false, error: `not a GitHub repository: ${repo}` };
  if (!isSha(sha)) return { ok: false, error: "invalid Git commit identifier" };

  const [runsReply, statusesReply] = await completeAll([
    readApiPages(cmd, repo, `commits/${sha}/check-runs?per_page=100`),
    readApiPages(cmd, repo, `commits/${sha}/status?per_page=100`),
  ]);

  if (!runsReply!.ok) return runsReply!;
  if (!statusesReply!.ok) return statusesReply!;

  const checkRuns: RemoteCheckRunEntry[] = [];
  for (const page of runsReply!.value) {
    const record = page as { readonly check_runs?: unknown } | null | undefined;
    if (!Array.isArray(record?.check_runs)) {
      return { ok: false, error: "GitHub returned unreadable check-run results" };
    }
    for (const raw of record.check_runs as RawCheckRun[]) {
      if (typeof raw?.name !== "string" || typeof raw?.status !== "string") continue;
      checkRuns.push({
        id: raw.id,
        name: raw.name,
        status: raw.status,
        conclusion: asOptionalString(raw.conclusion),
        headSha: asOptionalString(raw.head_sha),
        appId: raw.app?.id,
        suiteId: raw.check_suite?.id,
        timestamp:
          asOptionalString(raw.completed_at)
          ?? asOptionalString(raw.updated_at)
          ?? asOptionalString(raw.started_at)
          ?? asOptionalString(raw.created_at),
      });
    }
  }

  const statuses: RemoteCommitStatusEntry[] = [];
  for (const page of statusesReply!.value) {
    const record = page as { readonly statuses?: unknown } | null | undefined;
    if (!Array.isArray(record?.statuses)) {
      return { ok: false, error: "GitHub returned unreadable commit-status results" };
    }
    for (const raw of record.statuses as RawCommitStatus[]) {
      if (typeof raw?.context !== "string" || typeof raw?.state !== "string") continue;
      statuses.push({
        id: raw.id,
        context: raw.context,
        state: raw.state,
        description: asOptionalString(raw.description),
        timestamp: asOptionalString(raw.updated_at) ?? asOptionalString(raw.created_at),
      });
    }
  }

  return { ok: true, value: { sha, checkRuns, statuses } };
}
