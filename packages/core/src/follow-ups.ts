// Confirmed older bugs become Backlog cards when their task is done.
// Reviewers judge first. This module only decides which saved reports share a card.

import type { Finding, Id, RunState, Task } from "./model.js";

export type TrackingReason = "missing-steps" | "missing-evidence" | "no-choice" | "unmatched" | "unavailable" | "pictures";

const REASONS: Record<TrackingReason, string> = {
  "missing-steps": "The steps are missing",
  "missing-evidence": "The evidence is missing",
  "no-choice": "No card was chosen",
  unmatched: "Petrina could not match it",
  unavailable: "The match could not run",
  pictures: "The pictures could not be copied",
};

/** What the review shows for a follow-up that did or did not become a card. */
export function trackingWords(tracking: NonNullable<Finding["tracking"]>): { label: "Tracked in" | "Not tracked"; reason?: string } {
  if ("taskId" in tracking) return { label: "Tracked in" };
  return { label: "Not tracked", reason: REASONS[tracking.reason] };
}

export function followUpKey(taskId: Id, findingId: Id): string {
  return `${taskId}::${findingId}`;
}

export interface FollowUpImage {
  caption: string;
  sourceTaskId: Id;
  sourceImageId: string;
}

export interface FollowUpCredit {
  taskId: Id;
  findingId: Id;
  sourceTitle: string;
  text: string;
  steps: string;
  evidence: string;
  raisedBy: Id;
  roleId?: Id;
  productIds: readonly Id[];
  reasons?: readonly string[];
  at: number;
  images: readonly FollowUpImage[];
}

export interface FollowUpCandidate {
  key: string;
  taskId: Id;
  findingId: Id;
  sourceTitle: string;
  text: string;
  steps?: string;
  evidence?: string;
  reasons?: readonly string[];
  raisedBy: Id;
  roleId?: Id;
  productIds: readonly Id[];
  at: number;
  images: readonly FollowUpImage[];
  cardsShown?: readonly Id[];
  sameBug?: Id | "none";
  /** The report's own task is done, so a card may be opened from it. */
  sourceDone: boolean;
  tracking?: Finding["tracking"];
  /** Set when this open pre-existing report cannot become a card. Absent when it can. */
  block?: TrackingReason | "skip";
}

export interface OpenFollowUp {
  id: Id;
  /** Backlog can still gain a product. Started work records a new product as also reported. Closed cards are not reused. */
  phase: "backlog" | "started" | "closed";
  productIds: readonly Id[];
  title: string;
  problem: string;
  reportKeys: readonly string[];
  /** Coordinator-created requests cannot acquire a different product scope through matching. */
  fixedProducts?: boolean;
}

export interface FollowUpSnapshot {
  reports: readonly FollowUpCandidate[];
  cards: readonly OpenFollowUp[];
  pending: readonly { keys: readonly string[]; cardId?: Id; retry?: boolean }[];
  /** Pictures already kept on a card, so a retry does not keep another copy. */
  keptImages: readonly { cardId: Id; sourceTaskId: Id; sourceImageId: string }[];
  /** A linked report that is no longer a confirmed older bug. The credit and the tracking link come off. */
  releases?: readonly { taskId: Id; findingId: Id; cardId: Id }[];
}

export interface MatchAsk {
  reports: readonly { key: string; text: string; steps: string; evidence: string; productIds: readonly Id[]; raisedBy: Id }[];
  cards: readonly { id: Id; title: string; problem: string; productIds: readonly Id[] }[];
}

export type MatchAnswer = { groups: readonly { keys: readonly string[]; cardId?: Id }[]; uncertain?: readonly string[] } | "unavailable";

export interface FollowUpCreate {
  title: string;
  description: string;
  productIds: readonly Id[];
  reports: readonly FollowUpCredit[];
  keys: readonly string[];
}

export interface FollowUpLink {
  cardId: Id;
  reports: readonly FollowUpCredit[];
  addProducts: readonly Id[];
  alsoReported: readonly Id[];
  keys: readonly string[];
}

