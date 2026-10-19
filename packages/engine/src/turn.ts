import { repositoryView, type RepositoryContext } from "./repository-context.js";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Sources } from "./sources.js";
// One agent working one step: opening or reopening its conversation, its instructions, the turns until
// it hands back a valid result, and what it asks the coordinator on the way.

import { addAsk, beginAgentStep, endAgentStep, JOURNEY_WORDS as W, limitOf, openStep, SCREEN_WORDS, screenReason, slotWait, stepMayChange, type ActiveAgent, type AgentProfile, type Id, type InboxKind, type Pool, type Product, type Role, type StepNote, type TurnReason, type CheckId, pauseClock, plainTodo, resumeClock, startClock } from "@petrina/core";
import type { z } from "zod";
import { AgentRun, ReopenFailed, type PermissionInfo } from "./acp-run.js";
import * as git from "./git.js";
import { agentEnv } from "./env.js";
import { claudeSandbox, SandboxUnavailable, type ClaudeSandbox } from "./sandbox.js";
import { browserPrompt, buildPrompt, continuePrompt, EARLIER_ATTEMPT, OWN_COPY, ownCopy, formatHandBack, formatReviewTakeOver, formatStepNotes, formatTakeOver, formatWhereYouWere, HANDED_BACK, handBackPrompt, lastWords, MAX_DONE, parseResult, proseOf, pullRequestBackground, repairPrompt, restartPrompt, TOOK_OVER, WHERE_YOU_WERE, type WhereYouWere, mayAskScreen, screenPrompt, WHERE_YOU_WERE_SCREEN } from "./prompts.js";
import { UsageLimited, WaitingForUsage } from "./usage.js";
import type { AgentMessage } from "./agent-messages.js";
import { ADAPTERS } from "./tools.js";
import { CLEANUP_INCOMPLETE } from "./process-tree.js";
import { Kernel, Aborted, ScreenWait, notReady, stepKey, ToolProblem } from "./kernel.js";
import type { TurnAgent } from "./tracking.js";
import { WaitClock } from "./worklog.js";
import { isAuthRequired } from "./setup.js";
import type { ToolChecks } from "./tool-checks.js";
import type { Section } from "./context.js";
import { takeMessages } from "./messages.js";
import { preserveCaptures } from "./captures.js";
import { builderContext } from "./builder-context.js";

/** Turns a valid but incomplete result into what the agent is asked to repair, or undefined when it is complete. */
type Check<T> = (value: T) => string | undefined | Promise<string | undefined>;
type Given = () => Section[] | Promise<Section[]>;
type ResumeConversation = { sessionId: string; toolId: Id; model: string; context?: import("@petrina/core").BuilderContext; knownSections?: readonly string[] };
type ConversationOptions = {
  resume?: ResumeConversation | ((profile: AgentProfile, role: Role) => ResumeConversation | undefined | Promise<ResumeConversation | undefined>);
  reviewContext?: boolean;
  started?: () => void;
  completed?: (note: import("@petrina/core").ConversationNote, profile: AgentProfile, role: Role) => void;
};

/** `used` hears which profile worked each attempt: a stand-in when the planned one was out of usage. */
interface TurnOptions<T> extends ConversationOptions {
  status?: string;
  check?: Check<T>;
  copy?: string;
  /** Design participants use the same complete context packets as Builders, reducing unchanged background on return. */
  designContext?: boolean;
  used?: (profileId: Id) => void;
  reviewerKey?: string;
  /** Parallel review work whose summary and clock this conversation is continuing. */
  reviewKey?: string;
  /** The individual member whose saved screen conversation is being resumed. */
  member?: string;
  /** A parallel member replaces only its own reserved seat when it continues. */
  room?: (toolId: Id) => boolean;
}

/** What an agent that may not ask for the screen hears when it asks anyway: it never pauses its step or its group. */
const NO_SCREEN_HERE = "you cannot ask for the screen in this step. Finish without it, and list any check that needs the screen in your result";

export class Turns {
  readonly repositoryCopies = new Map<string, Readonly<Record<string, string>>>();
  constructor(
    private readonly k: Kernel,
    private readonly tools: ToolChecks,
    private readonly sources: Sources,
  ) {}

  /**
   * Processes stopped because a parallel member yielded the screen. The seat is free at once; copy
   * cleanup still waits until these finishes so a dying process is not left in the working copy.
   */
  private readonly yieldedStops: Promise<boolean>[] = [];

  /** Wait for screen yields that released their seat before their process had exited. */
  releasedStops(): Promise<void> {
    const pending = this.yieldedStops.splice(0);
    return Promise.allSettled(pending).then(() => undefined);
  }

  /**
   * One agent, one stage: run turns until it hands back a valid result. `status` names what it starts
   * on before its first activity; `check` turns a valid but incomplete result into a repair.
   * `given` builds the opening instructions' sections, only when a fresh conversation gets them.
   * After a restart, the step's agent picks up its own conversation when the tool can reopen it.
   * `resume` names an earlier step's conversation to go back to (same tool and model): the agent keeps what
   * it knew there, compactions and all, and hears only its job now. When it cannot reopen, a fresh one starts.
   * The profile is the planned one: while its tool or model is out of usage another works the step (see
   * `Kernel.choose`). An agent that runs out in the middle hands over to that stand-in in a fresh conversation,
   * told what the first one did and said; with no stand-in the task waits, and the first agent's conversation
   * is reopened when a limit ends.
   */
  async turn<T>(scope: RepositoryContext, roleId: Id, plannedId: Id, given: Given, schema: z.ZodType<T>, signal: AbortSignal, options: TurnOptions<T> = {}): Promise<T> {
    const { task, work: repository } = scope;
    if (!this.k.role(roleId) || !this.k.profile(plannedId) || (this.k.role(roleId)?.result !== "plan" && !this.k.productOf(scope))) throw new Error(`Unknown role or product: ${roleId} on ${plannedId}`);
    let stopped: { profileId: Id; error: UsageLimited } | undefined;
    for (;;) {
      if (this.k.admissionsClosed) throw new WaitingForUsage("Waiting for the pool to resume");
      // A screen request keeps the profile whose conversation asked, even if its planned tool is free again.
      const wanted = task.screen?.roleId === roleId ? task.screen.profileId : plannedId;
      const room = options.room ?? ((toolId: Id) => !slotWait(this.k.activeState(), { taskId: task.id, toolId }));
      const choice = this.k.choose(wanted, scope, roleId, room, options.reviewerKey)!;
      if (choice.kind === "none") {
        // Stopped by a limit and waiting for the reset: the step's next attempt is a retry.
        if (stopped) this.k.tracking.owesRetry(scope, roleId, plannedId);
        this.k.waitForUsage(task, choice.waiting);
        throw new WaitingForUsage(choice.waiting);
      }
      const { profile } = choice;
      // The tool said it was out while running something it should not have limited: the step cannot go on.
      if (stopped?.profileId === profile.id) throw stopped.error;
      // Every actual tool qualifies, including an internal errand before a reviewer, and a handoff
      // to another model on the same tool. The task's old seat is the one being replaced.
      const wait = options.room
        ? room(profile.toolId) ? undefined : `Waiting for a free ${this.k.s.tools.find((tool) => tool.id === profile.toolId)?.name ?? profile.toolId} slot`
        : slotWait(this.k.activeState(), { taskId: task.id, toolId: profile.toolId });
      if (wait) {
        if (stopped) this.k.tracking.owesRetry(scope, roleId, plannedId);
        this.k.waitForUsage(task, wait);
        throw new WaitingForUsage(wait);
      }
      this.k.tracking.attempt(scope, roleId, plannedId, profile, stopped !== undefined);
      options.used?.(profile.id);
      // Said where the coordinator will see it: a security review that could not stay off the builder's tool.
      const builder = this.k.profile(task.plan?.stages.find((stage) => stage.roleId === "builder")?.profileIds[0] ?? "");
      const builderTool = repository.builderSession?.toolId ?? builder?.toolId;
      if (roleId === "security-reviewer" && builderTool === profile.toolId && !task.timeline.some((entry) => entry.text.startsWith("Security review on the builder's tool"))) {
        this.k.log(scope, "warn", `Security review on the builder's tool (${this.k.named(profile.id)}): no other tool is available for this review`);
      }
      try {
        return await this.attempt(scope, roleId, plannedId, profile, given, schema, signal, options);
      } catch (error) {
        if (!(error instanceof UsageLimited) || signal.aborted) throw error;
        this.keepWords(scope, roleId, profile.id, error);
        this.k.recordLimit(task, roleId, profile.id, error);
        if (task.screen?.granted && task.screen.profileId === profile.id) {
          this.k.tracking.owesRetry(scope, roleId, plannedId);
          this.k.waitForScreen(task);
          throw new ScreenWait();
        }
        stopped = { profileId: profile.id, error };
      }
    }
  }

