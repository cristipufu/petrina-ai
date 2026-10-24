import type { DeliveryMode, Product, Task } from "./model.js";

export type StartFrom = { kind: "default" } | { kind: "branch"; name: string } | { kind: "pull-request"; value: string };

/** A structured repository choice, proposed by the planner or selected by the coordinator. */
export interface WorkChoice {
  productId: string;
  repo?: string;
  reason?: string;
  builderProfileId?: string;
  lead?: boolean;
  startFrom: StartFrom;
  delivery: DeliveryMode;
}

/** Approved identities, independent of later product settings or working-copy remotes. */
export interface TaskSource {
  product: Pick<Product, "id" | "name" | "repo" | "path" | "remote" | "defaultBranch">;
  start: { kind: "default" | "branch"; branch: string } | {
    kind: "pull-request";
    number: number;
    url: string;
    headRepo: string;
    branch: string;
  };
  destination: { mode: DeliveryMode; repo: string; branch: string; remote?: string; kind: "branch" | "new-pr" | "update-pr" | "release" };
  confirmed: boolean;
  /** Set only once, when preparation fetches the approved source. */
  initialSha?: string;
}

export interface PullRequestBackground {
  readAt: number;
  head: string;
  text: string;
}

export function sourceLabel(source: TaskSource | undefined): string {
  if (!source) return "";
  return source.start.kind === "pull-request" ? `from PR #${source.start.number}` : `from ${source.start.branch}`;
}

export function deliveryLabel(task: Pick<Task, "source" | "delivery">): string {
  const source = task.source;
  if (source?.start.kind === "pull-request") return `Update PR #${source.start.number}`;
  return task.delivery === "local" ? `Commit to ${source?.destination.branch ?? "main"}` : task.delivery === "release" ? "Publish a release" : "Open a pull request";
}

export function workSummary(source: TaskSource): string {
  const where = `${source.destination.repo} · ${source.destination.branch}`;
  const action = source.start.kind === "pull-request" ? `Update PR #${source.start.number}` : source.destination.kind === "new-pr" ? "Open a pull request into" : source.destination.kind === "release" ? "Publish a release from" : source.destination.repo.startsWith("local/") ? "Commit to" : "Commit and push to";
  return `Works on: ${source.product.name} (${sourceLabel(source)})\n${action} ${where}`;
}

export function prNumber(value: string, repo: string): number {
  const link = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i.exec(value);
  if (link && link[1]!.toLowerCase() !== repo.toLowerCase()) throw new Error(`That pull request belongs to ${link[1]}, not ${repo}. Choose the matching product or correct the link.`);
  const number = Number(link?.[2] ?? (/^#?\d+$/.test(value) ? value.replace("#", "") : NaN));
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Enter a pull request number or a GitHub pull request link.");
  return number;
}
