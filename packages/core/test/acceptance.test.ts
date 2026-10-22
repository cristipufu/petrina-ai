import { describe, expect, it } from "vitest";
import { acceptanceSummary } from "../src/acceptance.js";
import { createDemoState, createPortfolioDemo } from "../src/demo.js";
import { journeyView } from "../src/journey.js";
import { BUILT_IN_ROLES } from "../src/library.js";
import { displayTask } from "../src/repositories.js";
import { Simulator } from "../src/sim.js";
import type { JourneyStep, Role } from "../src/model.js";

const roles: readonly Role[] = [...BUILT_IN_ROLES,
  { ...BUILT_IN_ROLES.find((role) => role.result === "checks")!, id: "custom-test", name: "Quality partner" },
  { ...BUILT_IN_ROLES.find((role) => role.result === "build")!, id: "custom-build", name: "Repair partner" },
];
const roleFor = (id?: string) => roles.find((role) => role.id === id);
const step = (value: Partial<JourneyStep>): JourneyStep => ({ id: "step", kind: "agent", round: 1, sub: 0, startedAt: 10, endedAt: 20, end: "done", ...value });

function fixture(roleId = "tester") {
  const task = createDemoState(1_000_000_000_000).tasks[0]!;
  task.brief = { summary: "", forUsers: [], areas: [], risks: [], acceptance: [
    { text: "The total is correct", verification: "passed", met: true },
    { text: "Delivery is retained", verification: "failed", met: false },
    { text: "A real account works", verification: "blocked", reason: "Account unavailable" },
  ] };
  task.repository = { productId: task.productId, lessons: [], delivery: "pull-request", checks: { at: 20, tree: "tested-tree", current: true, results: [] } };
  delete task.repositories;
  task.journey = [step({ id: "tester", roleId, acceptanceChecks: [
    { text: "The total is correct", result: "pass", evidence: "The total includes delivery" },
    { text: "Delivery is retained", result: "fail", evidence: "Changing delivery reset the choice", reason: "Choice was lost" },
    { text: "A real account works", result: "blocked", reason: "Account unavailable" },
  ], agentResults: [{ roleId, profileId: "sol-high", at: 20, value: {}, versions: { [task.productId]: "tested-tree" } }] })];
  return task;
}

