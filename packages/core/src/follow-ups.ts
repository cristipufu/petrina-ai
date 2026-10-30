// Confirmed older bugs become Backlog cards when their task is done.
// Reviewers judge first. This module only decides which saved reports share a card.

import {
  acceptsFollowUpReport,
  fitsFollowUpCard,
  followUpDescription,
  followUpKey,
  followUpTitle,
  overlapsFollowUpProducts,
  type FollowUpCandidate,
  type FollowUpCreate,
  type FollowUpCredit,
  type FollowUpImage,
  type FollowUpLink,
  type FollowUpPlan,
  type FollowUpSnapshot,
  type MatchAnswer,
  type MatchAsk,
  type OpenFollowUp,
} from "./follow-up-cards.js";
import type { Finding, Id } from "./model.js";

export * from "./follow-up-cards.js";

const CAP = 24;

function creditOf(report: FollowUpCandidate, kept: FollowUpImage[]): FollowUpCredit {
  const seen = new Set(kept.map((image) => `${image.sourceTaskId}/${image.sourceImageId}`));
  const images = report.images.filter((image) => {
    const key = `${image.sourceTaskId}/${image.sourceImageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    kept.push(image);
    return true;
  });
  return {
    taskId: report.taskId,
    findingId: report.findingId,
    sourceTitle: report.sourceTitle,
    text: report.text,
    steps: report.steps!.trim(),
    evidence: report.evidence!.trim(),
    raisedBy: report.raisedBy,
    ...(report.roleId ? { roleId: report.roleId } : {}),
    productIds: report.productIds,
    ...(report.reasons?.length ? { reasons: report.reasons } : {}),
    at: report.at,
    images,
  };
}

interface Working {
  created: FollowUpCreate[];
  linked: FollowUpLink[];
  tracks: { taskId: Id; findingId: Id; tracking: NonNullable<Finding["tracking"]> }[];
  used: Set<string>;
}

function track(working: Working, report: FollowUpCandidate, tracking: NonNullable<Finding["tracking"]>): void {
  if (working.used.has(report.key) || (report.tracking && "taskId" in report.tracking)) return;
  working.used.add(report.key);
  working.tracks.push({ taskId: report.taskId, findingId: report.findingId, tracking });
}

function pictureKey(image: { sourceTaskId: string; sourceImageId: string }): string {
  return `${image.sourceTaskId}/${image.sourceImageId}`;
}

function remember(
  working: Working,
  cardId: Id,
  reports: readonly FollowUpCandidate[],
  snapshot: FollowUpSnapshot,
  phase: OpenFollowUp["phase"],
): void {
  const card = snapshot.cards.find((entry) => entry.id === cardId);
  reports = reports.filter((report) => !card || acceptsFollowUpReport(card, report));
  const already = new Set(card?.reportKeys ?? []);
  const keptIds = new Set(snapshot.keptImages.filter((image) => image.cardId === cardId).map(pictureKey));
  const pictureMissing = (report: FollowUpCandidate) => report.images.some((image) => !keptIds.has(pictureKey(image)));
  // Already on the card, and its pictures are there too: the link is recorded. A missing picture is not tracked yet.
  for (const report of reports) {
    if (!already.has(report.key) || pictureMissing(report)) continue;
    track(working, report, { taskId: cardId });
  }
  const fresh = reports.filter(
    (report) => !working.used.has(report.key) && !(report.tracking && "taskId" in report.tracking) && !already.has(report.key),
  );
  const pictured = reports.filter(
    (report) => already.has(report.key) && !working.used.has(report.key) && pictureMissing(report),
  );
  const carrying = [...fresh, ...pictured];
  if (!carrying.length) return;
  const kept = snapshot.keptImages
    .filter((image) => image.cardId === cardId)
    .map((image) => ({
      caption: "",
      sourceTaskId: image.sourceTaskId,
      sourceImageId: image.sourceImageId,
    }));
  const credits = carrying.map((report) => creditOf(report, kept));
  const products = [...new Set(fresh.flatMap((report) => report.productIds))].filter(
    (id) => !card?.productIds.includes(id),
  );
  const backlog = phase === "backlog";
  working.linked.push({
    cardId,
    reports: credits,
    addProducts: backlog ? products : [],
    alsoReported: backlog ? [] : products,
    keys: carrying.map((report) => report.key),
  });
  for (const report of fresh) track(working, report, { taskId: cardId });
  // The picture is still only on the original report. Tracking waits until the copy lands.
  for (const report of pictured) working.used.add(report.key);
}

/** Reports the matcher grouped onto a card this same pass is still creating. */
function attachToCreate(working: Working, index: number, reports: readonly FollowUpCandidate[]): void {
  const created = working.created[index];
  if (!created) return;
  const fresh = reports.filter((report) => !working.used.has(report.key) && !created.keys.includes(report.key));
  if (!fresh.length) return;
  const kept = created.reports.flatMap((report) => [...report.images]);
  const credits = fresh.map((report) => creditOf(report, kept));
  created.reports = [...created.reports, ...credits];
  created.keys = [...created.keys, ...fresh.map((report) => report.key)];
  created.productIds = [...new Set([...created.productIds, ...fresh.flatMap((report) => report.productIds)])];
  created.description = followUpDescription(created.reports, created.productIds);
  for (const report of fresh) working.used.add(report.key);
}

function openNew(working: Working, reports: readonly FollowUpCandidate[]): void {
  const fresh = reports.filter((report) => !working.used.has(report.key));
  if (!fresh.some((report) => report.sourceDone)) return;
  const kept: FollowUpImage[] = [];
  const credits = fresh.map((report) => creditOf(report, kept));
  const productIds = [...new Set(fresh.flatMap((report) => report.productIds))];
  working.created.push({
    title: followUpTitle(fresh[0]!.text),
    description: followUpDescription(credits, productIds),
    productIds,
    reports: credits,
    keys: fresh.map((report) => report.key),
  });
  for (const report of fresh) working.used.add(report.key);
}

/**
 * Decide cards and links from saved reports. `match` is called only for reports that are still ambiguous,
 * and only after every pointer, refusal and missing detail has been applied.
 * Reports already tracked, and reports that are not confirmed older bugs, are left alone.
 */
export async function planFollowUps(
  snapshot: FollowUpSnapshot,
  match: (ask: MatchAsk) => MatchAnswer | Promise<MatchAnswer>,
): Promise<FollowUpPlan> {
  const working: Working = { created: [], linked: [], tracks: [], used: new Set() };
  const released = [...(snapshot.releases ?? [])];
  const open = snapshot.cards.filter((card) => card.phase !== "closed");
  const pendingOut: { keys: readonly string[]; cardId?: Id; retry?: boolean }[] = [];
  const remaining = snapshot.reports.filter((report) => {
    if (report.tracking && "taskId" in report.tracking) return false;
    // Once a destination is saved, closing or archiving it must not assign this report again.
    const assignment = snapshot.pending.find((group) => group.cardId && group.keys.includes(report.key));
    if (assignment) {
      const card = snapshot.cards.find((entry) => entry.id === assignment.cardId);
      if (card && card.phase !== "closed" && !report.block) remember(working, card.id, [report], snapshot, card.phase);
      return false;
    }
    const missingChoice =
      report.tracking
      && "reason" in report.tracking
      && report.tracking.reason === "no-choice"
      && (!report.sameBug || report.sameBug === report.taskId);
    if (report.tracking && !report.tracking.retry && report.tracking.reason !== "unavailable" && !missingChoice) {
      return false;
    }
    const listed = snapshot.cards.find((card) => card.phase !== "closed" && card.reportKeys.includes(report.key));
    if (listed) {
      remember(working, listed.id, [report], snapshot, listed.phase);
      return false;
    }
    return true;
  });

  for (const group of snapshot.pending) {
    if (group.retry) continue;
    const reports = group.keys.flatMap((key) => remaining.find((report) => report.key === key) ?? []);
    if (!reports.length) continue;
    const card = group.cardId ? snapshot.cards.find((entry) => entry.id === group.cardId) : undefined;
    if (card && card.phase !== "closed") remember(working, card.id, reports, snapshot, card.phase);
    else if (!group.cardId) openNew(working, reports);
  }

  const free: FollowUpCandidate[] = [];
  const excluded = new Map<string, readonly Id[]>();
  for (const report of remaining) {
    if (working.used.has(report.key)) continue;
    if (report.block && report.block !== "skip") {
      if (report.sourceDone) track(working, report, { reason: report.block });
      continue;
    }
    if (report.block === "skip") continue;
    // A report's own task is never its destination. Naming it, as an older review could, supplies no hint.
    const shown = (report.cardsShown ?? []).filter((id) => id !== report.taskId);
    const sameBug = report.sameBug === report.taskId ? undefined : report.sameBug;
    const named = sameBug && sameBug !== "none" ? snapshot.cards.find((card) => card.id === sameBug) : undefined;
    const pointed =
      named && named.phase !== "closed" && shown.includes(named.id) && fitsFollowUpCard(named, report)
        ? named
        : undefined;
    // Preserve an explicit pointer that cannot be used. Silence supplies no hint to the matcher.
    if (shown.length && sameBug && !pointed && sameBug !== "none" && !(named && named.phase === "closed")) {
      if (report.sourceDone) track(working, report, { reason: "no-choice" });
      continue;
    }
    if (pointed) {
      remember(working, pointed.id, [report], snapshot, pointed.phase);
      continue;
    }
    excluded.set(report.key, [report.taskId, ...(sameBug === "none" ? shown : [])]);
    free.push(report);
  }

  const cardsMade = (): OpenFollowUp[] =>
    working.created.map((entry, index) => ({
      id: `__new_${index}`,
      phase: "backlog" as const,
      productIds: entry.productIds,
      title: entry.title,
      problem: entry.reports[0]?.text ?? entry.title,
      reportKeys: [...entry.keys],
    }));
  const comparable = (
    report: FollowUpCandidate,
    peers: readonly FollowUpCandidate[],
    cards: readonly OpenFollowUp[],
  ) => {
    const banned = new Set(excluded.get(report.key) ?? []);
    return (
      peers.some((other) => other.key !== report.key && overlapsFollowUpProducts(other.productIds, report.productIds))
      || cards.some(
        (entry) =>
          entry.phase !== "closed"
          && !banned.has(entry.id)
          && fitsFollowUpCard(entry, report)
          && overlapsFollowUpProducts(entry.productIds, report.productIds),
      )
    );
  };
  // A report with nothing to compare it with is one card. One that has rivals stays for the matcher, even past the cap.
  const deferred = new Set<string>();
  let pool = free.filter((report) => !working.used.has(report.key));
  for (const report of pool) {
    if (comparable(report, pool, open)) continue;
    if (report.sourceDone && !report.block) openNew(working, [report]);
  }
  pool = pool.filter((report) => !working.used.has(report.key));
  const askOf = (reports: readonly FollowUpCandidate[], cards: readonly OpenFollowUp[]): MatchAsk => ({
    reports: reports.map((report) => ({
      key: report.key,
      text: report.text,
      steps: report.steps!.trim(),
      evidence: report.evidence!.trim(),
      productIds: report.productIds,
      raisedBy: report.raisedBy,
    })),
    cards: cards.map((card) => ({ id: card.id, title: card.title, problem: card.problem, productIds: card.productIds })),
  });
  while (pool.length) {
    // An unfinished report can join a card when a finished one is matched with it.
    // By itself it waits. Finished reports are asked first, so a crowd of unfinished ones cannot hide them.
    if (!pool.some((report) => report.sourceDone)) break;
    const cardsNow = [...open, ...cardsMade()];
    const ordered = [...pool.filter((report) => report.sourceDone), ...pool.filter((report) => !report.sourceDone)];
    const comparablePool = ordered.filter((report) => comparable(report, pool, cardsNow));
    const askReports = comparablePool.slice(0, CAP);
    if (!askReports.length) {
      for (const report of pool) if (report.sourceDone && !report.block) openNew(working, [report]);
      break;
    }
    const relevant = cardsNow.filter(
      (card) =>
        askReports.some(
          (report) =>
            fitsFollowUpCard(card, report)
            && overlapsFollowUpProducts(card.productIds, report.productIds)
            && !(excluded.get(report.key) ?? []).includes(card.id),
        )
        && !askReports.every((report) => (excluded.get(report.key) ?? []).includes(card.id)),
    );
    let pending = askReports;
    let page = 0;
    let stopped = false;
    while (pending.length) {
      const more = (page + 1) * 20 < relevant.length;
      const answer = await match(askOf(pending, relevant.slice(page * 20, page * 20 + 20)));
      if (answer === "unavailable") {
        const left = pool.filter((report) => !working.used.has(report.key));
        pendingOut.push({ keys: left.map((report) => report.key), retry: true });
        for (const report of left) track(working, report, { reason: "unavailable", retry: true });
        stopped = true;
        break;
      }
      const grouped = new Set<string>();
      for (const group of answer.groups) {
        const reports = group.keys.flatMap((key) => pending.find((report) => report.key === key) ?? []);
        if (!reports.length) continue;
        for (const report of reports) grouped.add(report.key);
        const allowedReports = (id: Id) => reports.filter((report) => !(excluded.get(report.key) ?? []).includes(id));
        const made = group.cardId?.startsWith("__new_") ? Number(group.cardId.slice("__new_".length)) : undefined;
        if (made !== undefined && Number.isInteger(made) && working.created[made] && group.cardId) {
          attachToCreate(working, made, allowedReports(group.cardId));
        } else {
          const card = group.cardId ? open.find((entry) => entry.id === group.cardId) : undefined;
          const allowed =
            card && reports.some((report) => !(excluded.get(report.key) ?? []).includes(card.id)) ? card : undefined;
          if (allowed) remember(working, allowed.id, allowedReports(allowed.id), snapshot, allowed.phase);
        }
        // A report is not a new card until it has been shown every open card that could be the same bug.
        const fresh = reports.filter((report) => !working.used.has(report.key));
        if (fresh.length && !more) openNew(working, fresh);
      }
      if (more) {
        pending = pending.filter((report) => !working.used.has(report.key));
        page += 1;
        continue;
      }
      const placed = askReports.some((report) => working.used.has(report.key));
      for (const report of pending) {
        if (working.used.has(report.key)) continue;
        // Placed with a task that is not done yet: a card waits until that task finishes. Do not ask it again this pass.
        if (!report.sourceDone && grouped.has(report.key)) deferred.add(report.key);
        else track(working, report, { reason: "unmatched" });
      }
      // The whole capped batch was unplaced. The reports that did not fit are the same unresolved bug, not a new card.
      if (askReports.length === CAP && !placed) {
        for (const report of comparablePool.slice(CAP)) {
          if (working.used.has(report.key) || deferred.has(report.key)) continue;
          if (!report.sourceDone) deferred.add(report.key);
          else track(working, report, { reason: "unmatched" });
        }
      }
      break;
    }
    if (stopped) break;
    pool = pool.filter((report) => !working.used.has(report.key) && !deferred.has(report.key));
  }

  const consumed = new Set([
    ...working.created.flatMap((entry) => entry.keys),
    ...working.linked.flatMap((entry) => entry.keys),
    ...working.tracks.map((entry) => followUpKey(entry.taskId, entry.findingId)),
    ...released.map((entry) => followUpKey(entry.taskId, entry.findingId)),
  ]);
  for (const group of snapshot.pending) {
    if (group.retry) continue;
    if (
      group.keys.every(
        (key) =>
          consumed.has(key)
          || snapshot.reports.some((report) => report.key === key && report.tracking && "taskId" in report.tracking),
      )
    ) {
      continue;
    }
    if (group.keys.some((key) => !consumed.has(key))) pendingOut.push(group);
  }
  return { created: working.created, linked: working.linked, tracks: working.tracks, pending: pendingOut, released };
}