  /** What an agent had said when it ran out of usage joins the session, so the one taking over can be told. */
  private keepWords(scope: RepositoryContext, roleId: Id, profileId: Id, error: UsageLimited): void {

    if (error.streamed) return;
    const prose = error.said ? proseOf(error.said) : undefined;
    if (prose) this.k.say(scope, "agent", prose.length > 2400 ? `${prose.slice(0, 2400)}…` : prose, roleId, profileId);
  }

  /** One saved bubble per public message, including parallel agents; token chunks update that bubble. */
  private messageStream(scope: RepositoryContext, roleId: Id, profileId: Id, signal: AbortSignal, main = false): (message: AgentMessage) => void {
    const { task } = scope;
    let last: { key: number; line: Id } | undefined;
    return (message) => {
      if (this.k.task(task.id) !== task || this.k.stopped || signal.aborted) return;
      if (main) this.briefed(scope);
      const saved = last;
      const line = saved?.key === message.id ? task.session.find((entry) => entry.id === saved.line) : undefined;
      if (line) {
        if (line.text === message.text) return;
        line.text = message.text;
      } else {
        this.k.say(scope, "agent", message.text, roleId, profileId);
        last = { key: message.id, line: task.session.at(-1)!.id };
      }
      this.k.commit();
    };
  }

  /** An agent's last messages in a step, most recent first, as many as fit. */
  private lastWords(scope: RepositoryContext, roleId: Id, profileId: Id, since: number): string {
    const { task } = scope;
    return lastWords(
      task.session
        .filter((line) => line.from === "agent" && line.roleId === roleId && line.profileId === profileId && line.at >= since)
        .map((line) => line.text)
        .reverse(),
    );
  }

  /** Save the role-specific context at the moment it is handed to an agent, not reconstructed later. */
  private recordJourneyInput(scope: RepositoryContext, roleId: Id, profileId: Id, sections: readonly Section[], mode: "fresh" | "continued"): void {
    const { task } = scope;
    const step = openStep(task);
    if (step?.kind !== "agent") return;
    const input = {
      roleId,
      profileId,
      taskTitle: task.title,
      // Fresh prompts include the task request for every role. Continued prompts
      // receive only their updated sections in the existing conversation.
      ...(mode === "fresh" ? { taskDescription: task.description } : {}),
      ...(task.plan?.stages[task.stageIndex]?.title ? { stageTitle: task.plan.stages[task.stageIndex]!.title } : {}),
      sections: sections.map(({ title, body }) => ({ title, body })),
      mode,
    } as const;
    step.agentInputs = [...(step.agentInputs ?? []).filter((entry) => entry.roleId !== roleId || entry.profileId !== profileId), input];
    this.k.commitNow();
  }

  /** One attempt at the step by one agent on one profile. */
  private async attempt<T>(scope: RepositoryContext, roleId: Id, plannedId: Id, profile: AgentProfile, given: Given, schema: z.ZodType<T>, signal: AbortSignal, options: TurnOptions<T>): Promise<T> {
    const { task, work: repository } = scope;
    let role = this.k.role(roleId);
    const product = this.k.repositoryOf(scope) ?? (role?.result === "plan" ? { id: "", name: "To be chosen", repo: "", tone: "blue" as const } : undefined);
    if (!role || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profile.id}`);
    const profileId = profile.id;
    const workingCopy = repository.worktree ?? join(this.k.dataDir, "planning", task.id);
    if (!repository.worktree) mkdirSync(workingCopy, { recursive: true });
    const taskId = task.id;
    const worktree = options.copy ?? workingCopy;
    const protectedCopies = task.repositories && !options.copy ? await Promise.all(task.repositories.filter((work) => work.worktree && work.productId !== repository.productId).map(async (work) => ({ path: work.worktree!, sha: await git.head(work.worktree!) }))) : [];
    // Paused, cancelled or stopped while getting here: no agent starts, and the task stays as the coordinator left it.
    if (signal.aborted) throw new Aborted();
    this.mustBeReady(profile);
    if (role.result !== "plan") await this.sources.refresh(scope);

    // A conversation noted before a restart: the same step and role carry on from where it was. Only the
    // same tool and model reopen it, and never the Release Manager: interrupted shipping is checked first.
    const step = stepKey(task);
    const model = profile.modelId ?? profile.model;
    const saved = repository.conversation;
    const same = saved && saved.step === step && saved.roleId === roleId ? saved : undefined;
    role = structuredClone(same?.role ?? role);
    // The final acceptance pass runs after review, although it reuses the tester's earlier plan position.
    const access = same?.access ?? (task.retest ? { canEdit: false, afterReview: role.canEdit } : stepMayChange(role, task.plan?.stages ?? [], task.stageIndex));
    role.canEdit = access.canEdit;
    if (access.afterReview && !same) this.k.log(scope, "warn", `${role.name} works read-only on this task: its step comes after the final review`, roleId, profileId);
    // A conversation that never showed it got its instructions (Petrina stopped in between) starts again instead.
    const reopen = same && same.briefed && roleId !== "release-manager" && same.toolId === profile.toolId && same.model === model && (role.result !== "build" || !same.plannedProfileId || same.plannedProfileId === plannedId) ? same : undefined;
    let again = saved && !reopen ? (same ? (same.briefed || roleId === "release-manager" ? "it now runs on a different tool or model" : "it had not received its instructions yet") : "the saved conversation was for another step") : undefined;
    // Back to an earlier step's conversation, unless this step already has one of its own.
    const offered = typeof options.resume === "function" ? await options.resume(profile, role) : options.resume;
    const back = !saved && offered?.toolId === profile.toolId && offered.model === model ? offered : undefined;
    if (!saved && offered && !back) this.k.log(scope, "status", "Started a fresh conversation: the tool or model changed", roleId, profileId);
    const startedAt = same?.startedAt ?? Date.now();
    // Handed back by the coordinator: the note of what changed, until the agent hears it.
    const handback = same?.handback;
    // An agent that ran out of usage in this step is who this one takes over from.
    const before = same && !reopen && !back ? this.k.profile(same.profileId) : undefined;
    const previousLimit = before ? limitOf(this.k.activeState().pool as Pool, before, Date.now()) : undefined;
    const tookOver = previousLimit ? before : undefined;
    const refusal = previousLimit?.retry ? previousLimit.reason : undefined;
    // The agent has the screen for this step. Coming back from waiting for it, it has not heard yet that it may use it.
    const screen = task.screen?.granted && task.screen.roleId === roleId && task.screen.profileId === profileId && (!options.member || task.screen.member === options.member) ? task.screen : undefined;
    const forScreen = screen && !screen.heard ? screen : undefined;
    // Only the agent that has the screen is told it may use it.
    const screenWords = screen ? { reason: screen.reason } : mayAskScreen(role) ? ("ask" as const) : undefined;
    if (!task.holdsSlot || this.k.profile(task.agent?.profileId ?? "")?.toolId !== profile.toolId) {
      const waiting = this.k.admissionsClosed ? (this.k.draining ? this.k.drainLine : "Waiting for the pool to resume") : slotWait(this.k.activeState(), { taskId, toolId: profile.toolId });
      if (waiting) {
        this.k.pendingAgentAdmissions.set(taskId, { step, roleId, profileId });
        throw new WaitingForUsage(waiting);
      }
    }
    this.k.pendingAgentAdmissions.delete(taskId);
    repository.stepAttempts = (repository.stepAttempts ?? 0) + 1;
    // A step that starts fresh (a new step, after a pause, Try again) drops the old to-do item and starts its clock again.
    // After a restart, or with a stand-in taking over, both stay: the to-do item shows until the agent names its own.
    if (!same) delete task.todo;
    const reviewWork = options.reviewKey ? task.hunt?.work?.[options.reviewKey] : undefined;
    if (reviewWork) {
      reviewWork.attempts = (reviewWork.attempts ?? 0) + 1;
      reviewWork.clock = reviewWork.clock ? resumeClock(reviewWork.clock, Date.now()) : startClock(repositoryView(scope), roleId, Date.now());
      delete reviewWork.waiting;
      task.stepClock = reviewWork.clock;
    } else task.stepClock = same && task.stepClock ? resumeClock(task.stepClock, Date.now()) : startClock(repositoryView(scope), roleId, Date.now());

    task.agent = { roleId, profileId, since: Date.now(), step: 0, ...(options.reviewKey ? { reviewKey: options.reviewKey } : {}) };
    task.state = this.k.s.inbox.some((item) => item.taskId === taskId && item.blocking) ? "needs-you" : "running";
    task.holdsSlot = true;
    task.column = this.k.columnFor(task);
    // A stand-in is a new box, so the first agent's tool, time and lines stay with its own work.
    const previous = openStep(task);
    if (previous?.kind === "agent" && previous.roleId === roleId && !previous.team && previous.profileId !== profileId) {
      endAgentStep(task, { outcome: W.handedOn, reason: W.agentChanged, tone: "back" }, Date.now());
    }
    // Its box on the journey: picking up after a restart, a pause or a hand back continues the same one.
    const stage = task.plan?.stages[task.stageIndex];
    const journeyRole = options.copy && stage?.kind === "review-chain" && !repository.portReview && stage.roleIds?.includes(roleId) ? stage.roleId : roleId;
    const team = previous?.kind === "agent" && previous.roleId === journeyRole ? previous.team ?? (previous.profileId ? [previous.profileId] : []) : [];
    beginAgentStep(task, journeyRole, profileId, Date.now(), options.copy ? [...new Set([...team, profileId])] : undefined, repository);
    if (saved) {
      task.statusLine = options.status ?? `${role.name} is getting back to work`;
    } else {
      task.statusLine = options.status ?? `${role.name} is starting`;
      this.k.say(scope, "system", `${role.name} joined · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(scope, "milestone", `${role.name} started`, roleId, profileId);
    }
    if (same) { same.role = role; same.access = access; }
    this.k.commitNow();

