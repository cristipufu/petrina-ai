import { describe, expect, it } from "vitest";
import { createDemoState } from "../src/demo.js";
import { afterChangesAsked, columnOf, designRoundEnd, gateStatus, gateTitle, reviewRoundEnd, type DeepMutable } from "../src/flow.js";
import { BUILT_IN_ROLES } from "../src/library.js";
import type { Finding, Stage, Task } from "../src/model.js";

const demo = createDemoState(1_000_000_000);
const planned = demo.tasks.find((task) => task.plan?.stages.some((stage) => stage.roleId === "builder") && task.plan.stages.some((stage) => stage.kind === "review-chain"))!;
const stages = planned.plan!.stages;
const at = (match: (stage: Stage) => boolean) => stages.findIndex(match);
const copy = (extra: Partial<Task> = {}): DeepMutable<Task> => JSON.parse(JSON.stringify({ ...planned, ...extra })) as DeepMutable<Task>;
const important = (status: Finding["status"] = "open"): Finding => ({ id: "f1", text: "It breaks", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status });

describe("the rules a task's run follows, in the engine and the demo alike", () => {
  it("puts a task in the column of the stage it is on", () => {
    expect(columnOf({ ...planned, state: "queued" }, BUILT_IN_ROLES)).toBe("queue");
    expect(columnOf({ ...planned, state: "running", stageIndex: -1 }, BUILT_IN_ROLES)).toBe("planning");
    expect(columnOf({ ...planned, state: "running", stageIndex: at((stage) => stage.roleId === "builder") }, BUILT_IN_ROLES)).toBe("building");
    expect(columnOf({ ...planned, state: "running", stageIndex: at((stage) => stage.kind === "review-chain") }, BUILT_IN_ROLES)).toBe("reviewing");
    expect(columnOf({ ...planned, state: "pr-open" }, BUILT_IN_ROLES)).toBe("ready");
    expect(columnOf({ ...planned, state: "cancelled" }, BUILT_IN_ROLES)).toBe("done");
  });

  it("says what each checkpoint waits for", () => {
    expect(gateStatus(planned, "plan")).toBe("Plan ready. Waiting for your OK");
    expect(gateStatus(planned, "delivery")).toBe("Reviews done. Waiting for your OK to ship");
  });

  it("keeps an unverified acceptance item at the delivery decision", () => {
    const task = copy({ brief: { ...planned.brief!, acceptance: [{ text: "A real session can write safely", verification: "blocked", reason: "The account limit prevented a session." }] } });
    expect(gateTitle(task, "delivery")).toContain("1 acceptance check could not be verified");
    expect(gateStatus(task, "delivery")).toBe("1 acceptance check could not be verified. Your call");
  });

  it("sends a delivery back to the builder, and a plan back to the planner", () => {
    const delivery = copy({ stageIndex: stages.length - 1, sub: 2 });
    afterChangesAsked(delivery, "delivery", "The greeting is gone", 0);
    expect([delivery.stageIndex, delivery.fixing, delivery.sentBack, delivery.sub]).toEqual([at((stage) => stage.roleId === "builder"), true, 1, 0]);

    const plan = copy({ stageIndex: 0 });
    afterChangesAsked(plan, "plan", "Smaller, please", 0);
    expect([plan.stageIndex, plan.plan]).toEqual([-1, undefined]);
  });

  it("ends a design round settled, in another round, or with the architects disagreeing", () => {
    const converge = { ...stages[0]!, kind: "converge" as const, maxRounds: 3 };
    expect(designRoundEnd(0, 1, converge)).toBe("settled");
    expect(designRoundEnd(2, 1, converge)).toBe("next round");
    expect(designRoundEnd(1, 3, converge)).toBe("disagreement");
  });

  it("ends a review round back at the builder, passed, or with rounds used up", () => {
    const chain = at((stage) => stage.kind === "review-chain");
    const review = { ...stages[chain]!, maxRounds: 2 };
    expect(reviewRoundEnd({ ...planned, stageIndex: chain, findings: [important("fixed")] }, review, 1)).toEqual({ kind: "passed" });
    expect(reviewRoundEnd({ ...planned, stageIndex: chain, findings: [important()] }, review, 1)).toEqual({ kind: "send back", builder: at((stage) => stage.roleId === "builder"), open: 1 });
    expect(reviewRoundEnd({ ...planned, stageIndex: chain, findings: [important()] }, review, 2)).toEqual({ kind: "used up", open: 1 });
  });
});
