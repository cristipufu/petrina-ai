import { applyAcceptanceVersions, beginAgentStep, BUILT_IN_ROLES, finishTaskStep, roleForTask, type AcceptanceRestoration, type DeepMutable } from "@petrina/core";
import { AcceptanceResults } from "../../src/acceptance-results.js";
import { routeAcceptance } from "../../src/acceptance-routing.js";
import { DeliveryCheckpoint } from "../../src/delivery-checkpoint.js";
import { WorkCompletion } from "../../src/work-completion.js";
import { ReviewRoundCompletion } from "../../src/review-round-completion.js";
import { recordReviewProofs } from "../../src/review-proof.js";
import { executionFor, scopesFor, type RepositoryContext } from "../../src/repository-context.js";
import type { AcceptanceReply } from "../../src/ports/acceptance-results.js";
import type { AcceptanceRoutingHost } from "../../src/ports/acceptance.js";
import type { DeliveryCheckpointEffects } from "../../src/ports/delivery-checkpoint.js";
import { acceptanceTask } from "./acceptance.js";

export const PROOF_ITEM = "Linux recovery works";
export const proofPasses = (ids: readonly string[]): AcceptanceReply["proofAnswers"] => ids.map(id => ({ id, result: "pass", evidence: "The supplied recovery scenario and its nearby control passed." }));

