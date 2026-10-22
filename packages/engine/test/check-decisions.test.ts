import { afterAll, expect, it } from "bun:test";
import { Engine } from "./engine.js";
import { Coordination } from "../src/coordination.js";
import { executionFor } from "../src/repository-context.js";
import { mcpTools } from "../src/mcp.js";
import { removeDir, tempDir } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(interrupted = false, shared = false) {
  const root = tempDir("petrina-check-decision-"); roots.push(root);
  const engine = new Engine(root, { agentCommand: () => undefined, terminals: () => [] });
  await engine.waitUntilReady();
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  engine.s.products.push({ id: "shop", name: "Shop", repo: "local/shop", tone: "blue", delivery: "local" });
  const task = engine.task(engine.addTask({ productId: "shop", title: "Fix the shop" }))!;
  const work = executionFor(task).work;
  work.checks = { at: 1, sha: "checked", tree: "tree", current: true, results: [{ name: "Tests", command: "bun test", ok: false, output: "Original failure", ms: 1, ...(interrupted ? { interrupted: true } : {}) }] };
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
  const { engine, task, work, item, coordination: c } = await fixture(interrupted, shared);
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
      await engine.shutdown();
      const reopened = new Engine(engine.dataDir, { agentCommand: () => undefined, terminals: () => [] });
      reopened.schedule = () => {};
      try {
        expect(await new Coordination(reopened).call("inbox.rerun-checks", args)).toEqual(result);
        expect(reopened.task(task.id)!.timeline.filter(line => line.text.includes("You asked to run checks again"))).toHaveLength(1);
      } finally { await reopened.shutdown(); }
    }
  } finally { await engine.shutdown(); }
});

it("keeps ordinary delivery approval available and refuses reruns on other decisions", async () => {
  const { engine, task, work, item, coordination: c } = await fixture();
  try {
    work.checks!.results[0]!.ok = true;
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
    expect(work.approvedSha).toBe("checked"); expect(task.stageIndex).toBe(1);
    expect(mcpTools().find(tool => tool.name === "petrina_inbox_rerun_checks")?.annotations.readOnlyHint).toBe(false);
  } finally { await engine.shutdown(); }
});
