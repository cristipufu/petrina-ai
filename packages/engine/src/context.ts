// Native Context entry point; the actual context producer keeps its ordering and projections independent of I/O.
import { ContextInput, type ContextHost, type ContextEffects } from "./context-input.js";
import type { GuideKeeper } from "./guide-keeper.js";
import type { RecordedChecksApplicability } from "./product-checks.js";
import type { RepositoryContext } from "@petrina/orchestrator";
import { checksFor } from "@petrina/repositories/check-discovery";
import { currentSourcePointers } from "@petrina/repositories/source-pointers";
import { treeOf } from "@petrina/repositories/git";
import { readReviewHistory } from "./review-history.js";
import { verificationContext } from "./verification-context.js";
import { relatedCheckEvidence } from "./related-check-evidence.js";
export * from "./context-input.js";

const nativeContext: ContextEffects = {
  checksFor: (...args) => checksFor(...args), currentSourcePointers: (...args) => currentSourcePointers(...args),
  treeOf: (...args) => treeOf(...args), readReviewHistory: (...args) => readReviewHistory(...args),
  verificationContext: (...args) => verificationContext(...args), relatedCheckEvidence: (...args) => relatedCheckEvidence(...args),
};

export class Context extends ContextInput {
  constructor(k: ContextHost, guide: Pick<GuideKeeper, "pendingPoints">, currentChecks?: (scope: RepositoryContext) => Promise<RecordedChecksApplicability>) {
    super(k, guide, nativeContext, currentChecks);
  }
}
