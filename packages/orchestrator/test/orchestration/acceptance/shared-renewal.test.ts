import { describe, expect, it } from "vitest";
import { executionFor, prepareDeliveryReturn, routeAcceptance } from "../../../src/index.js";
import { acceptanceFailure, acceptanceHost, acceptanceTask } from "../../fixtures/acceptance.js";

describe("shared-task repair regressions", () => {
  it("bounds a still-failing shared acceptance pass after an asymmetric delivery send-back", () => {
    const task = acceptanceTask(), { host, events } = acceptanceHost();
    const scope = executionFor(task);
    acceptanceFailure(task, task.repositories!.map(work => work.productId));
    task.repositories![0]!.acceptanceReturns = 2;
    task.repositories![1]!.acceptanceReturns = 1;
    task.acceptancePassed = false;
    task.acceptanceBlocked = true;
    // Checkpoint owns the move to the Builder; the controller owns renewal/routing from that input.
    task.stageIndex = 0;
    expect(prepareDeliveryReturn(host, scope, { fromCheck: 4, now: 200, note: "Try a new approach across both products" })).toBe("waiting");
    expect(task.repositories!.map(work => work.acceptanceReturns ?? 0)).toEqual([0, 0]);
    for (const allowance of [1, 2]) {
      // A new completed Tester result is the input. Builder/Git execution is covered by the real journey.
      task.stageIndex = 1;
      delete task.repair;
      expect(routeAcceptance(host, scope, { failed: 1, requiredGap: false, requiredCount: 1, restored: false })).toBe("continue");
      expect(task.repositories!.map(work => work.acceptanceReturns)).toEqual([allowance, allowance]);
      expect(task).toMatchObject({ repair: { products: task.repositories!.map(work => work.productId) } });
    }
    task.stageIndex = 1;
    delete task.repair;
    expect(routeAcceptance(host, scope, { failed: 1, requiredGap: false, requiredCount: 1, restored: false })).toBe("continue");
    // These were the repeated native journey's final assertions. Its first exhausted cycle and restart remain real.
    expect(task.error).toBeUndefined();
    expect(task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, 2]);
    expect(task.acceptancePassed).toBe(false);
    expect(task.acceptanceBlocked).toBe(true);
    expect(task.repair).toBeUndefined();
    expect(task.stageIndex).toBe(2);
    expect(events.at(-2)).toMatchObject({ kind: "note", tone: "warn", text: expect.stringContaining("remaining reviews run first") });
  });
});
