// Single source of truth for workflow stage kinds and coordinator gates.

export const STAGE_KINDS = ["do", "converge", "review-chain", "gate"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const GATE_KINDS = ["plan", "design", "delivery"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export interface StageKindDescriptor {
  readonly id: StageKind;
  readonly label: string;
  readonly stepLabel?: string;
  readonly analytics?: {
    readonly key: string;
    readonly label: string;
    readonly order: number;
  };
  readonly multiAgent: boolean;
}

export const STAGE_KIND_CATALOG: Readonly<Record<StageKind, StageKindDescriptor>> = {
  do: {
    id: "do",
    label: "Single-role step",
    multiAgent: false,
  },
  converge: {
    id: "converge",
    label: "Design convergence",
    stepLabel: "Design",
    analytics: { key: "design", label: "Design", order: 3 },
    multiAgent: true,
  },
  "review-chain": {
    id: "review-chain",
    label: "Parallel review chain",
    stepLabel: "Review",
    analytics: { key: "review", label: "Review", order: 7 },
    multiAgent: true,
  },
  gate: {
    id: "gate",
    label: "Coordinator check",
    stepLabel: "Your check",
    multiAgent: false,
  },
} satisfies Readonly<Record<StageKind, StageKindDescriptor>>;
