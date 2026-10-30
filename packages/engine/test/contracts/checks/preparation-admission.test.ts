import { engineCaseFixtures } from "../../fixtures/engine-cases.js";

import { afterAll, expect, it } from "bun:test";

import { join } from "node:path";




const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());




it("admits bounded check preparation while every model slot is occupied", async () => {
  return engineCases.use("petrina-check-separate-capacity-", async caseOwner => {
  const root = caseOwner.root;

  const engine = caseOwner.open(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null },  });
  engine.setPoolPaused(true);
  await caseOwner.run(engine, async () => { await engine.waitUntilReady(); });
  try {
    const productId = "product";
    engine.s.products.push({ id: productId, name: "Product", repo: "local/product", tone: "blue" });
    const task = engine.task(engine.addTask({ productId, title: "Prepare checks without reserving a reviewer", backlog: true }))!;
    task.plan = { rationale: "Review", plannerProfileId: "sol-high", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 }] };
    task.stageIndex = 0;
    task.rounds = { review: 1 };
    engine.s.pool.limit = 1;
    engine.s.backgroundAgents = [{ id: "occupied", roleId: "verifier", profileId: "sol-high", label: "Comparing older bugs", since: Date.now() }];
    engine.setPoolPaused(false);
    // Admission only: the driver has not started I/O or asked a reviewer anything yet.
    expect(engine["driver"].workflow["reserveAgent"](task)).toBe(true);
    expect(task.holdsSlot).toBe(false);
    expect(task.agent).toBeUndefined();
    expect(engine["checks"].preparingCount).toBe(1);
    expect(engine["checks"].claimPreparation("another-task")).toBe(false);
    engine["checks"].releasePreparation(task.id);
    expect(engine["checks"].claimPreparation("another-task")).toBe(true);
    engine["checks"].releasePreparation("another-task");
    engine.setPoolPaused(true);
    expect(engine["checks"].claimPreparation(task.id)).toBe(false);
    engine.s.backgroundAgents = [];
    task.state = "waiting";
    engine["driver"].workflow["preparedTesters"].set(task.id, "already checked");
    engine.cancel(task.id);
    expect(engine["driver"].workflow["preparedTesters"].has(task.id)).toBe(false);
  } finally { await caseOwner.stop(engine); }

  });
});

it("admits a queued planner while the check-preparation lane is full", async () => {
  return engineCases.use("petrina-planner-beside-checks-", async caseOwner => {
  const root = caseOwner.root;
  const engine = caseOwner.open(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null },   });
  engine.setPoolPaused(true);
  await caseOwner.run(engine, async () => { await engine.waitUntilReady(); });
  try {
    const productId = "product";
    engine.s.products.push({ id: productId, name: "Product", repo: "local/product", tone: "blue" });
    const check = engine.task(engine.addTask({ productId, title: "Waiting for checks", backlog: true }))!;
    Object.assign(check, { state: "waiting", startedAt: Date.now(), stageIndex: 0, plan: { rationale: "Review", plannerProfileId: "sol-high", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 }] } });
    const queued = engine.addTask({ productId, title: "Plan while checks wait" });
    engine.s.pool.limit = 1;
    const started: string[] = [];
    engine["driver"].workflow["startDriver"] = (id) => { started.push(id); };
    engine.setPoolPaused(false);
    expect(started).toContain(queued);
    expect(engine["checks"].preparingCount).toBe(1);
  } finally { await caseOwner.stop(engine); }

  });
});
