import type { RuntimeTask } from "../../src/model.js";
import { beginPetrinaStep, checkResult, checkSetupOutcome, type CheckRun, type DeepMutable, type JourneyProductCheck } from "@petrina/core";
import { CheckEvidence } from "../../src/check-evidence.js";
import type { CheckBatchEvidence, CheckEnvironmentObservation, CheckEvidenceState } from "../../src/ports/check-evidence.js";
import { checkRepairs, observedCheck } from "./check-repairs.js";
import { facts, fixture as setupFixture } from "./check-setup.js";

/** Declared adapter observations exercise production controllers; this fixture starts no native commands. */
export async function checkEvidence(taskOwner?: RuntimeTask, clock?: () => number, productId?: string) {
  const repair = checkRepairs(false, taskOwner, productId), { scope, task } = repair;
  const setup = setupFixture();
  const accepted = await setup.run();
  const state: CheckEvidenceState = { ...accepted.input, definition: accepted.input.definition!, trackedChanged: false };
  repair.definition(state.definition);
  let now = 200, executionCount = 0, interruptionReads = 0;
  const tick = clock ?? (() => now++);
  const signal = new AbortController();
  const commands = ["test-product"];
  const declaration = { commands, expected: commands, hooks: [] as string[] };
  const notes: string[] = [];
  const host = {
    now: tick, changed: () => { repair.calls.push("changed"); },
    log: (_scope: typeof scope, _tone: "warn" | "done", text: string) => { notes.push(text); },
    deliveryRole: () => false,
    settleFindings: (bound: typeof scope, results: readonly CheckRun[]) => repair.controller.settleFindings(bound, results, new Set(results.map(run => `Check failed: ${run.name} (${run.command})`))),
    recordFailedFindings: (bound: typeof scope, results: readonly CheckRun[]) => repair.controller.recordFailedFindings(bound, results),
    closeEpisode: (bound: typeof scope, captured: CheckEvidenceState, valid: () => boolean) => repair.controller.closeEpisode(bound, captured, valid),
    refreshInterruptions: async () => { interruptionReads++; },
    check: (abort: AbortSignal) => { if (abort.aborted) throw new Error("Verification stopped"); },
  };
  const controller = new CheckEvidence(host);
  const observation = (position: "before-checks" | "after-checks"): CheckEnvironmentObservation => {
    const attempt = { ...(structuredClone(accepted) as DeepMutable<typeof accepted>), id: `setup-${tick()}`, productId: scope.work.productId, position, input: { ...state }, afterInput: { ...state } };
    scope.work.checkSetup = attempt;
    return { attempt, outcome: checkSetupOutcome(attempt), valid: () => true, forceFresh: false };
  };
  const record = async (results: CheckRun[], change?: (batch: CheckBatchEvidence) => void) => {
    const step = beginPetrinaStep(task, "checks", tick(), scope.work);
    const attemptId = `run-${tick()}`;
    const entries = new Map<string, DeepMutable<JourneyProductCheck>>(results.map((run, index) => {
      run.source ??= { stepId: step.id, attemptId, checkId: `check-${index}` };
      return [`check-${index}`, { id: `check-${index}`, attemptId, productId: scope.work.productId, name: run.name, result: checkResult(run), run: { ...run } }];
    }));
    step.productChecks = [...entries.values()];
    const provenance = { id: attemptId, productId: scope.work.productId, sha: state.sha!, tree: state.tree, commands: [...commands], definition: state.definition };
    step.checkAttempts = [provenance];
    const batch: CheckBatchEvidence = { state: { ...state }, finalState: { ...state }, before: state.sha!, rawTree: state.tree,
      results, live: observation("before-checks"), after: observation("after-checks"), expected: [...commands], commands: [...commands],
      attemptId, stepId: step.id, provenance, entries };
    change?.(batch);
    return controller.record(scope, batch);
  };
  const run = (code = 0, name = "Tests", command = "test-product"): CheckRun => ({ ...observedCheck(code), name, command, executor: structuredClone(facts) });
  const verify = () => controller.verify(scope, {
    check: () => host.check(signal.signal), currentChecks: () => declaration,
    verify: () => controller.attempt(scope, signal.signal, "acceptance", {
      capture: async () => ({ ...state }), setupContract: () => state.contract, setupRequired: () => false,
      applies: async captured => controller.applies(scope, captured, declaration),
      observe: async () => observation("before-checks"),
      execute: async () => { executionCount++; return record(commands.map(command => run(0, "Tests", command))); },
    }),
  }, declaration);
  return { ...repair, repairs: repair.controller, controller, host, state, signal, declaration, notes, record, run, verify, observation,
    executions: () => executionCount, interruptionReads: () => interruptionReads };
}
