import {
  checkSourceApplicability,
  checkInputApplicability,
  checkOutcome,
  checkOwnershipConfirmed,
  checkResult,
  checkSetupOutcome,
  checkSetupWords,
  endAgentStep,
  endPetrinaStep,
  incompleteCheckOutcome,
  JOURNEY_WORDS,
  openStep,
  sameCheckEnvironmentIdentity,
  sameCheckExecutorFacts,
  recordCheckReuse,
  isCheckEnvironmentBinding,
  type CheckRun,
  type JourneyCheckReuse,
  type CheckEnvironmentBinding
} from "@petrina/core";
import type { RepositoryContext } from "./repository-context.js";
import type {
  CheckBatchEvidence,
  CheckEnvironmentObservation,
  CheckEvidenceHost,
  CheckVerification,
  CheckVerificationEffects,
  CheckEvidenceState,
  CheckAttemptEffects,
  CheckEvidenceDeclaration
} from "./ports/check-evidence.js";

/** Records actual boundary observations and owns their verification/repair decisions without native effects. */
export class CheckEvidence {
  constructor(private readonly host: CheckEvidenceHost) {}

  async record(scope: RepositoryContext, batch: CheckBatchEvidence): Promise<CheckVerification> {
    const { task, work: repository } = scope;
    const { state, finalState, live, after, before, rawTree, results, expected, commands, attemptId, stepId, provenance, entries } = batch;
    const definition = state.definition;
    const completeRows = results.every(run => ["passed", "failed"].includes(checkOutcome(run).kind));
    const sameEnvironment = !!live.attempt.identity && !!after.attempt.identity && sameCheckEnvironmentIdentity(live.attempt.identity, after.attempt.identity);
    const stable = JSON.stringify(expected) === JSON.stringify(results.map(run => run.command))
      && live.valid() && after.valid() && after.outcome.kind === "verified"
      && !!live.attempt.identity && !!after.attempt.identity && sameCheckEnvironmentIdentity(live.attempt.identity, after.attempt.identity)
      && checkInputApplicability(state, after.attempt.input).kind === "matches" && !finalState.trackedChanged
      && results.every(run => sameCheckExecutorFacts(run.executor, after.attempt.executor));
    const binding: CheckEnvironmentBinding | undefined = stable ? {
      ...after.attempt.identity!,
      setupAttempts: {
      before: live.attempt.id,
      after: after.attempt.id
    }
    } : undefined;
    // A coordinator declaration/source change uses the existing bounded input convergence. A changed
    // executor/probe observation under the same inputs is a setup blocker and never retries a full suite.
    const inputsChanged = !live.valid() || !after.valid() || live.attempt.input.contract !== after.attempt.input.contract
      || checkInputApplicability(state, after.attempt.input).kind !== "matches";
    const blockedReason: Extract<CheckVerification, { kind: "blocked" }>["reason"] = !completeRows ? "native-incomplete"
      : after.outcome.kind !== "verified" ? "setup" : inputsChanged ? "inputs-changed" : !sameEnvironment ? "setup" : "inputs-changed";
    const tree = rawTree;
    repository.checks = {
      current: !!binding,
      ...(binding ? { environment: binding } : {}),
      at: this.host.now(),
      ...(before ? { sha: before } : {}),
      ...(tree ? { tree } : {}),
      ...(repository.baseSha ? { base: repository.baseSha } : {}),
      definition,
      results,
      ...(stepId && attemptId ? { provenance: {
      nodeId: stepId,
      attemptId
    } } : {})
    };
    const checksStep = openStep(task);
    for (const check of checksStep?.productChecks ?? []) if (check.result === "pending") check.result = "skipped";
    if (provenance && !binding) provenance.passed = false;
    const failed = binding ? this.host.settleFindings(scope, results) : results.filter(run => checkOutcome(run).kind === "failed");
    const interrupted = results.some((run) => {
      const kind = checkOutcome(run).kind;
      return kind === "incomplete" || kind === "unavailable";
    });
    for (const entry of entries.values()) if (entry.run && checkOutcome(entry.run).kind === "failed") {
      entry.findingId = task.findings.findLast((finding) => finding.raisedBy === "petrina" && finding.text === `Check failed: ${entry.run!.name} (${entry.run!.command})` && (!task.repositories || finding.productIds?.includes(repository.productId)))?.id;
    }
    if (binding && provenance) provenance.environment = binding;
    if (binding && provenance && !failed.length && !interrupted && provenance.tree) {
      // The post-observation already captured code, definitions and hooks after restoration.
      const finalDefinition = after.attempt.input.definition;
      provenance.passed = finalDefinition === definition && live.valid() && after.valid()
        && JSON.stringify(commands) === JSON.stringify(results.map((run) => run.command))
        && results.every((run) => checkOutcome(run).kind === "passed");
      provenance.environment = binding;
      repository.checks.current = provenance.passed;
    }
    if (binding && repository.checks.current && results.every((run) => checkOutcome(run).kind === "passed")) {
      await this.host.closeEpisode(scope, state, () => live.valid() && after.valid());
    }
    if (binding && live.valid() && after.valid()) delete repository.checkSetupInvalidated;
    else if (binding) {
      repository.checks.current = false;
      return this.blocked(scope, after, "inputs-changed");
    }
    const incomplete = !binding ? blockedReason === "inputs-changed" ? "Check inputs changed during verification" : blockedReason === "native-incomplete" ? "Product command execution is incomplete or unavailable" : after.outcome.kind !== "verified" ? checkSetupWords(after.outcome) : "Local setup changed during verification"
      : incompleteCheckOutcome(results.map((run) => ({ name: run.name, result: checkResult(run), run })));
    const failureNames = failed.map((run) => run.name).join(", ");
    this.host.log(
      scope,
      failed.length || interrupted ? "warn" : "done",
      incomplete ? `${incomplete}${failed.length ? ` (${failureNames})` : ""}; original reported results retained` : failed.length ? `Checks: ${failed.length} of ${results.length} failed (${failureNames})` : results.length ? `Checks passed: ${results.map((run) => run.name).join(", ")}` : "No product checks or commit hooks to run"
    );
    if ((failed.length || interrupted) && this.host.deliveryRole(scope)) {
      endAgentStep(
        task,
        {
        outcome: incomplete ?? JOURNEY_WORDS.interrupted,
        reason: incomplete ?? JOURNEY_WORDS.checksFailed(failed.length),
        tone: "back",
        end: "failed"
      },
        this.host.now()
      );
    } else {
      endPetrinaStep(
        task,
        incomplete ? {
        outcome: incomplete,
        reason: incomplete,
        tone: "back"
      } : failed.length ? {
        outcome: JOURNEY_WORDS.checks(
        failed.length,
        results.length
      ),
        reason: JOURNEY_WORDS.checksFailed(failed.length),
        tone: "back"
      } : {
        outcome: JOURNEY_WORDS.checks(
        0,
        results.length
      ),
        reason: results.length ? JOURNEY_WORDS.checksPassed : JOURNEY_WORDS.noChecks
      },
        this.host.now()
      );
    }
    delete task.checkActivity;
    this.host.changed();
    if (!binding || repository.checks.current === false && results.every(run => checkOutcome(run).kind === "passed")) return this.blocked(
      scope,
      after,
      blockedReason
    );
    return this.verification(scope, binding, "executed");
  }

