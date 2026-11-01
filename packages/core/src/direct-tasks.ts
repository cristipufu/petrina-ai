// Direct single-agent tasks: one chosen role and profile run directly on one product without the Planner
// or Reviewers. Read-only and discovery roles finish immediately; editing roles deliver only if files changed.

import type { NewTaskInput } from "./commands.js";
import type { DeepMutable } from "./flow.js";
import { deliveryStages } from "./library.js";
import type { AgentProfile, Id, Product, Role, State, Task, TaskState } from "./model.js";
import { ROLE_RESULT_CATALOG } from "./result-contracts.js";
import { activeRoles, roleForTask } from "./roles.js";

const copy = <T>(value: T): DeepMutable<T> => JSON.parse(JSON.stringify(value)) as DeepMutable<T>;

export interface DirectTaskSelection {
  readonly roleId: Id;
  readonly profileId: Id;
}

export interface DirectTaskRun {
  readonly role: Role;
  readonly profile: AgentProfile;
  readonly productId: Id;
}

export function isDirectCapableRole(
  role: Pick<Role, "result" | "canEdit" | "removed"> | undefined,
): boolean {
  if (!role || role.removed || !ROLE_RESULT_CATALOG[role.result]?.directCapable) return false;
  return !role.canEdit || role.result === "build";
}

/** Active roles whose result contract can run standalone in a single-agent task. */
export function directCapableRoles(roles: readonly Role[]): Role[] {
  return activeRoles(roles).filter(isDirectCapableRole);
}

/** Whether a finished task intentionally produced no product changes (either a routine investigation or a direct task). */
export function hasNoProductChanges(
  task: { noProductChanges?: boolean; maintenance?: { noProductChanges?: boolean } },
): boolean {
  return Boolean(task.noProductChanges || task.maintenance?.noProductChanges);
}

export function directTaskProblem(
  selection: DirectTaskSelection,
  productIds: readonly Id[],
  state: Pick<State, "products" | "roles" | "profiles">,
): string | undefined {
  if (productIds.length !== 1 || !state.products.some((product) => product.id === productIds[0])) {
    return "Choose one registered product for a single-agent task.";
  }
  const role = state.roles.find((entry) => entry.id === selection.roleId && !entry.removed);
  if (!role || !isDirectCapableRole(role)) {
    return "Choose an available role that can run as a single-agent task.";
  }
  if (!state.profiles.some((profile) => profile.id === selection.profileId)) {
    return "Choose an available agent profile.";
  }
  return undefined;
}

/** Freeze the chosen role and profile onto the task and build its pre-planned stage pipeline. */
export function prepareDirectTask(
  task: DeepMutable<TaskState>,
  selection: DirectTaskSelection,
  state: Pick<State, "products" | "roles" | "profiles">,
): void {
  const chosenIds = task.selectedProducts?.length
    ? task.selectedProducts.map((choice) => choice.productId)
    : task.productId
      ? [task.productId]
      : [];
  const problem = directTaskProblem(selection, chosenIds, state);
  if (problem) throw new Error(problem);
  const role = state.roles.find((entry) => entry.id === selection.roleId && !entry.removed)!;
  const profile = state.profiles.find((entry) => entry.id === selection.profileId)!;
  const productId = chosenIds[0]!;
  task.direct = copy({ role, profile, productId });
  task.stageIndex = 0;
  task.approvePlan = false;
  task.risk = role.canEdit
    ? { level: "medium", why: "Single-agent changes run automated checks before delivery." }
    : { level: "low", why: "Read-only single-agent run makes no product changes." };
  const stages = [
    {
      id: `${task.id}:direct`,
      title: role.result === "check-discovery" ? "Find automated checks" : role.name,
      kind: "do" as const,
      roleId: role.id,
      profileIds: [profile.id],
      assignments: [
        {
          profileId: profile.id,
          by: "coordinator" as const,
          reason: "Chosen for this single-agent task.",
        },
      ],
    },
    ...(role.canEdit
      ? copy(deliveryStages(task, profile.id)).map((stage) => ({
          ...stage,
          assignments: stage.profileIds.map((profileId) => ({
            profileId,
            by: "engine" as const,
            reason: "Selected by the workflow rules.",
          })),
        }))
      : []),
  ];
  task.plan = {
    rationale: role.canEdit
      ? `Run ${role.name} directly without planning or reviewers. If files change, Petrina runs checks and delivers.`
      : `Run ${role.name} directly as a single-step task.`,
    plannerProfileId: profile.id,
    stages,
  };
}

/** Find an already queued, waiting or running check-discovery task for a product so discovery is never duplicated. */
export function activeCheckDiscoveryTask(
  tasks: readonly Pick<Task, "id" | "productId" | "state" | "plan" | "maintenance" | "direct">[],
  roles: readonly Role[],
  productId: Id,
): Id | undefined {
  return tasks.find(
    (task) =>
      task.productId === productId
      && ["queued", "waiting", "running", "needs-you"].includes(task.state)
      && (task.plan?.stages ?? []).some(
        (stage) => stage.kind === "do" && roleForTask(roles, stage.roleId, task)?.result === "check-discovery",
      ),
  )?.id;
}

/** Build the single-agent check-discovery request for a product. */
export function checkDiscoveryTaskInput(
  product: Pick<Product, "id" | "name">,
  state: Pick<State, "roles" | "profiles" | "tools">,
  requestedProfileId?: Id,
  defaultProfileId: Id = "opus-high",
): NewTaskInput {
  const role = state.roles.find((entry) => !entry.removed && entry.result === "check-discovery");
  if (!role) throw new Error("No check-discovery role is available in the Library.");
  const explicit = requestedProfileId
    ? state.profiles.find((entry) => entry.id === requestedProfileId)
    : undefined;
  if (requestedProfileId && !explicit) throw new Error("Choose an available agent profile.");
  const ready = state.profiles.filter(
    (profile) => !profile.standby && state.tools.some((tool) => tool.id === profile.toolId && tool.status === "ready"),
  );
  const profile =
    explicit
    ?? ready.find((entry) => entry.id === defaultProfileId)
    ?? ready[0]
    ?? state.profiles.find((entry) => entry.id === defaultProfileId)
    ?? state.profiles[0];
  if (!profile) throw new Error("No agent profile is available in the Library.");
  return {
    productId: product.id,
    title: `Find automated checks for ${product.name}`,
    description:
      "Inspect the repository's CI workflows and build files, confirm which checks run on this machine, and save the product's automated checks.",
    kind: "chore",
    approvePlan: false,
    approveDelivery: false,
    direct: { roleId: role.id, profileId: profile.id },
  };
}
