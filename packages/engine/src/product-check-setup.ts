import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkSetupOutcome,
  checkSetupWords,
  openStep,
  type CheckInputApplicability,
  type CheckRun,
  type CheckSetupAttempt,
  type CheckSetupInput,
  type CheckSetupOutcome,
  type DeepMutable,
  type Id,
  type JourneyProductCheck,
  type ProductCheck,
  type ProductCheckSetup,
  type RecordedCheckBatchOutcome,
} from "@petrina/core";
import { CheckSetup, type RepositoryContext } from "@petrina/orchestrator";
import { withoutCredentials } from "@petrina/platform/process-environment";
import {
  checkSetupContract,
  deriveCheckEnvironmentIdentity,
  observeCheckExecutor,
} from "@petrina/repositories/check-environment";
import * as git from "@petrina/repositories/git";
import { livePowerRecords, type MachineRecords } from "./check-interruption.js";
import { checksFor, expectedCheckCommands, runChecks } from "./checks.js";
import { Aborted, SourceRefreshRequired, type Kernel } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";

export type CheckEntries = Map<string, DeepMutable<JourneyProductCheck>>;

export type CheckState = {
  sha?: string;
  tree?: string;
  trackedChanged: boolean;
  hooks: string[];
  definition: string;
  message?: string;
  setup?: ProductCheckSetup;
  contract: string;
  requiredCommands: string;
  invalidationId?: Id;
};

export type RecordedChecksApplicability = {
  inputs: CheckInputApplicability;
  batch: RecordedCheckBatchOutcome;
};

export type LiveSetup = {
  attempt: CheckSetupAttempt;
  outcome: CheckSetupOutcome;
  valid: () => boolean;
  forceFresh: boolean;
};

/** Repeat the owning step's source/approval policy only when its check batch waited. */
export type CheckPreparation = (() => Promise<boolean | void>) & { beforeQueue?: () => boolean | void };

export class CheckPreparationChanged extends Error {
  constructor() {
    super("The work needs its existing update or approval step before checks can run");
  }
}

export const nothingToRun = (checks: readonly ProductCheck[], hooks: readonly string[]): boolean =>
  !checks.some((check) => check.argv.length) && !hooks.length;

export function machineRecordsOf(k: Kernel): MachineRecords {
  return k.options.machineRecords ?? livePowerRecords;
}

export async function checkExecutionEnvironment(k: Kernel): Promise<NodeJS.ProcessEnv> {
  return {
    ...withoutCredentials(process.env, await k.emptyGhConfig()),
    CI: "1",
    BROWSER: "none",
    PETRINA_AGENT: "1",
  };
}

export async function computeCheckDefinition(
  k: Kernel,
  scope: RepositoryContext,
  checks: readonly ProductCheck[],
  hooks: Awaited<ReturnType<typeof git.commitHookFiles>>,
  sha?: string,
  capturedMessage?: string,
  setup = k.productOf(scope)?.checkSetup,
): Promise<{ definition: string; message?: string }> {
  const { work: repository } = scope;
  const hash = createHash("sha256").update(
    JSON.stringify(checks.filter((check) => check.argv.length).map((check) => check.argv)),
  );
  const [bodies, message] = await Promise.all([
    Promise.all(hooks.map((hook) => readFile(hook.path))),
    hooks.some((hook) => hook.name === "commit-msg")
      ? (capturedMessage ?? git.message(repository.worktree!, sha))
      : undefined,
  ]);
  for (const [index, hook] of hooks.entries()) {
    hash.update(JSON.stringify([hook.name, hook.path])).update(bodies[index]!);
    if (hook.name === "commit-msg") hash.update(message!);
    if (hook.name === "pre-commit") hash.update(repository.baseSha ?? "");
  }
  if (setup) hash.update(JSON.stringify(["local-check-setup", checkSetupContract(setup)]));
  return { definition: hash.digest("hex"), ...(message !== undefined ? { message } : {}) };
}

export async function captureCheckState(
  k: Kernel,
  noteHooks: (scope: RepositoryContext, observed?: string[]) => Promise<string[]>,
  scope: RepositoryContext,
  checks: readonly ProductCheck[],
): Promise<CheckState> {
  const path = scope.work.worktree!;
  const product = k.productOf(scope);
  const setup = product?.checkSetup && structuredClone(product.checkSetup);
  const contract = checkSetupContract(setup);
  const invalidationId = scope.work.checkSetupInvalidated?.id;
  const requiredCommands = JSON.stringify(
    (product ? checksFor(product, path) : checks).filter((check) => check.argv.length).map((check) => check.argv),
  );
  const status = await git.worktreeStatus(path, false);
  const { tree, hooks: files } = await git.checkInputFiles(path, status.head);
  const hooks = await noteHooks(scope, files.map((hook) => hook.name));
  const definition = await computeCheckDefinition(k, scope, checks, files, status.head, undefined, setup);
  return {
    sha: status.head,
    tree,
    trackedChanged: status.trackedChanged,
    hooks,
    ...definition,
    ...(setup ? { setup } : {}),
    contract,
    requiredCommands,
    ...(invalidationId ? { invalidationId } : {}),
  };
}

