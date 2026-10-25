import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { versionsOf } from "../../../src/repositories.js";
import { beginRepair, executionFor } from "@petrina/orchestrator";
import { git, removeDir, type World } from "../../support.js";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("explicit repository execution contexts", () => {
  it("uses frozen repair roles, complete findings and real acceptance trees without automated checks", async () => {
    const { engine, task } = await fixture("repair-context", { git: ["first","second"] });
    try {
      const role = { ...engine.role("builder")!, id: "saved-maintenance" };
      task.maintenance = { routineId: "routine", routineName: "Routine", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", role, profile: engine.s.profiles[0]!, product: engine.s.products[0]! };
      task.plan = { rationale: "Repair", plannerProfileId: "sol-high", stages: [{ id: "build", title: "Maintain", kind: "do", roleId: role.id, profileIds: ["sol-high"] }] };
      task.findings = [{ id: "failure", text: "The defect", severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"], productIds: ["first"], steps: "Exact reproduction", votes: [{ by: "grok-high", toolId: "grok", verdict: "real", reason: "Independent diagnostic" }] }];
      expect(beginRepair(engine, task, "review", 1)).toBe(true);
      const repair = await engine["context"].sectionsFor(executionFor(task), role.id);
      const body = repair.find(section => section.title.startsWith("Review findings"))!.body;
      expect(body).toContain("Exact reproduction");
      expect(body).toContain("Independent diagnostic");
      const versions = await versionsOf(task);
      task.retest = true;
      task.journey = [{ id: "prior-test", kind: "agent", roleId: "tester", round: 1, sub: 0, startedAt: 1, endedAt: 3, agentResults: [{ roleId: "tester", profileId: "sol-high", at: 2, versions, value: { summary: "Earlier incomplete acceptance", checks: [] } }] }];
      const read = async () => (await engine["context"].sectionsFor(executionFor(task), "tester")).find(section => section.title === "Why acceptance testing runs again")!.body;
      expect(await read()).toContain("Products with changed trees: none");
      await git(task.repositories![1]!.worktree!, "commit", "--allow-empty", "-m", "Same tree");
      expect(await read()).toContain("Products with changed trees: none");
      writeFileSync(join(task.repositories![1]!.worktree!, "changed.txt"), "Actual change");
      await git(task.repositories![1]!.worktree!, "add", "changed.txt");
      await git(task.repositories![1]!.worktree!, "commit", "-m", "Changed tree");
      expect(await read()).toContain("Products with changed trees: second");
    } finally { await engine.shutdown(); }
  });
});