/** Actual result/routing/checkpoint owners. Source identities and cleanup receipts are supplied observations, never Git or native cleanup proof. */
export function proofFreshnessFixture(shared = false, brief = false, gate = true) {
  const task = acceptanceTask(shared, gate), scope = executionFor(task);
  task.plan!.stages = task.plan!.stages.filter(stage => stage.id !== "security");
  task.title = "Keep required proof current"; task.state = "running"; task.stageIndex = 3;
  if (brief) task.brief = { summary: "Try recovery", areas: [], forUsers: [], risks: [], acceptance: [{ text: PROOF_ITEM }] };
  const ids = scopesFor(task).map(({ work }) => work.productId), review = task.plan!.stages[2]!;
  for (const { work } of scopesFor(task)) { work.worktree = `scripted:proof:${work.productId}`; work.baseSha = `scripted:base:${work.productId}`; }
  let sequence = 0, now = 1_000, source = 0;
  let versions = Object.fromEntries(ids.map(id => [id, `supplied:${id}:tree:0`]));
  let changes = Object.fromEntries(ids.map(id => [id, `supplied:${id}:task-change:0`]));
  let patch = "supplied:task-patch:0", testedPatchObservation: string | undefined;
  let recording = false;
  const notes: string[] = [], decisions: string[] = [], reports: AcceptanceReply[] = [], calls: string[] = [];
  const snapshots: typeof task[] = [];
  const role = (id: string, current: typeof task) => roleForTask(BUILT_IN_ROLES, id, current);
  const own = (bound: RepositoryContext) => {
    if (bound.task !== task || !scopesFor(task).some(entry => entry.work === bound.work)) throw new Error("Unexpected proof observation owner");
  };
  const routing: AcceptanceRoutingHost = {
    role, finishStep: bound => { own(bound); finishTaskStep(task, bound.work, now++); },
    note: (_scope, _tone, text) => { notes.push(text); },
    commit: current => { if (current !== task) throw new Error("Unexpected proof checkpoint"); snapshots.push(structuredClone(task)); },
    commitNow: current => { if (current !== task) throw new Error("Unexpected proof checkpoint"); snapshots.push(structuredClone(task)); },
    openDeliveryDecision: current => { decisions.push(current.id); },
  };
  const results = new AcceptanceResults({ id: () => `finding-${++sequence}`, now: () => now++,
    note: (_scope, _tone, text) => { notes.push(text); }, noteLearnings: async (_scope, lessons) => { if (lessons.length) throw new Error("Unexpected learnings"); },
    acceptancePatch: async bound => { own(bound); return testedPatchObservation; },
  });
  const effects: DeliveryCheckpointEffects = {
    writeGuide: async bound => { own(bound); calls.push(`guide:${bound.work.productId}`); },
    writeLearnings: async bound => { own(bound); }, upToDate: async bound => { own(bound); return "current"; },
    // An explicit normalized check-effect result; no saved execution/currentness record is manufactured.
    checksBeforeDelivery: async bound => { own(bound); calls.push(`checks:${bound.work.productId}`); return "passed"; },
    offerLearnings: async bound => { own(bound); }, previewRelease: async () => { throw new Error("No release in proof policy"); },
    head: async bound => { own(bound); return `supplied:${bound.work.productId}:head:${versions[bound.work.productId]}`; },
    patch: async bound => { own(bound); return patch; }, committedCode: async current => { if (current !== task) throw new Error("Unexpected source owner"); return { versions: { ...versions }, changes: { ...changes } }; },
    invalidateAcceptance: async (current, observed) => { const value = observed ?? versions; applyAcceptanceVersions(current, value); return current.repositories ? value : undefined; },
    versions: async current => { if (current !== task) throw new Error("Unexpected version owner"); return { ...versions }; },
    acceptanceVersion: async bound => { own(bound); return task.repositories ? JSON.stringify(versions) : patch; },
  };
  const checkpoint = new DeliveryCheckpoint({ role, admissionsClosed: () => false, admissionWait: () => "No supplied hold", column: () => "ready",
    blocked: () => { calls.push("blocked"); }, note: (_task, _tone, text) => { notes.push(text); }, checkpoint: () => { snapshots.push(structuredClone(task)); },
    gate: current => { if (current !== task) throw new Error("Unexpected decision owner"); decisions.push(current.id); },
    // Actual unasked publication and proof-decision persistence remain native boundary pairs.
    shipsUnasked: () => false, destination: bound => `scripted:destination:${bound.work.productId}`,
  }, effects);
  const completion = new WorkCompletion({ finishStep: routing.finishStep, endStage() {}, rerun: () => false,
    invalidateAcceptance: async bound => { own(bound); applyAcceptanceVersions(task, versions); }, checkpoint() {}, changed() {},
  });
  const rounds = new ReviewRoundCompletion({ roles: () => BUILT_IN_ROLES, role, incrementalReview: () => true,
    ownChanges: async () => ({ ...changes }), anchor: async bound => { own(bound); return { head: `supplied:${bound.work.productId}:head`, tree: versions[bound.work.productId] }; },
    reviewEnd() {}, releaseInput() {}, note: (_task, _tone, text) => { notes.push(text); },
    changed: current => { snapshots.push(structuredClone(current)); }, commitNow: current => { snapshots.push(structuredClone(current)); },
    openDeliveryDecision: current => { decisions.push(current.id); }, now: () => now++,
  });
  function request(text = "Run required recovery", productIds = ids, checklistText?: string) {
    task.hunt = { stageId: review.id, round: 1, reported: { "0": true }, findings: task.findings.length,
      input: { file: "scripted:accepted-review", digest: "supplied:review-input", heads: {}, trees: { ...versions } } };
    recordReviewProofs({ role, id: () => `proof-${++sequence}` }, task, review, [{ text, reason: "Required on final code", productIds, ...(checklistText ? { checklistText } : {}) }], "sol-high", "code-reviewer", "0");
    delete task.hunt;
    return task.proofRequests!.at(-1)!;
  }
  async function report(input: { answers?: AcceptanceReply["proofAnswers"]; checks?: AcceptanceReply["checks"]; restored?: AcceptanceRestoration; final?: boolean; beforeRecord?: () => void | Promise<void> } = {}) {
    if (recording) throw new Error("An acceptance observation is already being recorded");
    recording = true;
    try {
      task.stageIndex = 1;
      if (input.final === false) delete task.retest;
      else task.retest = true;
      const run = { versions: { ...versions }, changes: { ...changes }, requestIds: task.proofRequests?.map(request => request.id) ?? [],
        ...(input.restored ? { restored: structuredClone(input.restored) as DeepMutable<AcceptanceRestoration> } : {}) };
      testedPatchObservation = task.repositories ? JSON.stringify(run.versions) : patch;
      task.acceptanceRun = run;
      const step = beginAgentStep(task, "tester", "opus-high", now++, BUILT_IN_ROLES, undefined, scope.work);
      const reply: AcceptanceReply = { summary: "Tried the requested recovery", checks: input.checks ?? (brief ? [{ text: PROOF_ITEM, result: "pass", evidence: "Recovery worked." }] : []),
        proofAnswers: input.answers ?? proofPasses(run.requestIds), learnings: [] };
      reports.push(reply); step.agentResults = [{ roleId: "tester", profileId: "opus-high", at: now++, value: reply }];
      await input.beforeRecord?.();
      // Native cleanup/acceptanceVersion captures this observation on the accepted run's starting versions.
      const recorded = await results.record(scope, { roleId: "tester", profileId: "opus-high", report: reply, run, testedVersions: run.versions, currentVersions: versions });
      const next = routeAcceptance(routing, scope, recorded);
      if (next === undefined) await completion.complete(scope, { stageId: "test", canEdit: false });
      return { recorded, next, step, reply, run };
    } finally { recording = false; }
  }
  const observe = (index = 0, taskEdit = false) => {
    const id = ids[index]!;
    versions = { ...versions, [id]: `supplied:${id}:tree:${++source}` };
    if (taskEdit) { changes = { ...changes, [id]: `supplied:${id}:task-change:${source}` }; patch = `supplied:task-patch:${source}`; }
  };
  return { task, scope, ids, review, routing, results, effects, checkpoint, completion, rounds, notes, decisions, reports, snapshots, calls, request, report, observe,
    get versions() { return { ...versions }; }, get changes() { return { ...changes }; },
    final: () => { task.stageIndex = 3; return checkpoint.run(scope, new AbortController().signal); },
  };
}
