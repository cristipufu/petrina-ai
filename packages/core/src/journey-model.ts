// Task journey steps, check attempt evidence and exact prompt manifest types.
import type { GateKind, Id, ProfileAssignment } from "./catalog-model.js";
import type { CheckEnvironmentBinding, CheckEnvironmentIdentity, CheckRun, CheckSetupAttempt } from "./check-model.js";
import type { AgentToolActivity, Finding, Hunt, MessageDelivery, Objection, ProofDecision, ReportImage, ToolInvocation } from "./review-model.js";
import type { TurnReason } from "./worklog.js";
import type { ReadinessRecheck } from "./readiness.js";

/** How an arrow out of a step reads: the work moved on, went back (a send-back, changes asked), or got stuck. */
export type JourneyTone = "on" | "back" | "stuck";

/** What a step of the coordinator's waits for: a check, the call on a disagreement, a stuck task, or interrupted shipping. */
export type JourneyWait = GateKind | "call" | "stuck" | "shipping";

/** Petrina's own work, with no agent: running the product's checks, finding main moved on, and publishing the delivery. */
export type JourneyWork = "checks" | "check-reuse" | "update" | "delivery" | "review-decision";

/** A question or permission request asked during a step, with how the coordinator answered. */
export interface JourneyAsk {
  /** The inbox item. */
  id: Id;
  kind: "question" | "permission";
  title: string;
  at: number;
  endedAt?: number;
  /** Answered, allowed, said no, decided for you, or withdrawn (a pause, a restart or cancelling dropped it). */
  how?: "answered" | "allowed" | "denied" | "decided" | "withdrawn";
  /** The answer, or the note with a "No". */
  answer?: string;
}

/**
 * One step of a task's journey, recorded by the engine (and the simulator) the moment it starts.
 * A new round, send-back or retry is a new step; picking up after a restart or a pause is the same one.
 */
