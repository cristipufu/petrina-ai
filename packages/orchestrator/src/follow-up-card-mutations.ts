import {
  completeAll,
  createTaskState,
  findingImages,
  followUpDescription,
  followUpKey,
  followUpTitle,
  takesFollowUps,
  type DeepMutable,
  type FollowUpCreate,
  type FollowUpCredit,
  type FollowUpLink,
  type Id,
  type ReportImage,
  type Task,
} from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { FollowUpLinkHost } from "./ports/follow-up-links.js";

export function storedFollowUpCredit(report: FollowUpCredit): DeepMutable<NonNullable<Task["followUp"]>["reports"][number]> {
  return {
    taskId: report.taskId,
    findingId: report.findingId,
    sourceTitle: report.sourceTitle,
    text: report.text,
    steps: report.steps,
    evidence: report.evidence,
    raisedBy: report.raisedBy,
    ...(report.roleId ? { roleId: report.roleId } : {}),
    productIds: [...report.productIds],
    ...(report.reasons?.length ? { reasons: [...report.reasons] } : {}),
    at: report.at,
  };
}

export function createFollowUpCard(host: FollowUpLinkHost, create: FollowUpCreate): RuntimeTask {
  let id = host.id("task");
  while (host.taskIdTaken(id)) id = host.id("task");
  const choices = create.productIds.map((productId) => {
    const product = host.current().products.find((entry) => entry.id === productId);
    return {
      productId,
      startFrom: { kind: "default" as const },
      delivery: product?.delivery ?? ("pull-request" as const),
    };
  });
  const product = host.current().products.find((entry) => entry.id === choices[0]?.productId);
  const names = create.productIds.map(
    (productId) => host.current().products.find((entry) => entry.id === productId)?.name ?? productId,
  );
  const now = host.now();
  const task: RuntimeTask = createTaskState(
    {
      productId: choices[0]?.productId ?? "",
      title: create.title,
      description: followUpDescription(create.reports, names),
      kind: "bug",
      worksOn: choices,
      backlog: true,
    },
    host.current().products,
    { id, timelineId: host.id(id), now, priority: host.current().tasks.length },
  );
  // Discovery selects the affected products; the coordinator still reviews this inferred request.
  task.explicitStart = false;
  task.repository = {
    productId: task.productId,
    delivery: task.delivery,
    workChoice: structuredClone(task.workChoice),
    ...(product
      ? {
          workProduct: {
            id: product.id,
            name: product.name,
            repo: product.repo,
            path: product.path,
            remote: product.remote,
            defaultBranch: product.defaultBranch ?? "main",
          },
        }
      : {}),
  };
  task.timeline = [{ id: task.timeline[0]!.id, at: now, text: "Kept as future work", tone: "status" }];
  task.followUp = { reports: create.reports.map(storedFollowUpCredit) };
  host.current().tasks.push(task);
  return task;
}

export function followUpCardAfterClose(host: FollowUpLinkHost, link: FollowUpLink): RuntimeTask {
  const existing = host.current().tasks.find(
    (task) =>
      task.followUp
      && task.state !== "done"
      && task.state !== "cancelled"
      && task.followUp.reports.some((report) => link.keys.includes(followUpKey(report.taskId, report.findingId))),
  );
  if (existing) return existing;
  return createFollowUpCard(host, {
    title: followUpTitle(link.reports[0]?.text ?? "Older bug"),
    description: "",
    productIds: [...new Set(link.reports.flatMap((report) => report.productIds))],
    reports: link.reports,
    keys: [...link.keys],
  });
}