export async function captureFinalCheckDefinition(
  k: Kernel,
  scope: RepositoryContext,
  checks: readonly ProductCheck[],
  state: CheckState,
  ranAnything = true,
): Promise<CheckState> {
  const product = k.productOf(scope);
  const setup = product?.checkSetup && structuredClone(product.checkSetup);
  const contract = checkSetupContract(setup);
  const invalidationId = scope.work.checkSetupInvalidated?.id;
  const requiredCommands = JSON.stringify(
    (product ? checksFor(product, scope.work.worktree!) : checks)
      .filter((check) => check.argv.length)
      .map((check) => check.argv),
  );
  if (
    !ranAnything
    && contract === state.contract
    && requiredCommands === state.requiredCommands
    && invalidationId === state.invalidationId
  ) {
    return state;
  }
  const files = await git.commitHookFiles(scope.work.worktree!);
  const definition = await computeCheckDefinition(k, scope, checks, files, state.sha, state.message, setup);
  return { ...state, ...definition, setup, contract, requiredCommands, invalidationId, hooks: files.map((f) => f.name) };
}

export function buildCheckSetupInput(state: CheckState): CheckSetupInput {
  return {
    ...(state.sha ? { sha: state.sha } : {}),
    ...(state.tree && !state.trackedChanged ? { tree: state.tree } : {}),
    definition: state.definition,
    contract: state.contract,
    ...(state.invalidationId ? { invalidationId: state.invalidationId } : {}),
  };
}

