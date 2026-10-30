// Follow-up card shapes, eligibility rules, snapshot projection, and plain-language descriptions.

import { findingKind } from "./findings.js";
import type { Finding, Id, RunState, Task } from "./model.js";

export type TrackingReason =
  | "missing-steps"
  | "missing-evidence"
  | "no-choice"
  | "unmatched"
  | "unavailable"
  | "pictures";

const REASONS: Record<TrackingReason, string> = {
  "missing-steps": "The steps are missing",
  "missing-evidence": "The evidence is missing",
  "no-choice": "No card was chosen",
  unmatched: "Petrina could not match it",
  unavailable: "The match could not run",
  pictures: "The pictures could not be copied",
};

/** What the review shows for a follow-up that did or did not become a card. */
export function trackingWords(tracking: NonNullable<Finding["tracking"]>): {
  label: "Tracked in" | "Not tracked";
  reason?: string;
} {
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
  reports: readonly {
    key: string;
    text: string;
    steps: string;
    evidence: string;
    productIds: readonly Id[];
    raisedBy: Id;
  }[];
  cards: readonly { id: Id; title: string; problem: string; productIds: readonly Id[] }[];
}

export type MatchAnswer =
  | { groups: readonly { keys: readonly string[]; cardId?: Id }[]; uncertain?: readonly string[] }
  | "unavailable";

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

/** Products a task is about. */
export function productsOn(task: Pick<Task, "productId" | "repositories" | "selectedProducts">): Id[] {
  return [
    ...new Set(
      [
        task.productId,
        ...(task.repositories?.map((work) => work.productId) ?? []),
        ...(task.selectedProducts?.map((choice) => choice.productId) ?? []),
      ].filter((id) => id.length > 0),
    ),
  ];
}

function cardPhase(state: RunState): OpenFollowUp["phase"] {
  if (state === "done" || state === "cancelled") return "closed";
  return state === "backlog" ? "backlog" : "started";
}

export function overlapsFollowUpProducts(left: readonly Id[], right: readonly Id[]): boolean {
  if (!left.length || !right.length) return true;
  return left.some((id) => right.includes(id));
}

export function fitsFollowUpCard(card: OpenFollowUp, report: Pick<FollowUpCandidate, "productIds">): boolean {
  return (
    !card.fixedProducts
    || (card.productIds.length === report.productIds.length
      && card.productIds.every((id) => report.productIds.includes(id)))
  );
}

/** A report already credited on the card keeps it, so its copies and tracking can finish. Only a new report must fit. */
export function acceptsFollowUpReport(
  card: OpenFollowUp,
  report: Pick<FollowUpCandidate, "taskId" | "findingId" | "productIds">,
): boolean {
  return card.reportKeys.includes(followUpKey(report.taskId, report.findingId)) || fitsFollowUpCard(card, report);
}

/**
 * The card a task offers later reports, or nothing. A task already carrying reports keeps its own rules, whatever its kind.
 * A coordinator-created bug with products joins while unfinished, at the boundary automatic cards use, so queueing or
 * starting it keeps it. Listing candidates, checking a returned match and saving a link all use this one decision.
 */
export function followUpCard(task: Task): OpenFollowUp | undefined {
  if (!task.followUp && !(task.kind === "bug" && cardPhase(task.state) !== "closed" && productsOn(task).length)) {
    return undefined;
  }
  return {
    id: task.id,
    phase: cardPhase(task.state),
    productIds: [
      ...new Set([
        ...productsOn(task),
        ...(!task.followUp || task.followUp.preserveRequest
          ? []
          : task.followUp.reports.flatMap((report) => report.productIds)),
      ]),
    ],
    title: task.title,
    problem: task.description.trim() || task.title,
    reportKeys: task.followUp?.reports.map((report) => followUpKey(report.taskId, report.findingId)) ?? [],
    ...(!task.followUp || task.followUp.preserveRequest ? { fixedProducts: true } : {}),
  };
}

/** The task, as it is now, can take these reports: still open, and a coordinator's request only for exactly its products. */
export function takesFollowUps(
  task: Task,
  reports: readonly Pick<FollowUpCandidate, "taskId" | "findingId" | "productIds">[],
): boolean {
  const card = followUpCard(task);
  return !!card && card.phase !== "closed" && reports.every((report) => acceptsFollowUpReport(card, report));
}

/** Evidence that the change left the bug as it was. Checker reasons count once a vote settles it as older. */
export function olderEvidence(finding: Pick<Finding, "evidence" | "verification" | "votes">): string {
  if (finding.verification?.verdict === "pre-existing") {
    const reasons = [
      finding.verification.reason,
      ...(finding.votes ?? []).filter((vote) => vote.verdict === "pre-existing").map((vote) => vote.reason),
    ];
    return [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))].join("\n\n");
  }
  return finding.evidence?.trim() ?? "";
}

/** Why an open finding cannot become a card, or nothing when it can. Checks and nits are skipped entirely. */
export function followUpBlock(
  finding: Pick<Finding, "text" | "status" | "severity" | "raisedBy" | "steps" | "evidence" | "verification" | "votes"> & {
    kind?: Finding["kind"];
  },
): TrackingReason | "skip" | undefined {
  if (finding.status !== "open" || finding.severity !== "pre-existing") return "skip";
  if (findingKind(finding) !== "review") return "skip";
  if (!finding.steps?.trim()) return "missing-steps";
  if (!olderEvidence(finding)) return "missing-evidence";
  return undefined;
}

