import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { Coordination } from "../../../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import { mcpTools } from "../../../src/mcp-catalog.js";
import { checkSetupFixture } from "../../fixtures/check-setup.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


async function fixture(owner: EngineCaseOwner, interrupted = false, shared = false) {
  const root = mkdtempSync(join(owner.root, "petrina-check-decision-"));
  const engine = owner.open(root, { agentCommand: () => undefined, terminals: () => [] });
  await engine.waitUntilReady();
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  engine.s.products.push({ id: "shop", name: "Shop", repo: "local/shop", tone: "blue", delivery: "local" });
  const task = engine.task(engine.addTask({ productId: "shop", title: "Fix the shop" }))!;
  const work = executionFor(task).work;
  work.checks = { at: 1, sha: "checked", tree: "tree", current: true, results: [{ name: "Tests", command: "bun test", ok: false, execution: completeCheckExecution(7), output: "Original failure", ms: 1, ...(interrupted ? { interrupted: true } : {}) }] };
  work.checkReturns = 2;
  work.checkedSha = "checked"; work.checkedPatch = "patch";
  if (shared) task.repositories = [{ ...work, completedStages: [] }, { productId: "api", delivery: "local", completedStages: [] }];
  task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [{ id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }] };
  task.stageIndex = 0;
  engine.gate(task, "delivery");
  const item = engine.s.inbox.find(item => item.taskId === task.id)!;
  const coordination = new Coordination(engine);
  return { engine, task, work: executionFor(task).work, item, coordination };
}

for (const interrupted of [false, true]) for (const shared of [false, true]) it(`guards ${interrupted ? "unverified" : "failed"} check decisions (${shared ? "shared" : "single"} product) and deduplicates explicit reruns`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, task, work, item, coordination: c } = await fixture(owner, interrupted, shared);
    try {
      const before = structuredClone(task), inbox = structuredClone(engine.s.inbox);
      const inspected = await c.call("inbox.inspect", { itemId: item.id });
      expect(inspected.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
      expect(() => engine.approve(item.id)).toThrow("delivery has not been approved");
      expect(task).toEqual(before); expect(engine.s.inbox).toEqual(inbox);
      expect((await c.call("inbox.approve", { itemId: item.id, revision: inspected.revision, requestId: "cannot-approve" })).outcome).toBe("invalid");
      expect(work.approvedSha).toBeUndefined();
      work.checks!.results[0]!.output = "New evidence";
      expect((await c.call("inbox.rerun-checks", { itemId: item.id, revision: inspected.revision, requestId: "stale-rerun" })).outcome).toBe("changed");
      expect(engine.s.inbox).toHaveLength(1);
      const current = await c.call("inbox.inspect", { itemId: item.id });
      const args = { itemId: item.id, revision: current.revision, requestId: "explicit-rerun" };
      const result = await c.call("inbox.rerun-checks", args);
      expect(result.outcome).toBe("completed");
      expect(await c.call("inbox.rerun-checks", args)).toEqual(result);
      expect(work.checks).toMatchObject({ current: false, results: [{ output: "New evidence" }] });
      expect(work.checks!.sha).toBeUndefined(); expect(work.checks!.tree).toBeUndefined();
      expect(work.checkReturns).toBe(2); expect(work.approvedSha).toBeUndefined();
      expect(task.stageIndex).toBe(0); expect(task.state).toBe("waiting");
      expect(task.timeline.filter(line => line.text.includes("You asked to run checks again"))).toHaveLength(1);
      expect(engine.s.inbox).toEqual([]);
      if (!interrupted && !shared) {
        await owner.stop(engine);
        const reopened = owner.open(engine.dataDir, { agentCommand: () => undefined, terminals: () => [] });
        reopened.schedule = () => {};
        try {
          expect(await new Coordination(reopened).call("inbox.rerun-checks", args)).toEqual(result);
          expect(reopened.task(task.id)!.timeline.filter(line => line.text.includes("You asked to run checks again"))).toHaveLength(1);
        } finally { await owner.stop(reopened); }
      }
    } finally { await owner.stop(engine); }

  });
});

it("keeps a historical raw pass unverified when no setup observation was recorded", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, work, item, coordination } = await fixture(owner);
    try {
      await owner.run(engine, async () => {
        work.checks!.results[0]!.ok = true;
        work.checks!.results[0]!.execution = completeCheckExecution(0);
        const inspected = await coordination.call("inbox.inspect", { itemId: item.id });
        expect(inspected.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
        const saved = JSON.parse(String(inspected.text)).products[0];
        expect(saved.checks.results[0].commandOutcome).toBe("passed");
        expect(saved.localSetup.outcome).toEqual({ kind: "unobserved" });
        expect((await coordination.call("inbox.approve", { itemId: item.id, revision: inspected.revision, requestId: "legacy-pass" })).outcome).toBe("invalid");
        expect(work.approvedSha).toBeUndefined();

      });
    } finally { await owner.stop(engine); }

  });
});

it("keeps ordinary delivery approval available and refuses reruns on other decisions", async () => {
  const native = await checkSetupFixture();
  try {
    const { engine, task } = native, work = executionFor(task).work;
    native.setChecks(["Tests"]);
    expect((await native.check()).kind).toBe("passed");
    const checked = work.checks!.sha;
    expect(checked).toBeString();
    // The gate's checked version is the actual producer's saved source, not a placeholder identity.
    work.checkedSha = checked;
    task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [{ id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }] };
    task.stageIndex = 0;
    engine.gate(task, "delivery");
    const item = engine.s.inbox.find(item => item.taskId === task.id)!, c = new Coordination(engine);
    const inspected = await c.call("inbox.inspect", { itemId: item.id });
    expect(inspected.decisions).toEqual(["inbox.approve", "inbox.changes"]);
    expect(() => engine.rerunChecks(item.id)).toThrow("no failed or unverified");
    expect((await c.call("inbox.rerun-checks", { itemId: item.id, revision: inspected.revision, requestId: "ordinary-delivery" })).outcome).toBe("invalid");
    item.kind = "design";
    expect(() => engine.rerunChecks(item.id)).toThrow("only available");
    expect(engine.s.inbox).toHaveLength(1);
    item.kind = "delivery";
    const current = await c.call("inbox.inspect", { itemId: item.id });
    expect((await c.call("inbox.approve", { itemId: item.id, revision: current.revision, requestId: "valid-approval" })).outcome).toBe("completed");
    expect(work.approvedSha).toBe(checked); expect(task.stageIndex).toBe(1);
    expect(mcpTools().find(tool => tool.name === "petrina_inbox_rerun_checks")?.annotations.readOnlyHint).toBe(false);
  } finally { await native.close(); }
});