export async function observeProductCheckSetup(
  k: Kernel,
  captureState: (scope: RepositoryContext, checks: readonly ProductCheck[]) => Promise<CheckState>,
  scope: RepositoryContext,
  checks: readonly ProductCheck[],
  state: CheckState,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  position: CheckSetupAttempt["position"],
  restore?: () => Promise<void>,
  ownsPlace: () => boolean = () => false,
): Promise<LiveSetup> {
  const { task, work } = scope;
  const input = buildCheckSetupInput(state);
  const invalidation = state.invalidationId;
  const requirements = state.setup?.requirements ?? [];
  const commands = state.requiredCommands;
  const valid = () => {
    if (signal.aborted || k.stopped || work.checkSetupInvalidated?.id !== invalidation) return false;
    try {
      const product = k.productOf(scope);
      return (
        checkSetupContract(product?.checkSetup) === input.contract
        && JSON.stringify(
          (product ? checksFor(product, work.worktree!) : checks)
            .filter((check) => check.argv.length)
            .map((check) => check.argv),
        ) === commands
      );
    } catch {
      return false;
    }
  };
  const admitted = () => ownsPlace() || (!k.taskAdmissionsClosed(task) && !k.taskSourceRefreshDue(task));
  const assertAdmission = () => {
    if (signal.aborted || k.stopped) throw new Aborted();
    if (admitted()) return;
    if (k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
    throw new WaitingForUsage(k.taskAdmissionWait(task));
  };
  assertAdmission();
  const request = {
    id: k.id(task.id),
    productId: work.productId,
    queuedAt: Date.now(),
    position,
    input,
    requirements: requirements.map((requirement) => ({ ...requirement, argv: [...requirement.argv] })),
  };
  const step = openStep(task);
  const history =
    step
    ?? (work.checks?.provenance ? task.journey?.find((node) => node.id === work.checks!.provenance!.nodeId) : undefined);
  const attempt = await new CheckSetup({
    now: () => Date.now(),
    executor: () => {
      if (!valid()) return { kind: "unavailable", message: "The check inputs or admission changed before setup could be observed" };
      const observed = observeCheckExecutor();
      return observed.executor
        ? { kind: "observed", facts: observed.executor }
        : { kind: "unavailable", message: observed.executorError ?? "The local executor could not be observed" };
    },
    execute: async (requirement, stopped) => {
      if (!valid() || !admitted()) {
        return { kind: "not-started", reason: stopped.aborted ? "cancelled" : !valid() ? "inputs-changed" : "admission-lost" };
      }
      const runs = await runChecks(
        work.worktree!,
        [{ name: requirement.name, argv: [...requirement.argv] }],
        env,
        k.options.checkTimeoutMs,
        stopped,
        join(k.dataDir, "checks", task.id),
        undefined,
        undefined,
        machineRecordsOf(k),
        undefined,
        undefined,
        () => valid() && admitted(),
        k.options.runCheckCommand,
      );
      return runs[0]
        ? { kind: "recorded", run: runs[0] }
        : { kind: "not-started", reason: stopped.aborted ? "cancelled" : "admission-lost" };
    },
    finish: async (_attempt, activity) => {
      if (activity === "none") {
        return {
          afterInput: {
            ...input,
            ...(valid() ? {} : { contract: checkSetupContract(k.productOf(scope)?.checkSetup) }),
            trackedChanged: state.trackedChanged,
          },
          restoration: "unchanged",
        };
      }
      const product = k.productOf(scope);
      let observed: CheckState | undefined;
      const errors: unknown[] = [];
      try {
        observed = await captureState(scope, product ? checksFor(product, work.worktree!) : checks);
      } catch (error) {
        errors.push(error);
      }
      const needsRestore = !observed || observed.trackedChanged || observed.sha !== state.sha;
      try {
        if (needsRestore && restore) await restore();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Setup inputs and restoration could not both be confirmed");
      const changed = observed!.trackedChanged || observed!.sha !== state.sha;
      return {
        afterInput: { ...buildCheckSetupInput(observed!), trackedChanged: changed },
        restoration: changed ? "restored" : "unchanged",
      };
    },
    identity: (value) => deriveCheckEnvironmentIdentity(value),
    changed: (snapshot) => {
      work.checkSetup = structuredClone(snapshot) as DeepMutable<CheckSetupAttempt>;
      if (!signal.aborted && !k.stopped && step?.id === openStep(task)?.id) {
        task.statusLine =
          snapshot.lifecycle === "running"
            ? snapshot.runningRequirementId
              ? `Checking local setup: ${snapshot.requirements.find((r) => r.id === snapshot.runningRequirementId)?.name ?? "a requirement"}`
              : "Checking local setup"
            : checkSetupWords(checkSetupOutcome(snapshot));
      }
      if (history) {
        const prior = history.checkSetups ?? [];
        history.checkSetups = [
          ...prior.filter((value) => value.id !== snapshot.id),
          structuredClone(snapshot),
        ] as DeepMutable<CheckSetupAttempt[]>;
      }
      k.commit();
    },
  }).observe(request, signal);
  if (!admitted()) {
    const stopped = { ...attempt, lifecycle: "stopped" as const, identity: undefined };
    work.checkSetup = structuredClone(stopped) as DeepMutable<CheckSetupAttempt>;
    if (history) {
      history.checkSetups = (history.checkSetups ?? []).map((value) =>
        value.id === stopped.id ? structuredClone(stopped) : value,
      ) as DeepMutable<CheckSetupAttempt[]>;
    }
    k.commit();
    assertAdmission();
  }
  return { attempt, outcome: checkSetupOutcome(attempt), valid, forceFresh: invalidation !== undefined };
}

export async function restoreCheckWorktree(
  k: Kernel,
  scope: RepositoryContext,
  worktree: string,
  before: string,
  report = false,
): Promise<void> {
  const status = await git.worktreeStatus(worktree, false);
  if (status.head !== before) {
    await git.resetTo(worktree, before);
    if (report) {
      k.log(scope, "warn", "A check made a commit, so Petrina put the work back as it was: checks only look, and fixes come from the builder");
    }
  } else if (status.trackedChanged) {
    await git.restoreTracked(worktree);
    if (report) {
      k.log(scope, "warn", "A check changed files, so Petrina put them back: checks only look, and fixes come from the builder");
    }
  }
  if (status.head !== before || status.trackedChanged) {
    const restored = await git.worktreeStatus(worktree, false);
    if (restored.head !== before || restored.trackedChanged) {
      throw new Error("The check run could not restore the original work. Its results cannot count as current evidence.");
    }
  }
}

export function expectedCommandsWithHooks(
  checks: readonly ProductCheck[],
  results: readonly CheckRun[],
  hooks: readonly string[],
  staticFailed: boolean,
): string[] {
  return [
    ...expectedCheckCommands(checks, results),
    ...(!staticFailed
      ? hooks.map((hook) => (hook === "pre-commit" ? "git hook run --ignore-missing pre-commit" : "git hook run commit-msg"))
      : []),
  ];
}
