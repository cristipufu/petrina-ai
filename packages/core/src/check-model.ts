// Product and automated check execution domain types.
import type { DeliveryMode, GuideLine, Id, LearningReceipt, Tone } from "./catalog-model.js";

export interface Product {
  id: Id;
  name: string;
  /** owner/name on GitHub. */
  repo: string;
  /**
   * The address Petrina fetches from and publishes to, exactly as configured when the product was added
   * (no address rewrites). Products added before Petrina kept it ask the coordinator once.
   */
  remote?: string;
  /** An address the coordinator said is wrong: no fetching or publishing with it. */
  remoteRefused?: string;
  tone: Tone;
  /** The local clone Petrina makes worktrees from. */
  path?: string;
  defaultBranch?: string;
  delivery?: DeliveryMode;
  /** Ask the coordinator before delivering. Defaults to true. */
  approveDelivery?: boolean;
  /** Which part of the version a release bumps. Defaults to patch. */
  releaseBump?: "patch" | "minor" | "major";
  /** With "ask before shipping" on: low-risk work ships without asking. Off unless the coordinator opts in. */
  shipLowRisk?: boolean;
  /** Lines the coordinator accepted for the review guide (REVIEW.md). Reviewers see them at once; Petrina adds them to the file. */
  reviewGuide?: readonly GuideLine[];
  /** Lessons accepted for AGENTS.md, until their incorporation in the default branch is confirmed. */
  learnings?: readonly GuideLine[];
  /** The last 100 accepted lessons found on the default branch: read only when an update conflicts in AGENTS.md alone. */
  learningReceipts?: readonly LearningReceipt[];
  /** Lessons the coordinator said no to (declined or left unticked): never offered again. */
  learningsDeclined?: readonly string[];
  /** The commands that prove this product works. Petrina runs them itself; unset until found. */
  checks?: readonly ProductCheck[];
  /** Coordinator-owned local prerequisites. The Check finder never writes this declaration. */
  checkSetup?: ProductCheckSetup;
  /** Who set the checks: the Check finder agent, or the coordinator by hand (never replaced on its own). */
  checksBy?: "finder" | "coordinator";
  /** A fingerprint of the CI and build files the finder read: when they change, it looks again. */
  checksFingerprint?: string;
  /** What the Check finder found for each recent set of CI and build files: tasks on different bases each reuse theirs. */
  checksSeen?: readonly { fingerprint: string; checks: readonly ProductCheck[] }[];
  /** The repository's own commit hooks (pre-commit, commit-msg) as git would run them: Petrina runs them on every task's change. */
  hooks?: readonly string[];
}

/** One command that proves a product works, run as an argument array (never through a shell). */
export interface ProductCheck {
  name: string;
  argv: readonly string[];
  /** Why this command, in plain words (for example: "CI runs it on every pull request"). */
  why?: string;
}

/** A small read-only setup/identity command, supplied as literal arguments without a shell. */
export interface CheckPrerequisite {
  id: Id;
  name: string;
  argv: readonly string[];
}

export interface ProductCheckSetup {
  revision: Id;
  requirements: readonly CheckPrerequisite[];
}

/** Canonical identities compare relevant observations, never a machine, boot, PID or wall clock. */
export interface CheckEnvironmentIdentity {
  version: 1;
  contract: string;
  executor: string;
  prerequisites: { kind: "none" } | { kind: "declared"; observations: string };
}

export interface CheckEnvironmentBinding extends CheckEnvironmentIdentity {
  /** Provenance only: these attempt ids are deliberately excluded from identity equality. */
  setupAttempts: { before: Id; after: Id };
}

export interface CheckSetupInput {
  sha?: string;
  tree?: string;
  definition: string;
  contract: string;
  /** An actual coordinator invalidation this operation must consume, not another repair allowance. */
  invalidationId?: Id;
}

