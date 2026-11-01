// Shared engine configuration, runtime state types, error classes and startup migration helpers.

import type { FileOperations } from "@petrina/platform/file-operations";
import {
  CHECK_NAMES,
  DEFAULT_PLANNER_PROFILE,
  isCheckId,
  MAX_SESSION_LINES,
  openStep,
  stepKey,
  type AgentProfile,
  type CheckId,
  type CheckStatus,
  type DeepMutable,
  type Id,
  type Platform,
  type ProfileChoices,
  type RiskLevel,
  type Stage,
  type State,
  type Task,
  type Tone,
} from "@petrina/core";
import {
  scopesFor,
  type GitHubService,
  type RuntimeTask,
  type StartAgentSession,
  type ToolProbe,
  type ValidationRunEffects,
} from "@petrina/orchestrator";
import type { FoundTerminal } from "@petrina/agent-runtime/terminal";
import type { DeveloperToolsResult, Which } from "@petrina/repositories/tool-readiness";
import type { ContainerInspection } from "./container-inspection.js";
import type { ContainerControl } from "./container-control.js";
import type { CheckCommandExecutor } from "./checks.js";
import type { MachineRecords } from "./check-interruption.js";

export type { RuntimeTask };
export type RuntimeState = Omit<DeepMutable<State>, "tasks"> & { tasks: RuntimeTask[] };
export type MutableStage = DeepMutable<Stage>;

export const PLANNER_PROFILE = DEFAULT_PLANNER_PROFILE;
export const RELEASE_MANAGER_PROFILE = DEFAULT_PLANNER_PROFILE;
export const CHECK_FINDER_PROFILE = DEFAULT_PLANNER_PROFILE;
export const GUIDE_KEEPER_PROFILE = DEFAULT_PLANNER_PROFILE;

export const TONES: readonly Tone[] = [
  "blue",
  "green",
  "orange",
  "violet",
  "pink",
  "teal",
  "indigo",
  "purple",
  "amber",
  "slate",
];

export { MAX_SESSION_LINES, stepKey };
export const MAX_TIMELINE = 400;
export const RISK_WORD: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };

/** Role ids that changed: what was saved under the old one keeps working. */
const RENAMED_ROLES: Readonly<Record<string, string>> = { shipper: "release-manager" };

/**
 * State saved before a role was renamed, with every role id it holds moved to the new one, once, as it loads:
 * plan stages, the working agents, conversation and take-over notes, lessons, the timeline, the session and the inbox.
 */
export function renameRoles(state: RuntimeState): void {
  const move = (entry: { roleId?: string } | undefined) => {
    const to = entry?.roleId ? RENAMED_ROLES[entry.roleId] : undefined;
    if (to) entry!.roleId = to;
  };
  for (const task of state.tasks) {
    for (const stage of task.plan?.stages ?? []) {
      move(stage);
      const reviewer = stage.reviewerRoleId ? RENAMED_ROLES[stage.reviewerRoleId] : undefined;
      if (reviewer) stage.reviewerRoleId = reviewer;
    }
    move(task.agent);
    for (const helper of task.helpers ?? []) move(helper);
    for (const { work } of scopesFor(task)) {
      move(work.conversation);
      for (const lesson of work.lessons ?? []) move(lesson);
    }
    move(task.driving);
    for (const entry of task.timeline) move(entry);
    for (const line of task.session) move(line);
  }
  for (const item of state.inbox) move(item);
}

/** First run's record. An install that already has products or tasks never sees first run. */
export function setupOf(loaded: State | undefined): DeepMutable<NonNullable<State["setup"]>> {
  const platform: Platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
  const saved = loaded?.setup;
  if (!saved) {
    return {
      done: !!loaded && (loaded.products.length > 0 || loaded.tasks.length > 0),
      platform,
      checks: [],
    };
  }
  // Nothing is being checked right after a start; retired check ids from older saves are dropped.
  return {
    ...(saved as DeepMutable<NonNullable<State["setup"]>>),
    platform,
    checks: saved.checks.filter((check) => isCheckId(check.id)).map(({ checking: _, ...check }) => check),
  };
}

