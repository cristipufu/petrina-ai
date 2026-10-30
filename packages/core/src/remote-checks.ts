// Pure configuration normalization and remote-CI gate evaluation for exact-candidate GitHub validation.
import type { DeepMutable } from "./flow.js";
import type { Product, RepositoryState } from "./model.js";
import { repositoryPublished } from "./repositories.js";

export const REMOTE_CHECK_LIMITS = {
  count: 20,
  name: 120,
} as const;

export interface RemoteCheckRunEntry {
  id?: number | string | null;
  name: string;
  status: string;
  conclusion?: string | null;
  headSha?: string | null;
  appId?: number | string | null;
  suiteId?: number | string | null;
  timestamp?: string | null;
}

export interface RemoteCommitStatusEntry {
  id?: number | string | null;
  context: string;
  state: string;
  description?: string | null;
  timestamp?: string | null;
}

export interface RemoteCommitChecks {
  sha: string;
  checkRuns: readonly RemoteCheckRunEntry[];
  statuses: readonly RemoteCommitStatusEntry[];
}

export interface RemoteCheckFailure {
  name: string;
  reason: string;
}

export type RemoteCheckGateDecision =
  | { kind: "passed" }
  | { kind: "pending"; waitingOn: readonly string[]; summary: string }
  | { kind: "failed"; failed: readonly RemoteCheckFailure[]; summary: string };

export type RemoteCheckSettingWork = DeepMutable<
  Pick<
    RepositoryState,
    | "productId"
    | "shipping"
    | "approvedSha"
    | "approvedPatch"
    | "approvedFor"
    | "pr"
    | "release"
    | "landed"
    | "localUpdate"
  >
>;

export function normalizeRemoteChecks(names: readonly string[]): string[] {
  if (names.length > REMOTE_CHECK_LIMITS.count) {
    throw new Error(`Keep GitHub checks to ${REMOTE_CHECK_LIMITS.count} or fewer.`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    if (/[\r\n\u2028\u2029\0]/.test(raw)) {
      throw new Error("Keep each GitHub check name on a single line.");
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Give every GitHub check a name.");
    }
    if (trimmed.length > REMOTE_CHECK_LIMITS.name) {
      throw new Error(`Keep each GitHub check name to ${REMOTE_CHECK_LIMITS.name} characters or fewer.`);
    }
    if (seen.has(trimmed)) {
      throw new Error(`Each GitHub check name can appear only once (${trimmed}).`);
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function sameRemoteChecks(left: readonly string[] | undefined, right: readonly string[]): boolean {
  const current = left ?? [];
  return current.length === right.length && current.every((value, index) => value === right[index]);
}

export function configureProductRemoteChecks(
  product: DeepMutable<Pick<Product, "id" | "requiredRemoteChecks">> | undefined,
  names: readonly string[],
  executions: Iterable<RemoteCheckSettingWork>,
): boolean {
  const normalized = normalizeRemoteChecks(names);
  if (!product) throw new Error("This product is no longer in Petrina.");
  if (sameRemoteChecks(product.requiredRemoteChecks, normalized)) return false;
  if (normalized.length) {
    product.requiredRemoteChecks = normalized;
  } else {
    delete product.requiredRemoteChecks;
  }
  for (const work of executions) {
    if (work.productId !== product.id || repositoryPublished(work)) continue;
    if (work.shipping && !work.shipping.step && !work.shipping.pushed) {
      delete work.shipping.prepared;
      delete work.shipping.remoteValidation;
    }
    delete work.approvedSha;
    delete work.approvedPatch;
    delete work.approvedFor;
  }
  return true;
}

function latestEntries<T extends { id?: number | string | null; timestamp?: string | null }>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
): T[] {
  const sorted = [...entries].sort(
    (left, right) =>
      String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""))
      || Number(left.id ?? 0) - Number(right.id ?? 0),
  );
  const byKey = new Map<string, T>();
  for (const entry of sorted) byKey.set(keyOf(entry), entry);
  return [...byKey.values()];
}

function checkRunFailureReason(conclusion: string | null | undefined): string {
  switch (conclusion) {
    case "timed_out":
      return "timed out on GitHub";
    case "cancelled":
      return "was cancelled on GitHub";
    case "action_required":
      return "needs action on GitHub";
    case "startup_failure":
      return "could not start on GitHub";
    case "stale":
      return "was marked stale on GitHub";
    default:
      return "failed on GitHub";
  }
}

export function evaluateRemoteCheckGate(
  required: readonly string[],
  observation: RemoteCommitChecks,
): RemoteCheckGateDecision {
  const expectedNames = normalizeRemoteChecks(required);
  if (!expectedNames.length) return { kind: "passed" };

  const currentRuns = observation.checkRuns.filter((run) => !run.headSha || run.headSha === observation.sha);
  const latestRuns = latestEntries(
    currentRuns,
    (run) => `${run.appId ?? ""}:${run.suiteId ?? ""}:${run.name.trim()}`,
  );
  const latestStatuses = latestEntries(observation.statuses, (status) => status.context.trim());

  const waitingOn: string[] = [];
  const failed: RemoteCheckFailure[] = [];

  for (const name of expectedNames) {
    const runs = latestRuns.filter((run) => run.name.trim() === name);
    const statuses = latestStatuses.filter((status) => status.context.trim() === name);
    if (!runs.length && !statuses.length) {
      waitingOn.push(name);
      continue;
    }

    let failureReason: string | undefined;
    let stillRunning = false;
    let passedCount = 0;

    for (const run of runs) {
      if (run.status !== "completed") {
        stillRunning = true;
        continue;
      }
      if (run.conclusion === "success") {
        passedCount += 1;
      } else if (run.conclusion !== "neutral" && run.conclusion !== "skipped") {
        failureReason ??= checkRunFailureReason(run.conclusion);
      }
    }

    for (const status of statuses) {
      if (status.state === "pending") {
        stillRunning = true;
      } else if (status.state === "success") {
        passedCount += 1;
      } else {
        const detail = status.description?.trim();
        failureReason ??= detail ? `failed on GitHub (${detail})` : "failed on GitHub";
      }
    }

    if (failureReason) {
      failed.push({ name, reason: failureReason });
    } else if (stillRunning) {
      waitingOn.push(name);
    } else if (passedCount === 0) {
      failed.push({ name, reason: "was skipped on GitHub instead of passing" });
    }
  }

  if (failed.length) {
    const summary =
      failed.length === 1
        ? `GitHub check “${failed[0]!.name}” ${failed[0]!.reason}`
        : `GitHub checks did not pass: ${failed.map((entry) => `“${entry.name}” ${entry.reason}`).join("; ")}`;
    return { kind: "failed", failed, summary };
  }

  if (waitingOn.length) {
    return {
      kind: "pending",
      waitingOn,
      summary: `Waiting for GitHub checks: ${waitingOn.join(", ")}`,
    };
  }

  return { kind: "passed" };
}
