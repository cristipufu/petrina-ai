import { checkDecisionLabel, deliveryDecisionProblem } from "./check-evidence.js";
import { reviewDecisionPending } from "./flow.js";
import type { InboxItem, JourneyWait, Task, Tone } from "./model.js";
import type { SheetTab } from "./navigation.js";
import { proofGap } from "./proof-requests.js";

export const INBOX_KINDS = [
  "maintenance-settings",
  "question",
  "permission",
  "plan",
  "design",
  "disagreement",
  "delivery",
  "stuck",
  "shipping",
  "driving",
  "guide",
  "learnings",
  "screen",
] as const;

/**
 * `shipping`: a delivery was interrupted, and Petrina could not tell whether it went out, or found something
 * else there. `driving`: the coordinator took over a step in their terminal.
 * `screen`: an agent waits for the coordinator's OK to use the screen. Quiet: listed last, never a notification.
 */
export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxDecisionOperation =
  | "inbox.maintenance-settings"
  | "inbox.answer"
  | "inbox.allow"
  | "inbox.deny"
  | "inbox.approve"
  | "inbox.changes"
  | "inbox.rerun-checks"
  | "inbox.retry"
  | "inbox.recovery"
  | "learning.accept"
  | "learning.decline"
  | "review-guide.accept"
  | "review-guide.decline"
  | "screen.allow";

export type InboxDecisionContextTask = Parameters<typeof deliveryDecisionProblem>[0] &
  Pick<Task, "reviewDecision">;

export type InboxHeadlineContextTask = InboxDecisionContextTask &
  Parameters<typeof proofGap>[0] &
  Pick<Task, "acceptanceUnverified" | "findings">;

export interface InboxVisibility {
  readonly countsInBadge: boolean;
  readonly notifies: boolean;
  readonly showInSession: boolean;
  readonly showInOverview: boolean;
  readonly quietSort: boolean;
}

export interface InboxKindDescriptor {
  readonly id: InboxKind;
  readonly label: string;
  readonly waitLabel: string;
  readonly tone: Tone;
  readonly tab: Exclude<SheetTab, "overview">;
  readonly visibility: InboxVisibility;
  readonly survivesAgentStop: boolean;
  readonly throughputPhaseWait: boolean;
  readonly legacyWait?: JourneyWait;
  readonly worklogAsk?: "question" | "permission" | "checkpoint";
  cardHeader(task?: InboxHeadlineContextTask): { readonly label: string; readonly tone: Tone };
  noticeTitle(who: string, taskName: string, task?: InboxHeadlineContextTask): string;
  decisions(task?: InboxDecisionContextTask): readonly InboxDecisionOperation[];
}

const DEFAULT_VISIBILITY: InboxVisibility = {
  countsInBadge: true,
  notifies: true,
  showInSession: true,
  showInOverview: true,
  quietSort: false,
};

function classifyDeliveryHeadline(task?: InboxHeadlineContextTask): {
  readonly checkIssue: "failing" | "unverified" | undefined;
  readonly hasReviewOrAcceptanceGap: boolean;
  readonly hasProofGap: boolean;
} {
  const checkIssue = task && !reviewDecisionPending(task) ? deliveryDecisionProblem(task) : undefined;
  const hasReviewOrAcceptanceGap = Boolean(
    task?.acceptanceUnverified === true ||
      task?.findings.some((finding) => finding.status === "open" && finding.severity === "blocking"),
  );
  const hasProofGap = Boolean(task && proofGap(task));
  return { checkIssue, hasReviewOrAcceptanceGap, hasProofGap };
}