    const live = () => this.k.task(taskId);
    const env = this.envFor();
    // How its turns are written down in the work log, with its own waits for the coordinator left out of its time.
    const agent: TurnAgent = { roleId, profile, waits: new WaitClock() };
    // The working copy as the step first found it: what the summary compares with, and what a read-only role leaves.
    const head = same?.head ?? (worktree ? await git.head(worktree).catch(() => undefined) : undefined);
    // Tests: the command is asked for every agent process, so a test can tell a reopen attempt from the fresh start after it.
    const start = (sessionId?: string, sandbox?: ClaudeSandbox, command = this.k.options.agentCommand?.(profile)): Promise<AgentRun> =>
      AgentRun.start({
        profile,
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
        ...(sandbox ? { sandbox } : {}),
        cwd: worktree,
        browserRoot: join(this.k.dataDir, "browser-temp"),
        signal,
        ...(sessionId ? { reopen: sessionId, ...(this.k.options.reopenTimeoutMs ? { reopenTimeoutMs: this.k.options.reopenTimeoutMs } : {}) } : {}),
        ...(this.k.options.startTimeoutMs ? { startTimeoutMs: this.k.options.startTimeoutMs } : {}),
        callbacks: {
          onMessage: this.messageStream(scope, roleId, profileId, signal, true),
          onActivity: (line) => {
            const current = live();
            if (current) this.briefed(scope);
            if (!current || current.state !== "running") return;
            if (reviewWork) {
              reviewWork.activity = line;
              this.k.showReviewWork(current);
            } else current.statusLine = line;
            this.k.say(scope, "activity", line, roleId, profileId);
            this.k.commit();
          },
          // The to-do item is kept apart from the status line: tool activity never overwrites it, nor it the activity.
          onPlanStep: (line) => {
            const current = live();
            const text = plainTodo(line);
            if (!current || !text) return;
            this.briefed(scope);
            if (current.state !== "running" && current.state !== "needs-you") return;
            if (reviewWork) {
              if (reviewWork.todo === text) return;
              reviewWork.todo = text;
              this.k.showReviewWork(current);
            } else {
              if (current.todo === text) return;
              current.todo = text;
            }
            if (current.timeline.at(-1)?.text !== text) this.k.log(scope, "status", text, roleId, profileId);
            this.k.noteTodo();
          },
          onPermission: (info) => this.permission(scope, info, signal, { roleId, profileId }, agent.waits, options.reviewKey),
          onLog: (text) => void this.k.agentLog(taskId, text),
          onCleanupIncomplete: () => { const current = live(); if (current) this.k.log(scope, "warn", CLEANUP_INCOMPLETE); },
          onUsage: (info) => this.k.recordUsage(info),
        },
      }).catch(async (error: unknown) => {
        // A fresh conversation that does not open is the tool's problem: name it, with its fix.
        // Claude Code refusing its sandbox is not that: the caller opens the same conversation again without it.
        if (sessionId !== undefined || signal.aborted || error instanceof SandboxUnavailable) throw error;
        throw await this.tools.problem(profile.toolId, error);
      });
    let opened: { run: AgentRun; off?: string } | undefined;
    let notBack: string | undefined;
    if (reopen ?? back) {
      try {
        opened = await this.inSandbox(profile, (sandbox) => start((reopen ?? back)!.sessionId, sandbox));
      } catch (error) {
        if (signal.aborted || !(error instanceof ReopenFailed)) throw error;
        if (reopen) again = error.message;
        else notBack = error.message;
      }
    }
    opened ??= await this.inSandbox(profile, (sandbox) => start(undefined, sandbox));
    const { run } = opened;
    options.started?.();
    this.k.runs.set(taskId, run);
    this.k.syncIdleSleep();
    this.k.readUsage(profile.toolId);
    const picked = run.reopened !== undefined;
    const sandbox = this.sandboxState(scope, opened.off, roleId, profileId, picked);
    if (task.agent) task.agent.sandbox = sandbox;
    // Handing the same conversation back continues its work. A fresh conversation or a Petrina
    // restart is still another attempt, so neither can enter the timing history.
    if (picked && handback && same?.handbackBoot === this.k.boot && repository.stepAttempts > 1) repository.stepAttempts -= 1;
    const wentBack = picked && !reopen && back !== undefined;
    const where = saved ? this.whereYouWere(scope, role, startedAt) : undefined;
    if (wentBack) {
      this.k.say(scope, "system", `${role.name} went back to its own conversation from the last step · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(scope, "status", "Went back to its own conversation from the last step", roleId, profileId);
    } else if (back) {
      this.k.log(scope, "status", `Could not go back to its own conversation (${notBack ?? "the tool did not reopen it"}), so it started a fresh one with what it reported`, roleId, profileId);
    }
    if (wentBack) {
      // Said above.
    } else if (picked && handback) {
      this.k.say(scope, "system", `${role.name} took the step back on the same conversation · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(scope, "milestone", "Took the step back on the same conversation", roleId, profileId);
    } else if (handback) {
      this.k.say(scope, "system", `${role.name} carried on in a fresh conversation, with your note, because the one you drove could not be reopened · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(scope, "milestone", `Carried on in a fresh conversation: ${again}`, roleId, profileId);
    } else if (picked) {
      this.k.say(scope, "system", `${role.name} picked up where it left off · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(scope, "milestone", forScreen ? SCREEN_WORDS.pickedUp : "Picked up where it left off", roleId, profileId);
    } else if (tookOver) {
      const words = `${role.name} on ${this.k.named(profileId)} took over from ${this.k.named(tookOver.id)}, which ${refusal ? `could not continue (${refusal})` : "ran out of usage"}`;
      this.k.say(scope, "system", words, roleId, profileId);
      this.k.log(scope, "milestone", words, roleId, profileId);
    } else if (saved) {
      this.k.say(scope, "system", `${role.name} started this step again · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(scope, "milestone", `Started this step again: ${again}`, roleId, profileId);
    }
    // On disk before the agent gets any work, so a restart from here on can reopen it. A fresh one replaces
    // the old note; a reopened one keeps the open question until the conversation hears the answer.
    const asked = picked ? reopen?.asked : undefined;
    if (roleId !== "release-manager") {
      repository.conversation = { ...(this.repositoryCopies.get(worktree) ? { repositoryCopies: this.repositoryCopies.get(worktree) } : {}), step, roleId, profileId, role, access, ...(role.result === "build" ? { plannedProfileId: plannedId } : {}), toolId: profile.toolId, model, sessionId: run.sessionId, ...(head ? { head } : {}), startedAt, ...(asked ? { asked } : {}), ...(picked ? { briefed: true } : {}), ...(picked && same?.context ? { context: same.context } : {}), ...(picked && handback ? { handback } : {}) };
      const pending = screen?.member && task.hunt?.screenTurns?.[screen.member];
      // Keep the latest reopened or replacement conversation when this member yields to a peer.
      if (pending) pending.conversation = repository.conversation;
    }
    this.k.commitNow();
    const headBefore = !role.canEdit ? head : undefined;
    try {
      // The last moment to notice a pause before the agent gets any work.
      if (signal.aborted || !live()) throw new Aborted();
      const withBackground = async (): Promise<Section[]> => [...await given(), ...(repository.prBackground ? [{ title: "Pull request background", body: pullRequestBackground(repository.prBackground) }] : [])];
      let opening: string;
      if (wentBack) {
        // Its job as it stands now and the context, from the same sections a fresh conversation gets.
        const givenSections = await withBackground();
        const previous = back?.context ?? (repository.builderSession?.sessionId === run.sessionId ? repository.builderSession.context : undefined);
        const prepared = role.result === "build" || options.designContext || options.reviewContext ? await builderContext(this.k.dataDir, repositoryView(scope), role, run.sessionId, givenSections, previous, { design: options.designContext, knownSections: back?.knownSections }) : { sections: givenSections };
        const sections = prepared.sections;
        if (repository.conversation && (role.result === "build" || options.designContext || options.reviewContext)) {
          if ("snapshot" in prepared && prepared.snapshot) repository.conversation.context = prepared.snapshot;
          else delete repository.conversation.context;
        }
        this.recordJourneyInput(scope, roleId, profileId, sections, "continued");
        opening = continuePrompt({ task: repositoryView(scope), product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.usableProfiles(), worktree, branch: repository.branch ?? "planning", base: repository.baseSha ?? repository.base ?? "", defaultBranch: repository.source?.start.branch ?? product.defaultBranch ?? "main", access, sections, ...(screenWords ? { screen: screenWords } : {}) });
      } else if (picked) {
        // One line about the restart (or the hand back, or that it may now use the screen), then only what the conversation
        // has not heard: the answer to its open question, and messages still in line.
        const answer = asked?.answer !== undefined ? { question: asked.question, text: asked.answer } : undefined;
        if (repository.conversation) {
          delete repository.conversation.asked;
          delete repository.conversation.handback;
        }
        const messages = takeMessages(task, options.member);
        for (const message of messages) {
          if (!message.firstDelivery) continue;
          this.k.say(scope, "you", message.text);
          this.k.log(scope, "you", `You said: ${message.text}`);
        }
        const texts = messages.map((message) => message.text);
        opening = handback ? handBackPrompt(handback, texts) : forScreen ? screenPrompt(forScreen.reason, texts) : restartPrompt(where!, { ...(answer ? { answer } : {}), messages: texts });
        if (repository.prBackground) opening += `\n\n## Refreshed pull request background\n${pullRequestBackground(repository.prBackground)}`;
      } else {
        // Starting the step again: everything the coordinator said in it so far, in order, and after a restart, where it was.
        const files = where && !handback && head && worktree ? await git.changedSince(worktree, head) : [];
        if (signal.aborted || !live()) throw new Aborted();
        const earlier = repository.stepAttempts > 1 ? ((task.stepNotes ?? []) as StepNote[]) : [];
        if (earlier.length) this.k.log(scope, "you", `Handed on ${earlier.length} thing${earlier.length === 1 ? "" : "s"} you said in an earlier attempt at this step`, roleId, profileId);
        const sections = await withBackground();
        if (options.copy) sections.push({ title: OWN_COPY, body: ownCopy(head ?? "") });
        if (earlier.length) sections.push({ title: EARLIER_ATTEMPT, body: formatStepNotes(earlier) });
        if (handback) sections.push({ title: HANDED_BACK, body: formatHandBack(handback, again ?? "") });
        else if (where && tookOver) sections.push({ title: TOOK_OVER, body: formatTakeOver({ ...where, files }, this.k.named(tookOver.id), this.lastWords(scope, roleId, tookOver.id, startedAt), refusal) });
        else if (where) sections.push({ title: forScreen ? WHERE_YOU_WERE_SCREEN : WHERE_YOU_WERE, body: formatWhereYouWere({ ...where, files }, again ?? "", forScreen ? "screen" : "restart") });
        if ((role.result === "build" || options.designContext || options.reviewContext) && repository.conversation) {
          const prepared = await builderContext(this.k.dataDir, repositoryView(scope), role, run.sessionId, sections);
          if (prepared.snapshot) repository.conversation.context = prepared.snapshot;
          else delete repository.conversation.context;
        }
        this.recordJourneyInput(scope, roleId, profileId, sections, "fresh");
        opening = buildPrompt({ task: repositoryView(scope), product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.usableProfiles(), worktree: workingCopy, branch: repository.branch ?? "planning", base: repository.baseSha ?? repository.base ?? "", defaultBranch: repository.source?.start.branch ?? product.defaultBranch ?? "main", access, sections, ...(screenWords ? { screen: screenWords } : {}) });
      }
      if (screen) screen.heard = true;
      // What it is about to hear is on disk first: a restart after this does not hand it over again.
      if (signal.aborted || !live()) throw new Aborted();
      this.k.commitNow();
      // A reopened conversation carries on after the interruption; a fresh one gets its first instructions.
      const askScreen = options.member ? (reason: string) => {
        const current = this.k.task(taskId);
        if (!current?.hunt || !repository.conversation) return false;
        const conversation = structuredClone(repository.conversation);
        current.hunt.screenTurns = {
          ...current.hunt.screenTurns,
          [options.member!]: { reason, at: Date.now(), copy: worktree, conversation },
        };
        if (current.screen) this.k.log(scope, "status", SCREEN_WORDS.asked(reason), roleId, profileId);
        const granted = !current.screen && this.k.askScreen(current, roleId, profileId, reason, options.member);
        if (granted) repository.conversation = conversation;
        this.k.commitNow();
        return granted;
      } : undefined;
      const result = await this.converse(scope, run, agent, opening, picked && !wentBack ? "continue" : "first", role, profileId, schema, signal, { ...options, main: !options.copy, ...(askScreen ? { askScreen } : {}) });
      if (repository.conversation) options.completed?.(repository.conversation, profile, role);
      return result;
    } catch (error) {
      // Logged out in the middle of a step: the same fix as any other login problem.
      if (isAuthRequired(error)) throw await this.tools.problem(profile.toolId, error);
      throw error;
    } finally {
      this.k.runs.delete(taskId);
      this.k.syncIdleSleep();
      // Nothing the agent started may still write in the working copy once the step is over.
      await run.stop();
      for (const copy of protectedCopies) {
        if (await git.head(copy.path).catch(() => copy.sha) !== copy.sha) await git.resetTo(copy.path, copy.sha);
        if (!await git.isClean(copy.path).catch(() => true)) await git.discardChanges(copy.path);
      }
      // A read-only role runs in its tool's automatic mode, so it could change things: leave the
      // working copy exactly as the step first found it, commits and uncommitted changes alike.
      if (headBefore && worktree && (await git.head(worktree).catch(() => headBefore)) !== headBefore) {
        await git.resetTo(worktree, headBefore);
        this.k.log(scope, "warn", `Undid commits from ${role.name}, which is read-only`);
      }
      if (!role.canEdit && worktree && !(await git.isClean(worktree).catch(() => true))) {
        await git.discardChanges(worktree);
        this.k.log(scope, "warn", `Undid changes from ${role.name}, which is read-only`);
      }
    }
  }

  /**
   * One agent working beside others on the same step (reviewers looking at once, voters), in a working copy
   * of its own (`copy`) so none disturbs another. The caller saves each result as it arrives. Asking for
   * the screen keeps this member's copy and conversation, then the usual turn reopens it on its own.
   * Its starting role stays with the round through interruptions and usage replacements.
   * Each member keeps its own summary and clock; background activity leaves the task's status line to its group.
   * `agent` is its group's record of it, which learns whether it is sandboxed.
   */
  async parallel<T>(
    scope: RepositoryContext,
    roleId: Id,
    plannedId: Id,
    copy: string,
    given: Given,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: ConversationOptions & { check?: Check<T>; used?: (profileId: Id) => void; room?: (toolId: Id) => boolean; seat?: Id; reviewerKey?: string; key?: string; member?: string; agent?: ActiveAgent; refresh?: boolean } = {},
  ): Promise<T> {
    const { task } = scope;
    if (!this.k.role(roleId) || !this.k.productOf(scope) || !this.k.profile(plannedId)) throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
    if (signal.aborted) throw new Aborted();
    const key = options.key ?? `${roleId}:${plannedId}`;
    let role = task.hunt?.roles?.[key];
    // Out of usage: a stand-in looks at the change instead, told what the first one had said. With none, the
    // group (not this agent) makes the task wait: the others carry on, and this one is left for later.
    let stopped: { profileId: Id; error: UsageLimited; at: number } | undefined;
    // The group already reserved `seat` (the card shows it). Choosing again after that reservation sees a
    // full pool and would start the first full stand-in instead, so the first attempt uses the reserved profile.
    let first = true;
    // Partners of one step share the read the group just did. A usage replacement is another attempt and reads again.
    let refresh = options.refresh !== false;
    for (;;) {
      if (!first && this.k.admissionsClosed) throw new WaitingForUsage("Waiting for the pool to resume");
      const accepted = first && options.seat ? this.k.profile(options.seat) : undefined;
      first = false;
      let profile: AgentProfile;
      if (accepted) profile = accepted;
      else {
        const choice = this.k.choose(plannedId, scope, roleId, options.room, options.reviewerKey);
        if (!choice) throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
        if (choice.kind === "none") {
          // The group waits, and this agent is started again after: that attempt is a retry.
          if (stopped) this.k.tracking.owesRetry(scope, roleId, plannedId);
          throw new WaitingForUsage(choice.waiting);
        }
        profile = choice.profile;
      }
      // A later stand-in still has to fit the seat this member already holds. With no room, the group waits.
      if (stopped && options.room && !options.room(profile.toolId)) {
        const tool = this.k.s.tools.find((entry) => entry.id === profile.toolId)?.name ?? profile.toolId;
        this.k.tracking.owesRetry(scope, roleId, plannedId);
        throw new WaitingForUsage(`Waiting for a free ${tool} slot`);
      }
      if (stopped && stopped.profileId === profile.id) throw stopped.error;
      this.k.tracking.attempt(scope, roleId, plannedId, profile, stopped !== undefined);
      if (!role) {
        role = structuredClone(this.k.role(roleId)!);
        if (task.hunt) {
          task.hunt.roles = { ...task.hunt.roles, [key]: role };
          this.k.commitNow();
        }
      }
      options.used?.(profile.id);
      const previous = task.hunt?.work?.[key];
      const work = {
        ...previous,
        attempts: (previous?.attempts ?? 0) + 1,
        clock: previous?.clock ? resumeClock(previous.clock, Date.now()) : startClock(repositoryView(scope), roleId, Date.now()),
      };
      delete work.waiting;
      task.hunt!.work = { ...task.hunt!.work, [key]: work };
      const active = [task.agent, ...(task.helpers ?? [])].find((agent) => agent?.reviewKey === key);
      if (active) active.profileId = profile.id;
      this.k.showReviewWork(task);
      this.k.commitNow();
      const since = Date.now();
      try {
        return await this.attemptTogether(scope, role, profile, copy, given, schema, signal, { ...options, key, refresh, plannedId, member: options.member ?? key, ...(stopped ? { took: { from: this.k.named(stopped.profileId), words: this.lastWords(scope, roleId, stopped.profileId, stopped.at), ...(stopped.error.retry ? { refusal: stopped.error.reason } : {}) } } : {}) });
      } catch (error) {
        if (!(error instanceof UsageLimited) || signal.aborted) throw error;
        refresh = true;
        // This member has stopped, even while its peers keep working. A stand-in resumes its clock.
        work.clock = pauseClock(work.clock, Date.now());
        this.keepWords(scope, roleId, profile.id, error);
        this.k.recordLimit(task, roleId, profile.id, error);
        stopped = { profileId: profile.id, error, at: since };
      }
    }
  }

  /** The latest pull-request conversation, for the agents about to share one step. A task that did not start from a pull request has nothing to read. */
  refresh(scope: RepositoryContext): Promise<void> {

    return this.sources.refresh(scope);
  }

  /** One attempt of a parallel agent. `took`: whom it takes over from, and what that agent had said. */
  private async attemptTogether<T>(scope: RepositoryContext, role: Role, profile: AgentProfile, copy: string, given: Given, schema: z.ZodType<T>, signal: AbortSignal, options: ConversationOptions & { key: string; check?: Check<T>; member: string; plannedId: Id; took?: { from: string; words: string; refusal?: string }; agent?: ActiveAgent; refresh?: boolean }): Promise<T> {
    const { task, work: repository } = scope;
    const roleId = role.id;
    const product = this.k.repositoryOf(scope);
    if (!role || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profile.id}`);
    const profileId = profile.id;
    this.mustBeReady(profile);
    if (options.refresh !== false) await this.sources.refresh(scope);
    const taskId = task.id;
    // A usage handoff can change tools: the group's record describes this attempt, not the previous one.
    if (options.agent) {
      options.agent.profileId = profileId;
      delete options.agent.sandbox;
    }
    // The group records the profiles that actually start, including stand-ins, rather than the plan.
    // Different reviewer roles still share the round's one journey step; voters have their own.
    const stage = task.plan?.stages[task.stageIndex];
    const journeyRole = stage?.kind === "review-chain" && !repository.portReview && stage.roleIds?.includes(roleId) ? stage.roleId : roleId;
    const group = openStep(task);
    const team = group?.kind === "agent" && group.roleId === journeyRole ? group.team ?? (group.profileId ? [group.profileId] : []) : [];
    beginAgentStep(task, journeyRole, profileId, Date.now(), [...new Set([...team, profileId])], repository);
    if (options.took) {
      const words = `${role.name} on ${this.k.named(profileId)} took over from ${options.took.from}, which ${options.took.refusal ? `could not continue (${options.took.refusal})` : "ran out of usage"}`;
      this.k.say(scope, "system", words, roleId, profileId);
      this.k.log(scope, "milestone", words, roleId, profileId);
    } else {
      this.k.say(scope, "system", `${role.name} joined · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(scope, "milestone", `${role.name} started`, roleId, profileId);
    }
    this.k.commit();
    const agent: TurnAgent = { roleId, profile, waits: new WaitClock() };
    const command = this.k.options.agentCommand?.(profile);
    const offered = typeof options.resume === "function" ? await options.resume(profile, role) : options.resume;
    const start = (sessionId?: string) => this.inSandbox(profile, (sandbox) =>
      AgentRun.start({
        profile,
        ...(command ? { command } : {}),
        env: this.envFor(),
        ...(sandbox ? { sandbox } : {}),
        cwd: copy,
        ...(sessionId ? { reopen: sessionId, ...(this.k.options.reopenTimeoutMs ? { reopenTimeoutMs: this.k.options.reopenTimeoutMs } : {}) } : {}),
        browserRoot: join(this.k.dataDir, "browser-temp"),
        signal,
        ...(this.k.options.startTimeoutMs ? { startTimeoutMs: this.k.options.startTimeoutMs } : {}),
        callbacks: {
          onMessage: this.messageStream(scope, roleId, profileId, signal),
          onActivity: (line) => {
            const current = this.k.task(taskId);
            const work = current?.hunt?.work?.[options.key];
            if (!current || !work || signal.aborted || (current.state !== "running" && current.state !== "needs-you")) return;
            work.activity = line;
            this.k.showReviewWork(current);
            this.k.say(scope, "activity", line, roleId, profileId);
            this.k.commit();
          },
          onPlanStep: (line) => {
            const current = this.k.task(taskId);
            const work = current?.hunt?.work?.[options.key];
            const text = plainTodo(line);
            if (!current || !work || !text || signal.aborted || work.todo === text || (current.state !== "running" && current.state !== "needs-you")) return;
            work.todo = text;
            this.k.showReviewWork(current);
            this.k.log(scope, "status", text, roleId, profileId);
            this.k.noteTodo();
          },
          onPermission: (info) => this.permission(scope, info, signal, { roleId, profileId }, agent.waits, options.key),
          onLog: (text) => void this.k.agentLog(taskId, text),
          onCleanupIncomplete: () => { const current = this.k.task(taskId); if (current) this.k.log(scope, "warn", CLEANUP_INCOMPLETE); },
          onUsage: (info) => this.k.recordUsage(info),
        },
      }),
    ).catch(async (error: unknown) => {
      if (signal.aborted || sessionId !== undefined) throw error;
      throw await this.tools.problem(profile.toolId, error);
    });
    let opened: Awaited<ReturnType<typeof start>> | undefined;
    if (offered) {
      try { opened = await start(offered.sessionId); }
      catch (error) {
        if (signal.aborted || !(error instanceof ReopenFailed)) throw error;
        this.k.log(scope, "status", `Could not go back to its own review conversation (${error.message}), so it started fresh`, roleId, profileId);
      }
    }
    opened ??= await start();
    const { run, off } = opened;
    options.started?.();
    const wentBack = offered !== undefined && run.reopened !== undefined;
    if (wentBack) this.k.log(scope, "status", "Went back to its own review conversation from the previous round", roleId, profileId);
    // Its group's record of it, shown in the header or among the helpers, says whether it is sandboxed.
    const sandbox = this.sandboxState(scope, off, roleId, profileId);
    if (options.agent) options.agent.sandbox = sandbox;
    this.k.commit();
    const runs = this.k.helperRuns.get(taskId) ?? new Set();
    this.k.helperRuns.set(taskId, runs.add(run));
    this.k.syncIdleSleep();
    this.k.readUsage(profile.toolId);
    const head = await git.head(copy).catch(() => undefined);
    try {
      if (signal.aborted || !this.k.task(taskId)) throw new Aborted();
      const givenSections = [...await given(), ...(repository.prBackground ? [{ title: "Pull request background", body: pullRequestBackground(repository.prBackground) }] : []), { title: OWN_COPY, body: ownCopy(head ?? "") }];
      if (signal.aborted) throw new Aborted();
      if (options.took) givenSections.push({ title: TOOK_OVER, body: formatReviewTakeOver(options.took.from, options.took.words, options.took.refusal) });
      const prepared = options.reviewContext ? await builderContext(this.k.dataDir, repositoryView(scope), role, run.sessionId, givenSections, wentBack ? offered?.context : undefined) : { sections: givenSections };
      const sections = prepared.sections;
      const note: import("@petrina/core").ConversationNote = { ...(this.repositoryCopies.get(copy) ? { repositoryCopies: this.repositoryCopies.get(copy) } : {}), step: stepKey(task), roleId, profileId, role, access: { canEdit: role.canEdit }, toolId: profile.toolId, model: profile.modelId ?? profile.model, sessionId: run.sessionId, ...(head ? { head } : {}), startedAt: Date.now(), briefed: true, ...("snapshot" in prepared && prepared.snapshot ? { context: prepared.snapshot } : {}) };
      this.recordJourneyInput(scope, roleId, profileId, sections, wentBack ? "continued" : "fresh");
      const opening = (wentBack ? continuePrompt : buildPrompt)({ task: repositoryView(scope), product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.usableProfiles(), worktree: copy, branch: repository.branch ?? "planning", base: repository.baseSha ?? repository.base ?? "", defaultBranch: repository.source?.start.branch ?? product.defaultBranch ?? "main", sections });
      const result = await this.converse(scope, run, agent, opening, "first", role, profileId, schema, signal, {
        ...options,
        main: false,
        reviewKey: options.key,
        askScreen: (reason) => {
          // Each member keeps its own request. Only the first can be represented by task.screen;
          // the rest follow after it, without overwriting its conversation or permission.
          const conversation = structuredClone(note);
          task.hunt!.screenTurns = { ...task.hunt!.screenTurns, [options.member]: { reason, at: Date.now(), copy, conversation } };
          if (task.screen) this.k.log(scope, "status", SCREEN_WORDS.asked(reason), roleId, profileId);
          const granted = !task.screen && this.k.askScreen(task, roleId, profileId, reason, options.member);
          if (granted) repository.conversation = conversation;
          this.k.commitNow();
          return granted;
        },
      });
      options.completed?.(note, profile, role);
      return result;
    } catch (error) {
      if (isAuthRequired(error)) throw await this.tools.problem(profile.toolId, error);
      if (error instanceof UsageLimited && !signal.aborted && task.screen?.granted && task.screen.member === options.member) {
        this.keepWords(scope, roleId, profileId, error);
        this.k.recordLimit(task, roleId, profileId, error);
        this.k.tracking.owesRetry(scope, roleId, options.plannedId);
        this.k.waitForScreen(task);
        error = new ScreenWait();
      }
      // Asking for the screen ends this turn. The seat has to be free before the process is gone:
      // waiting out the stop kept the member "running", so a grant beside a peer never resumed it.
      if (error instanceof ScreenWait) {
        this.yieldedStops.push(run.stop());
        runs.delete(run);
        this.k.syncIdleSleep();
      }
      throw error;
    } finally {
      if (runs.has(run)) {
        try {
          await run.stop();
        } finally {
          // Draining still counts a reviewer who is working until its process is gone and its report can be recorded.
          runs.delete(run);
          this.k.syncIdleSleep();
        }
      }
    }
  }

