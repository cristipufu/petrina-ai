import { expect, it } from "vitest";
import { BUILT_IN_ROLES, DEFAULT_PROFILES } from "@petrina/core";
import { beginRepair, type RepairHost, type RuntimeTask } from "../../../src/index.js";
import { repairHost, repairTask } from "../../fixtures/tasks.js";

type Finding = RuntimeTask["findings"][number];
const finding = (kind: "checks" | "acceptance" | "review", ids: string[], id = "failure"): Finding => ({
  id, text: kind === "checks" ? "Check failed: Product tests" : kind === "acceptance" ? "Failed acceptance check: Guest view" : "The guest view loses its data",
  productIds: ids, severity: "blocking", raisedBy: kind === "checks" ? "petrina" : "reviewer", confirmedBy: [], status: "open",
});

it.each(["checks", "acceptance"] as const)("charges only affected %s owners once, retaining independent allowances", kind => {
  const task = repairTask(), { host, checkpoints } = repairHost();
  const field = kind === "checks" ? "checkReturns" : "acceptanceReturns";
  task.findings = [finding(kind, ["b"])];
  task.repositories![0]!.checkReturns = 1;
  const rounds = structuredClone(task.rounds), findings = structuredClone(task.findings);
  for (const tried of [1, 2]) {
    task.stageIndex = 2;
    expect(beginRepair(host, task, kind, 2)).toBe(true);
    expect(task.repair).toEqual({ products: ["b"], index: 0, returnStage: 2, kind });
    expect(task.repositories![1]![field]).toBe(tried);
    expect(task.repositories![0]!.checkReturns).toBe(1);
    expect(task.repositories![0]!.acceptanceReturns).toBeUndefined();
    expect(task.stageIndex).toBe(0); expect(task.activeProductId).toBe("b");
    expect(checkpoints).toHaveLength(tried);
    expect(checkpoints.at(-1)!.repair).toEqual(task.repair);
  }
  const before = structuredClone(task);
  expect(beginRepair(host, task, kind, 2)).toBe(false);
  expect(task).toEqual(before); expect(checkpoints).toHaveLength(2);
  expect(task.rounds).toEqual(rounds); expect(task.findings).toEqual(findings);
});

it.each([
  ["checks", false], ["checks", true], ["acceptance", false], ["acceptance", true],
] as const)("keeps remaining %s tries when another owner is exhausted (shared finding: %s)", (kind, shared) => {
  const task = repairTask(), { host, checkpoints } = repairHost();
  const field = kind === "checks" ? "checkReturns" : "acceptanceReturns";
  task.repositories![0]![field] = 2;
  task.findings = (shared ? [["a", "b"]] : [["a"], ["b"]]).map((ids, index) => finding(kind, ids, `f${index}`));
  for (const used of [1, 2]) {
    expect(beginRepair(host, task, kind, 1)).toBe(true);
    expect(task.repair).toEqual({ products: ["b"], index: 0, returnStage: 1, kind });
    expect(task.repositories!.map(work => work[field])).toEqual([2, used]);
  }
  expect(beginRepair(host, task, kind, 1)).toBe(false);
  expect(checkpoints).toHaveLength(2);
  expect(task.findings.every(finding => finding.status === "open")).toBe(true);
});

it("orders the lead first, clears only its conversation and marks final acceptance repairs", () => {
  const task = repairTask(), { host, checkpoints } = repairHost();
  task.leadProductId = "b"; task.sub = 3;
  const conversation = { step: "prior", roleId: "builder", profileId: "builder", toolId: "codex", model: "sol", sessionId: "saved", startedAt: 1 };
  task.repositories!.forEach(work => { work.conversation = { ...conversation }; });
  task.findings = [finding("acceptance", ["a", "b"])];
  expect(beginRepair(host, task, "acceptance", 1, { final: true })).toBe(true);
  expect(task.repair).toEqual({ products: ["b", "a"], index: 0, returnStage: 1, kind: "acceptance", final: true });
  expect(task.activeProductId).toBe("b"); expect(task.sub).toBe(0); expect(task.fixing).toBe(true);
  expect(task.repositories![0]!.conversation).toEqual(conversation);
  expect(task.repositories![1]!.conversation).toBeUndefined();
  expect(checkpoints[0]!.repositories!.map(work => work.acceptanceReturns)).toEqual([1, 1]);
});

it("keeps review repairs independent of exhausted check/acceptance allowances and covered findings", () => {
  const task = repairTask(), { host } = repairHost();
  task.acceptanceBlocked = true;
  task.repositories!.forEach(work => { work.checkReturns = 2; work.acceptanceReturns = 2; });
  task.findings = [finding("acceptance", ["a"]), finding("review", ["a"], "covered"), finding("review", ["b"], "current")];
  expect(beginRepair(host, task, "review", 2, { covered: new Set(["covered"]), final: true })).toBe(true);
  expect(task.repair).toEqual({ products: ["b"], index: 0, returnStage: 2, kind: "review" });
  expect(task.repositories!.map(work => [work.checkReturns, work.acceptanceReturns])).toEqual([[2, 2], [2, 2]]);
});

it.each(["single owner", "no builder", "settled findings", "minor findings", "unknown owners", "published owners"])("does no work for %s", variant => {
  const task = repairTask(variant !== "single owner"), { host, checkpoints } = repairHost();
  task.findings = [finding("review", ["a", "b"])];
  if (variant === "no builder") task.plan!.stages[0]!.roleId = "tester";
  if (variant === "settled findings") task.findings[0]!.status = "fixed";
  if (variant === "minor findings") task.findings[0]!.severity = "suggestion";
  if (variant === "unknown owners") task.findings[0]!.productIds = ["a", "unapproved"];
  if (variant === "published owners") task.repositories!.forEach(work => { work.landed = { branch: "main", sha: "published" }; });
  const before = structuredClone(task);
  expect(beginRepair(host, task, "review", 2)).toBe(false);
  expect(task).toEqual(before); expect(checkpoints).toEqual([]);
});

it("uses the task-owned maintenance role even after it leaves the role library", () => {
  const task = repairTask(), { host, roles } = repairHost();
  const role = { ...BUILT_IN_ROLES.find(role => role.result === "build")!, id: "saved-maintenance" };
  task.maintenance = { role, routineId: "routine", routineName: "Routine", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", profile: DEFAULT_PROFILES[0]!, product: { id: "a", name: "Shop", repo: "local/shop", tone: "blue" } };
  task.plan!.stages[0]!.roleId = role.id;
  task.findings = [finding("review", ["b"])];
  expect(beginRepair(host, task, "review", 2)).toBe(true);
  expect(roles).toEqual([{ id: role.id, task }]);
});

it("propagates checkpoint failure rather than reporting an unrecorded repair as successful", () => {
  const task = repairTask(), failure = new Error("Checkpoint unavailable");
  const { host } = repairHost(); let calls = 0;
  const broken: RepairHost = { role: host.role, commitNow() { calls++; throw failure; } };
  task.findings = [finding("checks", ["b"])];
  expect(() => beginRepair(broken, task, "checks", 2)).toThrow(failure);
  expect(calls).toBe(1);
});
