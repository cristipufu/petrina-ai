import type { DeepMutable, Task } from "@petrina/core";
import type { Engine } from "../engine.js";
import { PlanResult } from "../../src/roles.js";
import { PLANNER_PROFILE } from "../../src/kernel.js";

type BriefRecipe = { summary: string; forUsers: readonly string[]; areas: readonly string[]; acceptance: readonly string[]; risks: readonly string[] };

/** Call inside the fixture's generation owner. Only the supplied plan/design is prepared; no completed work is invented. */
export async function sourcePrepared(engine: Engine, input: Parameters<Engine["addTask"]>[0], recipe: unknown,
  start: { kind: "plan" } | { kind: "builder"; brief: BriefRecipe; beforeAdmission?: (taskId: string) => void }, available: () => void) {
  const active = () => { available(); engine.stopRequested.signal.throwIfAborted(); };
  active();
  engine.setPoolPaused(true);
  await engine.waitUntilReady(); active();
  const result = PlanResult.parse(recipe);
  const id = engine.addTask({ ...input, backlog: true }), task = engine.task(id)!;
  task.risk = result.risk ?? { level: "medium", why: "The planner did not rate it." };
  await engine["sources"].propose(task, result.worksOn); active();
  // Use the real host's normalization, including shared proposals and source-derived delivery labels.
  task.plan = engine["planning"]["normalizePlan"](task, result, engine.onUsable(PLANNER_PROFILE));
  if (start.kind === "builder") {
    engine["sources"].confirm(task);
    const build = task.plan.stages.findIndex(stage => stage.kind === "do" && engine.role(stage.roleId, task)?.result === "build");
    if (build < 0) throw new Error("The prepared source recipe has no Builder stage");
    if (task.plan.stages.slice(0, build).some(stage => stage.kind === "converge" && engine.role(stage.roleId, task)?.result === "brief")) {
      const brief = start.brief;
      task.brief = { summary: brief.summary, forUsers: [...brief.forUsers], areas: [...brief.areas],
        acceptance: brief.acceptance.map(text => ({ text })), risks: [...brief.risks] } as DeepMutable<NonNullable<Task["brief"]>>;
    }
    task.stageIndex = build;
  } else task.stageIndex = -1;
  task.startedAt = Date.now(); task.sub = 0; task.state = "waiting";
  task.column = engine.columnFor(task);
  // A supplied boundary must bind its exact task before unpausing can start the actual driver.
  if (start.kind === "builder") start.beforeAdmission?.(id);
  active(); engine.commitNow(task); engine.setPoolPaused(false);
  return id;
}
