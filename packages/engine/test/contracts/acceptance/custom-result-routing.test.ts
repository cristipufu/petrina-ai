import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import { removeDir, type World } from "../../support.js";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("explicit repository execution contexts", () => {
  it("routes check and final acceptance failures to a build-result role and retains its PR context", async () => {
    const { engine, task } = await fixture("result-routing", { git: ["first"] });
    const repository = task.repositories![0]!;
    delete task.repositories;
    task.repository = repository;
    repository.branch = "main";
    repository.delivery = "pull-request";
    repository.report = { summary: "Existing build", changes: [], title: "Custom builder title", description: "The custom builder's saved PR description" };
    const builder = { ...engine.role("builder")!, id: "implementer", name: "Implementer" };
    const tester = { ...engine.role("tester")!, id: "acceptance-specialist", name: "Acceptance specialist" };
    engine.s.roles.push(builder, tester);
    const build = { id: "build", title: "Implement", kind: "do" as const, roleId: builder.id, profileIds: ["sol-high"] };
    const test = { id: "test", title: "Test", kind: "do" as const, roleId: tester.id, profileIds: ["sol-high"] };
    task.plan = { rationale: "Custom result contracts", plannerProfileId: "sol-high", stages: [build, test, { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] }] };
    task.brief = { summary: "The task", forUsers: [], areas: [], risks: [], acceptance: [{ text: "The product works" }] };
    const scope = executionFor(task);
    task.stageIndex = 2;
    expect(engine["checks"].backToBuilder(scope, "before testing")).toBe(true);
    expect(task.stageIndex).toBe(0);
    expect(repository.checkReturns).toBe(1);
    expect(engine["updates"].message(scope)).toContain("Implementer on Codex");
    expect(engine["context"]["report"](scope, builder.id)).toContainEqual({ title: "The pull request description you wrote last time", body: repository.report.description! });
    task.stageIndex = 1;
    task.retest = true;
    const turn = spyOn(engine["turns"], "turn").mockImplementation(async (_scope, _role, _profile, _given, schema) =>
      schema.parse({ summary: "A confirmed acceptance failure", checks: [{ text: "The product works", result: "fail", evidence: "Reproduced the broken behavior" }], learnings: [] }));
    try {
      expect(await engine["work"].runDo(scope, test, new AbortController().signal)).toBe("continue");
      expect(task.stageIndex).toBe(0);
      expect(task.fixing).toBe(true);
      expect(repository.acceptanceReturns).toBe(1);
      expect(task.findings.some(finding => finding.text.includes("Failed acceptance check") && finding.status === "open")).toBe(true);
      task.stageIndex = 2;
      repository.shipping = { moves: 0, failures: 0 };
      expect(await engine["shipping"]["preparationFailed"](scope, "Version checks failed", new AbortController().signal)).toBe("continue");
      expect(task.stageIndex).toBe(0);
      expect(task.fixing).toBe(true);
    } finally { turn.mockRestore(); await engine.shutdown(); }
  });
});
