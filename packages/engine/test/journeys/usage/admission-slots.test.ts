import { afterAll } from "bun:test";
import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { expect, it, spyOn } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { slotUses } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { Engine } from "../../engine.js";
import { createProductRepository, git, waitFor } from "../../fixtures.js";
import { slotAgents } from "../../fixtures/slot-agents.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());
/** Actual repository preparation, Builder commits, checks and independent reviewer copies. */
async function fixture(caseOwner: EngineCaseOwner) {
  const root = caseOwner.root;
  let engine: Engine | undefined;
  const close = async () => { if (engine) { await caseOwner.stop(engine); engine = undefined; }  };
  return setupWithCleanup(async () => {
    const { agents, release } = slotAgents(), { path: repo } = await createProductRepository(root, { origin: "none" }); caseOwner.check();
    appendFileSync(join(repo, ".git", "config"), "\n[branch]\n\tautoSetupMerge = false\n");
    const started = engine = installSharedWorkflowFastPaths(
      caseOwner.open(join(root, "data"), {
        agentCommand: () => [process.execPath, join(import.meta.dir, "../../unconfigured-service.ts"), "native slot composition"],
        startAgentSession: agents.start,
        toolProbe: privateAgentToolProbe(),
      }),
      { skipUpToDate: true, skipPrepareChecks: true, skipReviewInputDiffs: true },
    );
  return caseOwner.run(started, async () => {
    started.setPoolPaused(true); started.setPoolLimit(2); started.setToolCap("claude-code", 1); started.setToolCap("codex", 2);
    await started.waitUntilReady();
    caseOwner.check();
    const productId = installPreparedProduct(started, privateCloneProduct(repo));
    const ids = Array.from({ length: 2 }, (_, index) => started.addTask({ productId, title: `Native change ${index}`, approveDelivery: true }));
    return { engine: started, agents, release, ids, repo, close };

  });
}, close);
}
it("uses the shared admission owners through actual repository preparation, design questions and six independent reviewer turns", async () => {
  return engineCases.use("petrina-slot-composition-", async caseOwner => {
  const f = await fixture(caseOwner), violations: string[] = [];
  let maximum = 0;
  const observe = () => {
    const state = f.engine.getState(), uses = slotUses(state);
    maximum = Math.max(maximum, uses.length);
    if (uses.length > 2 || uses.filter(use => use.toolId === "claude-code").length > 1 || uses.filter(use => use.toolId === "codex").length > 2 || state.tasks.some(task => task.holdsSlot && !task.agent)) violations.push(JSON.stringify(uses));
  };
  const unsubscribe = f.engine.subscribe(observe);
    caseOwner.onStop(unsubscribe);
  const qualify = spyOn(f.engine.agentAdmission.participant, "qualify");
    caseOwner.onStop(() => qualify.mockRestore());
  const advance = (reviewers: boolean) => {
    observe();
    for (const prompt of f.agents.received()) if (reviewers || prompt.result !== "findings") f.release(prompt.sessionId);
    const state = f.engine.getState();
    if (state.tasks.some(task => task.state === "failed")) throw new Error(JSON.stringify(state.tasks.map(task => ({ title: task.title, error: task.error }))));
    for (const item of state.inbox) if (item.kind === "question") f.engine.answer(item.id, "Formal");
    return state;
  };
  try {
    await caseOwner.run(f.engine, async () => {
    expect(f.engine.agentAdmission.participant).toBe(f.engine["driver"].workflow);
    expect(f.engine.agentAdmission.ownership.drivers).toBe(f.engine.drivers);
    expect(f.engine.agentAdmission.ownership.settling).toBe(f.engine.settling);
    expect(f.engine.agentAdmission.ownership.groups).toBe(f.engine.screenGroups);
    f.engine.setPoolPaused(false);
    const held = await waitFor(() => { advance(false); return f.agents.received("findings")[0]; }, "a real reviewer to hold its private copy", 60_000);
    const owner = f.engine.s.tasks.find(task => task.journey?.some(step => step.agentInputs?.some(input => input.sessionId === held.sessionId)))!;
    expect(owner).toBeDefined();
    const primary = executionFor(owner).work.worktree!;
    expect(held.cwd).not.toBe(primary);
    expect(readWorktreeCommit(held.cwd)?.commit).toBe(readWorktreeCommit(primary)?.commit);
    expect((await git(f.repo, "worktree", "list", "--porcelain")).replaceAll("\\", "/")).toContain(held.cwd.replaceAll("\\", "/"));
    expect(f.engine.screenGroups.get(owner.id)?.running("review-0") || f.engine.screenGroups.get(owner.id)?.running("review-1") || f.engine.screenGroups.get(owner.id)?.running("review-2")).toBe(true);
    await waitFor(() => {
      const state = advance(true);
      return state.tasks.every(task => task.state === "needs-you") && state.inbox.every(item => item.kind === "delivery");
    }, "both native tasks to reach the actual delivery checkpoint", 60_000);
    expect(maximum).toBe(2);
    expect(violations).toEqual([]);
    expect(qualify.mock.calls.length).toBeGreaterThan(0);
    expect(f.agents.received("notes")).toHaveLength(2);
    expect(f.agents.received("objections").length).toBeGreaterThan(2);
    expect(f.agents.received("findings")).toHaveLength(6);
    for (const id of f.ids) {
      const work = executionFor(f.engine.task(id)!).work;
      expect(readFileSync(join(work.worktree!, "greeting.txt"), "utf8").replace(/\r?\n$/, "")).toBe("Hello");
      expect(work.checks?.current).toBe(true);
      expect(work.checks?.tree).toBe(readWorktreeCommit(work.worktree!)?.tree);
      expect(work.checks!.results.length).toBeGreaterThan(0);
      expect(work.checks!.results.every(run => run.ok && !run.interruption && !run.interrupted)).toBe(true);
    }
    expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(".copies");

    });
} finally { qualify.mockRestore(); unsubscribe(); await f.close(); }
  });
});
