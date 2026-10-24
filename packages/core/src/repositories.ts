import { REPOSITORY_FIELDS, type Finding, type Id, type RepositoryState, type Task, type TaskRepository } from "./model.js";

/** A task's public view uses one repository's fields without making another writable execution record. */
export function repositoryTaskView(task: Task, work: RepositoryState): Task {
  const view = { ...task };
  Reflect.deleteProperty(view, "repository");
  for (const field of REPOSITORY_FIELDS) Reflect.deleteProperty(view, field);
  return Object.assign(view, work, { workChoice: task.workChoice });
}

/** Present stored records or an already displayed task through the same read-only surface. */
export function displayTask(task: Task): Task {
  const work = task.repositories?.find((entry) => entry.productId === (task.activeProductId ?? task.productId)) ?? task.repository;
  return work ? repositoryTaskView(task, work) : task;
}

/** One task appears under each retained product, and only once in portfolio totals. */
export function taskProductIds(task: Pick<Task, "productId" | "repositories" | "selectedProducts" | "workRows">): Id[] {
  const ids = task.repositories?.filter((entry) => !entry.removed).map((entry) => entry.productId)
    ?? task.workRows?.map((entry) => entry.source?.product.id ?? entry.choice.productId)
    ?? task.selectedProducts?.map((entry) => entry.productId)
    ?? [task.productId];
  return [...new Set(ids.filter(Boolean))];
}

export function involvesProduct(task: Parameters<typeof taskProductIds>[0], productId: Id): boolean {
  return taskProductIds(task).includes(productId);
}

/** Remove membership without losing the other products' shared history. Never mutate before a save succeeds. */
export function withoutProduct(task: Task, productId: Id): Task | undefined {
  if (!involvesProduct(task, productId)) return task;
  const remaining = taskProductIds(task).filter((id) => id !== productId);
  if (!remaining.length) return;
  const next: Task = { ...task };
  Reflect.set(next, "selectedProducts", next.selectedProducts?.filter((choice) => choice.productId !== productId));
  Reflect.set(next, "workRows", next.workRows?.filter((row) => (row.source?.product.id ?? row.choice.productId) !== productId));
  if (next.leadProductId === productId) Reflect.set(next, "leadProductId", remaining[0]);
  if (next.plan?.leadProductId === productId) Reflect.set(next, "plan", { ...next.plan, leadProductId: remaining[0] });
  if (next.repositories) {
    Reflect.set(next, "repositories", next.repositories.map((work) => work.productId === productId ? { ...work, removed: true } : work));
    if (next.productId === productId || next.activeProductId === productId) {
      const work = next.repositories.find((entry) => !entry.removed)!;
      Reflect.set(next, "productId", work.productId);
      Reflect.set(next, "delivery", work.delivery);
      Reflect.set(next, "workChoice", work.workChoice);
      for (const field of REPOSITORY_FIELDS) if (field !== "productId" && field !== "delivery" && field !== "workChoice") Reflect.deleteProperty(next, field);
      Reflect.set(next, "activeProductId", work.productId);
    }
  } else if (next.productId === productId) {
    Reflect.set(next, "productId", remaining[0]);
    const row = next.workRows?.find(row => (row.source?.product.id ?? row.choice.productId) === remaining[0]);
    const choice = next.selectedProducts?.find(choice => choice.productId === remaining[0]) ?? row?.choice;
    for (const field of REPOSITORY_FIELDS) if (field !== "productId" && field !== "delivery") Reflect.deleteProperty(next, field);
    Reflect.set(next, "workChoice", choice);
    Reflect.set(next, "source", row?.source);
    Reflect.set(next, "delivery", choice?.delivery ?? row?.source?.destination.mode ?? next.delivery);
    if (next.repository) Reflect.set(next, "repository", { productId: remaining[0]!, delivery: next.delivery, workChoice: choice, source: row?.source });
    if (next.activeProductId === productId) Reflect.set(next, "activeProductId", remaining[0]);
  }
  return next;
}

export function assignedProducts(task: Pick<Task, "productId" | "repositories" | "selectedProducts" | "workRows">, ids: readonly Id[] | undefined): Id[] {
  const products = taskProductIds(task);
  if (!task.repositories) return ids?.length ? ids.filter((id) => products.includes(id)) : products;
  // Partial or invalid assignments are not repaired by guessing.
  return ids?.length && ids.every((id) => products.includes(id)) ? [...new Set(ids)] : [];
}

export function repairOrder(task: Task, findings: readonly Pick<Finding, "productIds">[]): Id[] {
  const affected = new Set(findings.flatMap((finding) => assignedProducts(task, finding.productIds)));
  const order = taskProductIds(task);
  const lead = task.leadProductId ?? task.plan?.leadProductId;
  return [...(lead && affected.has(lead) ? [lead] : []), ...order.filter((id) => id !== lead && affected.has(id))];
}

export function repositoryPublished(work: Pick<TaskRepository, "pr" | "release" | "landed" | "localUpdate">): boolean {
  return !!(work.pr || work.release || work.landed || work.localUpdate?.pushed);
}

export function repositoryDelivered(work: TaskRepository): boolean {
  return !!(work.nothingToPublish || work.pr || work.release || (work.landed && work.localUpdate?.pushed !== false));
}

export function landingState(works: readonly TaskRepository[]): "unfinished" | "decision" | "waiting" | "landed" {
  if (works.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) return "decision";
  if (works.some((work) => !repositoryDelivered(work) || (work.companion && work.companion.state !== "done"))) return "unfinished";
  if (works.some((work) => work.pr?.state === "open")) return "waiting";
  return "landed";
}

export function companionText(works: readonly TaskRepository[]): string {
  const publishing = works.filter((work) => !work.nothingToPublish);
  if (publishing.length < 2) return "";
  return `Part of a change across: ${publishing.map((work) => {
    const name = work.source?.product.name ?? work.workProduct?.name ?? work.productId;
    const repo = work.source?.product.repo ?? work.workProduct?.repo;
    const url = work.pr?.url ?? work.release?.url;
    return url ? `[${name}](${url})` : work.landed || work.delivery === "local" ? `${name} (local delivery)` : `${name} (${repo ? `${repo}; ` : ""}link pending)`;
  }).join(", ")}.`;
}

/** One delivery approval covers the links completed after publication numbers become known. */
export function companionPreview(works: readonly TaskRepository[]): string {
  const text = companionText(works);
  const hasPullRequest = works.some((work) => !work.nothingToPublish && (work.delivery === "pull-request" || work.source?.destination.kind === "update-pr"));
  return text && hasPullRequest ? `${text}\nThese names and links will appear on every companion pull request, visible to anyone who can read it. Pending links will become the resulting pull request or release addresses in these approved repositories.` : text;
}

export function blocksDependents(task: Pick<Task, "state" | "repositories">): boolean {
  if (task.repositories?.some((work) => work.pr?.state === "open" || (work.pr?.state === "closed" && !work.landingAccepted) || work.shipping?.step || work.localUpdate?.pushed === false)) return true;
  return task.state !== "done" && task.state !== "cancelled";
}
