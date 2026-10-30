import type { Id } from "@petrina/core";
import { scopesFor, type RepositoryContext } from "./repository-context.js";
import type { AcceptancePreparation } from "./ports/agent-workflow.js";
import type { AcceptancePreflightHost, AcceptancePreflightEffects } from "./ports/acceptance-preflight.js";

/** Resolve source movement and real check eligibility before admitting an acceptance participant. */
export class AcceptancePreflight {
  constructor(private readonly host: AcceptancePreflightHost, private readonly effects: AcceptancePreflightEffects) {}
  async run(scope: RepositoryContext, signal: AbortSignal): Promise<AcceptancePreparation> {
    const current = scope.task;
    // Resolve an already-known stale base before spending checks or acceptance on it.
    // A saved helper finishes its version first; completed discovery does not defer the checks' update.
    let failed = false;
    const eligibleProducts = new Set<Id>();
    let conflict = false;
    for (const scope of scopesFor(current)) {
      const work = scope.work;
      if (current.repositories) current.activeProductId = work.productId;
      const deferred = !!work.conversation;
      const testerFinishing = () => this.host.role(work.conversation?.roleId ?? "", current)?.result === "checks";
      if (!deferred && await this.effects.upToDate(scope, signal) === "conflict") {
        conflict = true;
        break;
      }
      let required = await this.effects.ensureChecks(scope, signal);
      if (deferred && !testerFinishing()) {
        const update = await this.effects.upToDate(scope, signal);
        if (update === "conflict") {
          conflict = true;
          break;
        }
        if (update === "moved") required = await this.effects.ensureChecks(scope, signal);
      }
      try {
        const result = await this.effects.failing(
          scope,
          signal,
          required,
          async () => testerFinishing() || await this.effects.upToDate(
          scope,
          signal
        ) !== "conflict"
        );
        failed = result.kind !== "passed" || failed;
        if (result.kind === "product-failed") eligibleProducts.add(result.productId);
      } catch (error) {
        if (this.effects.preparationChanged(error)) {
        conflict = true;
        break;
      }
        throw error;
      }

    }
    if (conflict) return { kind: "repeat" };
    if (failed) {
      for (const { work } of scopesFor(current)) {
        delete work.portReview;
        delete work.reviewedTree;
      }
      if (this.host.backToBuilder(scope, eligibleProducts)) return { kind: "repeat" };
      // Acceptance testing waits here, and starts once the checks pass on the current code.
      this.host.blocked(current);
      return { kind: "stop" };
    }
    return { kind: "prepared" };
  }
}