export function applyFollowUpLink(host: FollowUpLinkHost, card: RuntimeTask, link: FollowUpLink): void {
  if (!takesFollowUps(card as Task, link.reports)) return;
  card.followUp ??= { reports: [], preserveRequest: true };
  const reports = [...card.followUp.reports];
  for (const report of link.reports) {
    if (!reports.some((entry) => entry.taskId === report.taskId && entry.findingId === report.findingId)) {
      reports.push(storedFollowUpCredit(report));
    }
  }
  // Read the card as it is now. Queueing or cancelling during the match must not use the earlier phase.
  const covered = new Set<string>([
    ...(card.selectedProducts ?? []).map((choice) => choice.productId),
    ...(card.followUp.alsoReported ?? []),
    ...card.followUp.reports.flatMap((report) => report.productIds),
  ]);
  const extra = [...new Set(link.reports.flatMap((report) => report.productIds))].filter(
    (id) => id.length > 0 && !covered.has(id),
  );
  if (card.state !== "backlog" || card.followUp.preserveRequest) {
    const also = [...(card.followUp.alsoReported ?? [])];
    for (const id of extra) if (!also.includes(id)) also.push(id);
    card.followUp = { ...card.followUp, reports, alsoReported: also.length ? also : undefined };
    return;
  }
  const selected = [...(card.selectedProducts ?? [])];
  for (const id of extra) {
    if (selected.some((choice) => choice.productId === id)) continue;
    const product = host.current().products.find((entry) => entry.id === id);
    selected.push({ productId: id, startFrom: { kind: "default" }, delivery: product?.delivery ?? card.delivery });
    if (product?.approveDelivery !== false) card.approveDelivery = true;
  }
  card.selectedProducts = selected;
  if (selected.length !== 1) card.approvePlan = true;
  const also = card.followUp.alsoReported;
  card.followUp = { ...card.followUp, reports, alsoReported: also?.length ? [...also] : undefined };
}

export async function keepFollowUpImages(
  host: FollowUpLinkHost,
  card: RuntimeTask,
  reports: readonly FollowUpCredit[],
): Promise<boolean> {
  const kept = new Set(
    card.session.flatMap((line) =>
      (line.images ?? []).flatMap((image) =>
        image.from ? [JSON.stringify([image.from.taskId, image.from.imageId])] : [],
      ),
    ),
  );
  const pending = reports
    .flatMap((report) => report.images)
    .filter((image) => {
      const key = JSON.stringify([image.sourceTaskId, image.sourceImageId]);
      if (kept.has(key)) return false;
      kept.add(key);
      return true;
    });
  const saved = await completeAll(pending.map((image) => host.keepPicture(card.id, image)));
  const failed = saved.some((image) => image === "failed");
  const images = saved.filter((image): image is ReportImage => !!image && image !== "failed");
  if (images.length) {
    card.session = [
      ...card.session,
      {
        id: host.id(card.id),
        at: host.now(),
        from: "system",
        text: "Kept from the original report",
        images,
      },
    ];
  }
  return !failed;
}