export const INBOX_CATALOG: Readonly<Record<InboxKind, InboxKindDescriptor>> = {
  "maintenance-settings": {
    id: "maintenance-settings",
    label: "Agent settings",
    waitLabel: "Routine settings",
    tone: "amber",
    tab: "session",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: true,
    throughputPhaseWait: false,
    cardHeader: () => ({ label: "Agent settings", tone: "amber" }),
    noticeTitle: (_who, taskName) => `Choose whether to keep the reported agent settings for ${taskName}`,
    decisions: () => ["inbox.maintenance-settings"],
  },
  question: {
    id: "question",
    label: "Question",
    waitLabel: "Agent question",
    tone: "violet",
    tab: "session",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: true,
    worklogAsk: "question",
    cardHeader: () => ({ label: "Question", tone: "violet" }),
    noticeTitle: (who) => `${who} has a question`,
    decisions: () => ["inbox.answer"],
  },
  permission: {
    id: "permission",
    label: "Permission",
    waitLabel: "Permission request",
    tone: "amber",
    tab: "session",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: true,
    worklogAsk: "permission",
    cardHeader: () => ({ label: "Permission", tone: "amber" }),
    noticeTitle: (who) => `${who} needs your permission`,
    decisions: () => ["inbox.allow", "inbox.deny"],
  },
  plan: {
    id: "plan",
    label: "Plan check",
    waitLabel: "Plan check",
    tone: "indigo",
    tab: "plan",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: true,
    legacyWait: "plan",
    worklogAsk: "checkpoint",
    cardHeader: () => ({ label: "Plan check", tone: "indigo" }),
    noticeTitle: (who) => `${who}: a plan needs your OK`,
    decisions: () => ["inbox.approve", "inbox.changes"],
  },
  design: {
    id: "design",
    label: "Design check",
    waitLabel: "Design check",
    tone: "violet",
    tab: "design",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: true,
    legacyWait: "design",
    worklogAsk: "checkpoint",
    cardHeader: () => ({ label: "Design check", tone: "violet" }),
    noticeTitle: (who) => `${who}: a design needs your check`,
    decisions: () => ["inbox.approve", "inbox.changes"],
  },
  disagreement: {
    id: "disagreement",
    label: "Disagreement",
    waitLabel: "Design call",
    tone: "purple",
    tab: "design",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: true,
    legacyWait: "call",
    worklogAsk: "checkpoint",
    cardHeader: () => ({ label: "Disagreement", tone: "purple" }),
    noticeTitle: (who) => `${who}: the architects need your call`,
    decisions: () => ["inbox.approve", "inbox.changes"],
  },
  delivery: {
    id: "delivery",
    label: "Ready to ship",
    waitLabel: "Delivery check",
    tone: "green",
    tab: "review",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: true,
    legacyWait: "delivery",
    worklogAsk: "checkpoint",
    cardHeader: (task) => {
      const { checkIssue, hasReviewOrAcceptanceGap, hasProofGap } = classifyDeliveryHeadline(task);
      if (checkIssue && task) {
        return { label: checkDecisionLabel(task)!, tone: "amber" };
      }
      if (hasReviewOrAcceptanceGap || hasProofGap) {
        return { label: "Your call", tone: "amber" };
      }
      return { label: "Ready to ship", tone: "green" };
    },
    noticeTitle: (who, _taskName, task) => {
      const { checkIssue, hasReviewOrAcceptanceGap, hasProofGap } = classifyDeliveryHeadline(task);
      if (checkIssue) {
        return `${who}: checks ${checkIssue === "failing" ? "still failing" : "unverified"}, your call`;
      }
      if (hasReviewOrAcceptanceGap) {
        return `${who}: review rounds ran out with blocking findings open, your call`;
      }
      if (hasProofGap) {
        return `${who}: requested proof needs your call`;
      }
      return `${who}: a task is ready to ship`;
    },
    decisions: (task) =>
      task && !reviewDecisionPending(task) && deliveryDecisionProblem(task)
        ? ["inbox.rerun-checks", "inbox.changes"]
        : ["inbox.approve", "inbox.changes"],
  },
  stuck: {
    id: "stuck",
    label: "Stuck",
    waitLabel: "Stuck task decision",
    tone: "slate",
    tab: "session",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: true,
    legacyWait: "stuck",
    cardHeader: () => ({ label: "Stuck", tone: "slate" }),
    noticeTitle: (who, taskName) => `${who}: ${taskName} is stuck`,
    decisions: () => ["inbox.retry"],
  },
  shipping: {
    id: "shipping",
    label: "Shipping was interrupted",
    waitLabel: "Shipping decision",
    tone: "amber",
    tab: "session",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: false,
    legacyWait: "shipping",
    cardHeader: () => ({ label: "Shipping was interrupted", tone: "amber" }),
    noticeTitle: (who) => `${who}: shipping a task was interrupted`,
    decisions: () => ["inbox.recovery"],
  },
  driving: {
    id: "driving",
    label: "You're driving",
    waitLabel: "Driving task",
    tone: "blue",
    tab: "session",
    visibility: {
      countsInBadge: true,
      notifies: false,
      // Session already shows the driving controls in the footer directly beneath the log.
      showInSession: false,
      showInOverview: true,
      quietSort: false,
    },
    survivesAgentStop: false,
    throughputPhaseWait: false,
    cardHeader: () => ({ label: "You're driving", tone: "blue" }),
    noticeTitle: () => "You're driving",
    decisions: () => [],
  },
  guide: {
    id: "guide",
    label: "Review guide",
    waitLabel: "Review guide suggestion",
    tone: "teal",
    tab: "review",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: false,
    cardHeader: () => ({ label: "Review guide", tone: "teal" }),
    noticeTitle: (who) => `${who}: a point for the review guide`,
    decisions: () => ["review-guide.accept", "review-guide.decline"],
  },
  learnings: {
    id: "learnings",
    label: "Learnings",
    waitLabel: "Learnings suggestion",
    tone: "teal",
    tab: "review",
    visibility: DEFAULT_VISIBILITY,
    survivesAgentStop: false,
    throughputPhaseWait: false,
    cardHeader: () => ({ label: "Learnings", tone: "teal" }),
    noticeTitle: (who) => `${who}: lessons about working in this repository`,
    decisions: () => ["learning.accept", "learning.decline"],
  },
  screen: {
    id: "screen",
    label: "Screen",
    waitLabel: "Screen request",
    tone: "slate",
    tab: "session",
    visibility: {
      countsInBadge: false,
      notifies: false,
      showInSession: true,
      showInOverview: true,
      quietSort: true,
    },
    survivesAgentStop: false,
    throughputPhaseWait: true,
    cardHeader: () => ({ label: "Screen", tone: "slate" }),
    noticeTitle: (who) => `${who} needs the screen`,
    decisions: () => ["screen.allow"],
  },
};

