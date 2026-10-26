import type { CheckExecutorFacts, CheckOutputIdentity, CheckPipeIdentity } from "./model.js";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value);
  return Reflect.ownKeys(value).length === expected.length && actual.length === expected.length && actual.every(key => expected.includes(key));
};
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Strict v1 shape only; validating a record does not prove that a native adapter observed it. */
export function isCheckExecutorFacts(value: unknown): value is CheckExecutorFacts {
  return record(value) && keys(value, ["version", "adapter", "contract", "launchPolicy", "platform", "architecture", "osRelease", "runtime"])
    && value.version === 1 && text(value.adapter) && version(value.contract) && version(value.launchPolicy)
    && text(value.platform) && text(value.architecture) && text(value.osRelease)
    && record(value.runtime) && keys(value.runtime, ["name", "version"]) && text(value.runtime.name) && text(value.runtime.version);
}

/** Compare every understood fact, never adding today's values to missing historical evidence. */
export function sameCheckExecutorFacts(recorded: unknown, observed: unknown): boolean {
  return isCheckExecutorFacts(recorded) && isCheckExecutorFacts(observed)
    && recorded.version === observed.version && recorded.adapter === observed.adapter && recorded.contract === observed.contract
    && recorded.launchPolicy === observed.launchPolicy && recorded.platform === observed.platform && recorded.architecture === observed.architecture
    && recorded.osRelease === observed.osRelease && recorded.runtime.name === observed.runtime.name && recorded.runtime.version === observed.runtime.version;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const pipeIdentity = (value: unknown): value is CheckPipeIdentity => record(value) && keys(value, ["algorithm", "bytes", "digest"])
  && value.algorithm === "sha256" && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0
  && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest) && (value.bytes !== 0 || value.digest === EMPTY_SHA256);

/** A complete pair only: unknown future fields/algorithms require an explicit schema change. */
export function isCheckOutputIdentity(value: unknown): value is CheckOutputIdentity {
  return record(value) && keys(value, ["stdout", "stderr"]) && pipeIdentity(value.stdout) && pipeIdentity(value.stderr);
}

export function sameCheckOutputIdentity(recorded: unknown, observed: unknown): boolean {
  if (!isCheckOutputIdentity(recorded) || !isCheckOutputIdentity(observed)) return false;
  return (["stdout", "stderr"] as const).every(pipe => recorded[pipe].algorithm === observed[pipe].algorithm
    && recorded[pipe].bytes === observed[pipe].bytes && recorded[pipe].digest === observed[pipe].digest);
}