export interface FollowUpPlan {
  created: readonly FollowUpCreate[];
  linked: readonly FollowUpLink[];
  tracks: readonly { taskId: Id; findingId: Id; tracking: NonNullable<Finding["tracking"]> }[];
  /** What should still be waiting after this plan is saved. */
  pending: readonly { keys: readonly string[]; cardId?: Id; retry?: boolean }[];
  /** Credits to take off a card because the report is no longer a confirmed older bug. */
  released: readonly { taskId: Id; findingId: Id; cardId: Id }[];
}

const CAP = 24;

/** Products a task is about. */
export function productsOn(task: Pick<Task, "productId" | "repositories" | "selectedProducts">): Id[] {
  return [...new Set([task.productId, ...(task.repositories?.map((work) => work.productId) ?? []), ...(task.selectedProducts?.map((choice) => choice.productId) ?? [])].filter((id) => id.length > 0))];
}

function cardPhase(state: RunState): OpenFollowUp["phase"] {
  if (state === "done" || state === "cancelled") return "closed";
  return state === "backlog" ? "backlog" : "started";
}

function overlaps(left: readonly Id[], right: readonly Id[]): boolean {
  if (!left.length || !right.length) return true;
  return left.some((id) => right.includes(id));
}

function fitsCard(card: OpenFollowUp, report: Pick<FollowUpCandidate, "productIds">): boolean {
  return !card.fixedProducts || (card.productIds.length === report.productIds.length && card.productIds.every(id => report.productIds.includes(id)));
}

/** A report already credited on the card keeps it, so its copies and tracking can finish. Only a new report must fit. */
function accepts(card: OpenFollowUp, report: Pick<FollowUpCandidate, "taskId" | "findingId" | "productIds">): boolean {
  return card.reportKeys.includes(followUpKey(report.taskId, report.findingId)) || fitsCard(card, report);
}

/**
 * The card a task offers later reports, or nothing. A task already carrying reports keeps its own rules, whatever its kind.
 * A coordinator-created bug with products joins while unfinished, at the boundary automatic cards use, so queueing or
 * starting it keeps it. Listing candidates, checking a returned match and saving a link all use this one decision.
 */
export function followUpCard(task: Task): OpenFollowUp | undefined {
  if (!task.followUp && !(task.kind === "bug" && cardPhase(task.state) !== "closed" && productsOn(task).length)) return undefined;
  return {
    id: task.id,
    phase: cardPhase(task.state),
    productIds: [...new Set([...productsOn(task), ...(!task.followUp || task.followUp.preserveRequest ? [] : task.followUp.reports.flatMap((report) => report.productIds))])],
    title: task.title,
    problem: task.description.trim() || task.title,
    reportKeys: task.followUp?.reports.map((report) => followUpKey(report.taskId, report.findingId)) ?? [],
    ...(!task.followUp || task.followUp.preserveRequest ? { fixedProducts: true } : {}),
  };
}

/** The task, as it is now, can take these reports: still open, and a coordinator's request only for exactly its products. */
export function takesFollowUps(task: Task, reports: readonly Pick<FollowUpCandidate, "taskId" | "findingId" | "productIds">[]): boolean {
  const card = followUpCard(task);
  return !!card && card.phase !== "closed" && reports.every((report) => accepts(card, report));
}

/** Evidence that the change left the bug as it was. Checker reasons count once a vote settles it as older. */
export function olderEvidence(finding: Pick<Finding, "evidence" | "verification" | "votes">): string {
  if (finding.verification?.verdict === "pre-existing") {
    const reasons = [finding.verification.reason, ...(finding.votes ?? []).filter((vote) => vote.verdict === "pre-existing").map((vote) => vote.reason)];
    return [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))].join("\n\n");
  }
  return finding.evidence?.trim() ?? "";
}

/** Why an open finding cannot become a card, or nothing when it can. Checks and nits are skipped entirely. */
export function followUpBlock(finding: Pick<Finding, "text" | "status" | "severity" | "raisedBy" | "steps" | "evidence" | "verification" | "votes">): TrackingReason | "skip" | undefined {
  if (finding.status !== "open" || finding.severity !== "pre-existing") return "skip";
  if (finding.raisedBy === "petrina" || finding.text.startsWith("Failed acceptance check:") || finding.text.startsWith("Check failed")) return "skip";
  if (!finding.steps?.trim()) return "missing-steps";
  if (!olderEvidence(finding)) return "missing-evidence";
  return undefined;
}