  /**
   * Turns until the agent hands back a valid result: its words go to the session, its questions to the
   * coordinator, and an unusable result back to it twice at most. Each parallel conversation hears
   * its own share of the coordinator's messages. An open question stays with the conversation that asked it.
   */
  private async converse<T>(scope: RepositoryContext, run: AgentRun, agent: TurnAgent, opening: string, reason: TurnReason, role: Role, profileId: Id, schema: z.ZodType<T>, signal: AbortSignal, options: { check?: Check<T>; main: boolean; member?: string; askScreen?: (reason: string) => boolean; reviewKey?: string }): Promise<T> {
    const { task, work: repository } = scope;
    const by = { roleId: role.id, profileId };
    // Every message to the agent and the reply it waits for is one entry in the work log.
    const send = (text: string, why: TurnReason) => this.k.tracking.turn(scope, agent, run, text, why, signal);
    const sendQueued = (batch: ReturnType<typeof takeMessages>) => {
      for (const message of batch) if (message.firstDelivery) {
        this.k.say(scope, "you", message.text);
        this.k.log(scope, "you", `You said: ${message.text}`);
      }
      this.k.commitNow();
      const messages = batch.map((message, index) => `${index + 1}. ${message.text}`).join("\n");
      return send(`Messages from the coordinator, in order:\n${messages}\n\nTake all of them into account. When you are done, end with the result block again.`, "message");
    };
    const mayAsk = mayAskScreen(role);
    let reply = await send(`${opening}\n\n${browserPrompt(run.browser!.directory)}`, reason);
    if (options.main) this.briefed(scope);
    for (let repairs = 0; ; ) {
      if (signal.aborted) throw new Aborted();
      const current = this.k.task(task.id);
      if (!current) throw new Aborted();
      const prose = proseOf(reply.text);
      if (prose && !reply.streamed) this.k.say(scope, "agent", prose.length > 2400 ? `${prose.slice(0, 2400)}…` : prose, role.id, profileId);
      // A streamed reply is already in the conversation. Pictures stay on that report, not on later activity.
      const reportLine = prose
        ? reply.streamed
          ? [...current.session].reverse().find((line) => line.from === "agent" && line.roleId === role.id && line.profileId === profileId)
          : current.session.at(-1)
        : undefined;
      const parsed = parseResult(reply.text, schema);
      // A screen request goes before messages in line: they reach the agent with the screen, now or when it continues.
      if (parsed.ok === "screen" && mayAsk && reply.stopReason !== "cancelled") {
        // Asking again for the screen it has: told once more, a limited number of times.
        if (current.screen?.granted && (options.main || current.screen.member === options.member)) {
          repairs += 1;
          if (repairs > 2) throw new Error(`${role.name} kept asking for the screen it already has`);
        } else if (!(options.askScreen ? options.askScreen(screenReason(parsed.reason)) : this.k.askScreen(current, role.id, profileId, screenReason(parsed.reason)))) {
          if (options.main) this.k.pauseStep(current);
          const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
          if (work?.clock) work.clock = pauseClock(work.clock, Date.now());
          this.k.commitNow();
          throw new ScreenWait();
        }
        // Given at once, in this conversation: the agent keeps its slot.
        current.screen!.heard = true;
        const messages = takeMessages(current, options.member);
        for (const message of messages) {
          if (!message.firstDelivery) continue;
          this.k.say(scope, "you", message.text);
          this.k.log(scope, "you", `You said: ${message.text}`);
        }
        this.k.commitNow();
        reply = await send(screenPrompt(current.screen!.reason, messages.map((message) => message.text)), "continue");
        continue;
      }
      const batch = options.main || options.member ? takeMessages(current, options.member) : [];
      if (batch.length) {
        reply = await sendQueued(batch);
        continue;
      }
      if (reply.stopReason === "cancelled") {
        reply = await send("Continue where you left off. When you are done, end with the result block.", "continue");
        continue;
      }
      if (parsed.ok === "input") {
        this.k.say(scope, "agent", parsed.question, role.id, profileId);
        this.k.log(scope, "warn", `Asked you: ${parsed.question}`, role.id, profileId);
        const answer = await this.wait(scope, "question", parsed.question, true, { options: parsed.options }, signal, "Waiting for your answer", by, options.main, options.reviewKey);
        // Heard from here on: a restart does not hand the answer over again.
        const note = repository.conversation;
        if (note && (options.main || (note.roleId === role.id && note.profileId === profileId))) delete note.asked;
        this.k.commitNow();
        reply = await send(`The coordinator answered: ${answer}\n\nContinue. When you are done, end with the result block.`, "answer");
        continue;
      }
      let error: string | undefined;
      if (reportLine) this.k.pendingReportIds.add(reportLine.id);
      try {
        error = parsed.ok === true ? await options.check?.(parsed.value) : parsed.ok === "screen" ? NO_SCREEN_HERE : parsed.error;
        if (parsed.ok === true && !error) {
          // Validation may await I/O. Notes arriving during it still reach this agent before its result is accepted.
          const late = options.main || options.member ? takeMessages(current, options.member) : [];
          if (late.length) {
            reply = await sendQueued(late);
            continue;
          }
          const images = (parsed.value as { images?: { path: string; caption: string }[] }).images ?? [];
          const finishedAt = Date.now();
          const storage = join(this.k.dataDir, "captures", task.id);
          let saved: Awaited<ReturnType<typeof preserveCaptures>> | undefined;
          try {
            saved = await preserveCaptures(run.browser!.directory, storage, images, signal);
          } catch (captureError) {
            if (signal.aborted || captureError instanceof Aborted) throw new Aborted();
            error = captureError instanceof Error ? captureError.message : "The chosen pictures could not be saved.";
          }
          if (saved) {
            let attached = false;
            try {
              const live = this.k.task(current.id) ?? current;
              if (signal.aborted || live.state === "done" || live.state === "cancelled") throw new Aborted();
              // Saving pictures also awaits I/O. Discard superseded copies and let this
              // agent hear any new instruction before attaching pictures or finishing.
              const whileSaving = options.main || options.member ? takeMessages(current, options.member) : [];
              if (whileSaving.length) {
                await Promise.all(saved.map((image) => rm(join(storage, `${image.id}.png`), { force: true })));
                saved.length = 0;
                reply = await sendQueued(whileSaving);
                continue;
              }
              if (options.member) this.k.screenGroups.get(task.id)?.finished(options.member);
              if (saved.length) {
                let host = reportLine ? live.session.find((line) => line.id === reportLine.id) : undefined;
                if (!host) {
                  this.k.say(live, "agent", reportLine?.text ?? (parsed.value as { summary?: string }).summary ?? "Report ready", role.id, profileId);
                  host = live.session.at(-1);
                }
                host!.images = saved;
              }
              const step = openStep(live);
              if (step) step.agentResults = [...(step.agentResults ?? []), { roleId: role.id, profileId, at: finishedAt, value: parsed.value, ...(saved.length ? { images: saved } : {}) }];
              // The result ends the agent's work. Saving its pictures is Petrina's time.
              if (options.main) this.k.pauseStep(current, finishedAt);
              const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
              if (work?.clock) work.clock = pauseClock(work.clock, finishedAt);
              // Durable references are saved before the agent stops or its working copy is cleaned.
              this.k.commitNow();
              attached = true;
              return parsed.value;
            } finally {
              if (!attached) await Promise.all(saved.map((image) => rm(join(storage, `${image.id}.png`), { force: true })));
            }
          }
        }
      } finally {
        if (reportLine) this.k.pendingReportIds.delete(reportLine.id);
      }
      repairs += 1;
      if (repairs > 2) throw new Error(`${role.name} did not hand back a usable result: ${error}`);
      this.k.tracking.redo(current, role.id, agent.profile);
      reply = await send(repairPrompt(error ?? ""), "redo");
    }
  }

