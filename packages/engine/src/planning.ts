// The planner's turn, delegating portable stage normalization and hint validation to @petrina/orchestrator.

import type { DeepMutable, Task } from "@petrina/core";
import { PlanningWorkflow } from "@petrina/orchestrator";
import { RepoOrientation } from "@petrina/repositories/navigation";
import type { z } from "zod";
import { Kernel, PLANNER_PROFILE, RELEASE_MANAGER_PROFILE, RISK_WORD, type RuntimeTask } from "./kernel.js";
import { PlanResult } from "./roles.js";
import type { Sources } from "./sources.js";
import type { Turns } from "./turn.js";

export class Planning {
  private readonly orientation = new RepoOrientation();
  private readonly workflow: PlanningWorkflow;

  constructor(k: Kernel, turns: Turns, sources: Sources) {
    this.workflow = new PlanningWorkflow(
      {
        plannerProfileId: PLANNER_PROFILE,
        releaseManagerProfileId: RELEASE_MANAGER_PROFILE,
        riskWord: RISK_WORD,
        now: () => Date.now(),
        products: () => k.s.products,
        roles: () => k.s.roles,
        profiles: () => k.s.profiles,
        onUsable: (id) => k.onUsable(id),
        note: (task, tone, text, roleId, profileId) => k.log(task, tone, text, roleId, profileId),
        finishStep: (task) => k.finishStep(task),
        endStage: (task) => k.tracking.endStage(task, "done"),
        changed: () => k.commit(),
      },
      {
        readOrientation: async (products) => {
          const read = await Promise.all(products.map((product) => this.orientation.read(product)));
          return read.filter((section) => section !== undefined);
        },
        runTurn: (scope, request, signal) => {
          const plannerRoleId = k.s.roles.find((role) => !role.removed && role.result === "plan")?.id ?? "planner";
          return turns.turn(
            scope,
            plannerRoleId,
            request.plannerProfileId,
            request.sections,
            PlanResult,
            signal,
            {
              requestedProfileId: request.requestedProfileId,
              ...(request.selectionReason ? { selectionReason: request.selectionReason } : {}),
              used: request.used,
            },
          );
        },
        proposeSources: (task, worksOn) => sources.propose(task, worksOn ? [...worksOn] : undefined),
      },
    );
  }

  runPlanner(task: RuntimeTask, signal: AbortSignal): Promise<void> {
    return this.workflow.runPlanner(task, signal);
  }

  normalizePlan(
    task: RuntimeTask,
    result: z.infer<typeof PlanResult>,
    planner: string,
  ): DeepMutable<NonNullable<Task["plan"]>> {
    return this.workflow.normalizePlan(task, result, planner);
  }
}
