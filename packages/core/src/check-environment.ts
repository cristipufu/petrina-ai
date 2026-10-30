import type {
  CheckEnvironmentBinding,
  CheckEnvironmentIdentity,
  CheckExecutorFacts,
  CheckOutputIdentity,
  CheckPipeIdentity,
  CheckPrerequisite,
  CheckRun,
  CheckSetupAttempt,
  CheckSetupInput,
  CheckSetupInvalidation,
  RepositoryState
} from "./model.js";
import { checkOutcome } from "./check-outcome.js";
import { commandText } from "./check-commands.js";

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

/** The existing product-check input bounds, applied to literal argv rather than a shell string. */
export const CHECK_SETUP_LIMITS = { count: 12, id: 200, name: 40, argv: 500 } as const;

/** Validate the whole declaration before a caller mutates products, approvals or saved evidence. */
export function normalizeCheckPrerequisites(value: unknown): CheckPrerequisite[] {
  if (!Array.isArray(value) || value.length > CHECK_SETUP_LIMITS.count) throw new Error("Give at most 12 setup requirements.");
  const requirements: CheckPrerequisite[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index];
    if (!record(entry) || !keys(entry, ["id", "name", "argv"]) || typeof entry.id !== "string" || typeof entry.name !== "string")
      throw new Error("Give every setup requirement an id, a name and literal command arguments.");
    const id = entry.id.trim();
    const name = entry.name.trim();
    if (!id || id.length > CHECK_SETUP_LIMITS.id || ids.has(id)) throw new Error("Give every setup requirement a unique, nonempty id of at most 200 characters.");
    if (!name || name.length > CHECK_SETUP_LIMITS.name || names.has(name)) throw new Error("Give every setup requirement a unique, nonempty name of at most 40 characters.");
    if (!Array.isArray(entry.argv) || !entry.argv.length || entry.argv.length > CHECK_SETUP_LIMITS.argv)
      throw new Error("Give every setup requirement a command as literal arguments.");
    const argv: string[] = [];
    for (let argument = 0; argument < entry.argv.length; argument++) {
      const part: unknown = entry.argv[argument];
      if (typeof part !== "string") throw new Error("Every setup command argument must be text.");
      argv.push(part);
    }
    if (!argv[0]!.trim() || JSON.stringify(argv).length > CHECK_SETUP_LIMITS.argv)
      throw new Error("Give a nonempty setup command with at most 500 characters of literal arguments.");
    ids.add(id);
    names.add(name);
    requirements.push({ id, name, argv });
  }
  return requirements;
}

function canonicalRequirements(value: unknown): value is readonly CheckPrerequisite[] {
  try {
    const normalized = normalizeCheckPrerequisites(value);
    return Array.isArray(value) && normalized.every((entry, index) => value[index].id === entry.id && value[index].name === entry.name);
  }
  catch { return false; }
}

/** Equality is ordered and includes labels: a real coordinator edit receives a new revision. */
export function sameCheckPrerequisites(a: readonly CheckPrerequisite[], b: readonly CheckPrerequisite[]): boolean {
  return canonicalRequirements(a) && canonicalRequirements(b) && a.length === b.length
    && a.every((entry, index) => entry.id === b[index]!.id && entry.name === b[index]!.name
      && entry.argv.length === b[index]!.argv.length && entry.argv.every((part, argument) => part === b[index]!.argv[argument]));
}

const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sourceIdentity = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const setupInput = (value: unknown): value is CheckSetupInput => record(value) && digest(value.definition) && digest(value.contract)
  && (value.sha === undefined || sourceIdentity(value.sha)) && (value.tree === undefined || sourceIdentity(value.tree))
  && (value.invalidationId === undefined || text(value.invalidationId));
/** Base row shape only; checkOutcome still owns the native execution meaning. */
const checkRunRecord = (value: unknown): value is CheckRun => record(value) && typeof value.name === "string" && typeof value.command === "string"
  && typeof value.ok === "boolean" && typeof value.ms === "number" && Number.isFinite(value.ms) && typeof value.output === "string";
const checkBatchRecord = (value: unknown): value is NonNullable<RepositoryState["checks"]> => {
  if (!record(value) || typeof value.at !== "number" || !Number.isFinite(value.at) || !Array.isArray(value.results) || value.current !== undefined && typeof value.current !== "boolean") return false;
  // every/filter skip sparse slots: a missing row must not become an empty passing batch.
  for (let index = 0; index < value.results.length; index++) if (!checkRunRecord(value.results[index])) return false;
  return true;
};
function environmentFields(value: Record<string, unknown>): boolean {
  return value.version === 1 && digest(value.contract) && digest(value.executor) && record(value.prerequisites)
    && (value.prerequisites.kind === "none" ? keys(value.prerequisites, ["kind"])
      : value.prerequisites.kind === "declared" && keys(value.prerequisites, ["kind", "observations"]) && digest(value.prerequisites.observations));
}

