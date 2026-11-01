// The role library: Petrina's built-in roles as the coordinator left them, and the roles they added.
// The engine and the demo squad share these rules, so the engine takes what the form allows and
// refuses the rest, whoever sends it. Petrina's own safeguards never depend on a role's wording:
// the result formats, the checks, undoing what read-only roles change, and no planned role
// changing anything after the final review.

import { MAINTENANCE_ROLES } from "./maintenance-roles.js";
import { BUILT_IN_ROLES } from "./library.js";
import {
  ROLE_ICON_CHOICES,
  TONE_CHOICES,
  type Column,
  type Id,
  type Role,
  type RoleChanges,
  type RoleEdit,
  type RoleIcon,
  type RoleResult,
  type Stage,
  type Task,
  type Tone,
} from "./model.js";
import { isRoleResult, ROLE_RESULT_CATALOG, ROLE_RESULTS, type RoleStep } from "./result-contracts.js";

export type { RoleStep };

export const ROLE_LIMITS = { name: 40, purpose: 200, instructions: 4000, handsBack: 300, added: 20 } as const;

/** The Release Manager writes release notes; Petrina handles delivery itself. */
export const RELEASE_MANAGER: Id = "release-manager";

export const NO_ROLE_CHANGES: RoleChanges = { edits: {}, added: [] };

/** What the coordinator fills in for a role. */
export interface RoleDraft {
  category?: "workflow" | "maintenance";
  name: string;
  icon: RoleIcon;
  tone: Tone;
  purpose: string;
  instructions: string;
  canEdit: boolean;
  handsBack: string;
  /** Chosen once, when a role is added. */
  result: RoleResult;
}

/** The fields a draft can have a problem with, and `role` for the role as a whole. */
export type RoleField = "name" | "purpose" | "instructions" | "handsBack" | "role";

/** The kinds of result a role the coordinator adds can hand back. */
export const ADDED_RESULTS: readonly RoleResult[] = ROLE_RESULTS.filter(
  (result) => ROLE_RESULT_CATALOG[result].userAddable.workflow,
);

export function stepOf(role: Pick<Role, "result">): RoleStep | undefined {
  return ROLE_RESULT_CATALOG[role.result].step;
}

/** Why a role's permission cannot change, or undefined when the coordinator may choose it. */
export function permissionLock(role: Pick<Role, "id" | "result" | "category">): string | undefined {
  if (role.category === "maintenance") {
    return role.result === "build"
      ? "Small changes with review can change the product."
      : "Reports only is always read-only.";
  }
  return ROLE_RESULT_CATALOG[role.result].permissionLock;
}

/** Where a task sits on the board while a role it added works on it: notes roles design or build, findings roles review. */
function addedColumn(result: RoleResult, canEdit: boolean): Column {
  return ROLE_RESULT_CATALOG[result].columnFor(canEdit);
}

/** What a role the coordinator adds sees, and where its tasks sit on the board. Petrina sets both from its kind of result and permission. */
export function addedFacts(result: RoleResult, canEdit: boolean): { sees: string; column: Column } {
  const spec = ROLE_RESULT_CATALOG[result];
  const effectiveCanEdit = spec.defaultCanEdit || (!spec.permissionLock && canEdit);
  return {
    sees: spec.addedSees ?? ROLE_RESULT_CATALOG.notes.addedSees!,
    column: addedColumn(result, effectiveCanEdit),
  };
}