export function isInboxKind(value: unknown): value is InboxKind {
  return typeof value === "string" && (INBOX_KINDS as readonly string[]).includes(value);
}

export function countableInboxItems<T extends Pick<InboxItem, "kind">>(items: readonly T[]): T[] {
  return items.filter((item) => INBOX_CATALOG[item.kind].visibility.countsInBadge);
}

export function notifiableInboxItem(item: Pick<InboxItem, "kind">): boolean {
  return INBOX_CATALOG[item.kind].visibility.notifies;
}

export function describeInboxCardHeader(
  item: Pick<InboxItem, "kind">,
  task?: InboxHeadlineContextTask,
): { readonly label: string; readonly tone: Tone } {
  return INBOX_CATALOG[item.kind].cardHeader(task);
}

export function describeInboxNoticeTitle(
  item: Pick<InboxItem, "kind">,
  who: string,
  taskName: string,
  task?: InboxHeadlineContextTask,
): string {
  return INBOX_CATALOG[item.kind].noticeTitle(who, taskName, task);
}

export function decisionsForInboxItem(
  kind: string,
  task?: InboxDecisionContextTask,
): InboxDecisionOperation[] {
  if (!isInboxKind(kind)) return [];
  return [...INBOX_CATALOG[kind].decisions(task)];
}