  /** A tool known to be missing or logged out is not started: the coordinator gets its fix instead. */
  private mustBeReady(profile: AgentProfile): void {
    const known = this.tools.status(profile.toolId as CheckId);
    if (notReady(known)) throw new ToolProblem(profile.toolId as CheckId, known);
  }

  /** The profiles agents hear about (the planner picks from them): only those on tools the squad can use. */
  private usableProfiles(): AgentProfile[] {
    const usable = this.k.usableTools() as Id[];
    return (this.k.s.profiles as AgentProfile[]).filter((entry) => !usable.length || usable.includes(entry.toolId));
  }

  /**
   * What every agent runs with: the coordinator's own environment and logins, with nothing waiting for a typed
   * answer, in the background (tools that would pop a browser tab stay quiet, and Petrina's own `open` refuses).
   */
  private envFor(): NodeJS.ProcessEnv {
    return agentEnv(process.env);
  }

  /**
   * Opens an agent's conversation in its tool's own sandbox. Codex always runs in its own; Claude Code's is
   * asked for here, unless it could not start earlier in this run of Petrina. When Claude Code says it cannot
   * start, the same conversation opens again without it, and later agents skip it. `off` says why it is off.
   * Other tools keep their own session settings.
   */
  private async inSandbox(profile: AgentProfile, start: (sandbox?: ClaudeSandbox) => Promise<AgentRun>): Promise<{ run: AgentRun; off?: string }> {
    if (!ADAPTERS[profile.toolId]?.sandboxMeta) return { run: await start() };
    if (this.k.sandboxOff === undefined) {
      try {
        return { run: await start(claudeSandbox()) };
      } catch (error) {
        if (!(error instanceof SandboxUnavailable)) throw error;
        this.k.sandboxOff = error.reason;
      }
    }
    return { run: await start(), off: this.k.sandboxOff };
  }