describe("acceptance evidence attribution", () => {
  it.each(["tester", "custom-test"])("keeps current %s passes and failures when a single-product task is prepared for the screen", (roleId) => {
    const task = fixture(roleId);
    const displayed = displayTask(task);
    expect(displayed.repository).toBeUndefined();
    expect(displayed.checks).toEqual(task.repository!.checks);
    expect(acceptanceSummary(displayed, roleFor)).toEqual(acceptanceSummary(task, roleFor));
    expect(acceptanceSummary(displayed, roleFor).items.map((item) => item.current)).toEqual([true, true, false]);
    task.state = "done";
    expect(acceptanceSummary(displayTask(task), roleFor).items.map((item) => item.current)).toEqual([true, true, false]);
  });

  it("keeps an unchanged displayed task fully verified after a later Tester passes", () => {
    const task = fixture("custom-test");
    const earlier = JSON.parse(JSON.stringify(task.journey![0]));
    task.journey = [...task.journey!, step({ roleId: "custom-build", buildVersions: { [task.productId]: "repaired-tree" } }), step({ roleId: "custom-test", acceptanceChecks: task.journey![0]!.acceptanceChecks!.map((check) => ({ ...check, result: "pass", evidence: "Later successful probe", reason: undefined })), agentResults: [{ roleId: "custom-test", profileId: "sol-high", at: 40, value: {}, versions: { [task.productId]: "repaired-tree" } }] })];
    task.repository!.checks = { at: 40, tree: "repaired-tree", current: true, results: [] };
    expect(acceptanceSummary(displayTask(task), roleFor).current).toBe(true);
    expect(task.journey![0]).toEqual(earlier);
    task.repository!.checks!.tree = "changed-again";
    expect(acceptanceSummary(displayTask(task), roleFor).items.every((item) => !item.current)).toBe(true);
  });

  it("retains each item's verification only for its own tested products", () => {
    const task = fixture();
    const a = task.productId;
    task.repositories = [{ ...task.repository!, completedStages: [] }, { productId: "b", delivery: "local", completedStages: [], checks: { at: 40, tree: "new-b", current: true, results: [] } }];
    delete task.repository;
    task.journey![0]!.agentResults![0]!.versions = { [a]: "tested-tree", b: "old-b" };
    task.brief!.acceptance = task.brief!.acceptance.map((item, i) => ({ ...item, productIds: i === 0 ? [a] : i === 1 ? ["b"] : [a, "b"], versions: i === 0 ? { [a]: "tested-tree" } : i === 1 ? { b: "old-b" } : { [a]: "tested-tree", b: "old-b" } }));
    task.journey = [...task.journey!, step({ roleId: "custom-build", buildVersions: { b: "new-b" } })];
    const summary = acceptanceSummary(displayTask(task), roleFor);
    expect(summary.items.map((item) => item.current)).toEqual([true, false, false]);
    expect(summary.partlyCurrent).toBe(true);
    task.brief!.acceptance[0]!.versions = { [a]: "unrelated-test-version" };
    expect(acceptanceSummary(displayTask(task), roleFor).items[0]!.current).toBe(false);
  });

  it("distinguishes testing not started, in progress, and missing completed evidence", () => {
    const task = fixture();
    task.journey = [];
    expect(acceptanceSummary(displayTask(task), roleFor)).toMatchObject({ started: false, running: false, current: false });
    task.state = "running";
    task.journey = [step({ roleId: "custom-test", endedAt: undefined, end: undefined })];
    expect(acceptanceSummary(displayTask(task), roleFor)).toMatchObject({ started: true, running: true, current: false });
    task.journey[0]!.endedAt = 30;
    expect(acceptanceSummary(displayTask(task), roleFor)).toMatchObject({ started: true, running: false, current: false });
    expect(acceptanceSummary(displayTask(task), roleFor).items.every((item) => item.check === undefined)).toBe(true);
    delete task.journey;
    expect(acceptanceSummary(displayTask(task), roleFor)).toMatchObject({ started: false, notStarted: false, running: false, current: false });
  });
  it.each(["tester", "custom-test"])("keeps %s results on their original step through commands, reuse and incomplete runs", (roleId) => {
    const task = fixture(roleId);
    const saved = JSON.parse(JSON.stringify(task.journey![0]!.acceptanceChecks));
    const commands = [{ name: "Types", result: "pass" as const }, { name: "Tests", result: "fail" as const, detail: "Two original timeout diagnostics" }];
    task.journey = [...task.journey!,
      step({ id: "checks", kind: "petrina", work: "checks", productChecks: commands }),
      step({ id: "reuse", kind: "petrina", work: "check-reuse", productChecks: commands.map((check) => ({ ...check, reusedAt: 30, source: { stepId: "checks", attemptId: "run-0", checkId: "tests" } })) }),
      step({ id: "running", roleId, endedAt: undefined, end: undefined }),
      step({ id: "stopped", roleId, end: "cancelled" }),
      step({ id: "interrupted", kind: "petrina", work: "checks", productChecks: [{ name: "Tests", result: "stopped", detail: "Original interruption" }] }),
      step({ id: "missing", roleId }),
    ];
    task.brief!.acceptance = task.brief!.acceptance.map((item) => ({ ...item, verification: "passed", met: true }));
    const view = journeyView(task, { roles, profiles: [], inbox: [], tasks: [task] });
    expect(view.nodes.find((node) => node.id === "tester")?.acceptanceChecks).toEqual(saved);
    for (const id of ["checks", "reuse", "running", "stopped", "interrupted", "missing"]) expect(view.nodes.find((node) => node.id === id)?.acceptanceChecks).toBeUndefined();
    expect(view.nodes.find((node) => node.id === "checks")?.productChecks).toEqual(commands);
    expect(view.nodes.find((node) => node.id === "reuse")?.productChecks?.[1]).toMatchObject({ reusedAt: 30, source: { stepId: "checks", attemptId: "run-0", checkId: "tests" }, detail: "Two original timeout diagnostics" });
  });

  it.each(["builder", "custom-build"])("makes both passes and failures historical after %s changes the work", (roleId) => {
    const task = fixture();
    const saved = JSON.parse(JSON.stringify(task.journey![0]));
    task.journey = [...task.journey!, step({ id: "repair", roleId, buildVersions: { [task.productId]: "repaired-tree" }, builderReturn: { productId: task.productId, changed: true, claimedFixes: 1, outcome: "Fix claimed" } })];
    task.repository!.checks = { at: 40, tree: "repaired-tree", current: true, results: [{ name: "Tests", command: "test", ok: true, ms: 1, output: "Passed" }] };
    const summary = acceptanceSummary(task, roleFor);
    expect(summary.current).toBe(false);
    expect(summary.items.map((item) => [item.check?.result, item.current])).toEqual([["pass", false], ["fail", false], ["blocked", false]]);
    expect(task.journey![0]).toEqual(saved);
  });

  it("retains applicable verification for proven unchanged work and read-only review", () => {
    const task = fixture();
    task.journey = [...task.journey!, step({ roleId: "custom-build", buildVersions: { [task.productId]: "tested-tree" }, builderReturn: { productId: task.productId, changed: false, claimedFixes: 1, outcome: "No code changes" } }), step({ roleId: "code-reviewer" })];
    expect(acceptanceSummary(task, roleFor).items.map((item) => item.current)).toEqual([true, true, false]);
  });

  it("retains verification when a later repair restores the exact tested contents", () => {
    const task = fixture();
    task.journey = [...task.journey!, step({ roleId: "builder", buildVersions: { [task.productId]: "changed-tree" } }), step({ roleId: "custom-build", buildVersions: { [task.productId]: "tested-tree" } })];
    expect(acceptanceSummary(task, roleFor).items.map((item) => item.current)).toEqual([true, true, false]);
  });

  it("keeps the last recorded summary when a later Tester stops without a result", () => {
    const task = fixture();
    task.journey = [...task.journey!, step({ roleId: "custom-build", buildVersions: { [task.productId]: "changed-tree" } }), step({ roleId: "custom-test", end: "cancelled" })];
    task.repository!.checks = { at: 40, tree: "changed-tree", current: true, results: [] };
    expect(acceptanceSummary(task, roleFor).items.map((item) => [item.check?.result, item.current])).toEqual([["pass", false], ["fail", false], ["blocked", false]]);
  });

  it.each(["unknown version", "running editor", "missing step evidence", "missing version", "unavailable version", "not current"])("leaves uncertain evidence unverified: %s", (variant) => {
    const task = fixture();
    if (variant === "unknown version") task.journey = [...task.journey!, step({ roleId: "custom-build" })];
    if (variant === "running editor") task.journey = [...task.journey!, step({ roleId: "custom-build", endedAt: undefined, buildVersions: { [task.productId]: "tested-tree" } })];
    if (variant === "missing step evidence") delete task.journey![0]!.acceptanceChecks;
    if (variant === "missing version") delete task.journey![0]!.agentResults;
    if (variant === "unavailable version") task.journey![0]!.agentResults![0]!.versions = { [task.productId]: "unavailable" };
    if (variant === "not current") task.repository!.checks!.current = false;
    task.state = "done";
    task.column = "ready";
    task.acceptancePassed = true;
    expect(acceptanceSummary(task, roleFor).items.every((item) => !item.current)).toBe(true);
    if (variant === "missing step evidence") expect(acceptanceSummary(task, roleFor).items.every((item) => !item.check)).toBe(true);
  });

  it("uses the later Tester's own version and results without rewriting history", () => {
    const task = fixture();
    const saved = JSON.parse(JSON.stringify(task.journey![0]));
    task.journey = [...task.journey!, step({ id: "repair", roleId: "custom-build", buildVersions: { [task.productId]: "repaired-tree" } }), step({ id: "later-tester", roleId: "custom-test", acceptanceChecks: [
      { text: "The total is correct", result: "pass", evidence: "Rechecked total" },
      { text: "Delivery is retained", result: "pass", evidence: "Delivery choice now remains" },
      { text: "A real account works", result: "blocked", reason: "Account still unavailable" },
    ], agentResults: [{ roleId: "custom-test", profileId: "sol-high", at: 40, value: {}, versions: { [task.productId]: "repaired-tree" } }] })];
    task.repository!.checks = { at: 40, tree: "repaired-tree", current: true, results: [] };
    expect(acceptanceSummary(task, roleFor).items.map((item) => [item.check?.result, item.current])).toEqual([["pass", true], ["pass", true], ["blocked", false]]);
    task.repository!.checks!.tree = "another-tree";
    expect(acceptanceSummary(task, roleFor).items.every((item) => !item.current)).toBe(true);
    expect(task.journey![0]).toEqual(saved);
  });
});