export interface JourneyStep {
  /** Complete shortened review entries, once per frozen round. Retained after working-file cleanup. */
  reviewHistory?: { file: string; digest: string; body: string; roundId?: Id };
  extraValidations?: readonly import("./extra-validation.js").ExtraValidation[];
  /** The immutable blind-review input shared by this round, retained after temporary review state ends. */
  reviewInput?: NonNullable<Hunt["input"]>;
  /** Unique within the task. Timeline and session lines carry it. */
  id: Id;
  /** Why this step began, captured then rather than reconstructed from later task state. */
  trigger?: { after?: Id; reason: string };
  /**
   * `agent`: a role at work. `you`: waiting for the coordinator. `wait`: waiting for other tasks to land.
   * `petrina`: Petrina's own work, with no agent.
   */
  kind: "agent" | "you" | "wait" | "petrina";
  /** The plan stage it belongs to; none while planning. */
  stageId?: Id;
  /** The design or review round. */
  round: number;
  /** The design position: 0 the architect of a design round and 1 its reviewer. A review round's reviewers share one step. */
  sub: number;
  /** The builder fixing review findings or changes asked for at the delivery check. */
  fixing?: boolean;
  /** Findings assigned to this builder fix round. */
  findingIds?: readonly Id[];
  /** This step's saved evidence, independent of later rounds. Unmarked older findings are hand-back copies. */
  result?: {
    objections?: readonly Objection[];
    findings?: readonly Finding[];
    findingsSettled?: true;
    /** Recorded transitions; a settled reviewers' step covers the whole examination across retries. */
    findingChanges?: {
      raised: readonly Id[];
      fixed: readonly Id[];
      dismissed: readonly Id[];
      reopened?: readonly {
      id: Id;
      evidence: boolean
    }[];
      claimedFixed?: readonly Id[]
    };
  };
  /** Whether the builder continued its saved conversation or began a fresh one for this step. */
  builderConversation?: "resumed" | "new";
  /** Observed contents for this return, independent of the Builder's claims. */
  builderReturn?: { productId: Id; changed?: boolean; claimedFixes: number; outcome: string };
  /** Created with exact per-turn usage attribution enabled. Older steps may need time-based evidence. */
  usageTracked?: boolean;
  /** The builder bringing the work up to date with main. */
  update?: boolean;
  /** A review round that looks only at the builder's port of an already reviewed change onto a main that moved. */
  port?: boolean;
  /** The architect following the coordinator's call. */
  call?: boolean;
  roleId?: Id;
  /** The tool, model and effort. */
  profileId?: Id;
  /** Every agent on the step when several work at once (a review round's reviewers, its voters), `profileId` first. */
  team?: readonly Id[];
  /**
   * The positions the step expects a result from, recorded by the engine as it admits participants: a review
   * round's reviewer places (`reviewer:0`, `reviewer:1`) or a vote's places (`verifier:<place>`, see `JourneyAgentInput.place`).
   * Profiles that start or stand in fill these positions; a planned seat nobody started is still expected.
   */
  seats?: readonly string[];
  /** The role-specific context given to each agent in this step. Older saved steps have no snapshot. */
  agentInputs?: readonly JourneyAgentInput[];
  /** The original accepted response, plus any pictures saved with that response. `findings`: the finding records exactly as this seat's result left them; later peers and rounds never rewrite them. */
  agentResults?: readonly {
    roleId: Id;
    profileId: Id;
    at: number;
    value: unknown;
    inputIndex?: number;
    images?: readonly ReportImage[];
    productId?: Id;
    versions?: Readonly<Record<Id, string>>;
    findings?: readonly Finding[]
  }[];
  /** Later steps that reused this step's run instead of running the checks again, with the basis for each reuse. */
  reuses?: readonly JourneyCheckReuse[];
  /** The product checks Petrina ran during this checks step. */
  productChecks?: readonly JourneyProductCheck[];
  /** Immutable run versions; unlike the repository's latest checks these survive subsequent runs. */
  checkAttempts?: readonly CheckAttemptEvidence[];
  /** Actual setup observations, separate from product commands and their findings. */
  checkSetups?: readonly CheckSetupAttempt[];
  /** Check-specific answers from a completed build result, bound before that repair started. */
  checkRepairs?: readonly CheckRepairEvidence[];
  buildVersions?: Readonly<Record<Id, string>>;
  buildProductId?: Id;
  /** Passed applicable review rounds, without any reviewer conclusions. */
  checkReviews?: readonly { productId: Id; tree: string; at: number; stageId: Id; round: number }[];
  /** Frozen before a Tester starts; retained when its conversation resumes. */
  proofRun?: { versions: Readonly<Record<Id, string>>; changes: Readonly<Record<Id, string>>; requestIds: readonly Id[]; restored?: AcceptanceRestoration };
  proofChecks?: readonly { id: Id; result: "pass" | "fail" | "blocked"; evidence?: string; reason?: string }[];
  proofDecision?: ProofDecision;
  /** A delivery decision's record of the required acceptance it was asked about, saved as the decision is raised. */
  acceptanceGap?: AcceptanceGap;
  /** Per seat, including finished members and usage replacements. */
  toolActivity?: Readonly<Record<string, AgentToolActivity>>;
  /** Recent calls across all seats, capped independently of lifetime action counts. */
  toolInvocations?: readonly (ToolInvocation & { seat: string; roleId: Id; profileId: Id; productId: Id })[];
  /** `petrina`: what Petrina did. */
  work?: JourneyWork;
  /** `you`: what it waits for. */
  waitsFor?: JourneyWait;
  /** `wait`: the tasks it waits for, named as they were then. */
  waitsOn?: readonly { id: Id; title: string }[];
  /** The coordinator's explicit reason for a runtime prerequisite hold. */
  waitReason?: string;
  waitStates?: readonly { id: Id; state: string; landed: boolean; decisionNeeded: boolean }[];
  runtimeWait?: boolean;
  /** A temporary partial-group line restores any real outcome when its hold ends. */
  waitOutcome?: { previous?: string };
  startedAt: number;
  endedAt?: number;
  /** How it ended: done, stuck, or stopped by cancelling. */
  end?: "done" | "failed" | "cancelled";
  /** What happened, in a few words: "Wrote the brief", "3 objections, 2 blocking", "Approved". */
  outcome?: string;
  /** Acceptance criteria and their result from this Tester run. */
  acceptanceChecks?: readonly JourneyAcceptanceCheck[];
  /** Change identity calculated for this acceptance run. Absent when unavailable or on older records. */
  acceptancePatch?: string;
  /** Why the work moved on from here: the words on the arrow out. */
  reason?: string;
  tone?: JourneyTone;
  asks?: readonly JourneyAsk[];
  /** Made up from the plan for a task that ran before journeys were recorded: no times or rounds. */
  legacy?: boolean;
}

