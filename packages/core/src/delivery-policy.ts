import { acceptanceGap } from "./acceptance.js";
import { checkOutcome } from "./check-outcome.js";
import { proofGap } from "./proof-requests.js";
import type { Product, Task } from "./model.js";

/** The host supplies the actual selected owner; policy never infers it from display fields. */
export interface DeliveryPolicyContext {
  readonly products: readonly Pick<Product, "id" | "shipLowRisk">[];
  readonly product: Pick<Product, "shipLowRisk"> | undefined;
  readonly checks: Task["checks"];
}
export type DeliveryPolicyTask = Pick<Task, "reviewDecision" | "proofRequests" | "repositories" | "repository" | "delivery" | "proofRefreshBlocked" | "brief" | "journey" | "acceptanceUnverified" | "proofDeliveryGate" | "approveDelivery" | "acceptancePassed" | "findings" | "risk">;

/** Low-risk work skips the delivery check only where the coordinator opted in, with nothing left that needs them. */
export function shipsUnasked(task: DeliveryPolicyTask, context: DeliveryPolicyContext): boolean {
  if (task.reviewDecision) return false;
  if (proofGap(task)) return false;
  const complete = (checks: Task["checks"]) => checks?.results.every(run => checkOutcome(run).kind === "passed") ?? true;
  if (!complete(context.checks) || task.repositories?.some(work => !complete(work.checks))) return false;
  // The added check lifts on a complete, current pass of every required item, even when an extra probe could not be verified.
  if (task.proofDeliveryGate && !task.approveDelivery && task.acceptancePassed === true && !acceptanceGap(task) && !task.findings.some(finding => finding.status === "open" && finding.severity === "blocking")) return true;
  // Shared work also needs the saved task choice and combined acceptance; single-product work keeps
  // the product's existing low-risk opt-in, even when its ordinary deliveries ask first.
  if (task.repositories && (task.approveDelivery || task.acceptancePassed !== true)) return false;
  if (task.repositories && (!task.repositories.every((work) => context.products.find((product) => product.id === work.productId)?.shipLowRisk && !!work.checks?.results.length))) return false;
  if (task.risk?.level !== "low" || !context.product?.shipLowRisk) return false;
  if (task.acceptanceUnverified || task.acceptancePassed === false) return false;
  if (task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) return false;
  return true;
}
