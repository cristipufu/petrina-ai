import { createTaskState, normalizePlan, type DeepMutable, type NewTaskInput, type Plan, type Product, type WorkChoice } from "@petrina/core";
import { executionFor, restoreRepositoryState } from "../../src/repository-context.js";
import { admissionFixture } from "./agent-workflow.js";
import { sourceFixture } from "./sources.js";

/** Source proposal and stage admission are real controllers; no repository or publication is supplied. */
export function sourcePlanAdmission(input: NewTaskInput, proposal?: readonly WorkChoice[]) {
  const scheduler = admissionFixture(2, 2, 0), source = sourceFixture();
  source.scripts.validBranch = async name => name === "main" || name === "trunk";
  source.scripts.requireBranch = async (repo, branch) => {
    if (!source.products.some(product => product.repo === repo && product.defaultBranch === branch))
      throw new Error(`Unexpected source branch: ${repo}:${branch}`);
  };
  scheduler.state.products = structuredClone(source.products) as DeepMutable<Product[]>;
  const task = createTaskState(input, source.products, { id: "source-plan", timelineId: "created", now: scheduler.clock.now(), priority: 0 });
  restoreRepositoryState(task);
  task.state = "waiting"; task.startedAt = scheduler.clock.now();
  scheduler.state.tasks.push(task);
  const gates: string[] = [], stages: string[] = [], preparation: (string | undefined)[] = [];
  scheduler.host.schedule = () => {};
  scheduler.host.gate = (current, kind) => { gates.push(kind); current.state = "needs-you"; };
  scheduler.phases.prepareWorkspace = async (current, stage) => {
    preparation.push(stage?.id);
    return { kind: "ready", scope: executionFor(current) };
  };
  scheduler.phases.planner = async current => {
    await source.selections.propose(current, proposal);
    const scope = executionFor(current);
    current.plan = structuredClone(normalizePlan({
      task: { ...current, source: current.proposedSource ?? scope.work.source },
      result: { rationale: "An explicit supplied planner response", stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
      ] },
      roles: scheduler.state.roles, profiles: scheduler.state.profiles,
      plannerProfileId: "sol-high", releaseManagerProfileId: "sol-high",
    })) as DeepMutable<Plan>;
  };
  scheduler.phases.doStage = async (_scope, stage) => { stages.push(stage.roleId); return "stop"; };
  return { task, source, gates, stages, preparation, scheduler,
    async drive() {
      scheduler.state.pool.paused = false;
      scheduler.workflow.startDriver(task.id);
      const operation = scheduler.ownership.settling.get(task.id);
      if (!operation) throw new Error("No owned source-plan driver");
      await operation;
      if (scheduler.failures.length) throw scheduler.failures.at(-1);
    },
    close: () => scheduler.close(),
  };
}
