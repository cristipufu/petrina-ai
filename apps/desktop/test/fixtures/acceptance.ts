import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { oneTaskFixture } from "./state";
import { displayTask, type State, type JourneyStep } from "@petrina/core";

export function acceptanceFixture(custom = false) {
  const state: State = oneTaskFixture(1_000_000_000_000);
  const task = state.tasks[0]!;
  task.id = "pricing-refresh"; task.state = "needs-you"; task.column = "ready"; task.stageIndex = 2;
  const tester = custom ? "quality-partner" : "tester";
  const builder = custom ? "repair-partner" : "builder";
  if (custom) state.roles = [...state.roles,
    { ...state.roles.find((role) => role.result === "checks")!, id: tester, name: "Quality partner" },
    { ...state.roles.find((role) => role.result === "build")!, id: builder, name: "Repair partner" },
  ];
  const checks = Array.from({ length: 25 }, (_, index) => ({ text: `Acceptance requirement ${index + 1}`, result: index < 18 ? "pass" as const : "fail" as const, evidence: `Original observation ${index + 1}`, ...(index >= 18 ? { reason: `Original failure reason ${index + 1}` } : {}) }));
  const base = { round: 1, sub: 0, startedAt: state.now - 1000, endedAt: state.now - 900, end: "done" as const };
  task.journey = [
    { ...base, id: "j14", kind: "agent", roleId: tester, profileId: "sol-high", acceptanceChecks: checks, agentResults: [{ roleId: tester, profileId: "sol-high", at: state.now - 900, value: {}, versions: { [task.productId]: "tested-tree" } }] },
    { ...base, id: "repair", kind: "agent", roleId: builder, profileId: "sol-high", fixing: true, trigger: { after: "j14", reason: "Acceptance failures" }, buildVersions: { [task.productId]: "repaired-tree" }, startedAt: state.now - 800, endedAt: state.now - 700 },
    { ...base, id: "j65", kind: "petrina", work: "checks", startedAt: state.now - 600, endedAt: state.now - 500, productChecks: [
      ...["Type check", "Web build", "Desktop shell"].map(name => ({ name, result: "pass" as const, run: { name, command: `check ${name}`, ms: 100, ok: true, output: "", execution: completeCheckExecution(0) } })),
      { name: "Tests", result: "fail", detail: "First recorded timeout diagnostic\nSecond recorded timeout diagnostic", run: { name: "Tests", command: "check Tests", ms: 100, ok: false, output: "First recorded timeout diagnostic\nSecond recorded timeout diagnostic", execution: completeCheckExecution(7) } },
    ] },
    { ...base, id: "command-repair", kind: "agent", roleId: builder, fixing: true, trigger: { after: "j65", reason: "Automated check failed" }, startedAt: state.now - 400, endedAt: state.now - 300 },
  ];
  task.findings = [];
  task.brief = { summary: "Acceptance evidence example", forUsers: [], areas: [], risks: [], acceptance: checks.map((check) => ({ text: check.text, verification: check.result === "pass" ? "passed" : "failed", met: check.result === "pass" })) };
  task.repository = { productId: task.productId, delivery: "pull-request", lessons: [], checks: { at: state.now - 500, tree: "repaired-tree", current: true, results: [] } };
  delete task.repositories;
  const displayed = displayTask(task);
  state.tasks = state.tasks.map((entry) => entry.id === task.id ? displayed : entry);
  return { state, task: displayed, checks, base, tester, builder };
}

export function laterTester(fixture: ReturnType<typeof acceptanceFixture>): JourneyStep {
  return { ...fixture.base, id: "later-tester", kind: "agent", roleId: fixture.tester, startedAt: fixture.state.now - 200, endedAt: fixture.state.now - 100,
    acceptanceChecks: fixture.checks.map((check, index) => ({ ...check, result: index === 24 ? "blocked" : "pass", evidence: index === 24 ? undefined : `New observation ${index + 1}`, reason: index === 24 ? "Account unavailable" : undefined })),
    agentResults: [{ roleId: fixture.tester, profileId: "sol-high", at: fixture.state.now - 100, value: {}, versions: { [fixture.task.productId]: "repaired-tree" } }],
  };
}
