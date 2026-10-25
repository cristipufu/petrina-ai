import { afterAll, expect, it, spyOn } from "bun:test";
import { beginAgentStep, endAgentStep } from "@petrina/core";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { signal, fixture, passes, close } = proofRequestFixtures();
afterAll(close);
it("retains one interrupted Tester run across restart and binds a stand-in's proof to its actual completed step", async () => {
  const f = await fixture(); await f.request();
  f.task.retest = true; f.task.proofRefreshes = 1; f.task.stageIndex = 1;
  const first = spyOn(f.engine["turns"], "turn").mockImplementation(async () => {
    beginAgentStep(f.task, "tester", "opus-high", 1, f.engine.s.roles, undefined, f.scope.work);
    f.task.state = "paused";
    throw new Error("controlled interruption before acceptance result");
  });
  try {
    try { await f.engine["work"].runDo(f.scope, f.tester, signal()); throw new Error("Expected interruption"); }
    catch (error) { expect(String(error)).toContain("controlled interruption"); }
    expect(f.task.proofRequests![0]!.proof).toBeUndefined(); expect(f.task.acceptanceRun!.requestIds).toHaveLength(1);
    const run = structuredClone(f.task.acceptanceRun);
    f.engine.setPoolPaused(true); await f.engine.shutdown(); first.mockRestore();
    f.engine = new Engine(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    expect(f.task.acceptanceRun).toEqual(run); expect(f.task.proofRefreshes).toBe(1);
    const resumed = spyOn(f.engine["turns"], "turn").mockImplementation(async (scope, roleId, _profileId, _given, schema, _signal, options) => {
      endAgentStep(scope.task, { outcome: "Tester handed over", reason: "Another tool continues" }, 2);
      options?.used?.("sol-high");
      const step = beginAgentStep(scope.task, roleId, "sol-high", 3, f.engine.s.roles, undefined, scope.work);
      const value = schema.parse({ summary: "The stand-in verified it", proofAnswers: passes(scope.task.acceptanceRun!.requestIds) });
      step.agentResults = [{ roleId, profileId: "sol-high", at: 4, value }];
      return value;
    });
    await f.engine["work"].runDo(f.scope, f.tester, signal()); resumed.mockRestore();
    const request = f.task.proofRequests![0]!;
    expect(request.status).toBe("proved"); expect(request.proof!.stepId).toBe(f.task.journey!.at(-1)!.id);
    expect(f.task.journey!.at(-1)!.profileId).toBe("sol-high"); expect(f.task.proofRefreshes).toBe(1);
    expect(f.task.acceptanceRun).toBeUndefined();
  } finally { first.mockRestore(); await f.engine.shutdown(); }
});

it("repairs missing or duplicate proof answers in the same Tester turn and never trusts evidence-free passes", async () => {
  const f = await fixture(); await f.request(); f.task.retest = true; f.task.stageIndex = 1;
  const turn = spyOn(f.engine["turns"], "turn").mockImplementation(async (scope, roleId, profileId, _given, schema, _signal, options) => {
    const missing = schema.parse({ summary: "Incomplete answer" });
    expect(await options?.check?.(missing)).toContain("exactly once by id");
    const id = scope.task.acceptanceRun!.requestIds[0]!;
    expect(await options?.check?.(schema.parse({ summary: "Duplicate answer", proofAnswers: [...passes([id]), ...passes([id])] }))).toContain("exactly once");
    const value = schema.parse({ summary: "No receipt was obtained", proofAnswers: [{ id, result: "pass" }] });
    expect(await options?.check?.(value)).toBeUndefined();
    const node = beginAgentStep(scope.task, roleId, profileId, 1, f.engine.s.roles, undefined, scope.work);
    node.agentResults = [{ roleId, profileId, at: 2, value }]; return value;
  });
  try {
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(turn).toHaveBeenCalledTimes(1); expect(f.task.proofRequests![0]!.status).toBe("unverified");
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
  } finally { turn.mockRestore(); await f.engine.shutdown(); }
});
