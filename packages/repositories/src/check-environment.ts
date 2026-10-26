import { createHash, type Hash } from "node:crypto";
import { release } from "node:os";
import { isCheckExecutorFacts, type CheckExecutorFacts, type CheckOutputIdentity, type CheckRun } from "@petrina/core";

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

type OutputObservation = Pick<CheckRun, "outputIdentity" | "outputIdentityError">;

/** Hash the existing readers' raw chunks without retaining output or affecting command execution. */
export function checkOutputCapture() {
  const pipes: Record<keyof CheckOutputIdentity, { hash?: Hash; bytes: number }> = { stdout: { bytes: 0 }, stderr: { bytes: 0 } };
  let failure: string | undefined, result: OutputObservation | undefined;
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
        pipe.hash!.update(bytes); pipe.bytes = length;
      } catch (error) { failure ??= message(error); }
    },
    finish(complete: boolean): OutputObservation {
      if (result !== undefined) return result;
      if (failure !== undefined) return result = { outputIdentityError: failure };
      if (!complete) return result = {};
      try {
        const identity = (name: keyof CheckOutputIdentity) => ({ algorithm: "sha256" as const, bytes: pipes[name].bytes, digest: pipes[name].hash!.digest("hex") });
        return result = { outputIdentity: { stdout: identity("stdout"), stderr: identity("stderr") } };
      } catch (error) { return result = { outputIdentityError: message(error) }; }
    },
  };
}
