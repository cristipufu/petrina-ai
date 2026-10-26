import { commandText, type CheckSetupAttempt, type DeepMutable } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";

/** Explicit recorded observations for presentation; no native execution or current readiness is claimed. */
export function setupObservation(productId = "shop", code = 0, at = 1_000_000): DeepMutable<CheckSetupAttempt> {
  const requirement = { id: "compiler-record-id", name: "Compiler version", argv: ["compiler", "--version"] };
  const executor = { version: 1 as const, adapter: "local-product-checks", contract: 1, launchPolicy: 1, platform: "recorded-platform", architecture: "recorded-architecture", osRelease: "recorded-release", runtime: { name: "bun", version: "recorded-version" } };
  const input = { definition: "a".repeat(64), contract: "b".repeat(64), sha: "1".repeat(40), tree: "2".repeat(40) };
  return { id: `setup-${productId}-${at}`, productId, queuedAt: at - 2, startedAt: at - 1, endedAt: at, lifecycle: "settled", position: "before-checks", input,
    afterInput: { ...input, trackedChanged: false }, restoration: "unchanged", requirements: [requirement], executor,
    results: [{ requirementId: requirement.id, run: { name: requirement.name, command: commandText(requirement.argv), ok: code === 0, ms: 1, output: "Tool version 1\n", execution: completeCheckExecution(code), executor: { ...executor, runtime: { ...executor.runtime } },
      outputIdentity: { stdout: { algorithm: "sha256", bytes: 15, digest: "9668d198f37cd7ef8368dd54f4d955ebfa17263cc14042643db9590c408e5096" }, stderr: { algorithm: "sha256", bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } } } }],
    identity: { version: 1, contract: input.contract, executor: "c".repeat(64), prerequisites: { kind: "declared", observations: "d".repeat(64) } },
  };
}
