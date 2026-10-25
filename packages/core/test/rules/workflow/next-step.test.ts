import { summaryAt } from '../../fixtures/summary.js';
import { describe, expect, it } from "vitest";

import type { Stage, Task } from "../../../src/model.js";

import { reviewRoundEnd } from "../../../src/flow.js";

import { nextLine, startClock } from "../../../src/summary.js";

describe("what comes next", () => {
  it("names the remaining role in a mixed review, including roles the coordinator added", () => {
    const { state, task } = summaryAt("builder");
    const custom = { ...state.roles.find((role) => role.id === "code-reviewer")!, id: "added-privacy", name: "Privacy specialist", added: true };
    const stages = task.plan!.stages.map((stage) => stage.kind === "review-chain" ? { ...stage, roleIds: ["code-reviewer", custom.id] } : stage);
    const planned = { ...task, plan: { ...task.plan!, stages } };
    const people = { ...state, roles: [...state.roles, custom] };
    expect(nextLine(people, planned)).toBe("Next: review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    const stageIndex = stages.findIndex((stage) => stage.kind === "review-chain");
    const review = stages[stageIndex]!;
    const paused: Task = { ...planned, state: "paused", stageIndex, sub: 0, hunt: { stageId: review.id, round: 1, reported: { "0": true } } };
    expect(nextLine(people, paused)).toBe("Next: privacy specialist (Codex · sol), then your OK to ship");
    expect(nextLine({ ...people, roles: [...state.roles, { ...custom, name: "Claims reviewer" }] }, paused)).toBe("Next: claims reviewer (Codex · sol), then your OK to ship");
    expect(nextLine(people, { ...paused, hunt: { ...paused.hunt!, reported: { "1": true } } })).toBe("Next: code review (Claude Code · Opus 5.5), then your OK to ship");
  });

  it("predicts the canonical finding-id convergence decision even when blocker counts stay at one", () => {
    const { state, task } = summaryAt("code-reviewer");
    const stage = task.plan!.stages[task.stageIndex]!;
    const original = { id: "earlier", text: "Original bug", severity: "blocking" as const, raisedBy: "sol-high", confirmedBy: [], status: "fixed" as const };
    const fresh = { ...original, id: "new", text: "A distinct new bug", status: "open" as const };
    const progressed: Task = { ...task, rounds: { [stage.id]: 3 }, blockingAfter: { [stage.id]: [1] }, blockingFindingsAfter: { [stage.id]: [[original.id]] }, findings: [original, fresh] };
    expect(reviewRoundEnd(progressed, stage, 3, state.roles).kind).toBe("send back");
    expect(nextLine(state, progressed)).toContain("or fixes by the builder");
    const unchanged: Task = { ...progressed, findings: [{ ...original, status: "open" }] };
    expect(reviewRoundEnd(unchanged, stage, 3, state.roles).kind).toBe("used up");
    expect(nextLine(state, unchanged)).toContain("Next: your call");
    expect(nextLine(state, { ...progressed, rounds: { [stage.id]: 5 } })).toContain("Next: your call");
    expect(reviewRoundEnd({ ...progressed, findings: [] }, stage, 3, state.roles).kind).toBe("passed");
    expect(nextLine(state, { ...progressed, findings: [] })).toContain("or fixes by the builder");
    const maintenanceRole = { ...state.roles.find((role) => role.result === "build")!, id: "saved-maintenance" };
    const maintenance: Task = { ...progressed, plan: { ...progressed.plan!, stages: progressed.plan!.stages.map((entry) => state.roles.find((role) => role.id === entry.roleId)?.result === "build" ? { ...entry, roleId: maintenanceRole.id } : entry) }, maintenance: { routineId: "routine", routineName: "Maintenance", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", role: maintenanceRole, profile: state.profiles[0]!, product: state.products[0]! } };
    expect(reviewRoundEnd(maintenance, stage, 3, state.roles).kind).toBe("send back");
    expect(nextLine(state, maintenance)).toContain("or fixes by the builder");
    const buildIndex = maintenance.plan!.stages.findIndex(entry => entry.roleId === maintenanceRole.id);
    for (const status of ["waiting", "paused"] as const) {
      const fixing: Task = { ...maintenance, state: status, agent: undefined, fixing: true, stageIndex: buildIndex };
      expect(nextLine(state, fixing)).toContain("Next: fixes by the builder");
      // The task's frozen build contract takes precedence over later Library edits too.
      expect(nextLine({ ...state, roles: [...state.roles, { ...maintenanceRole, result: "notes" }] }, fixing)).toContain("Next: fixes by the builder");
    }
  });

  it("names the work still ahead while the Check finder or the Guide keeper prepares it", () => {
    const { state, task: building } = summaryAt("builder");
    expect(nextLine(state, building)).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    const preparing = { ...building.agent!, roleId: "guide-keeper" as const };
    expect(nextLine(state, { ...building, agent: preparing })).toBe("Next: build (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)");
    expect(nextLine(state, { ...building, fixing: true, agent: preparing })).toBe("Next: fixes by the builder (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)");
    const reviewing = summaryAt("code-reviewer").task;
    const duringReview = "Next: your OK to ship, or fixes by the builder if blocking issues are found";
    expect(nextLine(state, reviewing)).toBe(duringReview);
    // A voter is part of the review, so what follows it stays next. Only preparation puts the review back.
    expect(nextLine(state, { ...reviewing, agent: { ...reviewing.agent!, roleId: "verifier" } })).toBe(duringReview);
    expect(nextLine(state, { ...reviewing, agent: { ...reviewing.agent!, roleId: "check-finder" } })).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
  });

  it("names a port review's one reviewer, a security review, and how each delivery goes out", () => {
    const { state, task } = summaryAt("architect");
    const stages = task.plan!.stages;
    const review = stages.findIndex((stage) => stage.kind === "review-chain");
    const waiting: Task = { ...task, state: "waiting", stageIndex: review, sub: 0 };
    expect(nextLine({ ...state, inbox: [] }, waiting)).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    // A port of a change already reviewed: one reviewer, on a tool other than the builder's (Codex).
    const port: Task = { ...waiting, portReview: { from: "a", head: "b", onto: "c", files: [] } };
    expect(nextLine({ ...state, inbox: [] }, port)).toBe("Next: a review of the port (Claude Code · Opus 5.5), then your OK to ship");
    const security: Task = { ...waiting, plan: { ...task.plan!, stages: stages.map((stage) => (stage.kind === "review-chain" ? { ...stage, roleId: "security-reviewer" } : stage)) } };
    expect(nextLine({ ...state, inbox: [] }, security)).toBe("Next: security review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    // At the delivery check: Petrina publishes by itself; a release has its notes written first.
    const check = stages.findIndex((stage) => stage.gate === "delivery");
    const ready: Task = { ...task, state: "waiting", stageIndex: check + 1, sub: 0 };
    expect(nextLine(state, { ...ready, delivery: "local" })).toBe("Next: Petrina commits to main");
    expect(nextLine(state, { ...ready, delivery: "release" })).toBe("Next: release notes (Claude Code · Sonnet 5.5), then Petrina publishes the release");
    const notes: Task = { ...ready, delivery: "release", state: "running", agent: { roleId: "release-manager", profileId: "sonnet-medium", since: 0, step: 0 } };
    expect(nextLine(state, notes)).toBe("Next: Petrina publishes the release");
    expect(nextLine(state, { ...notes, delivery: "pull-request" })).toBeUndefined();
  });

  it("skips acceptance already tried during fixes and names the delivery check after a final test pass", () => {
    const { state, task } = summaryAt("architect");
    const stages = [...task.plan!.stages];
    const build = stages.findIndex((stage) => stage.roleId === "builder");
    stages.splice(build + 1, 0, { id: "test", title: "Test", kind: "do", roleId: "tester", profileIds: ["sol-high"] });
    const fixing: Task = { ...task, plan: { ...task.plan!, stages }, state: "running", stageIndex: build, fixing: true, testedPatch: "earlier" };
    expect(nextLine(state, fixing)).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then final acceptance testing (Codex · sol) if the code changed");
    const tester = { roleId: "tester", profileId: "sol-high", since: 0, step: 0 };
    expect(nextLine(state, { ...fixing, stageIndex: build + 1, retest: true, agent: tester })).toBe("Next: your OK to ship, or fixes by the builder if acceptance checks fail");
    // While Petrina's own checks prepare it, the final test has not started: it still comes first.
    expect(nextLine(state, { ...fixing, stageIndex: build + 1, retest: true, agent: undefined })).toBe("Next: final acceptance testing (Codex · sol), then your OK to ship");
    expect(startClock({ ...fixing, stageIndex: build + 1, fixing: false, retest: true }, "tester", 0).repeat).toBe(true);
  });

  it("names the repair's acceptance test and the reviews still owed, or the final test and the delivery check, during a shared acceptance repair", () => {
    const { state, task } = summaryAt("architect");
    const stages = [...task.plan!.stages];
    const build = stages.findIndex((stage) => stage.roleId === "builder");
    stages.splice(build + 1, 0, { id: "test", title: "Test", kind: "do", roleId: "tester", profileIds: ["sol-high"] });
    const base: Task = { ...task, plan: { ...task.plan!, stages }, state: "running", testedPatch: "earlier", acceptancePassed: false };
    const early: Task = { ...base, stageIndex: build, fixing: true, repair: { products: ["a"], index: 0, returnStage: build + 1, kind: "acceptance" } };
    expect(nextLine(state, early)).toBe("Next: acceptance testing of the repair (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)");
    // A repair of what final testing found goes back to it, then straight to the delivery check.
    expect(nextLine(state, { ...early, repair: { ...early.repair!, final: true } })).toBe("Next: final acceptance testing (Codex · sol), then your OK to ship");
    // Checking the repair: the owed review follows, then the delivery check without inventing another test.
    const tester = { roleId: "tester", profileId: "sol-high", since: 0, step: 0 };
    const checking: Task = { ...base, stageIndex: build + 1, repairCheck: true, agent: tester };
    expect(nextLine(state, checking)).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    expect(startClock(checking, "tester", 0).repeat).toBe(true);
    // The repair is finished and its test has not started: paused, waiting for a slot or while Petrina's own checks
    // prepare it, that test still comes first.
    const repairTest = "Next: acceptance testing of the repair (Codex · sol), then code review (Claude Code · Opus 5.5 and Codex · sol)";
    for (const waiting of ["paused", "waiting", "running"] as const) {
      expect(nextLine({ ...state, inbox: [] }, { ...checking, state: waiting, agent: undefined })).toBe(repairTest);
      expect(nextLine({ ...state, inbox: [] }, { ...checking, state: waiting, agent: undefined, repairCheck: false, retest: true })).toBe("Next: final acceptance testing (Codex · sol), then your OK to ship");
    }
    // Failing product checks before that test send the work back first: the test still follows the check repair.
    const checkRepair: Task = { ...base, stageIndex: build, fixing: true, repairCheck: true, repair: { products: ["a"], index: 0, returnStage: build + 1, kind: "checks" }, agent: { roleId: "builder", profileId: "sol-high", since: 0, step: 0 } };
    expect(nextLine(state, checkRepair)).toBe(repairTest);
    expect(nextLine({ ...state, inbox: [] }, { ...checkRepair, state: "paused", agent: undefined })).toBe("Next: fixes by the builder (Codex · sol), then acceptance testing of the repair (Codex · sol)");
    // A task saved before repairs recorded their route, at a delivery check Petrina added: its reviews have not run, so its
    // test is a repair check and the reviews follow, as the engine routes it.
    const gate = stages.find((stage) => stage.kind === "gate" && stage.gate === "delivery")!;
    const older: Task = { ...checking, repairCheck: false, retest: true, proofDeliveryGate: gate.id };
    expect(nextLine(state, older)).toBe("Next: code review (Claude Code · Opus 5.5 and Codex · sol), then your OK to ship");
    expect(nextLine(state, { ...older, agent: undefined })).toBe(repairTest);
    expect(nextLine(state, { ...older, proofDeliveryGate: undefined })).toBe("Next: your OK to ship, or fixes by the builder if acceptance checks fail");
  });

  it("previews final acceptance with current profiles, without inventing a test when evidence is unchanged or blocked", () => {
    const { state, task } = summaryAt("code-reviewer");
    const stages = [...task.plan!.stages];
    stages.splice(task.stageIndex, 0, { id: "acceptance", title: "Acceptance", kind: "do", roleId: "custom-checker", profileIds: ["sol-high"] });
    const customState = { ...state, roles: [...state.roles, { ...state.roles.find((role) => role.result === "checks")!, id: "custom-checker" }] };
    const reviewing: Task = { ...task, stageIndex: task.stageIndex + 1, testedPatch: "old", plan: { ...task.plan!, stages }, findings: [], acceptancePassed: true };
    expect(nextLine(customState, reviewing)).toContain("final acceptance testing (Codex · sol) if the code changed");
    const swapped = { ...customState, profiles: customState.profiles.map((profile) => profile.id === "sol-high" ? { ...profile, model: "New model" } : profile) };
    expect(nextLine(swapped, reviewing)).toContain("Codex · New model");
    // Required acceptance that could not be verified is not tried again unchanged; an unverified extra probe alone changes nothing.
    const required = { acceptanceUnverified: true, brief: { summary: "", forUsers: [], areas: [], risks: [], acceptance: [{ text: "A real account works", verification: "blocked" as const, reason: "Account unavailable" }] } };
    for (const blocked of [required, { acceptanceBlocked: true, acceptancePassed: false }]) expect(nextLine(customState, { ...reviewing, ...blocked })).not.toContain("final acceptance testing");
    expect(nextLine(customState, { ...reviewing, acceptanceUnverified: true })).toContain("final acceptance testing (Codex · sol) if the code changed");
    const shared: Task = { ...reviewing, testedVersions: { api: "a", web: "b" }, repositories: ["api", "web"].map((productId) => ({ productId, delivery: "local", completedStages: [], checks: { current: true, at: 0, tree: productId === "api" ? "a" : "b", results: [] } })) };
    expect(nextLine(customState, shared)).not.toContain("final acceptance testing");
    shared.repositories![1]!.checks!.tree = "changed";
    expect(nextLine(customState, shared)).toContain("final acceptance testing (Codex · sol), or");
    expect(nextLine(customState, shared)).not.toContain("if the code changed");
  });

  it("skips the earlier design checks the engine goes past on the way back to the one where you asked for changes", () => {
    const { state, task } = summaryAt("architect");
    const [design, check, ...rest] = task.plan!.stages;
    const screens: Stage = { id: "screens", kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] };
    const later: Stage = { ...check!, id: "later-check" };
    const returning: Task = { ...task, rounds: { [design!.id]: 2 }, returnToCheck: 3, plan: { ...task.plan!, stages: [design!, check!, screens, later, ...rest] } };
    expect(nextLine(state, returning)).toBe("Next: design review again (Codex · sol), then screens (Claude Code · Opus 5.5)");
    const { returnToCheck: _, ...fresh } = returning;
    expect(nextLine(state, fresh)).toBe("Next: design review again (Codex · sol), then your design check");
  });

  it("leaves reported reviewers out of a paused or waiting round, including a port review", () => {
    const { state, task } = summaryAt("code-reviewer");
    const stage = task.plan!.stages[task.stageIndex]!;
    for (const waiting of ["paused", "waiting"] as const) {
      const partial: Task = { ...task, state: waiting, sub: 0, hunt: { stageId: stage.id, round: 1, reported: { "1": true } } };
      expect(nextLine(state, partial)).toBe("Next: code review (Claude Code · Opus 5.5), then your OK to ship");
      expect(nextLine(state, { ...partial, hunt: { ...partial.hunt!, round: 2 } })).toContain("Claude Code · Opus 5.5 and Codex · sol");
      const port = { ...partial, hunt: { ...partial.hunt!, reported: {} }, portReview: { from: "old", head: "change", onto: "new", files: [] } };
      expect(nextLine(state, port)).toContain("a review of the port (Claude Code · Opus 5.5)");
      expect(nextLine(state, { ...port, hunt: { ...port.hunt!, reported: { "0": true } } })).toBe("Next: your OK to ship, then Petrina opens the pull request");
      expect(nextLine(state, { ...port, hunt: { ...port.hunt!, reported: { "1": true } } })).toBe("Next: your OK to ship, then Petrina opens the pull request");
      const actualBuilder: Task = { ...port, builderSession: { stageId: "build", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "actual-build" } };
      expect(nextLine(state, actualBuilder)).toContain("a review of the port (Codex · sol)");
    }
  });
});
