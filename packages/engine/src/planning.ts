// The planner's turn, and turning its answer into a plan Petrina can run: only roles the planner was told
// about, always a builder and a review, a security review for high risk, and the delivery stages.

import { lastIndexWhere, type DeepMutable, deliveryStages, type Task } from "@petrina/core";
import type { z } from "zod";
import { PlanResult } from "./roles.js";
import { Kernel, type MStage, type MTask, PLANNER_PROFILE, RISK_WORD, SHIPPER_PROFILE } from "./kernel.js";
import type { Turns } from "./turn.js";

export class Planning {
  constructor(private readonly k: Kernel, private readonly turns: Turns) {}

  async runPlanner(task: MTask, signal: AbortSignal): Promise<void> {
    const result = await this.turns.turn(task, "planner", PLANNER_PROFILE, () => [], PlanResult, signal);
    // Unrated work is treated as medium: never shipped unasked, never short of reviewers.
    task.risk = result.risk ?? { level: "medium", why: "The planner did not rate it." };
    task.plan = this.normalizePlan(task, result);
    const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
    this.k.log(task, "milestone", `Plan ready: ${count} stages. ${result.rationale}`, "planner", PLANNER_PROFILE);
    this.k.log(task, "milestone", `${RISK_WORD[task.risk.level]} risk: ${task.risk.why}`, "planner", PLANNER_PROFILE);
    this.k.finishStep(task);
    this.k.commit();
  }

  private normalizePlan(task: MTask, result: z.infer<typeof PlanResult>): DeepMutable<NonNullable<Task["plan"]>> {
    // Only roles the planner was told about can be planned.
    const roles = new Set(this.k.s.roles.filter((role) => !role.internal).map((role) => role.id));
    const profile = (id: string | undefined, fallback: string) => (id && this.k.profile(id) ? id : fallback);
    const stages: MStage[] = [];
    result.stages.forEach((raw, index) => {
      if (!roles.has(raw.roleId)) return;
      const id = `${task.id}:s${index}`;
      if (raw.kind === "gate") {
        stages.push({ id, kind: "gate", title: raw.title, roleId: raw.roleId, profileIds: [], gate: raw.gate === "plan" ? "plan" : "design" });
      } else if (raw.kind === "converge") {
        stages.push({
          id,
          kind: "converge",
          title: raw.title,
          roleId: raw.roleId,
          profileIds: [profile(raw.profileIds[0], "opus-xhigh")],
          reviewerRoleId: raw.reviewerRoleId && roles.has(raw.reviewerRoleId) ? raw.reviewerRoleId : "design-reviewer",
          reviewerProfileIds: [profile(raw.reviewerProfileIds?.[0], "sol-xhigh")],
          maxRounds: raw.maxRounds ?? 3,
        });
      } else if (raw.kind === "review-chain") {
        const reviewers = raw.profileIds.map((id) => profile(id, "sol-xhigh"));
        stages.push({ id, kind: "review-chain", title: raw.title, roleId: "code-reviewer", profileIds: reviewers.length ? reviewers : ["sol-xhigh", "opus-xhigh"], maxRounds: raw.maxRounds ?? 2 });
      } else {
        stages.push({ id, kind: "do", title: raw.title, roleId: raw.roleId, profileIds: [profile(raw.profileIds[0], "opus-xhigh")] });
      }
    });
    if (!stages.some((stage) => stage.roleId === "builder")) {
      const at = stages.findIndex((stage) => stage.kind === "review-chain");
      const builder: MStage = { id: `${task.id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] };
      if (at >= 0) stages.splice(at, 0, builder);
      else stages.push(builder);
    }
    if (!stages.some((stage) => stage.kind === "review-chain")) {
      stages.push({ id: `${task.id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-xhigh", "opus-xhigh"], maxRounds: 2 });
    }
    if (task.risk?.level === "high") {
      // High-risk work gets a security review after the others, on a tool other than the builder's.
      const builderTool = this.k.profile(stages.find((stage) => stage.roleId === "builder")?.profileIds[0] ?? "")?.toolId;
      const other = this.k.s.profiles.filter((entry) => entry.toolId !== builderTool);
      const reviewer = (other.find((entry) => entry.effort === "xhigh") ?? other[0])?.id ?? "opus-xhigh";
      stages.splice(lastIndexWhere(stages, (stage) => stage.kind === "review-chain") + 1, 0, { id: `${task.id}:security`, kind: "review-chain", title: "Security review", roleId: "security-reviewer", profileIds: [reviewer], maxRounds: 2 });
    }
    stages.push(...(deliveryStages(task as unknown as Task, SHIPPER_PROFILE) as MStage[]));
    return { stages, rationale: result.rationale, plannerProfileId: PLANNER_PROFILE };
  }
}
