import { BUILT_IN_ROLES, builderFindings, changeRuntimeWait, freshBuilderRethink, recordBuilderFindingAnswers, roleForTask, runtimeWaitHolds, type Finding } from "@petrina/core";
import { SourceConflicts, finishSourcePort } from "../../src/source-conflicts.js";
import { beginRepair } from "../../src/repair.js";
import { executionFor, scopesFor, nextWorkspaceProduct, type RepositoryContext } from "../../src/repository-context.js";
import { WaitSourceRefresh } from "../../src/wait-source-refresh.js";
import { WorkCompletion } from "../../src/work-completion.js";
import { plannedReviewPlaces } from "../../src/review-members.js";
import type { SourceConflictHost, SourceConflictObservation, FinishSourcePortEffects } from "../../src/ports/source-conflicts.js";
import { admissionFixture } from "./agent-workflow.js";

/** Actual source/repair/admission owners; repository identities are supplied observations, never Git evidence. */
export function sourceConflictFixture(shared = true) {
  const scheduler = admissionFixture(2, 2, 1), task = scheduler.task(scheduler.ids[0]!)!;
  const productIds = shared ? ["shop", "api"] : ["shop"];
  scheduler.state.products = productIds.map(id => ({ id, name: id, repo: `local/${id}`, tone: "blue" }));
  task.productId = "shop"; task.activeProductId = "shop"; task.leadProductId = "shop";
  task.startedAt = 1; task.state = "waiting"; task.stageIndex = 1; task.rounds.review = 2;
  task.plan = { rationale: "Review accepted work", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] },
    { id: "acceptance", kind: "do", title: "Acceptance", roleId: "tester", profileIds: ["sol-high"] },
  ] };
  const works = productIds.map(productId => ({ productId, delivery: "local" as const, completedStages: ["build"],
    worktree: `scripted:workspace:${productId}`, base: "main", baseSha: `scripted:base:${productId}`,
    builderSession: { stageId: "build", profileId: "sol-high", toolId: "codex", model: "supplied-model", sessionId: `supplied:${productId}:builder` },
  }));
  if (shared) { task.repositories = works; delete task.repository; } else { task.repository = works[0]!; delete task.repositories; }
  const scopes = () => scopesFor(task), scope = scopes()[0]!;
  const calls: string[] = [], notes: string[] = [], checkpoints: typeof task[] = [];
  const now = () => ++scheduler.clock.at;
  const host: SourceConflictHost = {
    role: (id, current) => roleForTask(BUILT_IN_ROLES, id, current), productName: bound => bound.work.productId,
    checkpoint() { calls.push("checkpoint"); checkpoints.push(structuredClone(task)); }, changed() { calls.push("changed"); },
    note(bound, tone, text) { calls.push(`note:${bound.work.productId}:${tone}`); notes.push(text); }, now,
  };
  const conflicts = new SourceConflicts(host);
  const observations = new Map<string, SourceConflictObservation>();
  for (const bound of scopes()) observations.set(bound.work.productId, {
    sourceName: "main", from: `scripted:base:${bound.work.productId}`, onto: `scripted:latest:${bound.work.productId}`,
    ontoRef: "main", files: ["greeting.txt"], notes: [], gained: 1, reviewed: false,
  });
  const heads = new Map(productIds.map(id => [id, `scripted:accepted-head:${id}`]));
  const begin = (bound = scope) => conflicts.begin(bound, observations.get(bound.work.productId)!, {
    async head() { calls.push(`head:${bound.work.productId}`); return heads.get(bound.work.productId)!; },
    async open() { calls.push(`open:${bound.work.productId}`); },
  });
  const portEffects = (bound: RepositoryContext): FinishSourcePortEffects => ({
    async treeOf(head) { calls.push(`tree:${bound.work.productId}:${head}`); return `scripted:reviewed:${bound.work.productId}`; },
    async merge(onto, head) { calls.push(`merge:${bound.work.productId}:${onto}:${head}`); return { tree: `scripted:merged:${bound.work.productId}` }; },
    async changedFiles(tree) { calls.push(`files:${bound.work.productId}:${tree}`); return ["greeting.txt"]; },
  });
  const outcomes = new Map<string, "current" | "moved" | "conflict" | Error>(productIds.map(id => [id, "current"]));
  const refresh = new WaitSourceRefresh({
    due: () => true, stepStarted: () => false, checkpoint: () => host.checkpoint(),
    note: (_task, _tone, text) => { notes.push(text); }, aborted: () => new Error("Cancelled source refresh"),
  }, {
    async clean(bound) { calls.push(`clean:${bound.work.productId}`); return true; },
    async clearUnpublishedVersion(bound, preserve) { calls.push(`clear:${bound.work.productId}:${preserve}`); },
    async update(bound) {
      if (calls.filter(call => call === `update:${bound.work.productId}`).length >= 2) throw new Error(`Unexpected repeated source observation for ${bound.work.productId}`);
      calls.push(`update:${bound.work.productId}`);
      const result = outcomes.get(bound.work.productId);
      if (result instanceof Error) throw result;
      if (result === "conflict") {
        outcomes.set(bound.work.productId, "current");
        return begin(bound);
      }
      if (result === "moved") bound.work.baseSha = observations.get(bound.work.productId)!.onto;
      if (!result) throw new Error("Missing source observation");
      return result;
    },
  });
  const completion = new WorkCompletion({
    finishStep() {}, endStage() {}, rerun: () => false,
    async invalidateAcceptance(bound) { calls.push(`invalidate:${bound.work.productId}`); },
    checkpoint: () => host.checkpoint(), changed: () => host.changed(),
  });
  const builders: { productId: string; fixing: boolean; rethink: boolean; given: Finding[]; port: boolean }[] = [], reached: number[] = [];
  scheduler.host.schedule = () => {};
  scheduler.host.admissionsClosed = current => scheduler.state.pool.paused || runtimeWaitHolds(current);
  scheduler.phases.prepareWorkspace = async (current, stage, signal) => {
    if (await refresh.run(current, signal)) return { kind: "repeat" };
    if (current.repositories) current.activeProductId = nextWorkspaceProduct(current, stage?.kind === "do" && scheduler.catalog.role(stage.roleId, current)?.canEdit ? stage.id : undefined);
    return { kind: "ready", scope: executionFor(current) };
  };
  scheduler.phases.doStage = async (bound, stage) => {
    if (stage.roleId === "tester") { reached.push(task.stageIndex); return "stop"; }
    if (host.role(stage.roleId, task)?.result !== "build") throw new Error("Unexpected source-conflict role");
    const given = task.fixing ? builderFindings(task, bound.work.productId) : [];
    builders.push({ productId: bound.work.productId, fixing: !!task.fixing,
      rethink: freshBuilderRethink(task, bound.work.builderSession, stage.id, stage.profileIds[0]!), given: structuredClone(given), port: !!bound.work.updating });
    const updating = bound.work.updating;
    if (updating) await finishSourcePort(bound, updating, portEffects(bound));
    if (task.fixing) recordBuilderFindingAnswers(task, given, given.map(finding => ({ id: finding.id, fixed: true, text: "The accepted Builder reply reports the repair." })), { productId: bound.work.productId, shared, at: now() });
    return completion.complete(bound, { stageId: stage.id, canEdit: true });
  };
  scheduler.phases.review = async () => { reached.push(task.stageIndex); return "stop"; };
  const signal = new AbortController().signal;
  return { scheduler, task, scope, scopes, calls, notes, checkpoints, host, conflicts, observations, heads, begin, portEffects, outcomes, refresh, signal, builders, reached,
    reviewPlaces: () => plannedReviewPlaces(task, task.plan!.stages[1]!, { roles: () => BUILT_IN_ROLES, profile: scheduler.catalog.profile }),
    repair(owners = productIds) {
      task.findings = owners.map((productId, index) => ({ id: `f${index}`, text: "The greeting needs a repair", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open", ...(shared ? { productIds: [productId] } : {}) }));
      if (shared) return beginRepair({ role: host.role, commitNow: () => host.checkpoint() }, task, "review", 1);
      task.fixing = true; task.stageIndex = 0; return true;
    },
    reviewed() { for (const bound of scopes()) { bound.work.reviewedTree = `scripted:reviewed:${bound.work.productId}`; observations.get(bound.work.productId)!.reviewed = true; } },
    hold() { changeRuntimeWait(task, { after: ["prerequisite"], reason: "Wait for the prerequisite" }, now()); },
    release() { changeRuntimeWait(task, { after: [], reason: "The prerequisite landed" }, now()); },
    async drive() {
      scheduler.state.pool.paused = false;
      scheduler.workflow.startDriver(task.id);
      const operation = scheduler.ownership.settling.get(task.id);
      if (!operation) throw new Error("No owned source-conflict driver");
      await operation;
      if (scheduler.failures.length) throw scheduler.failures.at(-1);
    }, close: () => scheduler.close(),
  };
}