  /**
   * Whether the agent is sandboxed, for the Session tab; without the sandbox, its session says so once, with the
   * reason. A conversation picked up again (after a restart, or for a fix round or an update) that already said it does not repeat it.
   */
  private sandboxState(scope: RepositoryContext, off: string | undefined, roleId: Id, profileId: Id, reopened = false): ActiveAgent["sandbox"] {
    const { task } = scope;
    const toolId = this.k.profile(profileId)?.toolId;
    if (toolId !== "claude-code" && toolId !== "codex") return undefined;
    if (off === undefined) return { on: true };
    const line = `Running without Claude Code's sandbox: ${off}`;
    const said = reopened && task.session.some((entry) => entry.from === "system" && entry.text === line && entry.roleId === roleId && entry.profileId === profileId);
    if (!said) this.k.say(scope, "system", line, roleId, profileId);
    return { on: false, reason: off };
  }

  /** The tool's own safety check flagged something: the coordinator decides. Petrina adds no rules of its own. */
  private async permission(scope: RepositoryContext, info: PermissionInfo, signal: AbortSignal, by: { roleId: Id; profileId: Id }, waits: WaitClock, reviewKey?: string): Promise<"allow" | "deny"> {
    const { task } = scope;
    const taskId = task.id;
    if (this.k.task(taskId) !== task || signal.aborted) return "deny";
    const tool = ADAPTERS[this.k.profile(by.profileId)?.toolId ?? ""]?.name ?? "The agent's tool";
    const detail = info.command ?? (info.target ? info.target : info.paths.join("\n"));
    const main = !reviewKey && task.agent?.profileId === by.profileId && task.agent.roleId === by.roleId;
    // Waiting for the coordinator is not agent work: the wait is left out of the turn's working time.
    waits.start(taskId);
    try {
      const answer = await this.wait(scope, "permission", info.title, true, { body: `${tool}'s own safety check wants your OK before this.`, ...(detail ? { detail } : {}) }, signal, "Waiting for your permission", by, main, reviewKey);
      return answer === "allow" ? "allow" : "deny";
    } finally {
      waits.stop(taskId);
    }
  }