/** One product's undone acceptance changes join the in-flight run and its open step, adding to what was already seen. */
export function addRestored(
  task: RuntimeTask,
  entry: { productId: Id; commits?: boolean; edits?: boolean; files?: readonly string[] },
): void {
  const run = task.acceptanceRun!;
  const saved = run.restored?.products.find((other) => other.productId === entry.productId);
  const commits = !!entry.commits || !!saved?.commits;
  const edits = !!entry.edits || !!saved?.edits;
  const merged = {
    productId: entry.productId,
    ...(commits ? { commits } : {}),
    ...(edits ? { edits } : {}),
    files: [...new Set([...(saved?.files ?? []), ...(entry.files ?? [])])].slice(0, 20),
  };
  run.restored = {
    at: run.restored?.at ?? Date.now(),
    products: [...(run.restored?.products ?? []).filter((other) => other.productId !== entry.productId), merged],
  };
  const step = openStep(task);
  if (step?.kind === "agent" && step.proofRun) step.proofRun = structuredClone(run);
}

/** One plain line for the delivery check: what Petrina's own run of the checks found. */
export function checksLine(task: Task): string | undefined {
  const runs = task.checks?.results;
  if (!runs?.length) return undefined;
  const failed = runs.filter((run) => !run.ok && !run.interruption && !run.interrupted);
  if (runs.some((run) => run.interruption || run.interrupted)) {
    const interruptedNames = runs.filter((run) => run.interruption || run.interrupted).map((run) => run.name).join(", ");
    const failedPrefix = failed.length ? `${failed.length} failed (${failed.map((run) => run.name).join(", ")}); ` : "";
    return `Automated checks: ${failedPrefix}interrupted — verification incomplete (${interruptedNames}). Original reported results retained.`;
  }
  return failed.length
    ? `Automated checks: ${failed.length} of ${runs.length} failed (${failed.map((run) => run.name).join(", ")}).`
    : `Automated checks: all ${runs.length} passed (${runs.map((run) => run.name).join(", ")}).`;
}

