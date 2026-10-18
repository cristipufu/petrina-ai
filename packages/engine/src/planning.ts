// The planner's turn, and turning its answer into a plan Petrina can run: only roles the planner was told
// about, always a builder and a review, a security review for high risk, and the delivery stages.

import { endAgentStep, JOURNEY_WORDS as W, type DeepMutable, type Task } from "@petrina/core";
import type { z } from "zod";
import { PlanResult } from "./roles.js";
import { Kernel, type MTask, PLANNER_PROFILE, RISK_WORD, RELEASE_MANAGER_PROFILE } from "./kernel.js";
import { normalizePlan } from "./plan.js";
import type { Turns } from "./turn.js";

export class Planning {
  constructor(private readonly k: Kernel, private readonly turns: Turns) {}

  async runPlanner(task: MTask, signal: AbortSignal): Promise<void> {
    const planner = this.k.onUsable(PLANNER_PROFILE);
    const result = await this.turns.turn(task, "planner", planner, () => [], PlanResult, signal);
    // Unrated work is treated as medium: never shipped unasked, never short of reviewers.
    task.risk = result.risk ?? { level: "medium", why: "The planner did not rate it." };
    task.plan = this.normalizePlan(task, result, planner);
    const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
    this.k.log(task, "milestone", `Plan ready: ${count} stages. ${result.rationale}`, "planner", planner);
    this.k.log(task, "milestone", `${RISK_WORD[task.risk.level]} risk: ${task.risk.why}`, "planner", planner);
    endAgentStep(task, { outcome: W.planned(count), reason: W.planReady }, Date.now());
    this.k.finishStep(task);
    this.k.tracking.endStage(task, "done");
    this.k.commit();
  }

  private normalizePlan(task: MTask, result: z.infer<typeof PlanResult>, planner: string): DeepMutable<NonNullable<Task["plan"]>> {
    return normalizePlan({ task, result, roles: this.k.s.roles, profiles: this.k.s.profiles, plannerProfileId: planner, releaseManagerProfileId: RELEASE_MANAGER_PROFILE, onUsable: (id) => this.k.onUsable(id) }) as DeepMutable<NonNullable<Task["plan"]>>;
  }
}