/** Pictures a report chose, matched to that finding's words. */
export function findingImages(task: Task, finding: Finding): FollowUpImage[] {
  const want = finding.text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const images: FollowUpImage[] = [];
  const seen = new Set<string>();
  for (const step of task.journey ?? []) {
    for (const result of step.agentResults ?? []) {
      const reported = (result.value as { findings?: { text?: string }[] } | undefined)?.findings ?? [];
      if (
        !reported.some(
          (item) =>
            item.text
              ?.toLowerCase()
              .replace(/[^a-z0-9]+/g, " ")
              .trim() === want,
        )
      ) {
        continue;
      }
      for (const image of result.images ?? []) {
        if (seen.has(image.id)) continue;
        seen.add(image.id);
        images.push({ caption: image.caption, sourceTaskId: task.id, sourceImageId: image.id });
      }
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
export function followUpSnapshot(
  tasks: readonly Task[],
  pending: readonly { keys: readonly string[]; cardId?: Id; retry?: boolean }[] = [],
): FollowUpSnapshot {
  const reports: FollowUpCandidate[] = [];
  const cards: OpenFollowUp[] = [];
  const keptImages: { cardId: Id; sourceTaskId: Id; sourceImageId: string }[] = [];
  const releases: { taskId: Id; findingId: Id; cardId: Id }[] = [];
  for (const task of tasks) {
    const card = followUpCard(task);
    if (card) {
      cards.push(card);
      for (const line of task.session) {
        for (const image of line.images ?? []) {
          if (image.from) {
            keptImages.push({ cardId: task.id, sourceTaskId: image.from.taskId, sourceImageId: image.from.imageId });
          }
        }
      }
    }
    for (const finding of task.findings) {
      const block = followUpBlock(finding);
      // A report already on a card that is no longer an older bug loses that credit.
      if (block === "skip") {
        if (finding.tracking && "taskId" in finding.tracking) {
          releases.push({ taskId: task.id, findingId: finding.id, cardId: finding.tracking.taskId });
        } else {
          for (const group of pending) {
            if (group.cardId && group.keys.includes(followUpKey(task.id, finding.id))) {
              releases.push({ taskId: task.id, findingId: finding.id, cardId: group.cardId });
            }
          }
        }
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
        ...(finding.verification?.verdict === "pre-existing"
          ? { reasons: olderEvidence(finding).split("\n\n").filter(Boolean) }
          : {}),
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
export function openFollowUpCards(
  tasks: readonly Task[],
  reviewed: Task,
): { id: Id; title: string; problem: string; productIds: readonly Id[] }[] {
  const productIds = productsOn(reviewed);
  return tasks
    .flatMap((task) => followUpCard(task) ?? [])
    .filter(
      (card) =>
        card.id !== reviewed.id
        && card.phase !== "closed"
        && fitsFollowUpCard(card, { productIds })
        && overlapsFollowUpProducts(card.productIds, productIds),
    )
    .slice(0, 20)
    .map((card) => ({ id: card.id, title: card.title, problem: card.problem, productIds: card.productIds }));
}

export function followUpTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

export function followUpDescription(reports: readonly FollowUpCredit[], productNames: readonly string[]): string {
  const body = reports
    .map((report) =>
      [
        report.text,
        `How to see it again: ${report.steps}`,
        `Why the change left it as it was: ${report.evidence}`,
        report.reasons?.some((reason) => !report.evidence.includes(reason))
          ? `Checked as older: ${[...new Set(report.reasons.filter((reason) => !report.evidence.includes(reason)))].join(" ")}`
          : "",
        `Found on ${report.sourceTitle}.`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return [body, productNames.length ? `Products: ${productNames.join(", ")}` : ""].filter(Boolean).join("\n\n");
}

/**
 * Record one reviewer's tag without letting it erase an earlier one.
 * An older tag and a "this change caused it" tag on the same finding stay on the finding,
 * and the finding stays Important until the usual vote settles it.
 */
export function noteReviewTag(
  current:
    | {
        severity: Finding["severity"];
        judgments?: Finding["judgments"];
        verification?: Finding["verification"];
      }
    | undefined,
  incoming: Finding["severity"],
  by: Id,
  at: number,
): {
  severity: Finding["severity"];
  judgments: {
    by: Id;
    severity: Finding["severity"];
    at: number;
  }[];
  clearVote: boolean;
} {
  const judgments = [...(current?.judgments ?? [])];
  const clash =
    !!current
    && ((current.severity === "pre-existing" && incoming === "blocking")
      || (current.severity === "blocking" && incoming === "pre-existing"));
  if (!current || clash) judgments.push({ by, severity: incoming, at });
  if (!current) return { severity: incoming, judgments, clearVote: false };
  if (current.severity === "pre-existing" && incoming === "blocking") {
    return { severity: "blocking", judgments, clearVote: true };
  }
  return { severity: current.severity, judgments, clearVote: false };
}