/** What the delivery check says beside the work: its risk, what Petrina's own run of the checks found, and any required acceptance gap. */
export function deliveryLines(task: Task, acceptance: string): string | undefined {
  const lines = [
    task.risk ? `${RISK_WORD[task.risk.level]} risk: ${task.risk.why}` : "",
    checksLine(task) ?? "",
    acceptance,
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

export class Aborted extends Error {}
/** No input was admitted: return to the driver to prepare the newly required source. */
export class SourceRefreshRequired extends Error {}
export class MaintenanceProfileProblem extends Error {}
/** The agent asked for the screen and may not have it yet: its task waits without a slot, keeping its conversation. */
export class ScreenWait extends Error {}

/** Stop waiting promptly, and remove the abort listener on either outcome. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Aborted());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** A step's tool is not installed, not logged in, or would not start: the coordinator gets its fix and a Retry. */
export class ToolProblem extends Error {
  constructor(
    readonly toolId: CheckId,
    readonly status: CheckStatus | "wont-start",
    detail?: string,
  ) {
    super(detail || `${CHECK_NAMES[toolId]} is not ready`);
  }
}

/** Not installed or not logged in: a tool Petrina does not start. */
export const notReady = (status: CheckStatus) => status === "not-installed" || status === "logged-out";

export interface EngineOptions {
  /** Private storage effects for a host or fixture; never loaded from product settings or saved state. */
  files?: FileOperations;
  /** Tests: scripted workflow sessions. Native ACP/process tests keep the real AgentRun. */
  startAgentSession?: StartAgentSession;
  /** Process-local installation/login observations; native probe contracts keep the real adapter. */
  toolProbe?: ToolProbe;
  /** Record every shared SQLite driver execution, without bindings or results, for local analysis. */
  debugSql?: boolean;
  /** The launcher opens scheduling only once the local connection is ready. */
  admissionsClosed?: boolean;
  /** Tests: run a fake agent instead of the tool's adapter. */
  agentCommand?: (profile: AgentProfile) => readonly string[] | undefined;
  /** Tests: refuse native agent fallback, including an undefined result from the fake-command callback. */
  requireAgentCommand?: boolean;
  /** Tests: whether eligible conversations get a browser. Real agents always do; fake agents only when this is true. */
  browser?: boolean;
  /** Tests: a fixture's own parent for temporary browser folders, instead of the standard one. Startup recovery uses it too. */
  browserTempRoot?: string;
  /** Native startup recovery; applications may supply an owned implementation of the same boundary. */
  browserRecovery?(registry: string, root?: string): Promise<void>;
  /** Tests: a fake GitHub instead of `gh`. */
  gh?: readonly string[];
  /** Process-local repository-scoped GitHub service; never read from settings or saved state. */
  github?: GitHubService;
  /** Tests: native account-reader commands by tool; null disables a reader. Fake agents disable defaults. */
  usageCommands?: Readonly<Record<string, readonly string[] | null>>;
  /** Tests: a folder standing in for every product's copy on GitHub. Never from settings or saved data. */
  remote?: string;
  remotes?: Readonly<Record<string, string>>;
  /** Tests: separate local remotes for fork working repositories. */
  sourceRemotes?: Record<string, string>;
  /** Tests: how long a tool gets to reopen a conversation. */
  reopenTimeoutMs?: number;
  /** Tests: how long a tool gets to start a fresh conversation. */
  startTimeoutMs?: number;
  /** Tests: native profile configuration discovery, without opening a real tool. */
  profileChoices?: (toolId: string, modelId?: string) => Promise<ProfileChoices>;
  /** Tests: the tool's own app that a take-over opens, instead of the one on PATH. */
  toolPath?: (toolId: Id) => string | undefined;
  /** Tests: the terminals on this machine. */
  terminals?: () => FoundTerminal[];
  /** How many tasks' check runs may overlap (default: one full check set at a time). */
  checkRuns?: number;
  /** Tests: how long one of a product's checks may run. */
  checkTimeoutMs?: number;
  /** Process-local command execution for check controller/workflow tests; native adapter contracts keep real spawns. */
  runCheckCommand?: CheckCommandExecutor;
  /** Tests: a controlled local container CLI and cleanup cadence. Never accepted from callers. */
  containerTool?: readonly string[];
  /** Process-local metadata observations; workload execution and cleanup remain native. */
  containerInspection?: ContainerInspection;
  /** Process-local service controls; local process ownership and workload execution remain native. */
  containerControl?: ContainerControl;
  /** Process-local saved-copy preparation; execution, evidence and cleanup keep their native owners. */
  validationSnapshots?: Pick<ValidationRunEffects, "snapshot">;
  extraCleanupEveryMs?: number;
  containerCommandTimeoutMs?: number;
  /** Tests: where programs are found, instead of the PATH. */
  which?: Which;
  /** Tests: how long one tool check may take. */
  toolCheckTimeoutMs?: number;
  /** Tests: a smaller retained workflow-event window, to exercise eviction. */
  eventRetention?: { events?: number; bytes?: number };
  /** Tests: where Apple's developer tools are, instead of asking xcode-select. */
  developerTools?: () => Promise<DeveloperToolsResult>;
  /** Tests: the home folder: where the clone finder looks, and what ~ means in a pasted path. */
  home?: string;
  /** Tests: a scripted folder picker instead of opening the operating system's GUI folder dialog. */
  pickFolder?: () => Promise<string | null>;
  /** Tests: how often the once-a-minute checks run (pull requests, removing working copies). */
  checkEveryMs?: number;
  /** Tests: polling cadence and deadline for required GitHub checks before direct branch or release delivery. */
  remoteCheckPollMs?: number;
  remoteCheckTimeoutMs?: number;
  /** Tests: how long "For an hour" lasts. */
  screenHourMs?: number;
  /** Tests: where failed checks' sleep evidence comes from, instead of this Mac's power log. */
  machineRecords?: MachineRecords;
  /** Tests: observe when the engine owns work, without starting the macOS sleep assertion. */
  awakeObserver?: (active: boolean) => void;
  /**
   * Tests: answer a follow-up identity check without starting an agent.
   * The prompt lists the reports and the open cards. Return "unavailable" when the check cannot run.
   */
  matchFollowUps?: (
    prompt: string,
  ) => Promise<{ groups: readonly { keys: readonly string[]; cardId?: string }[]; uncertain?: readonly string[] } | "unavailable">;
}
