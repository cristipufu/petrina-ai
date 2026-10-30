import { lastIndexWhere } from "@petrina/core";
import type { RepositoryContext } from "./repository-context.js";
import type { CheckVerification } from "./ports/check-evidence.js";
import type { CheckDeliveryEffects } from "./ports/check-delivery.js";

/** Check routing at delivery boundaries; freshness, preparation and execution stay with their adapters. */
export class CheckDelivery<Preparation = () => Promise<boolean | void>> {
  constructor(private readonly effects: CheckDeliveryEffects<Preparation>) {}
  async beforeDelivery(scope: RepositoryContext, signal: AbortSignal, prepare?: Preparation): Promise<"passed" | "returned" | "exhausted" | "blocked"> {
    let result: CheckVerification;
    try { result = await this.effects.failing(scope, signal, "delivery-check", prepare); }
    catch (error) {
      if (this.effects.preparationChanged(error)) return "returned";
      throw error;
    }
    if (result.kind === "passed") return "passed";
    if (result.kind === "blocked") return "blocked";
    return this.effects.backToBuilder(scope, "right before your delivery check", new Set([result.productId])) ? "returned" : "exhausted";
  }

  /** Final verification has its own live observation; no earlier acceptance authority is borrowed. */
  async beforeShipping(scope: RepositoryContext, signal: AbortSignal, prepare?: Preparation): Promise<"passed" | "returned" | "blocked"> {
    const { task, work: repository } = scope;
    let result: CheckVerification;
    try { result = await this.effects.failing(scope, signal, "publishing", prepare); }
    catch (error) {
      if (this.effects.preparationChanged(error)) return "returned";
      throw error;
    }
    if (result.kind === "passed") return "passed";
    if (result.kind === "product-failed" && this.effects.backToBuilder(scope, "on what was about to ship", new Set([result.productId]))) return "returned";
    const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
    withdrawApproval(repository);
    if (check >= 0) {
      task.stageIndex = check;
      task.sub = 0;
    }
    this.effects.blocked(task);
    return "blocked";
  }

}

function withdrawApproval(work: { approvedSha?: string; approvedPatch?: string; approvedFor?: unknown }): void {
  delete work.approvedSha;
  delete work.approvedPatch;
  delete work.approvedFor;
}
