/** The checkpoint has already recorded the note and applied the ordinary request-changes transition. */
export interface DeliveryReturnInput {
  readonly note: string;
  /** The checkpoint's position before the task moved back to its builder. */
  readonly fromCheck: number;
  readonly now: number;
}

/** A decision stays at its checkpoint; waiting proceeds through the existing admission owner. */
export type DeliveryReturnRoute = "decision" | "waiting";
