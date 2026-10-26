import { expect, it } from "vitest";
import { beginRepair } from "../../../src/repair.js";
import { repairHost, repairTask } from "../../fixtures/tasks.js";

it("charges only the currently eligible failed owner while retaining a blocked sibling's old finding and budget", () => {
  const task = repairTask(), { host, checkpoints } = repairHost();
  task.findings = ["a", "b"].map(id => ({ id: `failure-${id}`, text: "Check failed: Tests", productIds: [id], raisedBy: "petrina", severity: "blocking", confirmedBy: [], status: "open" }));
  task.repositories![0]!.checkReturns = 1;
  expect(beginRepair(host, task, "checks", 2, { eligibleProducts: new Set(["b"]) })).toBe(true);
  expect(task.repair!.products).toEqual(["b"]);
  expect(task.repositories!.map(work => work.checkReturns)).toEqual([1, 1]);
  expect(task.findings.every(finding => finding.status === "open")).toBe(true);
  expect(checkpoints).toHaveLength(1);
});

it("an empty live eligibility set performs no repair, even with old blocking failures and remaining allowance", () => {
  const task = repairTask(), { host, checkpoints } = repairHost();
  task.findings = [{ id: "failure", text: "Check failed: Tests", productIds: ["a"], raisedBy: "petrina", severity: "blocking", confirmedBy: [], status: "open" }];
  const before = structuredClone(task);
  expect(beginRepair(host, task, "checks", 2, { eligibleProducts: new Set() })).toBe(false);
  expect(task).toEqual(before);
  expect(checkpoints).toEqual([]);
});