/** Pictures a report chose, matched to that finding's words. */
export function findingImages(task: Task, finding: Finding): FollowUpImage[] {
  const want = finding.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const images: FollowUpImage[] = [];
  const seen = new Set<string>();
  for (const step of task.journey ?? []) for (const result of step.agentResults ?? []) {
    const reported = (result.value as { findings?: { text?: string }[] } | undefined)?.findings ?? [];
    if (!reported.some((item) => item.text?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === want)) continue;
    for (const image of result.images ?? []) {
      if (seen.has(image.id)) continue;
      seen.add(image.id);
      images.push({ caption: image.caption, sourceTaskId: task.id, sourceImageId: image.id });
    }
  }
  return images;
}

/**
 * Another reviewer of this round has not answered yet.
 * Every older report on the task waits, including one raised before this round.
 * A saved older tag is not confirmed, and must not be matched, until that judgment is in.
 */
function reviewStillOpen(task: Task, finding: Finding): boolean {
  if (task.state === "done" || task.state === "cancelled" || !task.findings.includes(finding)) return false;
  const hunt = task.hunt;
  if (!hunt) return false;
  const stage = task.plan?.stages.find((entry) => entry.id === hunt.stageId && entry.kind === "review-chain");
  if (!stage) return false;
  const planned = task.portReview ? 1 : stage.profileIds.length;
  return planned >= 2 && Object.keys(hunt.reported).length < planned;
}

/** Saved reports and open cards the matcher is allowed to see. Archived history is not included. */
export function followUpSnapshot(tasks: readonly Task[], pending: readonly { keys: readonly string[]; cardId?: Id; retry?: boolean }[] = []): FollowUpSnapshot {
  const reports: FollowUpCandidate[] = [];
  const cards: OpenFollowUp[] = [];
  const keptImages: { cardId: Id; sourceTaskId: Id; sourceImageId: string }[] = [];
  const releases: { taskId: Id; findingId: Id; cardId: Id }[] = [];
  for (const task of tasks) {
    const card = followUpCard(task);
    if (card) {
      cards.push(card);
      for (const line of task.session) for (const image of line.images ?? []) {
        if (image.from) keptImages.push({ cardId: task.id, sourceTaskId: image.from.taskId, sourceImageId: image.from.imageId });
      }
    }
    for (const finding of task.findings) {
      const block = followUpBlock(finding);
      // A report already on a card that is no longer an older bug loses that credit.
      if (block === "skip") {
        if (finding.tracking && "taskId" in finding.tracking) releases.push({ taskId: task.id, findingId: finding.id, cardId: finding.tracking.taskId });
        else for (const group of pending) if (group.cardId && group.keys.includes(followUpKey(task.id, finding.id)))
          releases.push({ taskId: task.id, findingId: finding.id, cardId: group.cardId });
        continue;
      }
      // The other reviewers have not judged it yet. Leave it off every card.
      if (reviewStillOpen(task, finding)) continue;
      reports.push({
        key: followUpKey(task.id, finding.id),
        taskId: task.id,
        findingId: finding.id,
        sourceTitle: task.title,
        text: finding.text,
        ...(finding.steps ? { steps: finding.steps } : {}),
        evidence: olderEvidence(finding),
        ...(finding.verification?.verdict === "pre-existing" ? { reasons: olderEvidence(finding).split("\n\n").filter(Boolean) } : {}),
        raisedBy: finding.raisedBy,
        ...(finding.roleId ? { roleId: finding.roleId } : {}),
        productIds: finding.productIds?.length ? [...finding.productIds] : productsOn(task).slice(0, 1),
        at: finding.judgments?.[0]?.at ?? task.finishedAt ?? task.createdAt,
        images: block ? [] : findingImages(task, finding),
        ...(finding.cardsShown?.length ? { cardsShown: finding.cardsShown } : {}),
        ...(finding.sameBug ? { sameBug: finding.sameBug } : {}),
        sourceDone: task.state === "done",
        ...(finding.tracking ? { tracking: finding.tracking } : {}),
        ...(block ? { block } : {}),
      });
    }
  }
  return { reports, cards, pending, keptImages, ...(releases.length ? { releases } : {}) };
}

