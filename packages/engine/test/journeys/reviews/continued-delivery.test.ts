import { afterAll, expect, it } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { roleForTask, type JourneyStep, type Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Coordination } from "../../../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import { commandInputText } from "../../../src/checks.js";
import { coordinator, Fakes, git, itemOf, makeProduct, removeDir, taskOf, tempDir, until, waitFor } from "../../support.js";

const roots: string[] = [];

afterAll(() => roots.forEach(removeDir));

async function inspect(c: Coordination, itemId: string): Promise<{ reviewDecision: Task["reviewDecision"] | null }> {
  let page = await c.call("inbox.inspect", { itemId }), text = String(page.text);
  while (page.next) {
    page = await c.call("inbox.inspect", { itemId, cursor: page.next });
    text += page.text;
  }
  return JSON.parse(text);
}

const COVERED = "review passed; 1 earlier important still open under your decision to continue";

for (const restarts of [false, true]) it(`continues an exhausted review through a later passing security review to final testing and a separate delivery decision${restarts ? ", through restarts before and partway through that review" : ""}`, async () => {
  const root = tempDir("petrina-review-continuation-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  // Restarting partway: the security reviewer holds its first turn of each conversation until the test releases it.
  // High risk: Petrina adds its own security review after the code review.
  fakes.scenario({ planner: "tester-after", risk: "high", builder: "plain", reviewer: "important", ...(restarts ? { nativeRetry: [{ role: "security reviewer", steps: [{ mark: "security-held-{session}" }, { wait: "security-release-{session}" }] }] } : {}) });
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir] };
  let engine = new Engine(join(root, "data"), options);
  const replaced: Promise<void>[] = [];
  const restart = async () => {
    engine.setPoolPaused(true);
    const stopping = engine.shutdown();
    replaced.push(stopping);
    await stopping;
    engine = new Engine(join(root, "data"), options);
  };
  const held = () => readdirSync(fakes.dir).filter((name) => name.startsWith("security-held-")).map((name) => name.slice("security-held-".length));
  const release = () => { for (const session of held()) if (!existsSync(join(fakes.dir, `security-release-${session}`))) writeFileSync(join(fakes.dir, `security-release-${session}`), ""); };
  try {
    const clone = await makeProduct(root);
    const productId = await engine.addProduct(clone);
    engine.setProductDelivery(productId, "local", true);
    engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, "-e", "process.exit(0)"]) }]);
    const main = await git(clone, "rev-parse", "main");
    const id = engine.addTask({ productId, title: "A reviewed greeting", description: "[no-check]" });
    const task = () => engine.task(id)!;
    const resultOf = (step: JourneyStep) => roleForTask(engine.s.roles, step.roleId ?? "", task())?.result;

    // Code review runs out with one Important finding: the coordinator is asked before anything else runs.
    const first = await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator(["plan"]));
    const decision = itemOf(first, id, "delivery")!;
    const stages = task().plan!.stages;
    const review = stages.find((stage) => stage.roleId === "code-reviewer")!, security = stages.find((stage) => stage.roleId === "security-reviewer")!;
    expect(stages[task().stageIndex]!.id).toBe(security.id);
    const accepted = task().findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    expect(accepted).toHaveLength(1);
    const kept = structuredClone(accepted[0]!);
    // The decision names exactly the findings it is about and the version of the task's own change it was made on.
    const decided = structuredClone(task().reviewDecision!);
    expect(decided).toEqual({ stageId: review.id, round: 1, accepted: false, covers: [kept.id], at: expect.any(Number), versions: { [productId]: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    let c = new Coordination(engine);
    expect((await inspect(c, decision.id)).reviewDecision).toEqual(decided);
    const builderPrompts = fakes.received("builder").length;
    const rounds = structuredClone(task().rounds);
    expect(task().journey!.filter((step) => step.kind === "agent" && resultOf(step) === "build")).toHaveLength(1);

    if (restarts) engine.setPoolPaused(true);
    const inspected = await c.call("inbox.inspect", { itemId: decision.id });
    expect((await c.call("inbox.approve", { itemId: decision.id, revision: inspected.revision, requestId: "continue-review" })).outcome).toBe("completed");
    expect(task().reviewDecision).toEqual({ ...decided, accepted: true });
    expect(executionFor(task()).work.approvedSha).toBeUndefined();
    if (restarts) {
      // Before the later review starts, then while its reviewer is at work.
      await restart();
      expect(engine.task(id)!.reviewDecision).toEqual({ ...decided, accepted: true });
      engine.setPoolPaused(false);
      await waitFor(() => held().length > 0 && engine.task(id)!.agent?.roleId === security.roleId && engine.task(id)!.hunt?.stageId === security.id ? true : undefined, "the security reviewer at work");
      await restart();
      engine.setPoolPaused(false);
      c = new Coordination(engine);
    }

    // Security passes with nothing new: no Builder turn and no second review decision, straight to final testing.
    const settled = await until(engine, (state) => { const item = itemOf(state, id, "delivery"); return !!item && item.id !== decision.id; }, (engine, state) => { release(); coordinator([])(engine, state); });
    const final = itemOf(settled, id, "delivery")!;
    expect(fakes.received("builder")).toHaveLength(builderPrompts);
    const journey = task().journey!;
    expect(journey.filter((step) => step.kind === "agent" && resultOf(step) === "build")).toHaveLength(1);
    expect(journey.filter((step) => step.work === "review-decision")).toHaveLength(1);
    const securitySteps = journey.filter((step) => step.kind === "agent" && step.stageId === security.id && resultOf(step) === "findings" && step.endedAt !== undefined);
    expect(securitySteps.at(-1)!.reason).toBe(COVERED);
    expect(securitySteps.at(-1)!.tone).toBeUndefined();
    expect(task().timeline.some((entry) => entry.text === "Review passed: 1 earlier important still open under your decision to continue")).toBe(true);
    expect(task().timeline.filter((entry) => entry.text.startsWith("Sent back to the builder"))).toHaveLength(0);
    expect(task().timeline.filter((entry) => entry.text.startsWith("Review rounds used up"))).toHaveLength(1);
    // No stage spent or reset a round.
    expect(task().rounds).toEqual(rounds);
    // The accepted finding stays open with its original evidence, confirmations and history.
    expect(task().findings.find((finding) => finding.id === kept.id)).toEqual(kept);
    // The security reviewer still saw it in its own independent snapshot.
    expect(fakes.openings("security reviewer").every((prompt) => prompt.includes(`[${kept.id}]`))).toBe(true);
    expect(fakes.openings("security reviewer").length).toBeGreaterThan(0);
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(task().acceptancePassed).toBe(true);
    // The delivery decision is separate and still says the finding is open; nothing was approved or published.
    expect(final.title).toContain("1 blocking finding still open");
    expect(task().reviewDecision).toEqual({ ...decided, accepted: true });
    expect((await inspect(c, final.id)).reviewDecision).toEqual({ ...decided, accepted: true });
    const work = executionFor(task()).work;
    expect(work.approvedSha).toBeUndefined();
    expect(work.landed).toBeUndefined();
    expect(await git(clone, "rev-parse", "main")).toBe(main);

    // Approving that decision delivers.
    const current = await c.call("inbox.inspect", { itemId: final.id });
    expect((await c.call("inbox.approve", { itemId: final.id, revision: current.revision, requestId: "ship-it" })).outcome).toBe("completed");
    const done = await until(engine, (state) => taskOf(state, id).state === "done", coordinator([]));
    expect(taskOf(done, id).landed).toBeDefined();
    expect(await git(clone, "rev-parse", "main")).not.toBe(main);
  } finally {
    release();
    await engine.shutdown();
    await Promise.all(replaced);
  }
});