export function isCheckEnvironmentIdentity(value: unknown): value is CheckEnvironmentIdentity {
  return record(value) && keys(value, ["version", "contract", "executor", "prerequisites"]) && environmentFields(value);
}

export function isCheckEnvironmentBinding(value: unknown): value is CheckEnvironmentBinding {
  return record(value) && keys(value, ["version", "contract", "executor", "prerequisites", "setupAttempts"]) && environmentFields(value)
    && record(value.setupAttempts) && keys(value.setupAttempts, ["before", "after"])
    && text(value.setupAttempts.before) && text(value.setupAttempts.after) && value.setupAttempts.before !== value.setupAttempts.after;
}

/** Attempt identities and timestamps record provenance, never durable environment equality. */
export function sameCheckEnvironmentIdentity(recorded: unknown, observed: unknown): boolean {
  if (!(isCheckEnvironmentIdentity(recorded) || isCheckEnvironmentBinding(recorded))
    || !(isCheckEnvironmentIdentity(observed) || isCheckEnvironmentBinding(observed))) return false;
  return recorded.version === observed.version && recorded.contract === observed.contract && recorded.executor === observed.executor
    && recorded.prerequisites.kind === observed.prerequisites.kind
    && (recorded.prerequisites.kind === "none" || observed.prerequisites.kind === "declared" && recorded.prerequisites.observations === observed.prerequisites.observations);
}

export type CheckSetupOutcome =
  | { kind: "unobserved" | "pending" | "running" | "stopped" }
  | { kind: "outdated"; reason: "explicit-rerun" | "requirements-changed" | "inputs-changed" }
  | { kind: "unavailable" | "incomplete"; reason: string; requirementId?: string }
  | { kind: "unmet"; requirementId: string; code: number }
  | {
    kind: "verified";
    executor: CheckExecutorFacts;
    observations: readonly {
    requirementId: string;
    output: CheckOutputIdentity
  }[];
    identity?: CheckEnvironmentIdentity
  };

/** Input comparison is recorded applicability only; it neither observes Git nor authorizes a pass. */
export function sameCheckSetupInput(a: CheckSetupInput, b: CheckSetupInput): boolean {
  return a.sha === b.sha && a.tree === b.tree && a.definition === b.definition && a.contract === b.contract && a.invalidationId === b.invalidationId;
}

export type CheckInputApplicability =
  | { kind: "matches"; basis: "same-tree" | "same-commit" }
  | { kind: "changed"; reason: "definition" | "code" }
  | { kind: "unknown"; reason: "definition" | "source" };

/** Code/definition applicability only. A different commit can contain exactly the same reviewed tree. */
export function checkInputApplicability(recorded: unknown, observed: CheckSetupInput): CheckInputApplicability {
  if (!record(recorded) || !digest(recorded.definition) || !digest(observed.definition)) return { kind: "unknown", reason: "definition" };
  if (recorded.definition !== observed.definition) return { kind: "changed", reason: "definition" };
  return checkSourceApplicability(recorded, observed);
}

/** Source-only historical applicability; this says nothing about definitions or a current pass. */
export function checkSourceApplicability(recorded: unknown, observed: unknown): CheckInputApplicability {
  if (!record(recorded) || !record(observed)) return { kind: "unknown", reason: "source" };
  if ((recorded.sha !== undefined && !sourceIdentity(recorded.sha)) || (recorded.tree !== undefined && !sourceIdentity(recorded.tree))
    || (observed.sha !== undefined && !sourceIdentity(observed.sha)) || (observed.tree !== undefined && !sourceIdentity(observed.tree))) return {
      kind: "unknown",
      reason: "source"
    };
  if (sourceIdentity(recorded.tree) && sourceIdentity(observed.tree))
    return recorded.tree === observed.tree ? { kind: "matches", basis: "same-tree" } : { kind: "changed", reason: "code" };
  if (sourceIdentity(recorded.sha) && sourceIdentity(observed.sha))
    return recorded.sha === observed.sha ? { kind: "matches", basis: "same-commit" } : { kind: "changed", reason: "code" };
  return { kind: "unknown", reason: "source" };
}