it.each(["default", "portfolio"])("the %s demo records acceptance on each completed Tester and retains current examples", (demo) => {
  const state = demo === "default" ? createDemoState(1_000_000_000_000) : createPortfolioDemo(1_000_000_000_000).state;
  const findRole = (id?: string) => state.roles.find((role) => role.id === id);
  const tested = state.tasks.filter((task) => task.journey?.some((step) => step.kind === "agent" && step.endedAt !== undefined && findRole(step.roleId)?.result === "checks" && task.brief?.acceptance.length));
  expect(tested.length).toBeGreaterThan(0);
  for (const task of tested) {
    for (const step of task.journey!.filter((step) => step.kind === "agent" && step.endedAt !== undefined && findRole(step.roleId)?.result === "checks")) {
      expect(step.acceptanceChecks?.length).toBe(task.brief!.acceptance.length);
      expect(step.acceptanceChecks!.every((check) => check.evidence?.startsWith("Demo scenario:"))).toBe(true);
      expect(step.agentResults![0]!.versions).toBeDefined();
    }
    expect(task.journey!.filter((step) => step.work === "checks").every((step) => step.acceptanceChecks === undefined)).toBe(true);
  }
  expect(tested.some((task) => acceptanceSummary(displayTask(task), findRole).current)).toBe(true);
});

