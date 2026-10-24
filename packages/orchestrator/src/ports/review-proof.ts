import type { DeepMutable, ProofRequest, Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";

/** Parsed reviewer proposals; parsing and agent transport remain boundary responsibilities. */
export type ReviewProofProposal = DeepMutable<Pick<ProofRequest, "text" | "reason" | "productIds" | "checklistText">>;

/** Bookkeeping uses task-aware role lookup and identity allocation; its caller checkpoints the accepted report. */
export interface ReviewProofHost {
  role(id: string, task: RuntimeTask): Role | undefined;
  id(prefix: string): string;
}
