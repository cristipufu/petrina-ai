import { type EngineCaseOwner } from "./engine-cases.js";
import { type EngineOptions } from "../engine.js";
/** Real schema/recording/restart composition. The caller owns this private root and engine lifetime. */
export async function reviewRecords(owner: EngineCaseOwner, root: string, options: Pick<EngineOptions, "toolProbe"> = {}, shared = true) {
  const start = () => owner.open(root, options);
  const engine = start(); engine.setPoolPaused(true);
  try {
    await engine.waitUntilReady();
    const first = "first", second = "second";
    engine.s.products.push(...[first, second].map(id => ({ id, name: id, repo: `acme/${id}`, tone: "blue" as const })));
    const task = engine.task(engine.addTask({ productId: first, title: "Keep the shared task records", backlog: true }))!;
    if (shared) task.repositories = [first, second].map(productId => ({ productId, delivery: "pull-request", completedStages: [] }));
    else task.repository = { productId: first, delivery: "pull-request" };
    const stage = { id: "review", kind: "review-chain" as const, title: "Review both products", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };
    task.plan = { rationale: "Only review recording is under test", plannerProfileId: "sonnet-medium", stages: [stage] };
    task.stageIndex = 0;
    return { engine, start, first, second, task, stage };
  } catch (error) { await owner.stop(engine); throw error; }
}
