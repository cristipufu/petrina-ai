import { workflowRoles, stepOf } from "./roles.js";
import type { Role } from "./model.js";

/** What the planner can choose, including roles the coordinator added. */
export function plannerRoles(roles: readonly Role[]): string {
  const fits = { do: 'a "do" stage', design: 'the author of a "converge" stage', "design-review": 'the reviewer of a "converge" stage', review: 'a reviewer in a "review-chain" stage' };
  return workflowRoles(roles).filter((role) => !role.internal && stepOf(role)).map((role) => `- ${role.id} (${role.name}): ${role.purpose} | ${role.canEdit ? "changes the product" : "read-only"} | hands back: ${role.handsBack || role.result} | fits: ${fits[stepOf(role)!]}`).join("\n");
}