/** Open follow-up cards a reviewer of this task can point at. Bounded, only cards still open, and never the task itself. */
export function openFollowUpCards(tasks: readonly Task[], reviewed: Task): { id: Id; title: string; problem: string; productIds: readonly Id[] }[] {
  const productIds = productsOn(reviewed);
  return tasks.flatMap((task) => followUpCard(task) ?? [])
    .filter((card) => card.id !== reviewed.id && card.phase !== "closed" && fitsCard(card, { productIds }) && overlaps(card.productIds, productIds))
    .slice(0, 20)
    .map((card) => ({ id: card.id, title: card.title, problem: card.problem, productIds: card.productIds }));
}

export function followUpTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

export function followUpDescription(reports: readonly FollowUpCredit[], productNames: readonly string[]): string {
  const body = reports.map((report) => [
    report.text,
    `How to see it again: ${report.steps}`,
    `Why the change left it as it was: ${report.evidence}`,
    report.reasons?.some(reason => !report.evidence.includes(reason)) ? `Checked as older: ${[...new Set(report.reasons.filter(reason => !report.evidence.includes(reason)))].join(" ")}` : "",
    `Found on ${report.sourceTitle}.`,
  ].filter(Boolean).join("\n")).join("\n\n");
  return [body, productNames.length ? `Products: ${productNames.join(", ")}` : ""].filter(Boolean).join("\n\n");
}

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
  if (working.used.has(report.key) || report.tracking && "taskId" in report.tracking) return;
  working.used.add(report.key);
  working.tracks.push({ taskId: report.taskId, findingId: report.findingId, tracking });
}

function pictureKey(image: { sourceTaskId: string; sourceImageId: string }): string {
  return `${image.sourceTaskId}/${image.sourceImageId}`;
}

