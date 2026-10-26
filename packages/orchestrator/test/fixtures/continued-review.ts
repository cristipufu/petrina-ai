import { afterChangesAsked, beginAgentStep, finishTaskStep, roleForTask, BUILT_IN_ROLES, MAINTENANCE_ROLES, type DeepMutable, type Finding, type Role, type Stage, type Task } from "@petrina/core";
import { ReviewReports } from "../../src/review-reports.js";
import { ReviewRoundCompletion } from "../../src/review-round-completion.js";
import { prepareDeliveryReturn } from "../../src/delivery-return.js";
import { AcceptanceResults } from "../../src/acceptance-results.js";
import { routeAcceptance } from "../../src/acceptance-routing.js";
import { executionFor } from "../../src/repository-context.js";
import type { ReviewReport } from "../../src/ports/review-reports.js";
import { acceptanceTask } from "./acceptance.js";
import { ControlledClock } from "./clock.js";

export const COVERED = "review passed; 1 earlier important still open under your decision to continue";
export const important = (id: string, extra: Partial<DeepMutable<Finding>> = {}): DeepMutable<Finding> => ({ id, text: `Problem ${id}`, evidence: `Reproduced ${id}`, severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"], ...extra });
export const report = (value: Partial<ReviewReport> = {}): ReviewReport => ({ verdict: "pass", findings: [], confirms: [], confirmationEvidence: {}, disputes: [], resolves: [], ...value });

/** Actual round/report/repair controllers, consuming explicit task-change observations and coordinator intent. */
export function continuedReviewFixture(options: { shared?: boolean; later?: string; builder?: string; tested?: boolean } = {}) {
  const task = acceptanceTask(options.shared ?? false), roles: DeepMutable<Role>[] = structuredClone(BUILT_IN_ROLES) as DeepMutable<Role>[];
  const clock = new ControlledClock(); clock.at = 1_000;
  const scope = executionFor(task), ids = (task.repositories ?? [scope.work]).map(work => work.productId);
  let changes: Record<string, string> = Object.fromEntries(ids.map(id => [id, `observed-change-${id}`]));
  let sequence = 0;
  const decisions: string[] = [], notes: string[] = [], checkpoints: unknown[] = [];
  const builder = options.builder ?? "builder", later = options.later ?? "security-reviewer";
  if (builder !== "builder") task.maintenance = { routineId: "daily", routineName: "Daily", scheduledAt: 1, queuedAt: 1, zone: "UTC", focus: "Care", input: "Care",
    role: { ...MAINTENANCE_ROLES.find(role => role.result === "build")!, id: builder, name: "Saved caretaker" },
    profile: { id: "opus-high", toolId: "claude-code", model: "opus", effort: "high" }, product: { id: task.productId, name: "Shop", repo: "local/shop", tone: "blue" } };
  if (later !== "security-reviewer") roles.push({ ...roles.find(role => role.id === "security-reviewer")!, id: later, name: "Privacy reviewer", added: true });
  const stage = (id: string, kind: Stage["kind"], roleId: string, extra: Partial<DeepMutable<Stage>> = {}): DeepMutable<Stage> => ({ id, title: id, kind, roleId, profileIds: kind === "gate" ? [] : ["opus-high"], ...extra });
  const test = stage("test", "do", "tester"), security = stage("security", "review-chain", later, { maxRounds: 2 });
  task.plan = { rationale: "Only review continuation policy", plannerProfileId: "sol-high", stages: [
    stage("build", "do", builder), stage("review", "review-chain", "code-reviewer", { maxRounds: 1 }),
    ...(options.tested ? [test, security] : [security, test]),
    stage("delivery", "gate", "release-manager", { gate: "delivery" }), stage("ship", "do", "release-manager"),
  ] };
  task.state = "running"; task.stageIndex = 1;
  const role = (id: string, current: typeof task) => roleForTask(roles, id, current);
  const host = { roles: () => roles, role, incrementalReview: () => true, ownChanges: async () => changes,
    anchor: async () => { throw new Error("No native worktree is supplied by this policy fixture"); },
    reviewEnd() {}, releaseInput() {}, note: (_task: typeof task, _tone: unknown, text: string) => { notes.push(text); },
    changed: (current: typeof task) => { checkpoints.push(structuredClone(current)); }, commitNow: (current: typeof task) => { checkpoints.push(structuredClone(current)); },
    now: clock.now, openDeliveryDecision: (current: typeof task) => { decisions.push(current.id); },
  };
  const rounds = new ReviewRoundCompletion(host);
  const reports = new ReviewReports({ roles: host.roles, hasPendingReviewers: () => false, id: () => `finding-${++sequence}`, now: clock.now, verdict() {}, note: host.note });
  const results = new AcceptanceResults({ id: () => `acceptance-${++sequence}`, now: clock.now,
    note: (bound, tone, text) => host.note(bound.task, tone, text), noteLearnings: async (_bound, lessons) => { if (lessons.length) throw new Error("No learning work is declared by this fixture"); },
    acceptancePatch: async () => "observed-acceptance-patch",
  });
  const routing = { role, finishStep: (bound: typeof scope) => finishTaskStep(bound.task, bound.work, clock.now()),
    note: (bound: typeof scope, tone: unknown, text: string) => host.note(bound.task, tone, text),
    commit: host.changed, commitNow: host.commitNow, openDeliveryDecision: host.openDeliveryDecision };
  const stageOf = (id: string) => task.plan!.stages.find(entry => entry.id === id)!;
  const after = () => { clock.advance(1); };
  async function exhaust(decide: "continue" | "changes" = "continue") {
    task.stageIndex = 1;
    beginAgentStep(task, "code-reviewer", "sol-high", clock.now(), roles, undefined, scope.work);
    const result = await rounds.finish(task, stageOf("review"), 1, "Important findings");
    if (result !== "stop" || decisions.length !== 1) throw new Error("The actual round did not ask for a coordinator decision");
    if (decide === "continue") task.reviewDecision!.accepted = true;
    else {
      const fromCheck = task.stageIndex;
      afterChangesAsked(task, "delivery", "Repair it", clock.now(), roles);
      prepareDeliveryReturn(host, scope, { note: "Repair it", fromCheck, now: clock.now() });
    }
    decisions.length = 0;
  }
  async function review(value: ReviewReport = report()) {
    after();
    const at = stageOf("security"), round = task.rounds[at.id] ?? 1;
    task.stageIndex = task.plan!.stages.indexOf(at);
    task.hunt = { id: `review-${++sequence}`, stageId: at.id, round, reported: {}, findings: task.findings.length };
    const step = beginAgentStep(task, at.roleId, "opus-high", clock.now(), roles, undefined, scope.work);
    step.agentResults = [{ roleId: at.roleId, profileId: "opus-high", at: clock.now(), value }];
    reports.apply(task, at, value, "opus-high", at.roleId, "0");
    delete task.hunt;
    return rounds.finish(task, at, round, "The review's outcome");
  }
  return { task, scope, roles, clock, host, rounds, reports, notes, checkpoints, stageOf, exhaust, review, after,
    async acceptance(again: boolean, text: string) {
      after(); task.stageIndex = task.plan!.stages.indexOf(test);
      const run = { versions: Object.fromEntries(ids.map(id => [id, `observed-tree-${id}`])), changes: { ...changes }, requestIds: [] };
      task.acceptanceRun = run;
      const value = { summary: "Tried it", checks: [{ text, result: again ? "fail" as const : "pass" as const, evidence: again ? "Still missing for guests; signed-in control shows it" : "Shown" }], proofAnswers: [], learnings: [] };
      const step = beginAgentStep(task, "tester", "opus-high", clock.now(), roles, undefined, scope.work);
      step.agentResults = [{ roleId: "tester", profileId: "opus-high", at: clock.now(), value }];
      const recorded = await results.record(scope, { roleId: "tester", profileId: "opus-high", report: value, run, testedVersions: run.versions, currentVersions: run.versions });
      return routeAcceptance(routing, scope, recorded);
    },
    changes: () => changes,
    observeChange(index = 0) { changes = { ...changes, [ids[index]!]: `observed-changed-${++sequence}` }; },
    observeUnreadable() { changes = {}; },
    open: () => decisions,
    step: () => task.journey!.findLast(entry => entry.kind === "agent" && entry.stageId === "security")!,
  };
}
export const passedCovered = (task: Task) => task.plan!.stages[task.stageIndex]!.id !== "security" && !task.fixing && task.reviewDecision?.accepted === true;