export interface JourneyAcceptanceCheck {
  text: string;
  result: "pass" | "fail" | "blocked";
  reason?: string;
  /** The scenario and observed result, recorded by this acceptance run. */
  evidence?: string;
}

/**
 * Commits or tracked-file edits Petrina undid during one acceptance run, saved before the undo. None of the
 * run's answers can verify the restored product. New untracked files alone are output and are not recorded.
 * Without products, Petrina stopped before the run's cleanup was accounted for, so nothing shows what it undid.
 */
export interface AcceptanceRestoration {
  at: number;
  products: readonly { productId: Id; commits?: boolean; edits?: boolean; files?: readonly string[] }[];
}

/**
 * Required acceptance a delivery decision covers: the latest acceptance run and each saved checklist item it could not
 * verify, or that Petrina invalidated that run. The Tester's extra probes are observations and never part of it;
 * requested proof keeps its own decision.
 */
export interface AcceptanceGap {
  /** That acceptance run's journey step, and its original report there. */
  stepId?: Id;
  reportIndex?: number;
  /** As recorded: why it could not be verified, what the Tester observed, and the products it affects. */
  items: readonly { text: string; reason?: string; evidence?: string; productIds?: readonly Id[] }[];
  restored?: true;
  /** Saved with a decision: the exact versions tested and prepared, and how they relate for each product. */
  tested?: Readonly<Record<Id, string>>;
  prepared?: Readonly<Record<Id, string>>;
  coverage?: readonly { productId: Id; state: "same-contents" | "same-change" | "changed" | "unknown" }[];
}

export interface JourneyProductCheck {
  id?: string;
  /** Shared by the commands prepared together, including a rerun on the same journey step. */
  attemptId?: string;
  queuedAt?: number;
  productId?: Id;
  findingId?: Id;
  namedFailures?: readonly { name: string; file?: string }[];
  /** Original run, including its complete diagnostic link. Never points to a later run. */
  run?: CheckRun;
  /** When saved evidence was selected; never an execution start. */
  reusedAt?: number;
  /** Original recorded attempt, including entries skipped without execution. */
  source?: CheckRun["source"];
  name: string;
  result: "pending" | "running" | "pass" | "fail" | "did-not-finish" | "stopped" | "skipped";
  startedAt?: number;
  endedAt?: number;
  /** A short diagnostic from the failed run, saved with the step for later review. */
  detail?: string;
}

export interface CheckAttemptEvidence {
  id: string;
  productId: Id;
  sha?: string;
  tree?: string;
  /** Product commands only; hook inputs deliberately do not define a peer match. */
  commands: readonly string[];
  definition: string;
  /** Stable observed environment of this actual batch; absent historical evidence stays absent. */
  environment?: CheckEnvironmentBinding;
  /** Every required command and hook passed on this exact version and definition. */
  passed?: boolean;
}