/** An immutable settled observation; the repository points at its latest attempt. */
export interface CheckSetupAttempt {
  id: Id;
  productId: Id;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  lifecycle: "pending" | "running" | "settled" | "stopped";
  position: "before-checks" | "after-checks";
  input: CheckSetupInput;
  requirements: readonly CheckPrerequisite[];
  results: readonly { requirementId: Id; run: CheckRun }[];
  runningRequirementId?: Id;
  executor?: CheckExecutorFacts;
  observationFailure?: { kind: "executor" | "identity" | "inputs" | "restoration" | "execution"; message: string };
  afterInput?: CheckSetupInput & { trackedChanged: boolean };
  restoration?: "unchanged" | "restored" | "unconfirmed";
  /** Derived by the canonical observation owner, never accepted from coordinator configuration. */
  identity?: CheckEnvironmentIdentity;
}

/** Configuration/rerun can invalidate authority even before any real setup attempt exists. */
export interface CheckSetupInvalidation {
  id: Id;
  kind: "explicit-rerun" | "requirements-changed";
  at: number;
  revision?: Id;
}

/** Native execution observations; a diagnostic file is separate from the command's own completion. */
export interface CheckExecution {
  started: boolean;
  exit: { status: "unreported" | "reported" | "rejected" | "invalid"; code?: number; signal?: string };
  stdout: "incomplete" | "eof" | "read-error";
  stderr: "incomplete" | "eof" | "read-error";
  timedOut: boolean;
  cancelled: boolean;
  failure?: { kind: "start" | "observer" | "read" | "output" | "exit"; message: string };
  /** Not requested on an ordinary exit: that is not proof that every descendant ended. */
  cleanup: "not-requested" | "confirmed" | "unconfirmed";
  outputCleanup: "not-requested" | "confirmed" | "unconfirmed";
}

/** Actual local executor facts, not product platform requirements or physical-machine identity. */
export interface CheckExecutorFacts {
  version: 1;
  adapter: string;
  contract: number;
  launchPolicy: number;
  platform: string;
  architecture: string;
  osRelease: string;
  runtime: { name: string; version: string };
}

/** Every raw byte of one completely observed output pipe, independently of diagnostic excerpts. */
export interface CheckPipeIdentity {
  algorithm: "sha256";
  bytes: number;
  digest: string;
}

export interface CheckOutputIdentity {
  stdout: CheckPipeIdentity;
  stderr: CheckPipeIdentity;
}

/** What really happened when Petrina ran a check. */
export interface CheckRun {
  name: string;
  command: string;
  ok: boolean;
  ms: number;
  startedAt?: number;
  endedAt?: number;
  source?: { stepId: Id; attemptId: string; checkId: string };
  /** Present on newly executed commands only. Missing historical facts are never inferred from prose. */
  execution?: CheckExecution;
  /** Observed at this native command attempt, including failed or incomplete execution. */
  executor?: CheckExecutorFacts;
  /** Failure to observe the executor is separate from the command's actual exit. */
  executorError?: string;
  /** Complete independent stdout/stderr bytes; never reconstructed from saved text or a log prefix. */
  outputIdentity?: CheckOutputIdentity;
  /** Hash capture failed; this does not change the command's own execution result. */
  outputIdentityError?: string;
  /** Confirmed machine event overlapping this execution, not an inferred failure cause. */
  interruption?: { source: "macOS power log"; at: number; event: string };
  /** The end of the command's output, as plain text. */
  output: string;
  /** Private complete output on this machine, independent of the working copy and prompt excerpt. */
  logPath?: string;
  /** Identity captured from the file Petrina opened for this check; absent on older saved runs. */
  logFileIdentity?: { device: string; inode: string };
  /** Settled length in bytes, read through that same opened file; absent on older saved runs. */
  logFileLength?: number;
  /** SHA-256 of that file's first 4,096 bytes (or all of a shorter file): bounded recognition, not proof of later bytes. */
  logFileBeginning?: string;
  /** The log could not be saved completely; this never changes the command's own result. */
  logError?: string;
  /** Whether both output pipes reached their end before the command settled. Absent on older runs. */
  logComplete?: boolean;
  interrupted?: boolean;
  /** The local command was ended by a signal, rather than reporting an ordinary exit. */
  exitSignal?: string;
  timedOut?: boolean;
  /** Petrina could not obtain a process-tree snapshot while stopping this command. */
  cleanupIncomplete?: boolean;
}
