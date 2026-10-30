import { join } from "node:path";
import { AgentRun, type RunCallbacks } from "@petrina/agent-runtime/acp-run";
import { claudeSandbox, type ClaudeSandbox } from "@petrina/agent-runtime/sandbox";
import { SandboxUnavailable } from "@petrina/agent-runtime/sandbox-failures";
import { ADAPTERS, agentCommandFor } from "@petrina/agent-runtime/tools";
import {
  addAsk,
  completeAll,
  pauseClock,
  plainTodo,
  resumeClock,
  retryingWords,
  type ActiveAgent,
  type AgentProfile,
  type CheckId,
  type Id,
  type InboxKind,
  type JourneyAgentInput,
  type Role,
} from "@petrina/core";
import {
  openParticipantSession,
  type AgentMessage,
  type AgentSession,
  type AgentSessionCallbacks,
  type AgentSessionOptions,
  type NativeRetryReport,
  type PermissionInfo,
  type RepositoryContext,
  type ToolActivityEvent,
} from "@petrina/orchestrator";
import { agentEnv } from "@petrina/platform/process-environment";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";
import * as git from "@petrina/repositories/git";
import { WaitClock } from "@petrina/storage/worklog";
import { opensBrowser } from "./browser-policy.js";
import { Aborted, notReady, ToolProblem, type Kernel } from "./kernel.js";
import { discardParticipant, ParticipantUnavailable } from "./participant-conversation.js";
import { MAX_DONE, type WhereYouWere } from "./prompts.js";
import { recordToolActivity } from "./record-tool-activity.js";
import type { ToolChecks } from "./tool-checks.js";
import type { TurnAgent } from "./tracking.js";

/** An input recorded while the opening text is being built; it joins the journey with its exact message reference. */
export type PendingInput = { stepId: Id; input: JourneyAgentInput };

export interface OpenAgentRunOptions {
  main: boolean;
  reviewKey?: string;
  reviewerKey?: string;
  sessionId?: string;
  reselect?: boolean;
  onStarting?: () => void;
}

/** A tool known to be missing or logged out is not started: the coordinator gets its fix instead. */
export function ensureToolReady(tools: ToolChecks, profile: AgentProfile): void {
  const known = tools.status(profile.toolId as CheckId);
  if (notReady(known)) throw new ToolProblem(profile.toolId as CheckId, known);
}

/** The profiles agents hear about (the planner picks from them): only those on tools the squad can use. */
export function usableTurnProfiles(k: Kernel): AgentProfile[] {
  const usable = k.usableTools() as Id[];
  return (k.s.profiles as AgentProfile[]).filter((entry) => !usable.length || usable.includes(entry.toolId));
}

/**
 * Opens an agent's conversation in its tool's own sandbox. Codex always runs in its own; Claude Code's is
 * asked for here, unless it could not start earlier in this run of Petrina. When Claude Code says it cannot
 * start, the same conversation opens again without it, and later agents skip it. `off` says why it is off.
 * Other tools keep their own session settings.
 */
async function inSandbox(
  k: Kernel,
  profile: AgentProfile,
  start: (sandbox?: ClaudeSandbox) => Promise<AgentSession>,
): Promise<{ run: AgentSession; off?: string }> {
  if (!ADAPTERS[profile.toolId]?.sandboxMeta) return { run: await start() };
  if (k.sandboxOff === undefined) {
    try {
      return { run: await start(claudeSandbox()) };
    } catch (error) {
      if (!(error instanceof SandboxUnavailable)) throw error;
      k.sandboxOff = error.reason;
    }
  }
  return { run: await start(), off: k.sandboxOff };
}

/**
 * Whether the agent is sandboxed, for the Session tab; without the sandbox, its session says so once, with the
 * reason. A conversation picked up again (after a restart, or for a fix round or an update) that already said it does not repeat it.
 */