/** One line, no runs of spaces. Names, purposes and hands-back descriptions are single lines. */
function line(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Trimmed, with Windows line ends made plain. Instructions keep their lines. */
function block(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

const sameName = (a: string, b: string) => line(a).toLowerCase() === line(b).toLowerCase();

const defaultOf = (id: Id) => [...BUILT_IN_ROLES, ...MAINTENANCE_ROLES].find((role) => role.id === id);

/** Only the changes a built-in role allows, and only those that differ from Petrina's defaults (saved data is not trusted blindly). */
function editOf(role: Role, edit: RoleEdit | undefined): RoleEdit {
  const out: RoleEdit = {};
  if (!edit || role.result === "delivery") return out;
  if (typeof edit.purpose === "string" && line(edit.purpose) !== role.purpose) out.purpose = line(edit.purpose);
  if (typeof edit.instructions === "string" && block(edit.instructions) !== role.instructions) out.instructions = block(edit.instructions);
  if (typeof edit.handsBack === "string" && line(edit.handsBack) !== role.handsBack) out.handsBack = line(edit.handsBack);
  if (typeof edit.canEdit === "boolean" && edit.canEdit !== role.canEdit && !permissionLock(role)) out.canEdit = edit.canEdit;
  return out;
}

/** A role the coordinator added, in the shape Petrina uses, or undefined when what was saved is not one. */
function addedRole(raw: unknown): Role | undefined {
  const role = raw as Partial<Role> | undefined;
  if (!role || typeof role.id !== "string" || !/^added-[a-z0-9-]{1,40}$/.test(role.id)) return undefined;
  if (typeof role.name !== "string" || typeof role.purpose !== "string" || typeof role.instructions !== "string" || typeof role.handsBack !== "string") return undefined;
  if (typeof role.result !== "string" || !isRoleResult(role.result)) return undefined;
  const maintenance = role.category === "maintenance";
  const spec = ROLE_RESULT_CATALOG[role.result];
  if (!(maintenance ? spec.userAddable.maintenance : spec.userAddable.workflow)) return undefined;
  const canEdit = maintenance ? spec.defaultCanEdit : !spec.permissionLock && role.canEdit === true;
  return {
    id: role.id,
    category: maintenance ? "maintenance" : "workflow",
    name: line(role.name),
    icon: ROLE_ICON_CHOICES.includes(role.icon as RoleIcon) ? (role.icon as RoleIcon) : "lightbulb",
    tone: TONE_CHOICES.includes(role.tone as Tone) ? (role.tone as Tone) : "slate",
    purpose: line(role.purpose),
    instructions: block(role.instructions),
    canEdit,
    sees: spec.addedSees ?? ROLE_RESULT_CATALOG.notes.addedSees!,
    handsBack: line(role.handsBack),
    result: role.result,
    column: addedColumn(role.result, canEdit),
    added: true,
    ...(role.awayFromBuilder ? { awayFromBuilder: true } : {}),
    ...(role.fullReview ? { fullReview: true } : {}),
    ...(role.removed ? { removed: true } : {}),
  };
}

/** Every role: the built-in ones with the coordinator's changes, then the ones they added (removed ones included, marked). */
export function libraryRoles(changes: RoleChanges | undefined): Role[] {
  const edits = changes?.edits ?? {};
  const builtIn = [...BUILT_IN_ROLES, ...MAINTENANCE_ROLES].map((role): Role => {
    const edit = editOf(role, Object.hasOwn(edits, role.id) ? edits[role.id] : undefined);
    return Object.keys(edit).length ? { ...role, ...edit, edited: true } : { ...role };
  });
  const seen = new Set(builtIn.map((role) => role.id));
  const added: Role[] = [];
  for (const raw of changes?.added ?? []) {
    const role = addedRole(raw);
    if (role && !seen.has(role.id)) {
      seen.add(role.id);
      added.push(role);
    }
  }
  return [...builtIn, ...added];
}

/** The roles the Library shows and the planner can use: everything but removed ones. */
export function activeRoles(roles: readonly Role[]): Role[] {
  return roles.filter((role) => !role.removed);
}

export function draftOf(role: Role): RoleDraft {
  return {
    category: role.category ?? "workflow",
    name: role.name,
    icon: role.icon,
    tone: role.tone,
    purpose: role.purpose,
    instructions: role.instructions,
    canEdit: role.canEdit,
    handsBack: role.handsBack,
    result: role.result
  };
}

/** What is wrong with a draft, field by field, in plain words. Empty when it can be saved. */
export function roleProblems(draft: RoleDraft, roles: readonly Role[], editing?: Role): Partial<Record<RoleField, string>> {
  const problems: Partial<Record<RoleField, string>> = {};
  if (!editing || editing.added) {
    const name = line(draft.name);
    const taken = roles.find((other) => other.id !== editing?.id && !other.removed && sameName(other.name, name));
    if (!name) problems.name = "Give the role a name.";
    else if (name.length > ROLE_LIMITS.name) problems.name = `Keep the name to ${ROLE_LIMITS.name} characters. It has ${name.length}.`;
    else if (taken) problems.name = `There is already a role called “${taken.name}”. Pick another name.`;
  }
  const purpose = line(draft.purpose);
  if (!purpose) problems.purpose = "Say what the role is for. The planner reads it to decide when to bring the role in.";
  else if (purpose.length > ROLE_LIMITS.purpose) problems.purpose = `Keep this to ${ROLE_LIMITS.purpose} characters. It has ${purpose.length}.`;
  const instructions = block(draft.instructions);
  if (instructions.length > ROLE_LIMITS.instructions) problems.instructions = `Keep this to ${ROLE_LIMITS.instructions.toLocaleString("en-US")} characters. It has ${instructions.length.toLocaleString("en-US")}.`;
  const handsBack = line(draft.handsBack);
  if (handsBack.length > ROLE_LIMITS.handsBack) problems.handsBack = `Keep this to ${ROLE_LIMITS.handsBack} characters. It has ${handsBack.length}.`;
  return problems;
}

function check(draft: RoleDraft, roles: readonly Role[], editing?: Role): void {
  const problems = roleProblems(draft, roles, editing);
  const first = problems.name ?? problems.purpose ?? problems.instructions ?? problems.handsBack;
  if (first) throw new Error(first);
}

function findRole(roles: readonly Role[], roleId: Id): Role {
  const role = roles.find((entry) => entry.id === roleId);
  if (!role || role.removed) throw new Error("That role is not in the Library.");
  return role;
}

/** Save the coordinator's changes to a role. Throws a plain message for anything the squad does not allow. */
export function editRole(changes: RoleChanges, roleId: Id, draft: RoleDraft): RoleChanges {
  const roles = libraryRoles(changes);
  const role = findRole(roles, roleId);
  if (role.result === "delivery") throw new Error(permissionLock(role)!);
  if ((draft.category ?? "workflow") !== (role.category ?? "workflow")) throw new Error("A role keeps its Workflow or Maintenance category.");
  if (draft.result !== role.result) throw new Error("A role keeps the kind of result it hands back. To hand back something else, add a new role.");
  const lock = permissionLock(role);
  if (lock && draft.canEdit !== role.canEdit) throw new Error(lock);
  if (!role.added && (line(draft.name) !== role.name || draft.icon !== role.icon || draft.tone !== role.tone)) throw new Error("Built-in roles keep their name, icon and colour, because Petrina depends on them.");
  if (role.added && (!ROLE_ICON_CHOICES.includes(draft.icon) || !TONE_CHOICES.includes(draft.tone))) throw new Error("Pick one of the icons and colours shown.");
  check(draft, roles, role);
  if (role.added) {
    const next = addedRole({ ...role, ...clean(draft) })!;
    return { ...changes, added: changes.added.map((entry) => (entry.id === role.id ? next : entry)) };
  }
  const edit = editOf(defaultOf(role.id)!, clean(draft));
  const edits = { ...changes.edits };
  if (Object.keys(edit).length) edits[role.id] = edit;
  else delete edits[role.id];
  return { ...changes, edits };
}

function clean(draft: RoleDraft): RoleEdit & Pick<Role, "category" | "name" | "icon" | "tone" | "result"> {
  return {
    category: draft.category ?? "workflow",
    name: line(draft.name),
    icon: draft.icon,
    tone: draft.tone,
    purpose: line(draft.purpose),
    instructions: block(draft.instructions),
    canEdit: draft.canEdit,
    handsBack: line(draft.handsBack),
    result: draft.result
  };
}

/** An id for a role the coordinator adds: from its name, never one in use, never one a built-in role could take. */
function newRoleId(name: string, taken: readonly Role[]): Id {
  const slug =
    line(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "role";
  const used = new Set(taken.map((role) => role.id));
  let id = `added-${slug}`;
  for (let n = 2; used.has(id); n += 1) id = `added-${slug}-${n}`;
  return id;
}

/** Add a role. Its kind of result is chosen now, once. */
export function addRole(changes: RoleChanges, draft: RoleDraft): { changes: RoleChanges; roleId: Id } {
  const roles = libraryRoles(changes);
  if (roles.filter((role) => role.added && !role.removed).length >= ROLE_LIMITS.added) throw new Error(`You can add at most ${ROLE_LIMITS.added} roles. Remove one you no longer use first.`);
  const spec = ROLE_RESULT_CATALOG[draft.result];
  if (draft.category === "maintenance" && !spec.userAddable.maintenance) throw new Error("Maintenance roles hand back reports or small changes with review.");
  if (draft.category === "maintenance" && draft.canEdit !== spec.defaultCanEdit) throw new Error("The result kind decides whether a maintenance role may change the product.");
  if (draft.category !== "maintenance" && !spec.userAddable.workflow) throw new Error("A role you add hands back notes, or pass-or-fail findings.");
  if (spec.permissionLock && draft.canEdit !== spec.defaultCanEdit) throw new Error(spec.permissionLock);
  if (!ROLE_ICON_CHOICES.includes(draft.icon) || !TONE_CHOICES.includes(draft.tone)) throw new Error("Pick one of the icons and colours shown.");
  check(draft, roles);
  const roleId = newRoleId(draft.name, [...roles, ...changes.added]);
  const role = addedRole({ ...clean(draft), id: roleId })!;
  return { changes: { ...changes, added: [...changes.added, role] }, roleId };
}

/** Bring back Petrina's wording and settings for a built-in role. */
export function resetRole(changes: RoleChanges, roleId: Id): RoleChanges {
  const role = findRole(libraryRoles(changes), roleId);
  if (role.result === "delivery") throw new Error(permissionLock(role)!);
  if (role.added) throw new Error("Only built-in roles have Petrina's defaults to go back to.");
  const edits = { ...changes.edits };
  delete edits[roleId];
  return { ...changes, edits };
}

/**
 * Remove a role the coordinator added. It leaves the Library and the planner's list. Tasks that use it
 * (`inUse`) keep finding it, so planned ones still run it and past ones still show its name and icon.
 */
export function removeRole(changes: RoleChanges, roleId: Id, inUse: boolean): RoleChanges {
  const role = findRole(libraryRoles(changes), roleId);
  if (!role.added) throw new Error("Built-in roles can't be removed. You can reset one to Petrina's wording instead.");
  return {
    ...changes,
    added: inUse ? changes.added.map((entry) => (entry.id === roleId ? {
    ...entry,
    removed: true
  } : entry)) : changes.added.filter((entry) => entry.id !== roleId)
  };
}

/** Starting points for a new role. */
export const ROLE_STARTS: readonly { id: "blank" | "security" | "copywriter"; label: string; draft: RoleDraft }[] = [
  {
    id: "blank",
    label: "Start from blank",
    draft: { name: "", icon: "lightbulb", tone: "blue", purpose: "", instructions: "", canEdit: false, handsBack: "", result: "notes" },
  },
  {
    id: "security",
    label: "Security reviewer",
    draft: {
      name: "Security specialist",
      icon: "shield",
      tone: "slate",
      purpose: "Looks for security problems in the change before it ships. Pass or fail, never a score.",
      instructions: `Look for security problems the change brings in: secrets or keys written into the product, unsafe handling of what people type or upload, missing checks on who may see or change what, and risky new packages. Read Petrina's check results; run a focused test only to prove a finding.
Each finding is pass or fail with where it is and the evidence; never give a score. Mark a finding blocking only if the change should not ship with it.`,
      canEdit: false,
      handsBack: "Security findings, each pass or fail with where it is and the evidence.",
      result: "findings",
    },
  },
  {
    id: "copywriter",
    label: "Copywriter",
    draft: {
      name: "Copywriter",
      icon: "pen",
      tone: "pink",
      purpose: "Writes the words people see: labels, messages, emails and help text, clear and in the product's voice.",
      instructions: `Read the design brief and the parts of the product this task touches. Write the words people will see for this change: short, clear, friendly, and consistent with the rest of the product.
Point out any wording that is unclear or says different things in different places.`,
      canEdit: false,
      handsBack: "The words to use, screen by screen, and anything unclear.",
      result: "notes",
    },
  },
];

/** The role of the reviewer at `position` in a review chain. */
export function reviewerAt(stage: Pick<Stage, "roleId" | "roleIds">, position: number): Id {
  return stage.roleIds?.[position] ?? stage.roleId;
}

/** The final review: the last review chain in the plan. No planned role changes anything after it. */
export function finalReviewIndex(stages: readonly Stage[]): number {
  for (let index = stages.length - 1; index >= 0; index -= 1) if (stages[index]!.kind === "review-chain") return index;
  return -1;
}

/**
 * What a step may change: its role's permission, except that a step after the final review runs
 * read-only (`afterReview`), because no planned role changes anything after it.
 */
export function stepMayChange(role: Role, stages: readonly Stage[], index: number): { canEdit: boolean; afterReview: boolean } {
  if (role.result === "delivery") return { canEdit: false, afterReview: false };
  const review = finalReviewIndex(stages);
  const afterReview = role.canEdit && review >= 0 && index > review;
  return { canEdit: role.canEdit && !afterReview, afterReview };
}

/** Whether a task's plan has a role in any of its steps. */
export function planUses(task: Pick<Task, "plan">, roleId: Id): boolean {
  return (task.plan?.stages ?? []).some((stage) => stage.roleId === roleId || stage.reviewerRoleId === roleId || (stage.roleIds ?? []).includes(roleId));
}

/** Ordinary planning and task role pickers never include maintenance. */
export function workflowRoles(roles: readonly Role[]): Role[] { return activeRoles(roles).filter(role => role.category !== "maintenance"); }

/** Execution uses the role wording frozen when a routine queued its task. */
export function roleForTask<R extends Pick<Role, "id">>(roles: readonly R[], id: Id, task?: Pick<Task, "maintenance">): R | Role | undefined {
  return task?.maintenance?.role.id === id ? task.maintenance.role : roles.find(role => role.id === id);
}
