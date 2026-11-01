import { markedDoneUnconfirmed } from "./cleanup.js";
import { hasNoProductChanges } from "./direct-tasks.js";
import type { Id, TaskRepository, TaskState } from "./model.js";

export type PublishingResult =
  | { kind: "released"; landed: true; tag: string; url: string }
  | { kind: "committed"; landed: true; branch: string; sha: string; pushed?: true }
  | { kind: "merged"; landed: true; number: number; url: string }
  | { kind: "pull-request-open"; landed: false; number: number; url: string; updated?: boolean }
  | { kind: "pull-request-closed"; landed: false; number: number; url: string; decision: "needed" | "accepted" | "none" }
  | { kind: "local-unpushed"; landed: false; branch: string; sha: string }
  | { kind: "publishing"; landed: false; step: string }
  | { kind: "interrupted"; landed: false; decision: "needed" }
  | { kind: "unknown"; landed: false }
  | { kind: "no-changes"; landed: null }
  | {
      kind: "unconfirmed";
      landed: false;
      pullRequestCheck: "unconfirmed" | "none" | "pending" | "found";
      lookup?: { number: number; url: string; state: string };
      foreignPullRequest?: { number: number; url: string };
    }
  | { kind: "pending"; landed: false };

export interface PublishingFacts {
  productId: Id;
  productName: string;
  delivery: TaskRepository["delivery"];
  result: PublishingResult;
}

type Work = TaskRepository | NonNullable<TaskState["repository"]>;

/** One product's recorded delivery result through the existing delivery and landing rules. Nothing is inferred from a general delivered marker. */
export function publishingResult(
  task: Pick<TaskState, "state" | "repositories"> & {
    noProductChanges?: boolean;
    maintenance?: Pick<NonNullable<TaskState["maintenance"]>, "noProductChanges">;
  },
  work: Work,
  interrupted: boolean,
): PublishingResult {
  const shared = work as Partial<TaskRepository>;
  if (work.shipping?.carriedOver) return { kind: "unknown", landed: false };
  if (shared.nothingToPublish || hasNoProductChanges(task)) return { kind: "no-changes", landed: null };
  if (markedDoneUnconfirmed(task, work)) {
    return {
      kind: "unconfirmed",
      landed: false,
      pullRequestCheck: work.pr ? "found" : work.cleanup?.pullRequest ?? "pending",
      ...(work.pr ? { lookup: { number: work.pr.number, url: work.pr.url, state: work.pr.state } } : {}),
      ...(work.cleanup?.foreignPullRequest ? { foreignPullRequest: work.cleanup.foreignPullRequest } : {}),
    };
  }
  if (work.release) return { kind: "released", landed: true, tag: work.release.tag, url: work.release.url };
  if (work.pr?.state === "merged") return { kind: "merged", landed: true, number: work.pr.number, url: work.pr.url };
  if (work.pr?.state === "closed") {
    return {
      kind: "pull-request-closed",
      landed: false,
      number: work.pr.number,
      url: work.pr.url,
      decision: task.repositories ? (shared.landingAccepted ? "accepted" : "needed") : "none",
    };
  }
  if (work.landed && work.localUpdate?.pushed === false) {
    return { kind: "local-unpushed", landed: false, branch: work.localUpdate.branch, sha: work.localUpdate.sha };
  }
  if (work.landed) {
    return {
      kind: "committed",
      landed: true,
      branch: work.landed.branch,
      sha: work.landed.sha,
      ...(work.localUpdate?.pushed === true ? { pushed: true } : {})
    };
  }
  if (work.pr?.state === "open") {
    return {
      kind: "pull-request-open",
      landed: false,
      number: work.pr.number,
      url: work.pr.url,
      ...(work.source?.start.kind === "pull-request" ? { updated: true } : {})
    };
  }
  if (work.localUpdate && !work.localUpdate.pushed) {
    return { kind: "local-unpushed", landed: false, branch: work.localUpdate.branch, sha: work.localUpdate.sha };
  }
  if (interrupted) return { kind: "interrupted", landed: false, decision: "needed" };
  if (work.shipping?.step) return { kind: "publishing", landed: false, step: work.shipping.step };
  if (task.state === "done") {
    return {
      kind: "unconfirmed",
      landed: false,
      pullRequestCheck: work.cleanup?.pullRequest ?? "pending",
      ...(work.cleanup?.foreignPullRequest ? { foreignPullRequest: work.cleanup.foreignPullRequest } : {}),
    };
  }
  return { kind: "pending", landed: false };
}

/** Plain words for a product's result. */
export function publishingWords(result: PublishingResult): string {
  switch (result.kind) {
    case "released": return `published release ${result.tag} (landed)`;
    case "committed": return `committed to ${result.branch} at ${result.sha}${result.pushed ? " and pushed" : "; no push confirmation recorded"} (landed)`;
    case "merged": return `pull request #${result.number} merged (landed)`;
    case "pull-request-open": return `pull request #${result.number} ${result.updated ? "updated and " : ""}open, awaiting merge (not landed)`;
    case "pull-request-closed": return `pull request #${result.number} closed without merging (not landed${result.decision === "needed" ? "; your decision is needed" : result.decision === "accepted" ? "; you resolved it" : ""})`;
    case "local-unpushed": return `${result.branch} advanced locally at ${result.sha}; its push has not finished (not landed)`;
    case "publishing": return `publishing in progress (${result.step}; not landed yet)`;
    case "interrupted": return "shipping was interrupted; your decision is needed (not landed)";
    case "unknown": return "delivery saved by an older Petrina: what went out is unknown until you check GitHub";
    case "no-changes": return "no product changes";
    case "unconfirmed": return `marked done without a confirmed delivery${result.lookup ? `; later lookup found pull request #${result.lookup.number} (${result.lookup.state})` : result.pullRequestCheck === "none" ? "; no pull request was found on its branch" : result.pullRequestCheck === "pending" ? "; the pull request lookup has not finished" : "; the pull request lookup could not be confirmed"}`;
    case "pending": return "not published yet";
  }
}