  private async wait(scope: RepositoryContext, kind: InboxKind, title: string, blocking: boolean, extra: { body?: string; options?: string[]; detail?: string }, signal: AbortSignal, status: string, by: { roleId: Id; profileId: Id }, main: boolean, reviewKey?: string): Promise<string> {
    const { task, work: repository } = scope;
    const id = this.k.raise(scope, kind, title, blocking, { ...extra, ...(reviewKey ? { reviewKey } : {}) }, by);
    // It hangs under the step that asked, a reviewer's or a voter's among others included.
    if (kind === "question" || kind === "permission") addAsk(task, { id, kind, title, at: Date.now() });
    task.statusLine = status;
    const note = repository.conversation;
    // A parallel reviewer given the screen keeps that conversation on the task. Its question has to
    // survive a restart the same way the step's main agent does, or the next start resumes with no answer.
    const owns = !!note && note.roleId === by.roleId && note.profileId === by.profileId;
    if (kind === "question" && note && (main || owns)) {
      note.asked = { itemId: id, question: title };
    }
    // Time spent waiting for the coordinator is not the agent's working time.
    if (main) this.k.pauseStep(task);
    const work = reviewKey ? task.hunt?.work?.[reviewKey] : undefined;
    if (work) {
      if (work.clock) work.clock = pauseClock(work.clock, Date.now());
      work.waiting = status;
      this.k.showReviewWork(task);
    }
    if (kind === "question" && note && (main || owns)) this.k.commitNow();
    else this.k.commit();
    try {
      return await new Promise<string>((resolve, reject) => {
        this.k.waiting.set(id, { resolve, reject });
        signal.addEventListener("abort", () => reject(new Aborted()), { once: true });
      });
    } finally {
      if (work && !signal.aborted) {
        const pending = this.k.s.inbox.find((item) => item.taskId === task.id && item.blocking && item.reviewKey === reviewKey);
        if (pending) work.waiting = pending.kind === "permission" ? "Waiting for your permission" : "Waiting for your answer";
        else {
          delete work.waiting;
          if (work.clock) work.clock = resumeClock(work.clock, Date.now());
        }
        this.k.showReviewWork(task);
        this.k.commitNow();
      }
    }
  }