  blocked(scope: RepositoryContext, live: CheckEnvironmentObservation, reason: Extract<CheckVerification, { kind: "blocked" }>["reason"] = "setup"): CheckVerification {
    if (scope.work.checks) scope.work.checks.current = false;
    const step = openStep(scope.task);
    const words = reason === "native-incomplete" ? "Product command execution is incomplete or unavailable" : reason === "inputs-changed" ? "Check inputs changed during verification" : live.outcome.kind === "verified" ? "Local setup changed during verification" : checkSetupWords(live.outcome);
    if (step?.kind === "petrina" && step.work === "checks") {
      for (const check of step.productChecks ?? []) if (check.result === "pending" || check.result === "running") {
        check.result = "skipped";
        check.detail = words;
        check.endedAt = this.host.now();
      }
      endPetrinaStep(scope.task, { outcome: "Checks unverified", reason: words, tone: "back" }, this.host.now());
    }
    this.host.log(scope, "warn", `${words}; delivery remains unverified and no automatic Builder turn is used`);
    delete scope.task.checkActivity;
    this.host.changed();
    return { kind: "blocked", productId: scope.work.productId, results: scope.work.checks?.results ?? [], reason, setup: live.outcome };
  }

  verification(scope: RepositoryContext, binding: CheckEnvironmentBinding, basis: "executed" | "reused"): CheckVerification {
    const results = scope.work.checks!.results;
    if (results.some(run => !checkOwnershipConfirmed(run)))
      return { kind: "blocked", productId: scope.work.productId, results, reason: "native-incomplete", setup: checkSetupOutcome(scope.work.checkSetup) };
    const failed = results.filter(run => checkOutcome(run).kind === "failed");
    // A verified real failure keeps its bounded repair route even beside an incomplete peer.
    // Incomplete rows can never establish a pass or close the failure episode.
    if (failed.length) return { kind: "product-failed", productId: scope.work.productId, results, failed, binding };
    if (results.some(run => !["passed", "failed"].includes(checkOutcome(run).kind)))
      return { kind: "blocked", productId: scope.work.productId, results, reason: "native-incomplete", setup: checkSetupOutcome(scope.work.checkSetup) };
    return { kind: "passed", productId: scope.work.productId, results, basis, binding };
  }