it("the simulator records a custom Builder and Tester's versions and acceptance separately from commands", () => {
  const state = createDemoState(1_000_000_000_000);
  const task = displayTask(fixture("custom-test"));
  task.plan = { rationale: "", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "custom-build", profileIds: ["sol-high"] },
    { id: "test", kind: "do", title: "Test", roleId: "custom-test", profileIds: ["sol-high"] },
    { id: "deliver", kind: "gate", title: "Delivery check", roleId: "release-manager", profileIds: [], gate: "delivery" },
  ] };
  Object.assign(task, { state: "waiting", column: "building", stageIndex: 0, sub: 0, rounds: {}, journey: [], findings: [], checks: undefined, agent: undefined, holdsSlot: false });
  const sim = new Simulator({ ...state, tasks: [task], inbox: [], roles, pool: { limit: 1, paused: false, toolCaps: {} } });
  for (let tick = 0; tick < 50 && !sim.getState().inbox.some((item) => item.kind === "delivery"); tick++) sim.tick();
  const completed = sim.getState().tasks[0]!;
  const build = completed.journey!.find((step) => step.roleId === "custom-build")!;
  const tester = completed.journey!.find((step) => step.roleId === "custom-test")!;
  expect(build.buildVersions?.[task.productId]).toBeDefined();
  expect(tester.acceptanceChecks).toHaveLength(3);
  expect(tester.agentResults![0]!.versions).toEqual(build.buildVersions);
  expect(completed.journey!.filter((step) => step.work === "checks")).toHaveLength(1);
  expect(completed.journey!.find((step) => step.work === "checks")!.acceptanceChecks).toBeUndefined();
  expect(acceptanceSummary(completed, roleFor).current).toBe(true);
});
