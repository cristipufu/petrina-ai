import { lastIndexWhere, owedAcceptanceTest } from "@petrina/core";
import { beginRepair } from "./repair.js";
import { addDeliveryCheck } from "./delivery-gate.js";
import type { AcceptanceRoutingHost, AcceptanceRoutingInput } from "./ports/acceptance.js";
import type { RepositoryContext } from "./repository-context.js";

/** Route an already recorded result; ordinary stage completion stays with the caller. */
export function routeAcceptance(host: AcceptanceRoutingHost, scope: RepositoryContext, input: AcceptanceRoutingInput): "continue" | "stop" | undefined {
  const { task, work: repository } = scope;
  // Even with delivery approval off, required acceptance that could not be verified waits for the coordinator's decision.
  if (input.requiredGap && !task.plan!.stages.some((entry) => entry.kind === "gate" && entry.gate === "delivery") && addDeliveryCheck(host, task)) {
    host.note(scope, "milestone", input.restored
      ? "Added your delivery check: this acceptance run cannot verify the product, so delivery waits for your decision"
      : `Added your delivery check: ${input.requiredCount === 1 ? "a required acceptance check" : `${input.requiredCount} required acceptance checks`} could not be verified, so delivery waits for your decision`);
  }
  if (task.repositories && input.failed) {
    // Testing the delivery check started, and repairs of what it found, return to that check. Earlier testing and
    // its repairs go on through the rest of the plan: the owed reviews still run before any delivery decision.
    const final = owedAcceptanceTest(task)?.final === true;
    host.finishStep(scope);
    delete task.retest;
    if (beginRepair(host, task, "acceptance", task.stageIndex, { final })) return "continue";
    task.acceptanceBlocked = true;
    const planned = task.plan!.stages.some((entry) => entry.kind === "gate" && entry.gate === "delivery");
    // Even with delivery approval off, failures still open wait for the coordinator's explicit decision.
    if (!final && addDeliveryCheck(host, task)) {
      if (!planned) host.note(scope, "milestone", "Added your delivery check: acceptance still fails, so delivery waits for your decision");
      const reviews = task.plan!.stages.some((entry, index) => index > task.stageIndex && entry.kind === "review-chain");
      host.note(scope, "warn", `Acceptance still fails: the builder returns are unavailable or used up. ${reviews ? "The remaining reviews run first, then" : "Next,"} the decision goes to you at your delivery check`);
      task.stageIndex += 1;
      task.sub = 0;
      host.commitNow(task);
      return "continue";
    }
    host.note(scope, "warn", "Acceptance still fails: the builder returns are unavailable or used up, so the decision goes to you");
    const gate = task.plan!.stages.findIndex((entry) => entry.kind === "gate" && entry.gate === "delivery");
    task.stageIndex = gate >= 0 ? gate : task.plan!.stages.length;
    task.sub = 0;
    host.commitNow(task);
    if (gate >= 0) return "continue";
    host.openDeliveryDecision(task);
    return "stop";
  }
  if (task.retest) {
    // The final pass before the delivery check: on to the check, or back to the builder with what failed.
    const final = owedAcceptanceTest(task)?.final === true;
    delete task.retest;
    host.finishStep(scope);
    const stages = task.plan?.stages ?? [];
    const builder = lastIndexWhere(stages, (entry) => host.role(entry.roleId, task)?.result === "build" && entry.kind === "do");
    // A reproduced failure keeps its bounded repair even while another item could not be verified; that item alone sends nothing back.
    if (input.failed && builder >= 0 && (repository.acceptanceReturns ?? 0) < 2) {
      repository.acceptanceReturns = (repository.acceptanceReturns ?? 0) + 1;
      task.stageIndex = builder;
      task.fixing = true;
      host.note(scope, "warn", `Sent back to the builder: ${input.failed} acceptance check${input.failed === 1 ? "" : "s"} failed on the final code`);
    } else {
      if (input.failed || input.requiredGap) {
        task.acceptanceBlocked = true;
        host.note(scope, "warn", input.failed
          ? "Acceptance still fails: the builder returns are used up, so the decision goes to you"
          : "Acceptance could not be fully verified, so the decision goes to you");
      }
      // Final testing returns to the delivery check; any other goes on through the planned steps that have not run yet.
      const gate = stages.findIndex((entry) => entry.kind === "gate" && entry.gate === "delivery");
      task.stageIndex = gate >= 0 && final ? gate : task.stageIndex + 1;
    }
    task.sub = 0;
    host.commit(task);
    return "continue";
  }
}