export function resolveSandboxState(
  k: Kernel,
  scope: RepositoryContext,
  off: string | undefined,
  roleId: Id,
  profileId: Id,
  reopened = false,
): ActiveAgent["sandbox"] {
  const { task } = scope;
  const toolId = k.profile(profileId)?.toolId;
  const adapter = toolId ? ADAPTERS[toolId] : undefined;
  if (!adapter?.reportsSandbox) return undefined;
  if (off === undefined) return { on: true };
  const line = `Running without ${adapter.name}'s sandbox: ${off}`;
  const said =
    reopened
    && task.session.some(
      (entry) => entry.from === "system" && entry.text === line && entry.roleId === roleId && entry.profileId === profileId,
    );
  if (!said) k.say(scope, "system", line, roleId, profileId);
  return { on: false, reason: off };
}

/**
 * The agent's own tool says it is retrying the turn by itself, or (no report) that the retry is over. Petrina
 * only shows it: no prompt, no retry loop of its own and no capacity record. Only this agent's own run clears its status.
 */
function showRetrying(
  k: Kernel,
  scope: RepositoryContext,
  role: Role,
  profile: AgentProfile,
  report: NativeRetryReport | undefined,
  signal: AbortSignal,
  options: { main: boolean; reviewKey?: string },
): void {
  const current = k.task(scope.task.id);
  if (!current || (report && signal.aborted)) return;
  const tool =
    k.s.tools.find((entry) => entry.id === profile.toolId)?.name ?? ADAPTERS[profile.toolId]?.name ?? profile.toolId;
  const words = report ? retryingWords(tool, report.cause) : undefined;
  const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
  const starting = words !== undefined && (work ? work.retrying : current.retrying) === undefined;
  if (work) {
    if (work.retrying === words) return;
    if (words) work.retrying = words;
    else delete work.retrying;
    k.showReviewWork(current);
  } else if (options.main) {
    const before = current.retrying;
    if (before === words) return;
    if (words) {
      current.retrying = words;
      if (current.state === "running") current.statusLine = words;
    } else {
      delete current.retrying;
      // Useful work resumed, or the turn ended: drop the retry words. What comes next sets the line again.
      if (current.state === "running" && current.statusLine === before) current.statusLine = "Continuing work";
    }
  } else return;
  // One timeline line when a retry starts, not one per notice or change of cause.
  if (starting) k.log(scope, "warn", `${role.name}: ${words}`, role.id, profile.id);
  k.commit(scope);
}

export interface CoordinatorReplyRequest {
  scope: RepositoryContext;
  kind: InboxKind;
  title: string;
  blocking: boolean;
  extra: { body?: string; options?: string[]; detail?: string };
  signal: AbortSignal;
  status: string;
  by: { roleId: Id; profileId: Id };
  main: boolean;
  reviewKey?: string;
}

export async function waitForCoordinatorReply(k: Kernel, request: CoordinatorReplyRequest): Promise<string> {
  const { scope, kind, title, blocking, extra, signal, status, by, main, reviewKey } = request;
  if (signal.aborted) throw new Aborted();
  const { task, work: repository } = scope;
  const id = k.raise(scope, kind, title, blocking, { ...extra, ...(reviewKey ? { reviewKey } : {}) }, by);
  // It hangs under the step that asked, a reviewer's or a voter's among others included.
  if (kind === "question" || kind === "permission") addAsk(task, { id, kind, title, at: Date.now() });
  task.statusLine = status;
  const note = repository.conversation;
  // A parallel reviewer given the screen keeps that conversation on the task. Its question has to
  // survive a restart the same way the step's main agent does, or the next start resumes with no answer.
  const owns = Boolean(note && note.roleId === by.roleId && note.profileId === by.profileId);
  if (kind === "question" && note && (main || owns)) {
    note.asked = { itemId: id, question: title };
  }
  // Time spent waiting for the coordinator is not the agent's working time.
  if (main) k.pauseStep(task);
  const work = reviewKey ? task.hunt?.work?.[reviewKey] : undefined;
  if (work) {
    if (work.clock) work.clock = pauseClock(work.clock, Date.now());
    work.waiting = status;
    k.showReviewWork(task);
  }
  if (kind === "question" && note && (main || owns)) k.commitNow(scope);
  else k.commit(scope);
  try {
    return await k.waitForReply(id, signal);
  } finally {
    if (work && !signal.aborted) {
      const pending = k.s.inbox.find((item) => item.taskId === task.id && item.blocking && item.reviewKey === reviewKey);
      if (pending) {
        work.waiting = pending.kind === "permission" ? "Waiting for your permission" : "Waiting for your answer";
      } else {
        delete work.waiting;
        if (work.clock) work.clock = resumeClock(work.clock, Date.now());
      }
      k.showReviewWork(task);
      k.commitNow(scope);
    }
  }
}

