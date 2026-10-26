import { commandText, type CheckExecutorFacts, type CheckPrerequisite, type CheckSetupAttempt } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { CheckSetup } from "../../src/check-setup.js";
import type { CheckSetupExecution, CheckSetupHost, CheckSetupRequest } from "../../src/ports/check-setup.js";

export const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
export const compiler: CheckPrerequisite = { id: "compiler", name: "Compiler identity", argv: ["compiler", "--version"] };
export const browser: CheckPrerequisite = { id: "browser", name: "Browser identity", argv: ["browser", "--version"] };
const empty = { algorithm: "sha256" as const, bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
// Explicit accepted observations for a portable controller; no native process is claimed by these values.
export const facts: CheckExecutorFacts = { version: 1, adapter: "local-product-checks", contract: 1, launchPolicy: 1,
  platform: "scripted", architecture: "scripted", osRelease: "scripted", runtime: { name: "bun", version: "scripted" } };
export const reply = (requirement: CheckPrerequisite, code = 0): CheckSetupExecution => ({ kind: "recorded", run: {
  name: requirement.name, command: commandText(requirement.argv), ok: code === 0, ms: 1, output: "",
  execution: completeCheckExecution(code), executor: facts, outputIdentity: { stdout: empty, stderr: empty },
} });
export function fixture(requirements: readonly CheckPrerequisite[] = []) {
  let now = 2, identities = 0;
  const calls: string[] = [], published: CheckSetupAttempt[] = [];
  const request: CheckSetupRequest = { id: "setup", productId: "shop", queuedAt: 1, position: "before-checks",
    input: { sha: "1".repeat(40), tree: "2".repeat(40), definition: "3".repeat(64), contract: "a".repeat(64) }, requirements };
  const host: CheckSetupHost = {
    now() { return now++; }, executor() { calls.push("executor"); return { kind: "observed", facts }; },
    async execute(requirement) { calls.push(requirement.id); return reply(requirement); },
    async finish(attempt, activity) { calls.push(`finish:${activity}`); return { afterInput: { ...attempt.input, trackedChanged: false }, restoration: "unchanged" }; },
    identity(attempt) { identities++; return { version: 1, contract: attempt.input.contract, executor: "b".repeat(64),
      prerequisites: attempt.requirements.length ? { kind: "declared", observations: "c".repeat(64) } : { kind: "none" } }; },
    changed(attempt) { published.push(attempt); },
  };
  const controller = new CheckSetup(host), signal = new AbortController();
  return { request, host, controller, signal, calls, published, identities: () => identities, run: () => controller.observe(request, signal.signal) };
}
