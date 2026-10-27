import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { beginRepair } from "@petrina/orchestrator";
import { describe, expect, it } from "bun:test";
import { reviewRecords } from "../../fixtures/review-records.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


async function sharedRecords(owner: EngineCaseOwner) { const root = mkdtempSync(join(owner.root, "petrina-review-records-"));  return reviewRecords(owner, root); }

describe.concurrent("one task across products", () => {
  it("charges only affected products once per repair pass and preserves independent allowances at restart", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const fixture = await sharedRecords(owner), { start, first, second, task } = fixture;
      let engine = fixture.engine;
      try {
        const id = task.id;
        task.state = "paused";
        task.plan = { rationale: "Separate owners with shared verification", plannerProfileId: "sonnet-medium", stages: [
            { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { id: "acceptance", kind: "do", title: "Try it", roleId: "tester", profileIds: ["opus-high"] },
            { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
          ] };
        task.stageIndex = 2;
        task.repositories = [first, second].map((productId) => ({ productId, delivery: "pull-request", completedStages: [] }));
        task.leadProductId = first;
        task.activeProductId = first;
        task.findings = [{ id: "check", text: "Check failed: API", productIds: [second], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" }];
        expect(beginRepair(engine, task, "checks", 2)).toBe(true);
        expect(task.repair!.products).toEqual([second]);
        expect(task.repositories[0]!.checkReturns ?? 0).toBe(0);
        expect(task.repositories[1]!.checkReturns).toBe(1);
        task.stageIndex = 2; delete task.repair;
        expect(beginRepair(engine, task, "checks", 2)).toBe(true);
        expect(task.repositories[1]!.checkReturns).toBe(2);
        await owner.stop(engine); engine = start();
        const restored = engine.task(id)!;
        expect(beginRepair(engine, restored, "checks", 2)).toBe(false);
        expect(restored.repositories![1]!.checkReturns).toBe(2);
        restored.findings = [{ id: "shared", text: "Failed acceptance check: Shared behaviour", productIds: [second, first], severity: "blocking", raisedBy: "tester", confirmedBy: [], status: "open" }];
        expect(beginRepair(engine, restored, "acceptance", 1)).toBe(true);
        expect(restored.repair!.products).toEqual([first, second]);
        expect(restored.repositories!.map((work) => work.acceptanceReturns)).toEqual([1, 1]);
        expect(restored.repositories![1]!.checkReturns).toBe(2);
        expect(restored.rounds).toEqual({});
      } finally { await owner.stop(engine); }

    });
  });

  for (const kind of ["checks", "acceptance"] as const) for (const shared of [false, true]) it(`uses remaining ${kind} tries despite an exhausted owner of ${shared ? "a shared failure" : "a separate failure"}, including restart`, async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const fixture = await sharedRecords(owner), { start, first, second } = fixture;
      let engine = fixture.engine, task = fixture.task;
      try {
        const id = task.id;
        task.plan = { rationale: "Independent repairs", plannerProfileId: "sonnet-medium", stages: [
            { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { id: "test", kind: "do", title: "Try it", roleId: "tester", profileIds: ["opus-high"] },
          ] };
        const field = kind === "checks" ? "checkReturns" : "acceptanceReturns";
        task.repositories = [{ productId: first, delivery: "pull-request", completedStages: [], [field]: 2 }, { productId: second, delivery: "pull-request", completedStages: [] }];
        task.leadProductId = first;
        task.activeProductId = first;
        const text = kind === "checks" ? "Check failed: " : "Failed acceptance check: ";
        task.findings = (shared ? [[first, second]] : [[first], [second]]).map((productIds, index) => ({ id: `failure-${index}`, text: `${text}${index}`, productIds, severity: "blocking", raisedBy: kind === "checks" ? "petrina" : "tester", confirmedBy: [], status: "open" }));
        for (const tries of [1, 2]) {
          expect(beginRepair(engine, task, kind, 1)).toBe(true);
          expect(task.repair).toEqual({ products: [second], index: 0, returnStage: 1, kind });
          expect(task.activeProductId).toBe(second);
          expect(task.repositories!.map((work) => work[field] ?? 0)).toEqual([2, tries]);
          expect(task.findings.every((finding) => finding.status === "open")).toBe(true);
          // The first product remains exhausted regardless of which product the next step addresses.
          delete task.repair;
          task.activeProductId = first;
          engine.commitNow();
          await owner.stop(engine); engine = start(); task = engine.task(id)!;
        }
        expect(beginRepair(engine, task, kind, 1)).toBe(false);
        expect(task.repositories!.map((work) => work[field])).toEqual([2, 2]);
        expect(task.findings.every((finding) => finding.status === "open")).toBe(true);
      } finally { await owner.stop(engine); }

    });
  });
});