/** Classify actual recorded observations. Even verified recorded setup is not a live reuse capability. */
export function checkSetupOutcome(attempt?: CheckSetupAttempt, expectedContract?: string, invalidated?: CheckSetupInvalidation): CheckSetupOutcome {
  if (invalidated) return { kind: "outdated", reason: invalidated.kind };
  if (!attempt) return { kind: "unobserved" };
  if (!text(attempt.id) || !text(attempt.productId) || !canonicalRequirements(attempt.requirements)
    || !setupInput(attempt.input)
    || (attempt.position !== "before-checks" && attempt.position !== "after-checks")
    || !Array.isArray(attempt.results) || !Number.isFinite(attempt.queuedAt)) return { kind: "incomplete", reason: "Setup observation is malformed" };
  if (expectedContract !== undefined && attempt.input.contract !== expectedContract) return { kind: "outdated", reason: "requirements-changed" };
  if (attempt.lifecycle === "pending" || attempt.lifecycle === "running" || attempt.lifecycle === "stopped") return { kind: attempt.lifecycle };
  if (attempt.lifecycle !== "settled" || !Number.isFinite(attempt.startedAt) || !Number.isFinite(attempt.endedAt)
    || attempt.startedAt! < attempt.queuedAt || attempt.endedAt! < attempt.startedAt!) return {
      kind: "incomplete",
      reason: "Setup observation has not completed"
    };
  if ("observationFailure" in attempt) {
    const failure: unknown = attempt.observationFailure;
    if (!record(failure) || !keys(failure, ["kind", "message"])
      || typeof failure.kind !== "string" || ![
        "executor",
        "identity",
        "inputs",
        "restoration",
        "execution"
      ].includes(failure.kind) || typeof failure.message !== "string")
      return { kind: "incomplete", reason: "The setup observation failure is malformed" };
    return { kind: "unavailable", reason: text(failure.message) ? failure.message : "The setup observation could not be completed" };
  }
  if (!isCheckExecutorFacts(attempt.executor)) return { kind: "unavailable", reason: "The setup executor was not observed completely" };
  if (attempt.restoration !== undefined && !["unchanged", "restored", "unconfirmed"].includes(attempt.restoration))
    return { kind: "incomplete", reason: "The setup restoration observation is malformed" };
  if (attempt.restoration === "restored" || attempt.restoration === "unconfirmed")
    return {
      kind: "incomplete",
      reason: attempt.restoration === "restored" ? "A setup requirement changed tracked work" : "Setup cleanup could not be confirmed"
    };
  if (attempt.afterInput !== undefined && (!setupInput(attempt.afterInput) || typeof attempt.afterInput.trackedChanged !== "boolean")) return {
    kind: "incomplete",
    reason: "The setup input observation is malformed"
  };
  if (attempt.afterInput && (attempt.afterInput.trackedChanged || !sameCheckSetupInput(
    attempt.input,
    attempt.afterInput
  ))) return {
    kind: "outdated",
    reason: "inputs-changed"
  };
  const observations: { requirementId: string; output: CheckOutputIdentity }[] = [];
  if (attempt.results.length > attempt.requirements.length) return { kind: "incomplete", reason: "Unexpected setup results were recorded" };
  for (let index = 0; index < attempt.results.length; index++) {
    const requirement = attempt.requirements[index]!;
    const result = attempt.results[index]!;
    if (!record(result) || result.requirementId !== requirement.id || !checkRunRecord(result.run) || result.run.name !== requirement.name || result.run.command !== commandText(requirement.argv))
      return { kind: "incomplete", reason: "Setup result membership does not match the attempted declaration" };
    if (!sameCheckExecutorFacts(
      result.run.executor,
      attempt.executor
    )) return {
      kind: "incomplete",
      requirementId: requirement.id,
      reason: "The requirement executor does not match the setup observation"
    };
    const outcome = checkOutcome(result.run);
    if (outcome.kind !== "passed") {
      if (index + 1 !== attempt.results.length) return {
        kind: "incomplete",
        requirementId: requirement.id,
        reason: "Setup continued after a requirement did not pass"
      };
      return outcome.kind === "failed" ? { kind: "unmet", requirementId: requirement.id, code: outcome.code }
        : { kind: outcome.kind === "unavailable" ? "unavailable" : "incomplete", requirementId: requirement.id, reason: outcome.reason };
    }
    if (!isCheckOutputIdentity(result.run.outputIdentity)) return {
      kind: "incomplete",
      requirementId: requirement.id,
      reason: "The complete setup output identity was not observed"
    };
    observations.push({ requirementId: requirement.id, output: result.run.outputIdentity });
  }
  if (attempt.results.length !== attempt.requirements.length) return { kind: "incomplete", reason: "A setup requirement was not executed" };
  if (attempt.requirements.length && (!attempt.afterInput || attempt.restoration !== "unchanged")) return {
    kind: "incomplete",
    reason: "The setup inputs and unchanged work were not confirmed"
  };
  if (attempt.identity !== undefined && !isCheckEnvironmentIdentity(attempt.identity)) return { kind: "incomplete", reason: "The setup identity is malformed" };
  if (attempt.identity && (attempt.identity.contract !== attempt.input.contract || attempt.identity.prerequisites.kind !== (attempt.requirements.length ? "declared" : "none")))
    return { kind: "incomplete", reason: "The setup identity does not describe its attempted declaration" };
  return { kind: "verified", executor: attempt.executor, observations, ...(attempt.identity ? { identity: attempt.identity } : {}) };
}

