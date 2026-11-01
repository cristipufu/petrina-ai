// Single source of truth for every RoleResult contract: Library wording, allowed stage kinds,
// permission locks, board pipeline labels, analytics grouping, summary verbs and demo weights.

import type { StageKind } from "./stage-kinds.js";

export const ROLE_RESULTS = [
  "plan",
  "notes",
  "brief",
  "objections",
  "build",
  "checks",
  "findings",
  "delivery",
  "check-discovery",
  "guide",
  "votes",
] as const;

export type RoleResult = (typeof ROLE_RESULTS)[number];

/** Which kind of step a role works in, from what it hands back. The planner and internal/delivery roles have none: Petrina places them. */
export type RoleStep = "do" | "design" | "design-review" | "review";

export type ResultColumn = "planning" | "designing" | "building" | "reviewing" | "ready";

export interface RoleResultDescriptor {
  readonly id: RoleResult;
  readonly words: {
    readonly label: string;
    readonly detail: string;
  };
  readonly userAddable: {
    readonly workflow: boolean;
    readonly maintenance: boolean;
  };
  readonly step?: RoleStep;
  readonly allowedStageKinds: readonly StageKind[];
  readonly defaultCanEdit: boolean;
  readonly permissionLock?: string;
  readonly addedSees?: string;
  readonly columnFor: (canEdit: boolean) => ResultColumn;
  readonly stepLabel?: string;
  readonly upcomingVerb?: string;
  readonly analytics: {
    readonly defaultLabel?: string;
    readonly order: number;
  };
  readonly simTokenWeight: number;
  readonly allowsReportImages: boolean;
}

const DEFAULT_NOTES_SEES =
  "The task, the product, your notes on the task, the design brief and what earlier agents handed back.";

