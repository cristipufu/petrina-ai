// The planner's plan, made safe to run. Each role goes only where it can work, Petrina adds the
// delivery last itself, the final review always has a code reviewer, and every step that may change
// the product comes before the final review: after it, no planned role changes anything. Whatever
// Petrina changes, the plan's reason says so, so the task never gets stuck on a misplaced role.

import { activeRoles, deliveryStages, finalReviewIndex, RELEASE_MANAGER, stepOf, type AgentProfile, type Id, type Plan, type Role, type Stage, type Task } from "@petrina/core";
import type { z } from "zod";
import type { PlanResult } from "./roles.js";

const CODE_REVIEWER = "code-reviewer";
const DESIGN_REVIEWER = "design-reviewer";
const BUILDER = "builder";

export interface PlanInput {
  task: Pick<Task, "id" | "delivery" | "approveDelivery">;
  result: z.infer<typeof PlanResult>;
  /** Every role; removed ones are left out like unknown ones. */
  roles: readonly Role[];
  profiles: readonly AgentProfile[];
  plannerProfileId: Id;
  releaseManagerProfileId: Id;
  /** First run's tool checks decide which tool can run each planned profile. */
  onUsable?: (profileId: Id) => Id;
}

type Reviewer = { roleId: Id; profileId: Id };