export type RecordedCheckBatchOutcome =
  | { kind: "passed"; setup: Extract<CheckSetupOutcome, { kind: "verified" }> }
  | { kind: "product-failed"; setup: Extract<CheckSetupOutcome, { kind: "verified" }>; failed: readonly CheckRun[] }
  | { kind: "blocked"; setup: CheckSetupOutcome; reason: string; productFailures: readonly CheckRun[] };

/** Recorded applicability for guards/readers. Actual verification additionally needs an operation-local observation. */
function recordedBatch(work: Pick<RepositoryState, "checks" | "checkSetup" | "checkSetupInvalidated">, currency: "current" | "historical"): RecordedCheckBatchOutcome {
  const setup = checkSetupOutcome(work.checkSetup, undefined, work.checkSetupInvalidated);
  const saved: unknown = work.checks;
  const rows = record(saved) && Array.isArray(saved.results) ? saved.results : [];
  const productFailures = rows.filter(checkRunRecord).filter(run => checkOutcome(run).kind === "failed");
  const blocked = (reason: string): RecordedCheckBatchOutcome => ({ kind: "blocked", setup, reason, productFailures });
  if (!checkBatchRecord(saved)) return blocked("The recorded product batch is missing or malformed");
  const checks = saved;
  if (currency === "current" && checks.current === false) return blocked("The recorded batch is known to need fresh verification");
  if (setup.kind !== "verified") return blocked("Local setup has not been verified");
  if (!setup.identity || !isCheckEnvironmentBinding(checks.environment)) return blocked("The recorded batch has no complete environment binding");
  if (!sameCheckEnvironmentIdentity(checks.environment, setup.identity)) return blocked("The recorded setup and batch environments differ");
  const applicability = checkInputApplicability(checks, work.checkSetup!.input);
  if (applicability.kind !== "matches") return blocked(applicability.kind === "changed" ? "The recorded setup and batch code or definitions differ" : "The recorded setup and batch have no comparable source and definition identity");
  if (checks.results.some(run => !sameCheckExecutorFacts(
    run.executor,
    setup.executor
  ))) return blocked("A product command has missing or different executor facts");
  if (checks.results.some(run => {
    const kind = checkOutcome(run).kind;
    return kind !== "passed" && kind !== "failed";
  })) return blocked("Product command execution is incomplete or unavailable");
  return productFailures.length ? { kind: "product-failed", setup, failed: productFailures } : { kind: "passed", setup };
}

/** Strict recorded applicability; an outdated pass is not current check evidence. */
export function recordedCheckBatch(work: Pick<RepositoryState, "checks" | "checkSetup" | "checkSetupInvalidated">): RecordedCheckBatchOutcome {
  return recordedBatch(work, "current");
}

/** Historical proof only. This cannot authorize automatic delivery or live reuse. */
export function priorCheckBatchPass(work: Pick<RepositoryState, "checks" | "checkSetup" | "checkSetupInvalidated">): { kind: "prior-pass" } | { kind: "unverified" } {
  return { kind: recordedBatch(work, "historical").kind === "passed" ? "prior-pass" : "unverified" };
}

/** Plain recorded evidence; this label never samples the host or authorizes reuse. */
export function checkSetupWords(outcome: CheckSetupOutcome): string {
  switch (outcome.kind) {
    case "verified": return "Local setup was verified";
    case "unmet": return `Local setup requirement ${outcome.requirementId} did not pass (exit ${outcome.code})`;
    case "unavailable": return `Local setup unavailable: ${outcome.reason}`;
    case "incomplete": return `Local setup incomplete: ${outcome.reason}`;
    case "outdated": return outcome.reason === "explicit-rerun" ? "Fresh local setup and checks were requested" : "Local setup needs verification after changed inputs";
    case "running": return "Verifying local setup";
    case "pending": return "Local setup is waiting to run";
    case "stopped": return "Local setup verification stopped";
    case "unobserved": return "Local setup has not been observed";
  }
}
