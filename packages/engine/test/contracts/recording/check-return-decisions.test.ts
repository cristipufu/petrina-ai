import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { beginAgentStep, builderFindings } from "@petrina/core";
import { BuildCompletion, executionFor } from "@petrina/orchestrator";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { scriptedToolProbe } from "../../scripted-probes.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

// SQLite and the coordinator's real gate projection are this boundary. The accepted failure and
// unchanged Builder replies are explicit observations; command execution and ACP live in their anchors.
for (const before of ["review", "acceptance"] as const) it(`persists unchanged check-return claims at the ${before} decision`, () => cases.use("check-return-record-", async owner => {
  const options = { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [],
    toolProbe: scriptedToolProbe({ codex: { status: "not-installed" }, "claude-code": { status: "not-installed" }, git: { status: "ready" }, gh: { status: "not-installed" } }) };
  let engine = owner.open(join(owner.root, "data"), options);
  engine.schedule = () => {};
  await engine.waitUntilReady(); owner.check();
  engine.setPoolPaused(true);
  engine.s.products.push({ id: "product", name: "Welcome", repo: "local/welcome", tone: "blue" });
  let task = engine.task(engine.addTask({ productId: "product", title: "Add a greeting", backlog: true }))!;
  task.plan = { rationale: "Record a supplied completed candidate", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
    ...(before === "acceptance" ? [{ id: "test", kind: "do" as const, title: "Test", roleId: "tester", profileIds: ["sol-high"] }] : []),
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
    { id: "delivery", kind: "gate", title: "Delivery", gate: "delivery", roleId: "coordinator", profileIds: [] },
  ] };
  task.stageIndex = 1; task.state = "running";
  if (before === "review") task.rounds.review = 2;
  const scope = executionFor(task), tree = "a".repeat(40);
  const run = { name: "Welcome", command: "declared-check", ok: false, output: "captured failure", ms: 1, execution: completeCheckExecution(1) };
  scope.work.checks = { tree, at: 1, results: [run] };
  engine["checks"]["repairs"].recordFailedFindings(scope, [run]);
  const claim = "Nothing to fix: the check failed because the Mac went to sleep.";
  const effects = ["save", "fold", "tree", "save", "fold", "tree"];
  const take = (current: typeof scope, kind: string) => {
    if (current.task !== task || current.work !== scope.work || effects.shift() !== kind) throw new Error(`Unexpected ${kind} completion effect`);
  };
  const completion = new BuildCompletion({
    now: () => Date.now(), checkpoint: current => engine.commitNow(current),
    note: (current, tone, words, role, profile) => engine.log(current, tone, words, role, profile),
    noteLearnings: async (_scope, lessons) => { if (lessons.length) throw new Error("No learning supplied"); },
  }, {
    saveChanges: async current => { take(current, "save"); }, fold: async current => { take(current, "fold"); return undefined; },
    tree: async current => { take(current, "tree"); return tree; },
    finishPort: async () => { throw new Error("No source port supplied"); }, versions: async () => { throw new Error("No proof supplied"); },
    repairVersion: async () => { throw new Error("No command provenance supplied"); },
  });
  await owner.run(engine, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(engine["checks"].backToBuilder(scope, `before ${before}`, new Set(["product"]))).toBe(true);
      const given = builderFindings(task, "product");
      beginAgentStep(task, "builder", "sol-high", Date.now(), engine.s.roles, undefined, scope.work);
      await completion.complete(scope, { stageId: "build", roleId: "builder", plannedProfileId: "sol-high", actualProfileId: "sol-high", maintenance: false, sourceName: "main", startingTree: tree, given, checkFailures: [],
        result: { summary: "Unchanged", changes: [], learnings: [], answers: given.map(finding => ({ id: finding.id, fixed: false, text: claim })) } });
      task.stageIndex = 1;
    }
  });
  expect(effects).toEqual([]);
  expect(engine["checks"].backToBuilder(scope, `before ${before}`, new Set(["product"]))).toBe(false);
  engine["checks"].blocked(task);
  const decision = engine.getState().inbox.find(item => item.taskId === task.id && item.kind === "delivery")!;
  expect(decision.body).toContain(`The Builder's last answer: “${claim}”`);
  expect(decision.body).toContain("not independently confirmed");
  expect(decision.body).toContain(before === "acceptance" ? "Stopped before acceptance testing." : "Stopped before the review (round 2).");
  expect(scope.work.checks!.definition).toBeUndefined();
  const saved = { checks: structuredClone(scope.work.checks!), finding: structuredClone(task.findings[0]!), journey: structuredClone(task.journey!), decision: structuredClone(decision) };
  const taskId = task.id;
  engine.commitNow(task);
  engine = await owner.restart(engine, engine.dataDir, options); owner.check();
  engine.schedule = () => {};
  await engine.waitUntilReady(); owner.check();
  task = engine.task(taskId)!;
  expect(executionFor(task).work.checks).toEqual(saved.checks);
  expect(executionFor(task).work.checks!.definition).toBeUndefined();
  expect(task.findings[0]).toEqual(saved.finding);
  expect(task.journey).toEqual(saved.journey);
  expect(engine.getState().inbox.find(item => item.id === saved.decision.id)).toEqual(saved.decision);
  expect(task.repository!.checkReturns).toBe(2);
}));
