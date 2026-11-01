// Single pure catalog of usage-limit window kinds, default lengths and plain-language labels.

export interface UsageWindowDescriptor {
  readonly kind: string;
  readonly label: string;
  readonly allowanceBase?: string;
  readonly defaultMinutes?: number;
}

export const USAGE_WINDOW_CATALOG = [
  { kind: "five_hour", label: "5-hour", defaultMinutes: 300 },
  { kind: "seven_day", label: "weekly", defaultMinutes: 10_080 },
  { kind: "seven_day_opus", label: "weekly Opus", allowanceBase: "Weekly", defaultMinutes: 10_080 },
  { kind: "seven_day_sonnet", label: "weekly Sonnet", allowanceBase: "Weekly", defaultMinutes: 10_080 },
  { kind: "seven_day_overage_included", label: "weekly", defaultMinutes: 10_080 },
  { kind: "seven_day_model", label: "weekly", defaultMinutes: 10_080 },
  { kind: "overage", label: "extra usage" },
  { kind: "monthly", label: "monthly" },
] as const satisfies readonly UsageWindowDescriptor[];

const WINDOW_BY_KIND: Readonly<Record<string, UsageWindowDescriptor>> = Object.fromEntries(
  USAGE_WINDOW_CATALOG.map((entry) => [entry.kind, entry]),
);

export function getUsageWindowDescriptor(kind: string): UsageWindowDescriptor | undefined {
  return Object.hasOwn(WINDOW_BY_KIND, kind) ? WINDOW_BY_KIND[kind] : undefined;
}

export function inferUsageWindowMinutes(kind: string, explicitMinutes?: number): number | undefined {
  if (explicitMinutes !== undefined && Number.isFinite(explicitMinutes) && explicitMinutes > 0) {
    return explicitMinutes;
  }
  const descriptor = getUsageWindowDescriptor(kind);
  if (descriptor?.defaultMinutes !== undefined) return descriptor.defaultMinutes;
  if (kind.startsWith("seven_day")) return 10_080;
  return undefined;
}

/** A limit's name in plain words: "weekly Opus". */
export function kindWords(kind: string, minutes?: number, name?: string): string {
  let label = getUsageWindowDescriptor(kind)?.label ?? "usage";
  if (minutes !== undefined && Number.isFinite(minutes) && minutes > 0) {
    label =
      minutes === 10_080
        ? "weekly"
        : minutes === 1440
          ? "daily"
          : minutes < 60
            ? `${Math.round(minutes)}-minute`
            : minutes < 1440
              ? `${Math.round(minutes / 60)}-hour`
              : `${Math.round(minutes / 1440)}-day`;
  }
  return name ? `${label}, ${name}` : label;
}