export function releaseFollowUpReport(
  host: FollowUpLinkHost,
  release: { taskId: Id; findingId: Id; cardId: Id },
): void {
  const card = host.task(release.cardId);
  const task = host.task(release.taskId);
  const finding = task?.findings.find((entry) => entry.id === release.findingId);
  const productNames = (ids: readonly Id[]): string[] =>
    ids.map((id) => host.current().products.find((entry) => entry.id === id)?.name ?? id);
  if (card?.followUp) {
    const before = card.followUp.reports;
    const dropped = before.find((report) => report.taskId === release.taskId && report.findingId === release.findingId);
    const reports = before.filter((report) => report.taskId !== release.taskId || report.findingId !== release.findingId);
    if (dropped && reports.length && reports.length !== before.length) {
      const still = new Set(reports.flatMap((report) => report.productIds));
      const only = dropped.productIds.filter((id) => !still.has(id));
      if (card.state === "backlog" && only.length && !card.followUp.preserveRequest) {
        card.selectedProducts = (card.selectedProducts ?? []).filter((choice) => !only.includes(choice.productId));
        if ((card.selectedProducts ?? []).length === 1) card.approvePlan = false;
      }
      const also = (card.followUp.alsoReported ?? []).filter((id) => !only.includes(id));
      const auto = followUpDescription(
        before.map(asCredit),
        productNames([...new Set(before.flatMap((report) => report.productIds))]),
      );
      const rewrite = !card.followUp.preserveRequest && card.description === auto;
      card.followUp = { ...card.followUp, reports, alsoReported: also.length ? also : undefined };
      if (task && finding) dropCreditedPictures(host, card, task, finding);
      if (rewrite) {
        const names = productNames((card.selectedProducts ?? []).map((choice) => choice.productId));
        card.description = followUpDescription(
          reports.map(asCredit),
          names.length ? names : productNames([...new Set(reports.flatMap((report) => report.productIds))]),
        );
      }
    } else if (reports.length !== before.length) {
      const also = card.followUp.alsoReported;
      card.followUp = { ...card.followUp, reports, alsoReported: also?.length ? [...also] : undefined };
    }
    if (!host.current().tasks.includes(card)) host.saveArchived(card);
  }
  if (
    !task
    || !finding?.tracking
    || ("taskId" in finding.tracking ? finding.tracking.taskId !== release.cardId : finding.tracking.reason !== "pictures")
  ) {
    return;
  }
  delete finding.tracking;
  if (!host.current().tasks.includes(task)) host.saveArchived(task);
}

function dropCreditedPictures(
  host: FollowUpLinkHost,
  card: RuntimeTask,
  source: RuntimeTask,
  finding: RuntimeTask["findings"][number],
): void {
  const wanted = new Set(
    findingImages(source as Task, finding).map((image) => `${image.sourceTaskId}/${image.sourceImageId}`),
  );
  if (!wanted.size) return;
  const session: RuntimeTask["session"][number][] = [];
  for (const line of card.session) {
    if (!line.images?.length) {
      session.push(line);
      continue;
    }
    const images = line.images.filter((image) => {
      const key = image.from ? `${image.from.taskId}/${image.from.imageId}` : "";
      if (!wanted.has(key)) return true;
      try {
        host.dropCreditedPicture(card.id, image.id);
      } catch {
        // The file is already gone.
      }
      return false;
    });
    if (!images.length && line.from === "system" && line.text === "Kept from the original report") continue;
    if (images.length) session.push({ ...line, images });
    else {
      const { images: _removed, ...rest } = line;
      session.push(rest);
    }
  }
  card.session = session;
}

function asCredit(report: NonNullable<Task["followUp"]>["reports"][number]): FollowUpCredit {
  return { ...report, images: [] };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key) => right.includes(key));
}

export function mergeFollowUpPending(
  current: readonly { keys: readonly string[]; cardId?: string; retry?: boolean }[],
  next: readonly { keys: readonly string[]; cardId?: string; retry?: boolean }[],
): { keys: string[]; cardId?: string; retry?: boolean }[] {
  const seen = new Set<string>();
  const merged: { keys: string[]; cardId?: string; retry?: boolean }[] = [];
  for (const group of [...current, ...next]) {
    const id = `${group.retry ? "retry" : ""}:${group.cardId ?? ""}:${[...group.keys].sort().join("|")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push({
      keys: [...group.keys],
      ...(group.cardId ? { cardId: group.cardId } : {}),
      ...(group.retry ? { retry: true } : {}),
    });
  }
  return merged;
}

export function sameFollowUpPending(
  current: readonly { keys: readonly string[]; cardId?: string; retry?: boolean }[] | undefined,
  next: readonly { keys: readonly string[]; cardId?: string; retry?: boolean }[],
): boolean {
  const left = current ?? [];
  return (
    left.length === next.length
    && left.every((entry, index) => {
      const other = next[index];
      return (
        !!other
        && entry.cardId === other.cardId
        && !!entry.retry === !!other.retry
        && sameKeys(entry.keys, other.keys)
      );
    })
  );
}