  /** The step in the coordinator's words, for an agent coming back to it. */
  private stepTitle(scope: RepositoryContext): string {
    const { task } = scope;
    if (task.stageIndex < 0) return "Planning";
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return "this step";
    if (stage.kind === "converge") return `${stage.title}, round ${task.rounds[stage.id] ?? 1}`;
    if (stage.kind === "review-chain") return `${stage.title}, round ${task.rounds[stage.id] ?? 1}`;
    return task.fixing ? `${stage.title}, fixing review findings` : stage.title;
  }

  /** Where an agent was in its step: the stage, its role, and its last activity and plan steps since the step started. */
  private whereYouWere(scope: RepositoryContext, role: Role, since: number): WhereYouWere {
    const { task } = scope;
    const done = [
      ...task.session.filter((line) => line.from === "activity" && line.roleId === role.id && line.at >= since),
      ...task.timeline.filter((entry) => entry.tone === "status" && entry.roleId === role.id && entry.at >= since),
    ]
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.text)
      .filter((text, index, all) => text !== all[index - 1]);
    return { stage: this.stepTitle(scope), role: role.name, done: done.slice(-MAX_DONE) };
  }

  /** The agent showed it has its instructions: from now on a restart may reopen its conversation. */
  private briefed(scope: RepositoryContext): void {
    const { work: repository } = scope;
    if (!repository.conversation || repository.conversation.briefed) return;
    repository.conversation.briefed = true;
    this.k.commitNow();
  }
}