export type WaitForCoordinatorFn = (request: CoordinatorReplyRequest) => Promise<string>;

/** The tool's own safety check flagged something: the coordinator decides. Petrina adds no rules of its own. */
async function askToolPermission(
  k: Kernel,
  waitFn: WaitForCoordinatorFn,
  scope: RepositoryContext,
  info: PermissionInfo,
  signal: AbortSignal,
  by: { roleId: Id; profileId: Id },
  waits: WaitClock,
  reviewKey?: string,
): Promise<"allow" | "deny"> {
  const { task } = scope;
  const taskId = task.id;
  if (k.task(taskId) !== task || signal.aborted) return "deny";
  const tool = ADAPTERS[k.profile(by.profileId)?.toolId ?? ""]?.name ?? "The agent's tool";
  const detail = info.command ?? (info.target ? info.target : info.paths.join("\n"));
  const main = !reviewKey && task.agent?.profileId === by.profileId && task.agent.roleId === by.roleId;
  // Waiting for the coordinator is not agent work: the wait is left out of the turn's working time.
  waits.start(taskId);
  try {
    const answer = await waitFn({
      scope,
      kind: "permission",
      title: info.title,
      blocking: true,
      extra: { body: `${tool}'s own safety check wants your OK before this.`, ...(detail ? { detail } : {}) },
      signal,
      status: "Waiting for your permission",
      by,
      main,
      reviewKey,
    });
    return answer === "allow" ? "allow" : "deny";
  } finally {
    waits.stop(taskId);
  }
}

export interface OpenTurnAgentRunRequest {
  k: Kernel;
  tools: ToolChecks;
  scope: RepositoryContext;
  role: Role;
  profile: AgentProfile;
  cwd: string;
  signal: AbortSignal;
  agent: TurnAgent;
  options: OpenAgentRunOptions;
  hooks: {
    onMessage: (message: AgentMessage) => void;
    markBriefed: (scope: RepositoryContext) => void;
    wait: WaitForCoordinatorFn;
  };
}