export interface CheckRepairEvidence {
  productId: Id;
  failureNode: Id;
  checkId: string;
  attemptId: string;
  findingId: Id;
  sha: string;
  tree: string;
  definition: string;
  commands: readonly string[];
  answer: { fixed: boolean; text: string };
}

/** A later step consumed this step's saved run because the code and check definitions were unchanged. */
export interface JourneyCheckReuse {
  at: number;
  /** The original attempt on its saved journey node, when recorded. */
  attemptId?: string;
  /** What the reused evidence was for. */
  purpose: "acceptance" | "review" | "delivery-check" | "publishing";
  productId?: Id;
  /** How the unchanged code was recognized. */
  basis: "same-tree" | "same-commit";
  originalAt: number;
  sha?: string;
  tree?: string;
  definition?: string;
  passed: boolean;
  /** The new observation that authorized this handoff; never a new execution of the original rows. */
  environment?: { identity: CheckEnvironmentIdentity; setupAttemptId: Id };
}

/** The exact text handed to an agent, saved once as an immutable file beside the complete-context files. */
export interface ExactMessage {
  file: string;
  digest: string;
  size: number;
}

/** One section of an exact message: its name, size and content identity, never its body. */
export interface InputManifestEntry {
  name: string;
  /** Distinguishes sections that share a name within one message. */
  occurrence?: number;
  size: number;
  digest: string;
  /** `reference`: an unchanged complete-context packet referenced instead of repeated. `omitted`: unchanged background left out of a continued conversation, recognized from recorded comparisons. */
  kind: "text" | "instructions" | "reference" | "omitted";
  file?: string;
  reference?: string;
  /** A recorded coordinator note left out, without asserting message delivery. */
  noteId?: Id;
}

/** The job and task context actually handed to one agent, captured before sending. */
export interface JourneyAgentInput {
  /** The bound repository and its recorded versions at this handoff; absent on older records. */
  productId?: Id;
  stepAttempts?: number;
  versions?: {
    base?: string;
    reviewed?: string;
    reviewedTree?: string;
    checks?: {
    at: number;
    sha?: string;
    tree?: string;
    definition?: string;
    passed: boolean;
    count: number;
    node?: Id
  }
  };
  reviewInput?: NonNullable<Hunt["input"]>;
  at?: number;
  roleId: Id;
  profileId: Id;
  /** Distinguishes reviewer seats even when their role and profile are identical. */
  reviewerKey?: Id;
  /** A vote's place, kept through usage replacements: its original planned profile, or `third:<profile>` for a third answer. */
  place?: string;
  requestedProfileId?: Id;
  selectionReason?: string;
  /** Settings confirmed by the native tool when this turn opened. */
  confirmedSettings?: { model?: string; modelName?: string; effort?: string };
  assignment?: ProfileAssignment;
  taskTitle: string;
  /** Present when this start included the task request; continued prompts only add updated context. */
  taskDescription?: string;
  stageTitle?: string;
  /** The role's job for this particular start, including runtime changes such as conflict repair. */
  instructions?: string;
  sections: readonly { title: string; body: string }[];
  /** Further instructions sent in this step: answers, repairs, messages and interruption resumes. */
  updates?: readonly { at: number; reason: TurnReason; text: string; messageId?: Id; delivery?: MessageDelivery["state"]; exact?: ExactMessage }[];
  mode: "fresh" | "continued";
  /** This continuation resumes an interrupted step, rather than starting a later step in the conversation. */
  resumed?: boolean;
  /** The complete opening text as sent, after context reduction and automatic additions. Absent on older records. */
  exact?: ExactMessage;
  /** The sections the opening text actually supplied, by name, size and identity. */
  manifest?: readonly InputManifestEntry[];
  /** Why a fresh conversation was needed instead of the saved one, when Petrina recorded it. */
  freshReason?: string;
  /** A saved conversation's bounded readiness recheck before this start: what was known, started or joined, and found. */
  readiness?: ReadinessRecheck;
  /** The native conversation this input went to. */
  sessionId?: string;
}
