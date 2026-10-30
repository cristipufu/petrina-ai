import { prNumber, type Product, type TaskSource, type WorkChoice } from "@petrina/core";
import type { SourceQueries } from "./ports/source.js";
import type { RepositoryContext } from "./repository-context.js";

export async function resolveSource(scope: RepositoryContext, choice: WorkChoice, products: readonly Product[], queries: SourceQueries, candidate?: TaskSource["product"]): Promise<TaskSource> {
  const { task } = scope;
  const row = task.workRows?.find((entry) => entry.choice === choice || (entry.choice.productId === choice.productId && entry.choice.repo === choice.repo));
  const addition = row?.addition;
  const registered = products.find((entry) => entry.id === choice.productId) ?? products.find((entry) => entry.repo.toLowerCase() === (choice.repo ?? choice.productId).toLowerCase())
    ?? (addition && row?.source ? { ...row.source.product, id: addition.productId, name: addition.name, path: addition.path } : candidate);
  if (!registered) throw new Error(`Needs adding: ${choice.productId || "a product"}. Add it through Products, then choose it here, or replace it with a registered product.`);
  const product = scope.work.workProduct?.id === choice.productId ? {
    ...scope.work.workProduct,
    name: registered.name
  } : {
    id: registered.id,
    name: registered.name,
    repo: registered.repo,
    path: registered.path,
    remote: registered.remote,
    defaultBranch: registered.defaultBranch ?? "main"
  };
  const { startFrom, delivery } = choice;
  if (delivery === "release" && startFrom.kind !== "default") throw new Error("Releases start from the default branch. Correct the starting point or choose another delivery mode.");
  let start: TaskSource["start"];
  let repo = product.repo;
  let remote = product.remote;
  if (startFrom.kind === "pull-request") {
    const pr = await queries.pullRequest(product.repo, prNumber(startFrom.value, product.repo));
    if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. Choose an open pull request; the work stays here.`);
    start = { kind: "pull-request", number: pr.number, url: pr.url, headRepo: pr.headRepo, branch: pr.branch };
    repo = pr.headRepo;
    remote = repo.toLowerCase() === product.repo.toLowerCase() ? product.remote : `https://github.com/${repo}.git`;
  } else {
    const branch = startFrom.kind === "branch" ? startFrom.name : product.defaultBranch ?? "main";
    if (!await queries.validBranch(branch)) throw new Error("Enter an exact, valid branch name.");
    if ((startFrom.kind === "branch" || task.workRows) && !product.repo.startsWith("local/")) await queries.requireBranch(product.repo, branch);
    start = { kind: startFrom.kind, branch };
  }
  return {
    product,
    start,
    destination: {
    mode: delivery,
    kind: start.kind === "pull-request" ? "update-pr" : delivery === "pull-request" ? "new-pr" : delivery === "release" ? "release" : "branch",
    repo,
    branch: start.branch,
    ...(remote ? { remote } : {})
  },
    confirmed: false
  };
}