  matchesEnvironment(scope: RepositoryContext, live: CheckEnvironmentObservation, rows: readonly CheckRun[] | undefined = scope.work.checks?.results): boolean {
    const saved = scope.work.checks;
    return !live.forceFresh && live.valid() && live.outcome.kind === "verified" && !!live.attempt.identity
      && !!saved && isCheckEnvironmentBinding(saved.environment) && sameCheckEnvironmentIdentity(saved.environment, live.attempt.identity)
      && Array.isArray(rows) && rows.every(run => !!run && sameCheckExecutorFacts(run.executor, live.attempt.executor));
  }

  retainIncomplete(scope: RepositoryContext, state: CheckEvidenceState, purpose: JourneyCheckReuse["purpose"], live: CheckEnvironmentObservation): CheckVerification {
    const { task, work } = scope;
    const saved = work.checks!;
    const host = (saved.provenance ? task.journey?.find(step => step.id === saved.provenance!.nodeId) : undefined) ?? task.journey?.at(-1);
    if (host) host.reuses = [...(host.reuses ?? []), { at: this.host.now(), purpose, productId: work.productId,
      ...(saved.provenance ? { attemptId: saved.provenance.attemptId } : {}), basis: state.tree && saved.tree === state.tree ? "same-tree" : "same-commit", originalAt: saved.at,
      ...(saved.sha ? { sha: saved.sha } : {}), ...(saved.tree ? { tree: saved.tree } : {}), ...(saved.definition ? { definition: saved.definition } : {}), passed: false }];
    recordCheckReuse(task, work, this.host.now());
    return this.blocked(scope, live, "native-incomplete");
  }

  async reuse(scope: RepositoryContext, state: CheckEvidenceState, purpose: JourneyCheckReuse["purpose"], live: CheckEnvironmentObservation, signal: AbortSignal): Promise<CheckVerification> {
    const { task, work: repository } = scope;
    if (!this.matchesEnvironment(scope, live)) return this.blocked(scope, live, "inputs-changed");
    const saved = repository.checks!;
    if (saved.definition !== undefined) saved.current = true;
    await this.host.refreshInterruptions(scope, signal);
    this.host.check(signal);
    if (!live.valid() || !this.matchesEnvironment(scope, live)) return this.blocked(scope, live, "inputs-changed");
    // Rereading a saved failure is no new attempt; a saved pass on this code and these definitions is a genuine pass.
    if (saved.definition === undefined) this.host.recordFailedFindings(scope, saved.results.filter(run => checkOutcome(run).kind === "failed"));
    else this.host.settleFindings(scope, saved.results);
    const passed = saved.definition !== undefined && saved.results.every((run) => checkOutcome(run).kind === "passed");
    if (passed) await this.host.closeEpisode(scope, state, live.valid);
    if (!live.valid()) return this.blocked(scope, live, "inputs-changed");
    // The reuse and its basis are saved on the step that ran the original, so the evidence survives restarts and later runs.
    const host = (saved.provenance ? task.journey?.find((step) => step.id === saved.provenance!.nodeId) : undefined) ?? task.journey?.at(-1);
    if (host) host.reuses = [...(host.reuses ?? []), { at: this.host.now(), purpose, productId: repository.productId, ...(saved.provenance ? { attemptId: saved.provenance.attemptId } : {}), basis: state.tree && saved.tree === state.tree ? "same-tree" : "same-commit", originalAt: saved.at, ...(saved.sha ? { sha: saved.sha } : {}), ...(saved.tree ? { tree: saved.tree } : {}), ...(saved.definition ? { definition: saved.definition } : {}), passed,
      environment: { identity: structuredClone(live.attempt.identity!), setupAttemptId: live.attempt.id } }];
    recordCheckReuse(scope.task, repository, this.host.now());
    delete scope.task.checkActivity;
    this.host.changed();
    return this.verification(scope, saved.environment!, "reused");
  }