/** Shared startup, callbacks and reopen fallback for main turns and parallel members. */
export async function openTurnAgentRun(
  request: OpenTurnAgentRunRequest,
): Promise<{ run: AgentSession; off?: string; reopenFailure?: string }> {
  const { k, tools, scope, role, profile, cwd, signal, agent, options, hooks } = request;
  const { task } = scope;
  const roleId = role.id;
  const profileId = profile.id;
  const callbacks: AgentSessionCallbacks = {
    onMessage: hooks.onMessage,
    onActivity: () => {},
    onToolActivity: (event: ToolActivityEvent) => {
      const current = k.task(task.id);
      if (!current || (signal.aborted && event.turnEndedAt === undefined)) return;
      if (options.main && event.invocation) hooks.markBriefed(scope);
      const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
      const summary = recordToolActivity(
        current,
        agent.journeyId,
        { seat: options.reviewKey ?? agent.agentSeat ?? roleId, roleId, profileId, productId: scope.work.productId },
        event,
      );
      if (!summary) return;
      const line = summary.runningTool?.description ?? "Continuing work";
      const active = current.state === "running" || current.state === "needs-you";
      if (work && active) {
        work.toolActivity = summary;
        work.activity = line;
        k.showReviewWork(current);
      } else if (options.main && active) {
        current.toolActivity = summary;
        // While the tool retries by itself, an update to an earlier call does not replace that status.
        if (current.state === "running" && !current.retrying) current.statusLine = line;
      }
      if (event.invocation) {
        const invocation = event.invocation;
        const existing = current.session.find((entry) => entry.toolInvocationId === invocation.id);
        if (existing) existing.text = invocation.description;
        else if (event.isNew) {
          k.participantSay(scope, "activity", invocation.description, roleId, profileId, options.reviewerKey, invocation.id);
        }
      }
      k.commit(scope);
    },
    onPlanStep: (line: string) => {
      const current = k.task(task.id);
      const text = plainTodo(line);
      if (!current || !text || signal.aborted) return;
      if (options.main) hooks.markBriefed(scope);
      if (current.state !== "running" && current.state !== "needs-you") return;
      const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
      if (!options.main && !work) return;
      if (work) {
        if (work.todo === text) return;
        work.todo = text;
        k.showReviewWork(current);
      } else {
        if (current.todo === text) return;
        current.todo = text;
      }
      if (!options.main || current.timeline.at(-1)?.text !== text) k.log(scope, "status", text, roleId, profileId);
      k.noteTodo(scope);
    },
    onRetrying: (report?: NativeRetryReport) => showRetrying(k, scope, role, profile, report, signal, options),
    onPermission: (info: PermissionInfo) =>
      askToolPermission(k, hooks.wait, scope, info, signal, { roleId, profileId }, agent.waits, options.reviewKey),
    onCleanupIncomplete: () => {
      if (k.task(task.id)) k.log(scope, "warn", CLEANUP_INCOMPLETE);
    },
  };
  // New, reopened and replacement conversations share the engine's browser folders and recovery.
  const browser = opensBrowser(role, k.options);
  const browserTempRoot = k.options.browserTempRoot;
  const start = async (sessionId?: string): Promise<{ run: AgentSession; off?: string }> => {
    await k.agentCleanup.wait(task.id, cwd);
    if (signal.aborted) throw new Aborted();
    const launchFor = () => {
      const cleanup = k.agentCleanup.opening(task.id, cwd);
      const onCleanupIncomplete = () => {
        cleanup.onCleanupIncomplete();
        callbacks.onCleanupIncomplete?.();
      };
      const nativeCallbacks: RunCallbacks = {
        ...callbacks,
        onCleanupIncomplete,
        onLog: (text) => void k.agentLog(task.id, text),
        onUsage: (info) => k.recordUsage(info),
        onAccountUsage: (reports) => k.recordAccountUsage(profile.toolId, reports),
      };
      const sessionCallbacks: AgentSessionCallbacks = { ...callbacks, onCleanupIncomplete };
      Object.defineProperties(sessionCallbacks, {
        onLog: { value: nativeCallbacks.onLog },
        onUsage: { value: nativeCallbacks.onUsage },
        onAccountUsage: { value: nativeCallbacks.onAccountUsage },
      });
      const launch: AgentSessionOptions = {
        profile,
        cwd,
        browser,
        signal,
        ...(sessionId
          ? {
              reopen: sessionId,
              ...(k.options.reopenTimeoutMs ? { reopenTimeoutMs: k.options.reopenTimeoutMs } : {}),
            }
          : {}),
        ...(k.options.startTimeoutMs ? { startTimeoutMs: k.options.startTimeoutMs } : {}),
        onGone: cleanup.onGone,
        callbacks: sessionCallbacks,
      };
      return { launch, cleanup, nativeCallbacks };
    };
    try {
      if (k.options.startAgentSession) {
        const { launch, cleanup } = launchFor();
        const run = await k.options.startAgentSession(launch, role);
        cleanup.attach(run);
        return { run };
      }
      return await inSandbox(k, profile, async (sandbox) => {
        // Sandbox refusal can retry this callback without returning through start().
        // Every actual launch must wait for the previous owner's cleanup.
        await k.agentCleanup.wait(task.id, cwd);
        if (signal.aborted) throw new Aborted();
        const { launch, cleanup, nativeCallbacks } = launchFor();
        // Resolve native launch details for each process, including a fallback or sandbox retry.
        const command = agentCommandFor(k.options, profile);
        const run = await AgentRun.start({
          ...launch,
          ...(command ? { command } : {}),
          env: agentEnv(process.env),
          ...(sandbox ? { sandbox } : {}),
          browserRoot: join(k.dataDir, "browser-temp"),
          ...(browserTempRoot ? { browserTempRoot } : {}),
          callbacks: nativeCallbacks,
        });
        cleanup.attach(run);
        return run;
      });
    } catch (error) {
      // A working-copy cleanup failure is not a new login/startup problem. Do not
      // probe or replace that provider while the earlier native owner is uncertain.
      try {
        await k.agentCleanup.wait(task.id, cwd);
      } catch (cleanup) {
        if (Object.is(error, cleanup)) throw error;
        throw new AggregateError([error, cleanup], "The agent could not open and its cleanup was not confirmed");
      }
      if (sessionId !== undefined || signal.aborted || error instanceof SandboxUnavailable) throw error;
      throw await tools.problem(profile.toolId, error);
    }
  };
  return openParticipantSession(options, {
    start,
    stop: (run) => k.stopAgent(task.id, run),
    announce: () => options.onStarting?.(),
    aborted: () => signal.aborted,
    unavailable: (reason) => new ParticipantUnavailable(reason),
  });
}

