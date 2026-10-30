import { createHash, type Hash } from "node:crypto";
import { release } from "node:os";
import {
  checkSetupOutcome,
  isCheckExecutorFacts,
  normalizeCheckPrerequisites,
  sameCheckPrerequisites,
  type CheckEnvironmentIdentity,
  type CheckExecutorFacts,
  type CheckOutputIdentity,
  type CheckRun,
  type CheckSetupAttempt,
  type ProductCheckSetup
} from "@petrina/core";

// Bump these when execution/launch semantics change, not for every build or process restart.
// launchPolicy describes this adapter's argv/env handling; it is not a claim about caller credentials.
export const CHECK_EXECUTION_CONTRACT = 1;
export const CHECK_LAUNCH_POLICY = 1;

const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(-1000);

/** Actual APIs of this Bun-based local executor; no version commands, product requirements or defaults. */
export function observeCheckExecutor(): Pick<CheckRun, "executor" | "executorError"> {
  try {
    const executor: CheckExecutorFacts = { version: 1, adapter: "local-product-checks", contract: CHECK_EXECUTION_CONTRACT,
      launchPolicy: CHECK_LAUNCH_POLICY, platform: process.platform, architecture: process.arch, osRelease: release(),
      runtime: { name: "bun", version: Bun.version } };
    if (!isCheckExecutorFacts(executor)) throw new Error("The local check executor facts could not be observed completely");
    return { executor };
  } catch (error) { return { executorError: message(error) }; }
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** An unset contract keeps its own identity; explicitly clearing requirements keeps the coordinator's revision. */
export function checkSetupContract(setup?: ProductCheckSetup): string {
  if (setup === undefined) return hash(["local-check-setup", 1, "undeclared"]);
  if (typeof setup.revision !== "string" || !setup.revision.trim()) throw new Error("The product's setup declaration has no revision");
  const requirements = normalizeCheckPrerequisites(setup.requirements);
  if (!sameCheckPrerequisites(setup.requirements, requirements)) throw new Error("The saved setup declaration is not normalized");
  return hash(["local-check-setup", 1, setup.revision, requirements.map(requirement => [requirement.id, requirement.argv])]);
}

/** Canonical composition over actual recorded observations; never a preferred executor/version override. */
export function deriveCheckEnvironmentIdentity(attempt: CheckSetupAttempt): CheckEnvironmentIdentity {
  const outcome = checkSetupOutcome(attempt);
  if (outcome.kind !== "verified") throw new Error("Only a complete setup observation has an environment identity");
  const facts = outcome.executor;
  const executor = hash([
    facts.version,
    facts.adapter,
    facts.contract,
    facts.launchPolicy,
    facts.platform,
    facts.architecture,
    facts.osRelease,
    [
    facts.runtime.name,
    facts.runtime.version
  ]
  ]);
  return { version: 1, contract: attempt.input.contract, executor, prerequisites: attempt.requirements.length ? {
    kind: "declared", observations: hash(outcome.observations.map(({ requirementId, output }) => [requirementId,
      [output.stdout.algorithm, output.stdout.bytes, output.stdout.digest], [output.stderr.algorithm, output.stderr.bytes, output.stderr.digest]])),
  } : { kind: "none" } };
}

type OutputObservation = Pick<CheckRun, "outputIdentity" | "outputIdentityError">;

/** Hash the existing readers' raw chunks without retaining output or affecting command execution. */
export function checkOutputCapture() {
  const pipes: Record<keyof CheckOutputIdentity, { hash?: Hash; bytes: number }> = { stdout: { bytes: 0 }, stderr: { bytes: 0 } };
  let failure: string | undefined;
  let result: OutputObservation | undefined;
  for (const name of ["stdout", "stderr"] as const) {
    try { pipes[name].hash = createHash("sha256"); }
    catch (error) { failure ??= message(error); }
  }
  return {
    add(name: keyof CheckOutputIdentity, bytes: Uint8Array): void {
      if (failure !== undefined || result !== undefined) return;
      const pipe = pipes[name];
      try {
        const length = pipe.bytes + bytes.byteLength;
        if (!Number.isSafeInteger(length)) throw new Error("The check output byte count exceeded its supported range");
        pipe.hash!.update(bytes);
        pipe.bytes = length;
      } catch (error) { failure ??= message(error); }
    },
    finish(complete: boolean): OutputObservation {
      if (result !== undefined) return result;
      if (failure !== undefined) return result = { outputIdentityError: failure };
      if (!complete) return result = {};
      try {
        const identity = (name: keyof CheckOutputIdentity) => ({
          algorithm: "sha256" as const,
          bytes: pipes[name].bytes,
          digest: pipes[name].hash!.digest("hex")
        });
        return result = { outputIdentity: { stdout: identity("stdout"), stderr: identity("stderr") } };
      } catch (error) { return result = { outputIdentityError: message(error) }; }
    },
  };
}
