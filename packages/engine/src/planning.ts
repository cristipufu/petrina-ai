import { executionFor } from "./repository-context.js";
// The planner's turn, and turning its answer into a plan Petrina can run: only roles the planner was told
// about, always a builder and a review, a security review for high risk, and the delivery stages.

import { endAgentStep, JOURNEY_WORDS as W, type DeepMutable, type Task } from "@petrina/core";
import type { z } from "zod";
import { PlanResult } from "./roles.js";
import { Kernel, type MTask, PLANNER_PROFILE, RISK_WORD, RELEASE_MANAGER_PROFILE } from "./kernel.js";
import { normalizePlan } from "./plan.js";
import type { Sources } from "./sources.js";
import type { Turns } from "./turn.js";
import { RepoOrientation } from "./repo-orientation.js";

export class Planning {
  private readonly orientation = new RepoOrientation();
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly sources: Sources) {}

  async runPlanner(task: MTask, signal: AbortSignal): Promise<void> {
    const scope = executionFor(task);
    const planner = this.k.onUsable(PLANNER_PROFILE);
    let by = planner;
    const selected = new Set((task.selectedProducts ?? [task.workChoice]).flatMap((choice) => choice ? [choice.productId] : []));
    const navigation = (await Promise.all(this.k.s.products.filter((product) => selected.has(product.id)).slice(0, 4).map((product) => this.orientation.read(product)))).filter((section) => section !== undefined);
    signal.throwIfAborted();
    const result = await this.turns.turn(scope, "planner", planner, () => [{ title: "Registered products and starting choices", body: `Registered products (use registered ids; propose unregistered repositories explicitly with repo):\n${this.k.s.products.map((product) => JSON.stringify({ id: product.id, name: product.name, repo: product.repo, defaultBranch: product.defaultBranch ?? "main", existingLocalCopy: product.path })).join("\n")}\nCurrent coordinator choices: ${JSON.stringify(task.selectedProducts ?? [task.workChoice])}. The selected product and delivery mode are authoritative. ${task.explicitStart ? "The starting point was explicitly chosen too." : "You may propose a starting point from the task words."} Changes require the coordinator’s confirmation. Return worksOn as the complete ordered product list. Retain every coordinator-selected product. For each entry give a reason and builderProfileId, and propose the leadProductId for shared repairs. You may search GitHub, including private dependencies, with the coordinator’s login. Never guess an engine action from task wording. Each structured choice has: productId, startFrom ({kind: default}, {kind: branch, name}, or {kind: pull-request, value: number or link as text}), delivery (pull-request, local, release). Unknown products must be named honestly; never substitute another product. Never fetch, clone, create a worktree or change existing local work.` }, ...navigation], PlanResult, signal, { used: (id) => (by = id) });
    // Unrated work is treated as medium: never shipped unasked, never short of reviewers.
    task.risk = result.risk ?? { level: "medium", why: "The planner did not rate it." };
    if (result.sourcePointers?.length) task.sourcePointers = result.sourcePointers;
    else delete task.sourcePointers;
    await this.sources.propose(task, result.worksOn);
    task.plan = this.normalizePlan(task, result, by);
    const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
    this.k.log(task, "milestone", `Plan ready: ${count} stages. ${result.rationale}`, "planner", by);
    this.k.log(task, "milestone", `${RISK_WORD[task.risk.level]} risk: ${task.risk.why}`, "planner", by);
    endAgentStep(task, { outcome: W.planned(count), reason: W.planReady }, Date.now());
    this.k.finishStep(task);
    this.k.tracking.endStage(task, "done");
    this.k.commit();
  }

  private normalizePlan(task: MTask, result: z.infer<typeof PlanResult>, planner: string): DeepMutable<NonNullable<Task["plan"]>> {
    const scope = executionFor(task);
    return normalizePlan({ task: { ...task, ...(task.workRows ? { approveDelivery: true } : {}), source: task.proposedSource ?? scope.work.source, delivery: task.proposedSource?.destination.mode ?? task.delivery }, result: { ...result, ...(task.workRows ? { worksOn: task.workRows.map((row) => row.choice) } : {}) }, roles: this.k.s.roles, profiles: this.k.s.profiles, plannerProfileId: planner, releaseManagerProfileId: RELEASE_MANAGER_PROFILE, onUsable: (id) => this.k.onUsable(id) }) as DeepMutable<NonNullable<Task["plan"]>>;
  }
}