export function normalizePlan(input: PlanInput): Plan {
  const { task, result } = input;
  const onUsable = input.onUsable ?? ((id: Id) => id);
  const roles = new Map(activeRoles(input.roles).filter((role) => !role.internal).map((role) => [role.id, role]));
  /** Every role, removed ones included, to name what Petrina left out. */
  const all = new Map(input.roles.map((role) => [role.id, role]));
  const profile = (id: string | undefined, fallback: Id) => (id && input.profiles.some((entry) => entry.id === id) ? id : fallback);
  const changes: string[] = [];
  const say = (text: string) => {
    if (!changes.includes(text)) changes.push(text);
  };
  const deliveryLeftOut = () => say("Petrina handles delivery itself, so it left the Release Manager out of the planned steps.");
  /** Why a role the plan names can't run: removed, unknown, or a role Petrina brings in itself. */
  const cannotRun = (roleId: Id) => {
    const named = all.get(roleId);
    if (!named) return "the plan named a role Petrina doesn't have";
    if (named.removed) return `the ${named.name} was removed from the Library`;
    return named.id === "planner" ? "the Planner only makes the plan" : `Petrina brings in the ${named.name} itself when it is needed`;
  };
  /** A step whose role can't run. Delivery is already accounted for. */
  const leftOut = (roleId: Id, title: string) => {
    if (roleId !== RELEASE_MANAGER) say(`Petrina left out “${title}”: ${cannotRun(roleId)}.`);
  };
  const stages: Stage[] = [];
  /** Reviewers that join the final review, wherever the planner put them. */
  const joining: Reviewer[] = [];

  /** A role on its own, outside the step kind the planner gave it: placed where it can work, or left out. */
  const alone = (role: Role, id: Id, title: string, profileId: string | undefined, why: string) => {
    switch (stepOf(role)) {
      case "do":
        stages.push({ id, kind: "do", title, roleId: role.id, profileIds: [profile(profileId, "opus-xhigh")] });
        say(`Petrina gave the ${role.name} a step of its own: ${why}.`);
        return;
      case "review":
        joining.push({ roleId: role.id, profileId: profile(profileId, "sol-xhigh") });
        say(`Petrina moved the ${role.name} into the final review, next to the code reviewers: it hands back pass-or-fail findings.`);
        return;
      case "design":
        stages.push({ id, kind: "converge", title, roleId: role.id, profileIds: [profile(profileId, "opus-xhigh")], reviewerRoleId: DESIGN_REVIEWER, reviewerProfileIds: ["sol-xhigh"], maxRounds: 3 });
        say(`Petrina paired the ${role.name} with the Design reviewer: a design needs both.`);
        return;
      default:
        say(`Petrina left out a step for the ${role.name}: it only works in a design, next to the Architect.`);
    }
  };

  result.stages.forEach((raw, index) => {
    const id = `${task.id}:s${index}`;
    const role = raw.roleId === RELEASE_MANAGER || raw.roleId === "planner" ? undefined : roles.get(raw.roleId);
    if (raw.roleId === RELEASE_MANAGER || raw.reviewerRoleId === RELEASE_MANAGER || raw.roleIds?.includes(RELEASE_MANAGER)) deliveryLeftOut();

    if (raw.kind === "gate") {
      if (role) stages.push({ id, kind: "gate", title: raw.title, roleId: raw.roleId, profileIds: [], gate: raw.gate === "plan" ? "plan" : "design" });
      else leftOut(raw.roleId, raw.title);
      return;
    }

    if (raw.kind === "review-chain") {
      const reviewers: Reviewer[] = [];
      const profiles = raw.profileIds.length ? raw.profileIds : ["sol-xhigh", "opus-xhigh"];
      /** Roles in this review given a step of their own before it, each once. */
      const ownSteps = new Set<Id>();
      /**
       * A role in the review that is not a reviewer. One that hands back notes or checks gets a step of its
       * own before the review. Any other is not used there, and a code reviewer takes its place when
       * `replace` is set. Either way the plan's reason says so. Says whether a code reviewer takes its place.
       */
      const notReviewer = (roleId: Id, at: Id, profileId: string | undefined, replace: boolean): boolean => {
        const other = roles.get(roleId);
        if (other && other.result !== "build" && stepOf(other) === "do") {
          if (!ownSteps.has(other.id)) {
            ownSteps.add(other.id);
            alone(other, at, other.name, profileId, `${other.result === "checks" ? "it checks the acceptance list, not the change" : "it hands back notes, not pass-or-fail findings"}, so it works before the review`);
          }
          return false;
        }
        const gone = other ? undefined : all.get(roleId);
        if (replace) {
          if (other) say(`Petrina put a Code reviewer in the review where the plan had the ${other.name}.`);
          else if (gone && !gone.removed) say(`Petrina put a Code reviewer in the review instead of the ${gone.name}: ${cannotRun(roleId)}.`);
          else say(gone ? `Petrina put a Code reviewer in the review instead of the ${gone.name}, which was removed from the Library.` : "Petrina put a Code reviewer in the review where the plan named a role Petrina doesn't have.");
        } else if (other) say(`Petrina didn't use the ${other.name} in “${raw.title}”: it doesn't review changes, and the plan named every reviewer there.`);
        else if (gone && !gone.removed) say(`Petrina didn't use the ${gone.name} in “${raw.title}”: ${cannotRun(roleId)}.`);
        else say(gone ? `Petrina didn't use the ${gone.name} in “${raw.title}”: it was removed from the Library.` : `Petrina left a role it doesn't have out of “${raw.title}”.`);
        return replace;
      };
      // The review's own role stands in for every reviewer the plan does not name. When it does not
      // review, code reviewers do, and the plan's reason says what became of it, even when the plan
      // named every reviewer and nobody needs to stand in.
      const standIn = role && stepOf(role) === "review" ? role.id : CODE_REVIEWER;
      const unnamed = profiles.some((_, position) => raw.roleIds?.[position] === undefined);
      if (standIn !== raw.roleId && raw.roleId !== RELEASE_MANAGER) notReviewer(raw.roleId, `${id}-own`, profiles[0], unnamed);
      if (role && stepOf(role) === "review" && !unnamed && !raw.roleIds?.includes(role.id)) {
        say(`Petrina didn't use the ${role.name} in “${raw.title}”: the plan named every reviewer there.`);
      }
      profiles.forEach((profileId, position) => {
        const wanted = raw.roleIds?.[position] ?? standIn;
        if (wanted === RELEASE_MANAGER) return;
        const reviewer = roles.get(wanted);
        if (reviewer && stepOf(reviewer) === "review") reviewers.push({ roleId: reviewer.id, profileId: profile(profileId, "sol-xhigh") });
        else if (notReviewer(wanted, `${id}-${position}`, profileId, true)) reviewers.push({ roleId: CODE_REVIEWER, profileId: profile(profileId, "sol-xhigh") });
      });
      // A role named beyond the chosen profiles has nobody to run it. Notes still get their own step;
      // every other unused place is named in the reason, rather than silently disappearing.
      raw.roleIds?.slice(profiles.length).forEach((roleId, index) => {
        if (roleId === RELEASE_MANAGER) return;
        const extra = roles.get(roleId);
        const named = all.get(roleId);
        if (named?.internal && !named.removed) say(`Petrina left the ${named.name} out of “${raw.title}”: ${cannotRun(roleId)}.`);
        else if (extra && stepOf(extra) !== "review") notReviewer(roleId, `${id}-extra-${index}`, undefined, false);
        else {
          const name = all.get(roleId)?.name;
          say(name
            ? `Petrina left an extra place for the ${name} out of “${raw.title}”: the plan didn't say who would run it.`
            : `Petrina left a role it doesn't have out of “${raw.title}”.`);
        }
      });
      if (reviewers.length) stages.push(reviewChain(id, raw.title, reviewers, raw.maxRounds ?? 2));
      return;
    }

    if (!role) {
      leftOut(raw.roleId, raw.title);
      return;
    }

    if (raw.kind === "converge") {
      if (stepOf(role) !== "design") {
        alone(role, id, raw.title, raw.profileIds[0], `only the Architect writes a design`);
        return;
      }
      const reviewer = raw.reviewerRoleId ? roles.get(raw.reviewerRoleId) : undefined;
      const named = raw.reviewerRoleId && raw.reviewerRoleId !== RELEASE_MANAGER ? all.get(raw.reviewerRoleId) : undefined;
      if (named && !(reviewer && stepOf(reviewer) === "design-review")) say(`Petrina put the Design reviewer in the design pair instead of the ${named.name}.`);
      stages.push({
        id,
        kind: "converge",
        title: raw.title,
        roleId: role.id,
        profileIds: [profile(raw.profileIds[0], "opus-xhigh")],
        reviewerRoleId: reviewer && stepOf(reviewer) === "design-review" ? reviewer.id : DESIGN_REVIEWER,
        reviewerProfileIds: [profile(raw.reviewerProfileIds?.[0], "sol-xhigh")],
        maxRounds: raw.maxRounds ?? 3,
      });
      return;
    }

    if (stepOf(role) === "do") stages.push({ id, kind: "do", title: raw.title, roleId: role.id, profileIds: [profile(raw.profileIds[0], "opus-xhigh")] });
    else alone(role, id, raw.title, raw.profileIds[0], "");
  });

  // Reviews right after one another, with a reviewer the coordinator added, are one review.
  for (let index = stages.length - 1; index > 0; index -= 1) {
    const [first, second] = [stages[index - 1]!, stages[index]!];
    if (first.kind !== "review-chain" || second.kind !== "review-chain") continue;
    const reviewers = [...reviewersOf(first), ...reviewersOf(second)];
    if (reviewers.every((reviewer) => reviewer.roleId === CODE_REVIEWER)) continue;
    stages.splice(index - 1, 2, reviewChain(first.id, first.title, reviewers, Math.max(first.maxRounds ?? 2, second.maxRounds ?? 2)));
    say("Petrina joined the reviews that came one after another into one review.");
  }

  if (!stages.some((stage) => stage.roleId === BUILDER)) {
    const at = stages.findIndex((stage) => stage.kind === "review-chain");
    const builder: Stage = { id: `${task.id}:build`, kind: "do", title: "Build", roleId: BUILDER, profileIds: ["opus-xhigh"] };
    if (at >= 0) stages.splice(at, 0, builder);
    else stages.push(builder);
  }
  if (!stages.some((stage) => stage.kind === "review-chain")) stages.push(reviewChain(`${task.id}:review`, "Review", [], 2));

  // The final review: reviewers moved there join it, and it always has a code reviewer.
  const final = finalReviewIndex(stages);
  const review = stages[final]!;
  let reviewers = [...reviewersOf(review), ...joining];
  if (!reviewers.some((reviewer) => reviewer.roleId === CODE_REVIEWER)) {
    reviewers = [{ roleId: CODE_REVIEWER, profileId: "sol-xhigh" }, ...reviewers];
    say("Petrina added a Code reviewer to the final review, so a code reviewer always checks the change.");
  }
  stages[final] = reviewChain(review.id, review.title, reviewers, review.maxRounds ?? 2);

  // Steps that may change the product come before the final review, in the order the planner gave them.
  const later = stages.slice(final + 1);
  const moving = later.filter((stage) => stage.kind !== "gate" && roles.get(stage.roleId)?.canEdit);
  if (moving.length) {
    const staying = later.filter((stage) => !moving.includes(stage));
    stages.splice(final, stages.length - final, ...moving, stages[final]!, ...staying);
    for (const stage of moving) say(`Petrina moved “${stage.title}” before the final review: the ${roles.get(stage.roleId)!.name} changes the product, and every planned step that changes the product must run before it.`);
  }

  if (result.risk?.level === "high") {
    const builderTool = input.profiles.find((entry) => entry.id === onUsable(stages.find((stage) => stage.roleId === BUILDER)!.profileIds[0]!))?.toolId;
    const other = input.profiles.filter((entry) => entry.toolId !== builderTool && !entry.standby && onUsable(entry.id) === entry.id);
    const reviewer = onUsable((other.find((entry) => entry.effort === "xhigh") ?? other[0])?.id ?? "opus-xhigh");
    stages.splice(finalReviewIndex(stages) + 1, 0, { id: `${task.id}:security`, kind: "review-chain", title: "Security review", roleId: "security-reviewer", profileIds: [reviewer], maxRounds: 2 });
  }
  stages.push(...deliveryStages(task, input.releaseManagerProfileId));
  // Apply the tool checks to every place, including added roles and the fallbacks Petrina supplied.
  const usable = stages.map((stage) => ({ ...stage, profileIds: stage.profileIds.map(onUsable), ...(stage.reviewerProfileIds ? { reviewerProfileIds: stage.reviewerProfileIds.map(onUsable) } : {}) }));
  return { stages: usable, rationale: changes.length ? `${result.rationale} ${changes.join(" ")}` : result.rationale, plannerProfileId: input.plannerProfileId };
}

function reviewersOf(stage: Stage): Reviewer[] {
  return stage.profileIds.map((profileId, position) => ({ roleId: stage.roleIds?.[position] ?? stage.roleId, profileId }));
}

/** A review chain. It lists each reviewer's role only when one is not a code reviewer. */
function reviewChain(id: Id, title: string, reviewers: readonly Reviewer[], maxRounds: number): Stage {
  const list = reviewers.length ? reviewers : [{ roleId: CODE_REVIEWER, profileId: "sol-xhigh" }, { roleId: CODE_REVIEWER, profileId: "opus-xhigh" }];
  return {
    id,
    kind: "review-chain",
    title,
    roleId: CODE_REVIEWER,
    profileIds: list.map((reviewer) => reviewer.profileId),
    ...(list.some((reviewer) => reviewer.roleId !== CODE_REVIEWER) ? { roleIds: list.map((reviewer) => reviewer.roleId) } : {}),
    maxRounds,
  };
}