export function discardUnavailableTurnParticipant(
  k: Kernel,
  scope: RepositoryContext,
  roleId: Id,
  error: unknown,
  reviewerKey?: string,
): boolean {
  if (!(error instanceof ParticipantUnavailable)) return false;
  return discardParticipant(scope, k.role(roleId, scope.task)!, error.message, reviewerKey, (text) => {
    k.log(scope, "status", text, roleId);
    k.commitNow(scope);
  });
}

/** Where an agent was in its step: the stage, its role, and its last activity and plan steps since the step started. */
export function buildWhereYouWere(scope: RepositoryContext, role: Role, since: number): WhereYouWere {
  const { task } = scope;
  const stage = task.stageIndex < 0 ? undefined : task.plan?.stages[task.stageIndex];
  const stageTitle =
    task.stageIndex < 0
      ? "Planning"
      : !stage
        ? "this step"
        : stage.kind === "converge" || stage.kind === "review-chain"
          ? `${stage.title}, round ${task.rounds[stage.id] ?? 1}`
          : task.fixing
            ? `${stage.title}, fixing review findings`
            : stage.title;
  const done = [
    ...task.session.filter((line) => line.from === "activity" && line.roleId === role.id && line.at >= since),
    ...task.timeline.filter((entry) => entry.tone === "status" && entry.roleId === role.id && entry.at >= since),
  ]
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.text)
    .filter((text, index, all) => text !== all[index - 1]);
  return { stage: stageTitle, role: role.name, done: done.slice(-MAX_DONE) };
}

/** Restore protected companion repositories and read-only primary working copies after an attempt stops. */
export async function restoreProtectedCopies(
  k: Kernel,
  scope: RepositoryContext,
  role: Role,
  worktree: string,
  headBefore: string | undefined,
  protectedCopies: readonly { productId: Id; path: string; sha: string }[],
): Promise<void> {
  const { task, work: repository } = scope;
  await completeAll([
    ...protectedCopies.map(async (copy) => {
      const state = await git.worktreeStatus(copy.path);
      const commits = state.head !== copy.sha;
      await k.noteRestoredAcceptance(scope, role, copy.productId, copy.path, copy.sha, {
        commits,
        edits: state.trackedChanged,
      });
      if (commits) await git.resetTo(copy.path, copy.sha);
      if (!state.clean) await git.discardChanges(copy.path);
      const why = role.canEdit
        ? `which may change only ${k.productLabel(repository.productId)} in this step`
        : "which is read-only";
      if (commits) k.log(scope, "warn", `Undid commits in ${k.productLabel(copy.productId)} from ${role.name}, ${why}`);
      if (state.trackedChanged) {
        k.log(scope, "warn", `Undid changes in ${k.productLabel(copy.productId)} from ${role.name}, ${why}`);
      }
    }),
    // A read-only role leaves its primary copy as found, including commits and tracked changes.
    ...(!role.canEdit && headBefore
      ? [
          (async () => {
            const state = await git.worktreeStatus(worktree);
            if (task.maintenance?.role.id === role.id && (state.head !== headBefore || !state.clean)) {
              task.maintenance.readOnlyWrites = true;
            }
            await k.noteRestoredAcceptance(scope, role, repository.productId, worktree, headBefore, {
              commits: state.head !== headBefore,
              edits: state.trackedChanged,
            });
            if (state.head !== headBefore) {
              await git.resetTo(worktree, headBefore);
              k.log(scope, "warn", `Undid commits from ${role.name}, which is read-only`);
            }
            if (!state.clean) {
              await git.discardChanges(worktree);
              k.log(scope, "warn", `Undid changes from ${role.name}, which is read-only`);
            }
          })(),
        ]
      : []),
  ]);
}