  applies(scope: RepositoryContext, state: CheckEvidenceState, declaration: CheckEvidenceDeclaration): boolean {
    const { work: repository } = scope;
    if (!repository.checks || !Array.isArray(repository.checks.results) || repository.checks.results.some(run => !run) || !repository.worktree || state.trackedChanged) return false;
    const { expected, hooks } = declaration;
    const { definition } = state;
    if (JSON.stringify(expected) !== JSON.stringify(repository.checks.results.map((run) => run.command))) return false;
    if (repository.checks.definition !== undefined) {
      if (repository.checks.definition !== definition) return false;
    } else {
      // Missing inputs may keep a failure blocking, but cannot establish a current pass.
      // Never attach today's definition to an execution that did not record it.
      if (hooks.length || !repository.checks.results.some(run => checkOutcome(run).kind === "failed")) return false;
    }
    const matched = (repository.checks.definition === undefined ? checkSourceApplicability(repository.checks, state)
      : checkInputApplicability(repository.checks, state)).kind === "matches";
    // A hook may launch checks outside the committed tree: unchanged launcher bytes cannot prove
    // their inputs stayed unchanged. Revalidate passes; a captured failure still blocks without retrying.
    if (matched && repository.checks.results.every((run) => checkOutcome(run).kind === "passed") && hooks.length) return false;
    return matched;
  }

  retainedProductResults(scope: RepositoryContext, state: CheckEvidenceState, live: CheckEnvironmentObservation, declaration: CheckEvidenceDeclaration): readonly CheckRun[] | undefined {
    const { work: repository } = scope;
    if (!repository.checks || !Array.isArray(repository.checks.results) || repository.checks.results.some(run => !run) || !repository.worktree) return undefined;
    if (state.trackedChanged) return undefined;
    if (repository.checks.definition !== undefined && (repository.checks.definition !== state.definition || !declaration.hooks.length)) return undefined;
    if ((repository.checks.definition === undefined ? checkSourceApplicability(repository.checks, state)
      : checkInputApplicability(repository.checks, state)).kind !== "matches") return undefined;
    const commands = declaration.commands;
    const results = repository.checks.results.slice(0, commands.length);
    if (!this.matchesEnvironment(scope, live, results)) return undefined;
    if (JSON.stringify(commands) !== JSON.stringify(results.map((run) => run.command))) return undefined;
    // Rechecking only the hooks cannot bind an earlier product pass to unknown command inputs.
    if (repository.checks.definition === undefined && results.some(run => checkOutcome(run).kind !== "failed")) return undefined;
    const hooks = repository.checks.results.slice(commands.length);
    if (!hooks.every((run) => run.command === "git hook run commit-msg" || run.command === "git hook run --ignore-missing pre-commit")) return undefined;
    return results;
  }

  async attempt<State extends CheckEvidenceState>(scope: RepositoryContext, signal: AbortSignal, purpose: JourneyCheckReuse["purpose"], effects: CheckAttemptEffects<State>): Promise<CheckVerification> {
    const { work } = scope;
    if (!work.worktree) return {
      kind: "blocked",
      productId: work.productId,
      results: work.checks?.results ?? [],
      reason: "inputs-changed",
      setup: { kind: "unobserved" }
    };
    const state = await effects.capture();
    const previous = work.checkSetup;
    if (previous && !state.trackedChanged && previous.input.invalidationId === state.invalidationId
      && checkInputApplicability(previous.input, state).kind === "matches" && previous.input.contract === effects.setupContract()) {
      const outcome = checkSetupOutcome(previous);
      if ([
        "unmet",
        "unavailable",
        "incomplete"
      ].includes(outcome.kind)) {
        if (scope.task.checkActivity) {
          delete scope.task.checkActivity;
          this.host.changed();
        }
        return {
          kind: "blocked",
          productId: work.productId,
          results: work.checks?.results ?? [],
          reason: "setup",
          setup: outcome
        };
      }
    }
    if (!effects.setupRequired() && await effects.applies(state)) {
      const live = await effects.observe(state);
      this.host.check(signal);
      if (live.outcome.kind !== "verified") return this.blocked(scope, live);
      if (!live.valid()) return this.blocked(scope, live, "inputs-changed");
      if (this.matchesEnvironment(scope, live)) return this.reuse(scope, state, purpose, live, signal);
      if (!live.forceFresh && work.checks!.results.some(run => ![
        "passed",
        "failed"
      ].includes(checkOutcome(run).kind))) return this.retainIncomplete(
        scope,
        state,
        purpose,
        live
      );
    }
    return effects.execute(state);
  }

  async verify<Checks>(scope: RepositoryContext, effects: CheckVerificationEffects<Checks>, checks?: Checks): Promise<CheckVerification> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await effects.verify(checks);
      effects.check();
      if (result.kind !== "blocked" || result.reason !== "inputs-changed" || !scope.work.worktree) return result;
      effects.check();
      this.host.log(scope, "warn", "Check inputs changed while verification ran; checking the current code and requirements before continuing");
      checks = effects.currentChecks(checks);
    }
    throw new Error("The product's check inputs kept changing during verification. Nothing was approved or published; run the checks again once they are stable.");
  }
}