function remember(working: Working, cardId: Id, reports: readonly FollowUpCandidate[], snapshot: FollowUpSnapshot, phase: OpenFollowUp["phase"]): void {
  const card = snapshot.cards.find((entry) => entry.id === cardId);
  reports = reports.filter(report => !card || accepts(card, report));
  const already = new Set(card?.reportKeys ?? []);
  const keptIds = new Set(snapshot.keptImages.filter((image) => image.cardId === cardId).map(pictureKey));
  const pictureMissing = (report: FollowUpCandidate) => report.images.some((image) => !keptIds.has(pictureKey(image)));
  // Already on the card, and its pictures are there too: the link is recorded. A missing picture is not tracked yet.
  for (const report of reports) {
    if (!already.has(report.key) || pictureMissing(report)) continue;
    track(working, report, { taskId: cardId });
  }
  const fresh = reports.filter((report) => !working.used.has(report.key) && !(report.tracking && "taskId" in report.tracking) && !already.has(report.key));
  const pictured = reports.filter((report) => already.has(report.key) && !working.used.has(report.key) && pictureMissing(report));
  const carrying = [...fresh, ...pictured];
  if (!carrying.length) return;
  const kept = snapshot.keptImages.filter((image) => image.cardId === cardId).map((image) => ({ caption: "", sourceTaskId: image.sourceTaskId, sourceImageId: image.sourceImageId }));
  const credits = carrying.map((report) => creditOf(report, kept));
  const products = [...new Set(fresh.flatMap((report) => report.productIds))].filter((id) => !card?.productIds.includes(id));
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
export async function planFollowUps(snapshot: FollowUpSnapshot, match: (ask: MatchAsk) => MatchAnswer | Promise<MatchAnswer>): Promise<FollowUpPlan> {
  const working: Working = { created: [], linked: [], tracks: [], used: new Set() };
  const released = [...(snapshot.releases ?? [])];
  const open = snapshot.cards.filter((card) => card.phase !== "closed");
  const pendingOut: { keys: readonly string[]; cardId?: Id; retry?: boolean }[] = [];
  const remaining = snapshot.reports.filter((report) => {
    if (report.tracking && "taskId" in report.tracking) return false;
    // Once a destination is saved, closing or archiving it must not assign this report again.
    const assignment = snapshot.pending.find(group => group.cardId && group.keys.includes(report.key));
    if (assignment) {
      const card = snapshot.cards.find(card => card.id === assignment.cardId);
      if (card && card.phase !== "closed" && !report.block) remember(working, card.id, [report], snapshot, card.phase);
      return false;
    }
    const missingChoice = report.tracking && "reason" in report.tracking && report.tracking.reason === "no-choice" && (!report.sameBug || report.sameBug === report.taskId);
    if (report.tracking && !report.tracking.retry && report.tracking.reason !== "unavailable" && !missingChoice) return false;
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
    const pointed = named && named.phase !== "closed" && shown.includes(named.id) && fitsCard(named, report) ? named : undefined;
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

  const cardsMade = (): OpenFollowUp[] => working.created.map((entry, index) => ({
    id: `__new_${index}`,
    phase: "backlog" as const,
    productIds: entry.productIds,
    title: entry.title,
    problem: entry.reports[0]?.text ?? entry.title,
    reportKeys: [...entry.keys],
  }));
  const comparable = (report: FollowUpCandidate, peers: readonly FollowUpCandidate[], cards: readonly OpenFollowUp[]) => {
    const banned = new Set(excluded.get(report.key) ?? []);
    return peers.some((other) => other.key !== report.key && overlaps(other.productIds, report.productIds))
      || cards.some((entry) => entry.phase !== "closed" && !banned.has(entry.id) && fitsCard(entry, report) && overlaps(entry.productIds, report.productIds));
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
    reports: reports.map((report) => ({ key: report.key, text: report.text, steps: report.steps!.trim(), evidence: report.evidence!.trim(), productIds: report.productIds, raisedBy: report.raisedBy })),
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
    const relevant = cardsNow.filter((card) => askReports.some((report) => fitsCard(card, report) && overlaps(card.productIds, report.productIds) && !(excluded.get(report.key) ?? []).includes(card.id)) && !askReports.every((report) => (excluded.get(report.key) ?? []).includes(card.id)));
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
        if (made !== undefined && Number.isInteger(made) && working.created[made] && group.cardId) attachToCreate(working, made, allowedReports(group.cardId));
        else {
          const card = group.cardId ? open.find((entry) => entry.id === group.cardId) : undefined;
          const allowed = card && reports.some((report) => !(excluded.get(report.key) ?? []).includes(card.id)) ? card : undefined;
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

  const consumed = new Set([...working.created.flatMap((entry) => entry.keys), ...working.linked.flatMap((entry) => entry.keys), ...working.tracks.map((entry) => followUpKey(entry.taskId, entry.findingId)), ...released.map(entry => followUpKey(entry.taskId, entry.findingId))]);
  for (const group of snapshot.pending) {
    if (group.retry) continue;
    if (group.keys.every((key) => consumed.has(key) || snapshot.reports.some((report) => report.key === key && report.tracking && "taskId" in report.tracking))) continue;
    if (group.keys.some((key) => !consumed.has(key))) pendingOut.push(group);
  }
  return { created: working.created, linked: working.linked, tracks: working.tracks, pending: pendingOut, released };
}

/**
 * Record one reviewer's tag without letting it erase an earlier one.
 * An older tag and a "this change caused it" tag on the same finding stay on the finding,
 * and the finding stays Important until the usual vote settles it.
 */
export function noteReviewTag(current: { severity: Finding["severity"]; judgments?: Finding["judgments"]; verification?: Finding["verification"] } | undefined, incoming: Finding["severity"], by: Id, at: number): { severity: Finding["severity"]; judgments: { by: Id; severity: Finding["severity"]; at: number }[]; clearVote: boolean } {
  const judgments = [...(current?.judgments ?? [])];
  const clash = !!current && ((current.severity === "pre-existing" && incoming === "blocking") || (current.severity === "blocking" && incoming === "pre-existing"));
  if (!current || clash) judgments.push({ by, severity: incoming, at });
  if (!current) return { severity: incoming, judgments, clearVote: false };
  if (current.severity === "pre-existing" && incoming === "blocking") return { severity: "blocking", judgments, clearVote: true };
  return { severity: current.severity, judgments, clearVote: false };
}
