import type { DeepMutable } from "../../src/flow.js";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { commandText } from "../../src/check-commands.js";
import type { CheckEnvironmentIdentity, CheckExecutorFacts, CheckPrerequisite, CheckRun, CheckSetupAttempt, RepositoryState } from "../../src/model.js";

/** Explicit scripted complete observations for pure rules; these are not native execution evidence. */
export const setupExecutor: CheckExecutorFacts = { version: 1, adapter: "local-product-checks", contract: 1, launchPolicy: 1,
  platform: "scripted-platform", architecture: "scripted-architecture", osRelease: "scripted-release", runtime: { name: "bun", version: "scripted-version" } };
export const setupRequirement: CheckPrerequisite = { id: "compiler", name: "Compiler identity", argv: ["compiler", "--version", ""] };
const empty = { algorithm: "sha256" as const, bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
export const setupIdentity = (declared = false): CheckEnvironmentIdentity => ({ version: 1, contract: "a".repeat(64), executor: "b".repeat(64),
  prerequisites: declared ? { kind: "declared", observations: "c".repeat(64) } : { kind: "none" } });

export function setupRun(code = 0, requirement = setupRequirement): CheckRun {
  return { name: requirement.name, command: commandText(requirement.argv), ok: code === 0, ms: 1, output: "",
    execution: completeCheckExecution(code), executor: { ...setupExecutor, runtime: { ...setupExecutor.runtime } },
    outputIdentity: { stdout: { ...empty }, stderr: { ...empty } } };
}

export function setupAttempt(requirements: readonly CheckPrerequisite[] = []): CheckSetupAttempt {
  const input = { sha: "1".repeat(40), tree: "2".repeat(40), definition: "3".repeat(64), contract: "a".repeat(64) };
  return { id: "observed-after", productId: "shop", queuedAt: 1, startedAt: 2, endedAt: 3, lifecycle: "settled", position: "before-checks",
    input, afterInput: { ...input, trackedChanged: false }, restoration: "unchanged", requirements,
    executor: { ...setupExecutor, runtime: { ...setupExecutor.runtime } },
    results: requirements.map(requirement => ({ requirementId: requirement.id, run: setupRun(0, requirement) })), identity: setupIdentity(!!requirements.length) };
}

export function setupWork(results: readonly CheckRun[] = []): DeepMutable<Pick<RepositoryState, "checks" | "checkSetup" | "checkSetupInvalidated">> {
  return { checkSetup: setupAttempt(), checks: { at: 3, sha: "1".repeat(40), tree: "2".repeat(40), definition: "3".repeat(64), results,
    environment: { ...setupIdentity(), setupAttempts: { before: "observed-before", after: "observed-after" } } } } as DeepMutable<Pick<RepositoryState, "checks" | "checkSetup" | "checkSetupInvalidated">>;
}
