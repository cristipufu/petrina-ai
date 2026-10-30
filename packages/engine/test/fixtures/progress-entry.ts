import { normalizePlan, type DeepMutable, type PlanDraft } from "@petrina/core";
import type { Engine } from "../engine.js";
import type { EngineCaseOwner } from "./engine-cases.js";
import { localFixtureSource } from "./prepared-runtime.js";
import type { ProductRepository } from "@petrina/test-support/repositories";

/** The first live participant is the Builder; no earlier participant or check execution is claimed. */
export async function prepareProgressEntry(owner: EngineCaseOwner, engine: Engine, id: string, parallel: boolean, builderProfile: "sol-high" | "sol-xhigh", initial: ProductRepository) {
  return owner.run(engine, async () => {
    owner.check();
    const task = engine.task(id)!;
    if (task.state !== "backlog" || task.plan || task.journey?.length)
      throw new Error("Progress input must be supplied before its first workflow step");
    await localFixtureSource(engine, task, { initial, check: () => owner.check() });
    owner.check();
    const draft: PlanDraft = { rationale: "Observe the actual participants' live progress", stages: [
      { kind: "do", title: "Build", roleId: "builder", profileIds: [builderProfile] },
      { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: parallel ? ["opus-high", "sol-high"] : ["opus-high"], maxRounds: 1 },
    ] };
    const plan = normalizePlan({ task, result: draft, roles: engine.s.roles, profiles: engine.s.profiles,
      plannerProfileId: "opus-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) });
    task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
    task.risk = { level: "medium", why: "Declared progress fixture input" };
    task.approvePlan = false;
    task.stageIndex = 0;
    task.sub = 0;
    const product = engine.s.products.find(product => product.id === task.productId)!;
    product.checks = [];
    product.checksBy = "coordinator";
    engine.commitNow(task);
  });
}
