import { checkOutcome, checkOutcomeLabel, workSummary, type Id } from "@petrina/core";
import type { RuntimeTask } from "./model.js";

export interface ProductContextRow {
  productId: Id;
  beforeCopy: string;
  copy: string;
  afterCopy: string;
}

/** Shared product facts, with the copy kept separate for a reviewer's own workspace. */
export function productRows(task: Pick<RuntimeTask, "repositories">): ProductContextRow[] | undefined {
  return task.repositories?.map((work) => ({
    productId: work.productId,
    beforeCopy: `${work.source ? workSummary(work.source) : work.productId}\nProduct id: ${work.productId}; copy: `,
    copy: work.worktree ?? "preparing",
    afterCopy: `; base version: ${work.baseSha ?? "not prepared"}; last completed review: ${work.reviewedSha ?? "none; inspect the full change"}\nBuilder report: ${work.report?.summary ?? "not yet built"}. Checks: ${work.checks?.results.map((run) => `${run.name}: ${checkOutcomeLabel(checkOutcome(run))}`).join(", ") || "Not run"}\nReview guide: use this product’s REVIEW.md at its saved base version.`,
  }));
}