export const ROLE_RESULT_CATALOG: Readonly<Record<RoleResult, RoleResultDescriptor>> = {
  plan: {
    id: "plan",
    words: { label: "A plan", detail: "The steps for the task, with a reason for each." },
    userAddable: { workflow: false, maintenance: false },
    allowedStageKinds: [],
    defaultCanEdit: false,
    permissionLock: "The Planner is always read-only: it plans the work and changes nothing.",
    columnFor: () => "planning",
    stepLabel: "Plan",
    upcomingVerb: "planning",
    analytics: { defaultLabel: "Planning", order: 1 },
    simTokenWeight: 0.5,
    allowsReportImages: false,
  },
  notes: {
    id: "notes",
    words: { label: "Notes", detail: "A summary and a list that every later agent on the task reads." },
    userAddable: { workflow: true, maintenance: true },
    step: "do",
    allowedStageKinds: ["do"],
    defaultCanEdit: false,
    addedSees: DEFAULT_NOTES_SEES,
    columnFor: (canEdit) => (canEdit ? "building" : "designing"),
    analytics: { order: 2 },
    simTokenWeight: 0.8,
    allowsReportImages: true,
  },
  brief: {
    id: "brief",
    words: {
      label: "A design brief",
      detail: "What changes for users, the parts that change, an acceptance checklist and risks.",
    },
    userAddable: { workflow: false, maintenance: false },
    step: "design",
    allowedStageKinds: ["converge"],
    defaultCanEdit: false,
    columnFor: (canEdit) => (canEdit ? "building" : "designing"),
    stepLabel: "Design",
    upcomingVerb: "design",
    analytics: { defaultLabel: "Design", order: 3 },
    simTokenWeight: 0.8,
    allowsReportImages: false,
  },
  objections: {
    id: "objections",
    words: { label: "Objections", detail: "Each one blocking or not. The architect answers every one." },
    userAddable: { workflow: false, maintenance: false },
    step: "design-review",
    allowedStageKinds: ["converge"],
    defaultCanEdit: false,
    permissionLock: "Reviewers never change the work they judge, so they are always read-only.",
    columnFor: () => "designing",
    stepLabel: "Design",
    upcomingVerb: "design review",
    analytics: { defaultLabel: "Design", order: 3 },
    simTokenWeight: 0.8,
    allowsReportImages: true,
  },
  build: {
    id: "build",
    words: {
      label: "A change ready for review",
      detail: "With a plain-language summary that goes into the pull request.",
    },
    userAddable: { workflow: false, maintenance: true },
    step: "do",
    allowedStageKinds: ["do"],
    defaultCanEdit: true,
    permissionLock: "The Builder always makes changes: building the work is its job.",
    addedSees: DEFAULT_NOTES_SEES,
    columnFor: () => "building",
    stepLabel: "Build",
    upcomingVerb: "build",
    analytics: { defaultLabel: "Build", order: 5 },
    simTokenWeight: 1.6,
    allowsReportImages: true,
  },
  checks: {
    id: "checks",
    words: { label: "Pass or fail per acceptance item", detail: "Failed checks go back to the builder." },
    userAddable: { workflow: false, maintenance: false },
    step: "do",
    allowedStageKinds: ["do"],
    defaultCanEdit: false,
    columnFor: () => "building",
    stepLabel: "Test",
    upcomingVerb: "testing",
    analytics: { defaultLabel: "Testing", order: 6 },
    simTokenWeight: 0.8,
    allowsReportImages: true,
  },
  findings: {
    id: "findings",
    words: {
      label: "Pass-or-fail findings",
      detail: "It joins the review next to the code reviewers. Its blocking findings go back to the builder.",
    },
    userAddable: { workflow: true, maintenance: false },
    step: "review",
    allowedStageKinds: ["review-chain"],
    defaultCanEdit: false,
    permissionLock: "Reviewers never change the work they judge, so they are always read-only.",
    addedSees:
      "The design, the acceptance checklist, the change, the builder's report and earlier findings. Never the builder's transcript.",
    columnFor: () => "reviewing",
    stepLabel: "Review",
    upcomingVerb: "review",
    analytics: { defaultLabel: "Review", order: 7 },
    simTokenWeight: 1.1,
    allowsReportImages: true,
  },
  delivery: {
    id: "delivery",
    words: { label: "Release notes", detail: "Notes for a release that Petrina publishes itself." },
    userAddable: { workflow: false, maintenance: false },
    allowedStageKinds: ["do"],
    defaultCanEdit: false,
    permissionLock: "The Release Manager writes release notes. Petrina handles delivery itself. It can't be edited here.",
    columnFor: () => "ready",
    stepLabel: "Ship",
    upcomingVerb: "release notes",
    analytics: { defaultLabel: "Delivery", order: 9 },
    simTokenWeight: 0.8,
    allowsReportImages: false,
  },
  "check-discovery": {
    id: "check-discovery",
    words: { label: "Product checks", detail: "The checks Petrina runs on the work." },
    userAddable: { workflow: false, maintenance: false },
    allowedStageKinds: [],
    defaultCanEdit: false,
    permissionLock: "Petrina runs this role read-only as part of its checks.",
    columnFor: () => "reviewing",
    upcomingVerb: "check discovery",
    analytics: { defaultLabel: "Check discovery", order: 10 },
    simTokenWeight: 0.8,
    allowsReportImages: false,
  },
  guide: {
    id: "guide",
    words: { label: "Review guide point", detail: "A proposed point to help future reviews." },
    userAddable: { workflow: false, maintenance: false },
    allowedStageKinds: [],
    defaultCanEdit: false,
    permissionLock: "Petrina runs this role read-only as part of its checks.",
    columnFor: () => "building",
    upcomingVerb: "review guide",
    analytics: { defaultLabel: "Review guide", order: 10 },
    simTokenWeight: 0.8,
    allowsReportImages: false,
  },
  votes: {
    id: "votes",
    words: { label: "Verdicts on findings", detail: "An independent check of important findings." },
    userAddable: { workflow: false, maintenance: false },
    allowedStageKinds: [],
    defaultCanEdit: false,
    permissionLock: "Petrina runs this role read-only as part of its checks.",
    columnFor: () => "reviewing",
    upcomingVerb: "finding verification",
    analytics: { defaultLabel: "Finding verification", order: 10 },
    simTokenWeight: 0.8,
    allowsReportImages: false,
  },
} satisfies Readonly<Record<RoleResult, RoleResultDescriptor>>;

export function isRoleResult(value: string): value is RoleResult {
  return Object.hasOwn(ROLE_RESULT_CATALOG, value);
}
