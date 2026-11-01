export const DELIVERY_MODES = ["pull-request", "release", "local"] as const;

/**
 * What "ready" means for a product.
 * - `pull-request`: push the work's one commit and open a pull request (never merged by Petrina).
 * - `release`: push the work with a version commit to the default branch, with a new version tag, and publish a GitHub release.
 * - `local`: advance the approved branch in the local copy and push the tested work to its saved GitHub address. Commit to main does the same for the default branch.
 * Petrina publishes, and sets a release's version itself; the only agent at delivery is the Release Manager, writing a release's notes.
 */
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Display order used in per-repository `<Select>` controls. */
export const DELIVERY_SELECT_MODES = ["pull-request", "local", "release"] as const satisfies readonly DeliveryMode[];

export const DELIVERY_DESTINATION_KINDS = ["branch", "new-pr", "update-pr", "release"] as const;
export type DeliveryDestinationKind = (typeof DELIVERY_DESTINATION_KINDS)[number];

export type StartFromKind = "default" | "branch" | "pull-request";

export interface DeliveryModeDescriptor {
  readonly id: DeliveryMode;
  readonly label: string;
  readonly previousLabel: string;
  readonly publishSummary: string;
  readonly allowedStartKinds: readonly StartFromKind[];
  readonly invalidStartReason?: string;
  readonly invalidStartInlineNote?: string;
  readonly requiresGitHub: boolean;
  readonly requiresAgentPrepNotes: boolean;
  readonly wantsBuilderPrDescription: boolean;
  readonly createsVersionCommit: boolean;
  choiceSummaryLabel(startKind: StartFromKind): string;
  selectOptionLabel(startKind: StartFromKind, options?: { readonly definitePr?: boolean }): string;
}

export const DELIVERY_MODE_CATALOG: Readonly<Record<DeliveryMode, DeliveryModeDescriptor>> = {
  "pull-request": {
    id: "pull-request",
    label: "Open a pull request",
    previousLabel: "Pull request",
    publishSummary: "Petrina opens the pull request",
    allowedStartKinds: ["default", "branch", "pull-request"],
    requiresGitHub: true,
    requiresAgentPrepNotes: false,
    wantsBuilderPrDescription: true,
    createsVersionCommit: false,
    choiceSummaryLabel: (startKind) => (startKind === "pull-request" ? "Update pull request" : "Open a pull request"),
    selectOptionLabel: (startKind, options) =>
      startKind === "pull-request"
        ? options?.definitePr
          ? "Update the pull request"
          : "Update pull request"
        : "Open a pull request",
  },
  release: {
    id: "release",
    label: "Publish a release",
    previousLabel: "Release",
    publishSummary: "Petrina publishes the release",
    allowedStartKinds: ["default"],
    invalidStartReason: "Releases start from the default branch. Correct the starting point or choose another delivery mode.",
    invalidStartInlineNote: "Releases use the default branch.",
    requiresGitHub: true,
    requiresAgentPrepNotes: true,
    wantsBuilderPrDescription: false,
    createsVersionCommit: true,
    choiceSummaryLabel: () => "Publish a release",
    selectOptionLabel: () => "Publish a release",
  },
  local: {
    id: "local",
    label: "Commit to main",
    previousLabel: "Commit locally",
    publishSummary: "Petrina commits to main",
    allowedStartKinds: ["default", "branch", "pull-request"],
    requiresGitHub: false,
    requiresAgentPrepNotes: false,
    wantsBuilderPrDescription: false,
    createsVersionCommit: false,
    choiceSummaryLabel: () => "Commit and push",
    selectOptionLabel: () => "Commit and push to the starting branch",
  },
};

export const DELIVERY_LABEL: Record<DeliveryMode, string> = {
  "pull-request": DELIVERY_MODE_CATALOG["pull-request"].label,
  release: DELIVERY_MODE_CATALOG.release.label,
  local: DELIVERY_MODE_CATALOG.local.label,
};

export function isDeliveryMode(value: unknown): value is DeliveryMode {
  return typeof value === "string" && (DELIVERY_MODES as readonly string[]).includes(value);
}

export function isValidDeliveryStart(startKind: StartFromKind, delivery: DeliveryMode): boolean {
  return DELIVERY_MODE_CATALOG[delivery].allowedStartKinds.includes(startKind);
}

export function assertValidDeliveryStart(startKind: StartFromKind, delivery: DeliveryMode): void {
  if (!isValidDeliveryStart(startKind, delivery)) {
    throw new Error(
      DELIVERY_MODE_CATALOG[delivery].invalidStartReason ??
        `Delivery mode "${delivery}" is not compatible with starting from "${startKind}".`,
    );
  }
}

export function resolveDestinationKind(startKind: StartFromKind, delivery: DeliveryMode): DeliveryDestinationKind {
  if (startKind === "pull-request") return "update-pr";
  switch (delivery) {
    case "pull-request":
      return "new-pr";
    case "release":
      return "release";
    case "local":
      return "branch";
  }
}

export function effectiveDestinationKind(work: {
  readonly delivery: DeliveryMode;
  readonly source?: { readonly start: { readonly kind: StartFromKind } } | undefined;
}): DeliveryDestinationKind {
  return resolveDestinationKind(work.source?.start.kind ?? "default", work.delivery);
}

export function deliveryChoiceSummaryLabel(mode: DeliveryMode, startKind: StartFromKind): string {
  return DELIVERY_MODE_CATALOG[mode].choiceSummaryLabel(startKind);
}

export function deliverySelectLabel(
  mode: DeliveryMode,
  startKind: StartFromKind,
  options?: { readonly definitePr?: boolean },
): string {
  return DELIVERY_MODE_CATALOG[mode].selectOptionLabel(startKind, options);
}
