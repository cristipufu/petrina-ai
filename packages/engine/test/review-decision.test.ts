import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { journeyView } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "../src/repository-context.js";
import { Coordination } from "../src/coordination.js";
import { coordinator, Fakes, itemOf, makeProduct, removeDir, tempDir, until } from "./support.js";
import { commandText } from "../src/checks.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

// Start at round completion: this decision must precede delivery preparation, not replay a whole task.
for (const following of ["gate", "agent"] as const) it(`asks about exhausted review before the following ${following}, and continuing approves no delivery`, async () => {
  const root = tempDir("petrina-review-decision-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  try {
    const repo = await makeProduct(root);
    const productId = await engine.addProduct(repo);
    const task = engine.task(engine.addTask({ productId, title: "A bounded review" }))!;
    const work = executionFor(task).work;
    work.worktree = repo;
    task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      following === "gate" ? { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }
        : { id: "test", title: "Test", kind: "do", roleId: "tester", profileIds: ["sol-high"] },
      { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    task.stageIndex = 1; task.rounds = { review: 5 };
    task.findings = [{ id: "bug", text: "Confirmed failure", severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"] }];
    const review = task.plan.stages[1]!;
    const result = await engine["reviews"]["closeReviewRound"](task, review, 5, "1 important");
    expect(result).toBe("stop");
    expect(task.stageIndex).toBe(2);
    expect(task.reviewDecision).toEqual({ stageId: "review", round: 5, accepted: false });
    expect(task.state).toBe("needs-you"); expect(task.agent).toBeUndefined();
    expect(work.checkedSha).toBeUndefined(); expect(work.approvedSha).toBeUndefined();
    const decision = engine.s.inbox.find(item => item.taskId === task.id)!;
    expect(decision.body).toContain("Continuing approves no delivery");
    expect(task.journey!.at(-1)!.work).toBe("review-decision");
    const view = journeyView(engine.taskDetails(task.id)!, { roles: engine.s.roles, profiles: engine.s.profiles, tasks: [], inbox: engine.s.inbox });
    expect(view.nodes.find(node => node.id === task.journey!.at(-1)!.id)!.name).toBe("Your review decision");
    const c = new Coordination(engine);
    const inspected = await c.call("inbox.inspect", { itemId: decision.id });
    expect((await c.call("inbox.approve", { itemId: decision.id, revision: inspected.revision, requestId: "continue-review" })).outcome).toBe("completed");
    expect(task.reviewDecision!.accepted).toBe(true);
    expect(task.stageIndex).toBe(2); expect(task.rounds.review).toBe(5);
    expect(work.approvedSha).toBeUndefined(); expect(work.approvedFor).toBeUndefined();
    expect(task.findings[0]!.status).toBe("open");
    task.risk = { level: "low", why: "Fixture" };
    engine.s.products.find(product => product.id === productId)!.shipLowRisk = true;
    const findings = task.findings;
    task.findings = [];
    expect(engine["driver"]["shipsUnasked"](task)).toBe(false);
    task.findings = findings;
    // The actual delivery approval remains a different decision, after preparation.
    work.checkedSha = "final-code"; work.checkedPatch = "final-patch";
    task.stageIndex = 2;
    engine.gate(task, "delivery");
    const final = engine.s.inbox.find(item => item.taskId === task.id)!;
    expect(final.id).not.toBe(decision.id);
    expect(task.journey!.at(-1)!.work).not.toBe("review-decision");
    engine.approve(final.id);
    expect(work.approvedSha).toBe("final-code");
  } finally { await engine.shutdown(); }
});

it("keeps the early decision through restart, then runs changed checks and acceptance before a separate approval", async () => {
  const root = tempDir("petrina-review-final-verification-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "tester-after", builder: "plain", reviewer: "important" });
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] };
  let engine = new Engine(join(root, "data"), options);
  const log = join(root, "check-runs");
  const check = join(root, "check.ts");
  writeFileSync(check, `import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], process.argv[3] + "\\n");`);
  const definitions = (name: string) => [{ name: "Tests", command: commandText([process.execPath, check, log, name]) }];
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    engine.setProductDelivery(productId, "local", true);
    engine.setProductChecks(productId, definitions("before decision"));
    const id = engine.addTask({ productId, title: "A reviewed greeting", description: "[no-check]" });
    const first = await until(engine, state => !!itemOf(state, id, "delivery"), coordinator(["plan"]));
    const item = itemOf(first, id, "delivery")!;
    expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
    expect(fakes.openings("tester")).toHaveLength(0);
    expect(readFileSync(log, "utf8")).toBe("before decision\n");
    engine.setPoolPaused(true);
    await engine.shutdown();
    engine = new Engine(join(root, "data"), options);
    expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
    expect(engine.s.inbox.find(entry => entry.id === item.id)).toBeDefined();
    engine.setProductChecks(productId, definitions("after decision"));
    appendFileSync(log, "decision\n");
    engine.approve(item.id);
    expect(executionFor(engine.task(id)!).work.approvedSha).toBeUndefined();
    engine.setPoolPaused(false);
    const final = await until(engine, state => !!itemOf(state, id, "delivery"));
    expect(itemOf(final, id, "delivery")!.id).not.toBe(item.id);
    expect(readFileSync(log, "utf8")).toBe("before decision\ndecision\nafter decision\n");
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(engine.task(id)!.acceptancePassed).toBe(true);
    expect(engine.task(id)!.findings.some(finding => finding.severity === "blocking" && finding.status === "open")).toBe(true);
    expect(executionFor(engine.task(id)!).work.approvedSha).toBeUndefined();
    engine.requestChanges(itemOf(final, id, "delivery")!.id, "Repair the confirmed defect and review it again");
    engine.setPoolPaused(true);
    expect(engine.task(id)!.reviewDecision).toBeUndefined();
    expect(engine.task(id)!.fixing).toBe(true);
    expect(engine.task(id)!.plan!.stages[engine.task(id)!.stageIndex]!.roleId).toBe("builder");
  } finally { await engine.shutdown(); }
});
