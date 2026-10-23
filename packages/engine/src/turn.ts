import { repositoryView, type RepositoryContext } from "./repository-context.js";
import { completeAll } from "./parallel.js";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Sources } from "./sources.js";
// One agent working one step: opening or reopening its conversation, its instructions, the turns until
// it hands back a valid result, and what it asks the coordinator on the way.

import { sameModel, addAsk, beginAgentStep, endAgentStep, JOURNEY_WORDS as W, limitOf, openStep, SCREEN_WORDS, screenReason, slotWait, stepMayChange, type ActiveAgent, type AgentProfile, type Id, type InboxKind, type Pool, type Product, type Role, type StepNote, type TurnReason, type CheckId, type ConversationNote, type BuilderContext, pauseClock, plainTodo, resumeClock, retryingWords, startClock } from "@petrina/core";
import type { z } from "zod";
import { AgentRun, ReopenFailed, type NativeRetryReport, type PermissionInfo, type TurnResult } from "./acp-run.js";
import * as git from "./git.js";
import { agentEnv } from "./env.js";
import { claudeSandbox, SandboxUnavailable, type ClaudeSandbox } from "./sandbox.js";
import { browserPrompt, buildPrompt, capacityContinuePrompt, continuePrompt, currentStepAssignment, EARLIER_ATTEMPT, OWN_COPY, ownCopy, formatHandBack, formatReviewTakeOver, formatStepNotes, formatTakeOver, formatWhereYouWere, HANDED_BACK, handBackPrompt, lastWords, MAX_DONE, parseResult, proseOf, pullRequestBackground, repairPrompt, restartPrompt, TOOK_OVER, WHERE_YOU_WERE, type WhereYouWere, mayAskScreen, screenPrompt, WHERE_YOU_WERE_SCREEN } from "./prompts.js";
import { capacityRetryDelay, capacityWaiting, MODEL_CAPACITY_WAIT_MS, ModelAtCapacity, sameCapacityModel, UsageLimited, WaitingForCapacity, waitingFor, WaitingForUsage } from "./usage.js";
import type { AgentMessage } from "./agent-messages.js";
import { ADAPTERS } from "./tools.js";
import { CLEANUP_INCOMPLETE } from "./process-tree.js";
import { MaintenanceProfileProblem, Kernel, Aborted, ScreenWait, notReady, stepKey, ToolProblem, type EngineOptions } from "./kernel.js";
import type { TurnAgent } from "./tracking.js";
import { WaitClock } from "./worklog.js";
import { isAuthRequired } from "./setup.js";
import type { ToolChecks } from "./tool-checks.js";
import { coordinatorNotes, type Section } from "./context.js";
import { supplyReviewHistory } from "./review-history.js";
import { backgroundMessage, holdUnconfirmed, MessageTurn, takeMessages } from "./messages.js";
import { preserveCaptures } from "./captures.js";
import { builderContext } from "./builder-context.js";
import { recordToolActivity } from "./record-tool-activity.js";
import { discardParticipant, ParticipantUnavailable } from "./participant-conversation.js";
import type { ToolActivityEvent } from "./tool-invocations.js";
import type { ReadinessRecheck, ReadinessWait } from "@petrina/core";
import { inputManifest, numberInputManifest, saveExactMessage } from "./exact-input.js";

/** Turns a valid but incomplete result into what the agent is asked to repair, or undefined when it is complete. */
type Check<T> = (value: T) => string | undefined | Promise<string | undefined>;
type Given = () => Section[] | Promise<Section[]>;
type ResumeConversation = { sessionId: string; toolId: Id; model: string; context?: import("@petrina/core").BuilderContext; knownSections?: readonly string[]; continuedSections?: readonly Section[]; reselect?: boolean; readinessWait?: ReadinessWait };
type ConversationOptions = {
  /** Why a saved conversation was not kept, from the choice that started this participant fresh. */
  freshReason?: string;
  /** The saved conversation's bounded readiness recheck behind this choice, for the journey. */
  readiness?: ReadinessRecheck;
  resume?: ResumeConversation | ((profile: AgentProfile, role: Role) => ResumeConversation | undefined | Promise<ResumeConversation | undefined>);
  reviewContext?: boolean;
  reviewFindings?: readonly import("@petrina/core").Finding[];
  started?: () => void;
  completed?: (note: import("@petrina/core").ConversationNote, profile: AgentProfile, role: Role) => void;
  /** A vote's place, recorded on each journey input so a replacement or reused tool stays on its own seat. */
  place?: string;
};

/** `used` hears which profile worked each attempt: a stand-in when the planned one was out of usage. */
interface TurnOptions<T> extends ConversationOptions {
  builderTree?: string;
  requestedProfileId?: Id;
  selectionReason?: string;
  status?: string;
  check?: Check<T>;
  copy?: string;
  /** Design participants use the same complete context packets as Builders, reducing unchanged background on return. */
  designContext?: boolean;
  used?: (profileId: Id) => void;
  reviewerKey?: string;
  /** The positions the step expects a result from (a round's reviewer places, a vote's electorate), recorded on the step as this participant is admitted. */
  seats?: readonly string[];
  /** Parallel review work whose summary and clock this conversation is continuing. */
  reviewKey?: string;
  /** The individual member whose saved screen conversation is being resumed. */
  member?: string;
  /** A parallel member replaces only its own reserved seat when it continues. */
  room?: (toolId: Id, profile: AgentProfile) => boolean;
}

/** Real agents get a browser in every role that may check pages. A scripted fake agent never opens a page, so it gets one only when its test asks. */
export function opensBrowser(role: Role, options: Pick<EngineOptions, "agentCommand" | "browser">): boolean {
  return mayAskScreen(role) && (options.browser ?? !options.agentCommand);
}

/** An input recorded while the opening text is being built; it joins the journey with its exact message reference. */
type PendingInput = { stepId: Id; input: import("@petrina/core").JourneyAgentInput };

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
    if (!this.k.role(roleId, task) || !(task.maintenance?.profile.id === plannedId || this.k.profile(plannedId)) || (this.k.role(roleId, task)?.result !== "plan" && !this.k.productOf(scope))) throw new Error(`Unknown role or product: ${roleId} on ${plannedId}`);
    let stopped: { profileId: Id; error: UsageLimited | ModelAtCapacity; at: number } | undefined;
    for (;;) {
      if (this.k.admissionsClosed) throw new WaitingForUsage("Waiting for the pool to resume");
      // A screen request keeps the profile whose conversation asked, even if its planned tool is free again.
      const wanted = task.screen?.roleId === roleId ? task.screen.profileId : plannedId;
      const room = options.room ?? ((toolId: Id, profile: AgentProfile) => !slotWait(this.k.activeState(), { ...profile, taskId: task.id, toolId }));
      const choice = this.k.choose(wanted, scope, roleId, room, options.reviewerKey)!;
      if (choice.kind === "none" && choice.readiness && !stopped) {
        // Only a saved participant's uncertain tool stands in the way. A step holding its place keeps it for the
        // bounded decision and chooses again; otherwise the check starts or is joined and the task waits as usual.
        if (!options.member && this.k.readiness.hold(task, choice.readiness)) {
          await this.k.readiness.resolve(choice.readiness, signal);
          if (signal.aborted) throw new Aborted();
          continue;
        }
        if (!this.k.admissionsClosed) void this.k.readiness.resolve(choice.readiness);
      }
      if (choice.kind === "none") {
        // A full model, with nothing else to take the step, retries the same conversation. It is not a usage limit,
        // unless the account is out as well: then the wait is that limit's.
        if (stopped?.error instanceof ModelAtCapacity) {
          this.prepareCapacityRetry(scope, roleId, stopped.profileId, stopped.error, options.member);
          this.k.waitForUsage(task, choice.waiting);
          throw waitingFor(choice.waiting);
        }
        // Stopped by a limit and waiting for the reset: the step's next attempt is a retry.
        if (stopped) this.k.tracking.owesRetry(scope, roleId, plannedId);
        this.k.waitForUsage(task, choice.waiting);
        throw new WaitingForUsage(choice.waiting);
      }
      const { profile } = choice;
      // The same model, including another effort of it, cannot take over from itself.
      if (stopped?.error instanceof ModelAtCapacity && (stopped.profileId === profile.id || sameCapacityModel(stopped.error, profile))) {
        this.prepareCapacityRetry(scope, roleId, stopped.profileId, stopped.error, options.member);
        const words = this.capacityWords(scope, stopped.profileId);
        this.k.waitForUsage(task, words);
        throw new WaitingForCapacity(words);
      }
      // The tool said it was out while running something it should not have limited: the step cannot go on.
      if (stopped?.profileId === profile.id) throw stopped.error;
      // Every actual tool qualifies, including an internal errand before a reviewer, and a handoff
      // to another model on the same tool. The task's old seat is the one being replaced.
      const wait = options.room
        ? room(profile.toolId, profile) ? undefined : `Waiting for a free ${this.k.s.tools.find((tool) => tool.id === profile.toolId)?.name ?? profile.toolId} slot`
        : slotWait(this.k.activeState(), { ...profile, taskId: task.id, toolId: profile.toolId });
      if (wait) {
        if (stopped && !(stopped.error instanceof ModelAtCapacity)) this.k.tracking.owesRetry(scope, roleId, plannedId);
        this.k.waitForUsage(task, wait);
        throw new WaitingForUsage(wait);
      }
      this.k.tracking.attempt(scope, roleId, plannedId, profile, stopped !== undefined);
      options.used?.(profile.id);
      // Said where the coordinator will see it: a security review that could not stay off the builder's tool.
      const builder = this.k.profile(task.plan?.stages.find((stage) => this.k.role(stage.roleId, task)?.result === "build")?.profileIds[0] ?? "");
      const builderTool = repository.builderSession?.toolId ?? builder?.toolId;
      if (roleId === "security-reviewer" && builderTool === profile.toolId && !task.timeline.some((entry) => entry.text.startsWith("Security review on the builder's tool"))) {
        this.k.log(scope, "warn", `Security review on the builder's tool (${this.k.named(profile.id)}): no other tool is available for this review`);
      }
      try {
        return await this.attempt(scope, roleId, plannedId, profile, given, schema, signal, { ...options, selectionReason: [options.selectionReason, choice.reason].filter(Boolean).join(" "), ...(choice.freshReason ? { freshReason: choice.freshReason } : {}), ...(choice.readiness ? { readiness: choice.readiness } : {}) });
      } catch (error) {
        if (signal.aborted) throw error;
        if (this.discardUnavailableParticipant(scope, roleId, error, options.reviewerKey)) continue;
        if (error instanceof ModelAtCapacity) {
          // Keep the conversation and the work. The same model gets a few short continues before anyone else takes the step.
          // An agent that already has the screen keeps it: this is not a usage limit, and it does not give the screen up.
          this.keepWords(scope, roleId, profile.id, error);
          if (this.deferCapacity(scope, roleId, profile.id, error, plannedId, options.member)) {
            const words = this.capacityWords(scope, profile.id);
            this.k.waitForUsage(task, words);
            throw new WaitingForCapacity(words);
          }
          stopped = { profileId: profile.id, error, at: Date.now() };
          continue;
        }
        if (!(error instanceof UsageLimited)) throw error;
        this.keepWords(scope, roleId, profile.id, error);
        this.k.recordLimit(task, roleId, profile.id, error);
        if (task.screen?.granted && task.screen.profileId === profile.id) {
          this.k.tracking.owesRetry(scope, roleId, plannedId);
          this.k.waitForScreen(task);
          throw new ScreenWait();
        }
        stopped = { profileId: profile.id, error, at: Date.now() };
      }
    }
  }

  /** What an agent had said when it stopped joins the session, so the one taking over can be told. */
  private keepWords(scope: RepositoryContext, roleId: Id, profileId: Id, error: { said?: string; streamed?: boolean }): void {

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
        this.k.noteStream(scope);
      } else {
        this.k.say(scope, "agent", message.text, roleId, profileId);
        last = { key: message.id, line: task.session.at(-1)!.id };
        this.k.commit(scope);
      }
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

  /**
   * The role-specific context at the moment it is handed to an agent, not reconstructed later. The record is
   * returned, and joins the journey when the exact text goes out, so its saved message reference is part of it.
   */
  private recordJourneyInput(scope: RepositoryContext, roleId: Id, profileId: Id, sections: readonly Section[], mode: "fresh" | "continued", plannedId: Id, selectionReason: string | undefined, reviewerKey: string | undefined, confirmedSettings: { model?: string; modelName?: string; effort?: string }, instructions: string, extra: { omitted?: readonly { title: string; digest: string }[]; freshReason?: string; sessionId?: string; resumed?: boolean; supplied?: readonly Section[]; place?: string; readiness?: ReadinessRecheck } = {}): PendingInput | undefined {
    const { task, work } = scope;
    const step = openStep(task);
    if (step?.kind !== "agent") return undefined;
    const stage = task.plan?.stages[task.stageIndex];
    const designReview = stage?.kind === "converge" && roleId === (stage.reviewerRoleId ?? "design-reviewer");
    const seats = designReview ? stage?.reviewerProfileIds : stage?.profileIds;
    const index = reviewerKey !== undefined ? Number(reviewerKey) : seats?.indexOf(plannedId) ?? -1;
    const assignedRole = designReview ? stage?.reviewerRoleId ?? "design-reviewer" : stage?.roleIds?.[index] ?? stage?.roleId;
    const assignment = assignedRole === roleId ? (designReview ? stage?.reviewerAssignments : stage?.assignments)?.[index] : undefined;
    const previous = step.agentInputs?.findLast(entry => entry.roleId === roleId && entry.profileId === profileId && entry.reviewerKey === reviewerKey);
    const reason = selectionReason || previous?.selectionReason;
    if (reason && /^(Kept its own conversation|Started a fresh conversation:)/.test(reason)) this.k.log(scope, "status", reason, roleId, profileId);
    const input = {
      productId: work.productId,
      stepAttempts: work.stepAttempts ?? 0,
      versions: { ...(work.baseSha ? { base: work.baseSha } : {}), ...(work.reviewedSha ? { reviewed: work.reviewedSha } : {}), ...(work.reviewedTree ? { reviewedTree: work.reviewedTree } : {}), ...(work.checks ? { checks: { at: work.checks.at, sha: work.checks.sha, tree: work.checks.tree, definition: work.checks.definition, passed: work.checks.results.every((run) => run.ok), count: work.checks.results.length, ...(work.checks.provenance ? { node: work.checks.provenance.nodeId } : {}) } } : {}) },
      ...(step.reviewInput ? { reviewInput: structuredClone(step.reviewInput) } : {}),
      at: Date.now(),
      instructions,
      requestedProfileId: plannedId,
      ...(reason ? { selectionReason: reason } : {}),
      ...(reviewerKey !== undefined ? { reviewerKey } : {}),
      ...(extra.place !== undefined ? { place: extra.place } : {}),
      ...(assignment ? { assignment: structuredClone(assignment) } : {}),
      ...(confirmedSettings ? { confirmedSettings } : {}),
      roleId,
      profileId,
      taskTitle: task.title,
      // Fresh prompts include the task request for every role. Continued prompts
      // receive only their updated sections in the existing conversation.
      ...(mode === "fresh" ? { taskDescription: task.description } : {}),
      ...(task.plan?.stages[task.stageIndex]?.title ? { stageTitle: task.plan.stages[task.stageIndex]!.title } : {}),
      sections: sections.map(({ title, body }) => ({ title, body })),
      mode,
      ...(extra.resumed ? { resumed: true } : {}),
      manifest: inputManifest(instructions, extra.supplied ?? sections, extra.omitted, extra.supplied !== undefined),
      ...(extra.freshReason ? { freshReason: extra.freshReason } : {}),
      ...(extra.readiness ? { readiness: structuredClone(extra.readiness) } : {}),
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    };
    return { stepId: step.id, input };
  }

  /** Another start on this seat is another input, never a rewrite of what it heard before. Saved once the text is known. */
  private async attachInput(scope: RepositoryContext, pending: PendingInput | undefined, text: string, additions: readonly Section[] = [], openingSections: readonly Section[] = []): Promise<void> {
    if (!pending) return;
    const { task } = scope;
    const step = task.journey?.find((entry) => entry.id === pending.stepId);
    if (!step) return;
    const exact = await saveExactMessage(this.k.dataDir, task.id, text);
    const input = { ...pending.input, sections: [...pending.input.sections, ...openingSections].filter(section => section.body), ...(additions.length ? { manifest: numberInputManifest([...(pending.input.manifest ?? []), ...inputManifest("", additions, [], true)]) } : {}), ...(exact ? { exact } : {}) } as NonNullable<typeof step.agentInputs>[number];
    step.agentInputs = [...(step.agentInputs ?? []), input];
    this.k.commitNow(scope);
  }

  /** One attempt at the step by one agent on one profile. */
  private async attempt<T>(scope: RepositoryContext, roleId: Id, plannedId: Id, profile: AgentProfile, given: Given, schema: z.ZodType<T>, signal: AbortSignal, options: TurnOptions<T>): Promise<T> {
    const { task, work: repository } = scope;
    let role = this.k.role(roleId, task);
    const product = this.k.repositoryOf(scope) ?? (role?.result === "plan" ? { id: "", name: "To be chosen", repo: "", tone: "blue" as const } : undefined);
    if (!role || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profile.id}`);
    const profileId = profile.id;
    const workingCopy = repository.worktree ?? join(this.k.dataDir, "planning", task.id);
    if (!repository.worktree) mkdirSync(workingCopy, { recursive: true });
    const taskId = task.id;
    const worktree = options.copy ?? workingCopy;
    // Paused, cancelled or stopped while getting here: no agent starts, and the task stays as the coordinator left it.
    if (signal.aborted) throw new Aborted();
    await holdUnconfirmed(this.k, scope, options.member, signal, options.reviewKey);
    this.mustBeReady(profile);
    if (role.result !== "plan") await this.sources.refresh(scope, !!repository.conversation || task.fixing);

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
    const reopen = same && same.briefed && role.result !== "delivery" && same.toolId === profile.toolId && same.model === model && (role.result !== "build" || !same.plannedProfileId || same.plannedProfileId === plannedId) ? same : undefined;
    let again = saved && !reopen ? (same ? (same.briefed || role.result === "delivery" ? (options.readiness && options.freshReason) || "it now runs on a different tool or model" : "it had not received its instructions yet") : "the saved conversation was for another step") : undefined;
    // Back to an earlier step's conversation, unless this step already has one of its own.
    const offered = typeof options.resume === "function" ? await options.resume(profile, role) : options.resume;
    const back = !saved && offered?.toolId === profile.toolId && offered.model === model ? offered : undefined;
    // A selection that already said why (its saved tool's readiness) is logged with the journey input instead.
    if (!saved && offered && !back && !options.freshReason) this.k.log(scope, "status", "Started a fresh conversation: the tool or model changed", roleId, profileId);
    const startedAt = same?.startedAt ?? Date.now();
    // Handed back by the coordinator: the note of what changed, until the agent hears it.
    const handback = same?.handback;
    // An agent that ran out of usage, or whose model filled up, is who this one takes over from.
    const before = same && !reopen && !back ? this.k.profile(same.profileId) : undefined;
    const now = Date.now();
    const previousLimit = before ? limitOf(this.k.activeState().pool as Pool, before, now) : undefined;
    const capacityHold = before ? task.modelCapacity?.find((entry) => entry.until > now && entry.toolId === before.toolId && entry.modelId === (before.modelId ?? before.model)) : undefined;
    const tookOver = previousLimit || capacityHold ? before : undefined;
    const refusal = capacityHold ? "the selected model is at capacity" : previousLimit?.retry ? previousLimit.reason : undefined;
    if (capacityHold && before) this.forgetCapacityResume(task, (entry) => entry.roleId === roleId && entry.profileId === before.id);
    // The agent has the screen for this step. Coming back from waiting for it, it has not heard yet that it may use it.
    const screen = task.screen?.granted && task.screen.roleId === roleId && task.screen.profileId === profileId && (!options.member || task.screen.member === options.member) ? task.screen : undefined;
    const forScreen = screen && !screen.heard ? screen : undefined;
    // Only the agent that has the screen is told it may use it.
    const screenWords = screen ? { reason: screen.reason } : mayAskScreen(role) ? ("ask" as const) : undefined;
    if (!task.holdsSlot || this.k.profile(task.agent?.profileId ?? "")?.toolId !== profile.toolId) {
      const waiting = this.k.admissionsClosed ? (this.k.draining ? this.k.drainLine : "Waiting for the pool to resume") : slotWait(this.k.activeState(), { ...profile, taskId, toolId: profile.toolId });
      if (waiting) {
        this.k.pendingAgentAdmissions.set(taskId, { step, roleId, profileId });
        throw new WaitingForUsage(waiting);
      }
    }
    this.k.pendingAgentAdmissions.delete(taskId);
    // A step that starts fresh (a new step, after a pause, Try again) drops the old to-do item and starts its clock again.
    // After a restart, or with a stand-in taking over, both stay: the to-do item shows until the agent names its own.
    if (!same) delete task.todo;
    const reviewWork = options.reviewKey ? task.hunt?.work?.[options.reviewKey] : undefined;
    if (reviewWork) {
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
    const journeyStep = beginAgentStep(task, journeyRole, profileId, Date.now(), this.k.s.roles, options.copy ? [...new Set([...team, profileId])] : undefined, repository);
    if (options.seats) journeyStep.seats = [...options.seats];
    if (role.result === "build") journeyStep.buildProductId = repository.productId;
    if (role.result === "checks" && task.acceptanceRun) journeyStep.proofRun = structuredClone(task.acceptanceRun);
    if (["findings", "votes"].includes(role.result) && task.hunt?.input) journeyStep.reviewInput = structuredClone(task.hunt.input);
    if (role.result === "checks" && task.retest && !journeyStep.agentInputs?.length) journeyStep.trigger = { ...journeyStep.trigger, reason: task.proofRetestReason === "requested" ? "A reviewer asked for proof on the final code" : task.proofRetestReason === "main-moved" ? "Main moved since the proof was recorded" : task.proofRetestReason === "code-changed" ? "The task's code changed since acceptance testing" : "Final acceptance testing after review: the final code needs current acceptance evidence" };
    if (saved) {
      task.statusLine = options.status ?? `${role.name} is getting back to work`;
    } else {
      task.statusLine = options.status ?? `${role.name} is starting`;
    }
    if (same) { same.role = role; same.access = access; }
    this.k.commitNow(scope);

    const live = () => this.k.task(taskId);
    // How its turns are written down in the work log, with its own waits for the coordinator left out of its time.
    const agent: TurnAgent = { roleId, profile, waits: new WaitClock(), journeyId: journeyStep.id, agentSeat: options.reviewerKey ?? options.reviewKey ?? roleId };
    // The working copy as the step first found it: what the summary compares with, and what a read-only role leaves.
    const [head, protectedCopies] = await Promise.all([
      same?.head ?? (worktree ? git.head(worktree).catch(() => undefined) : undefined),
      task.repositories && !options.copy ? Promise.all(task.repositories.filter((work) => work.worktree && work.productId !== repository.productId).map(async (work) => ({ productId: work.productId, path: work.worktree!, sha: await git.head(work.worktree!) }))) : [],
    ]);
    // Tests: the command is asked for every agent process, so a test can tell a reopen attempt from the fresh start after it.
    const opened = await this.openAgentRun(scope, role, profile, worktree, signal, agent, {
      main: true, reviewKey: options.reviewKey, sessionId: (reopen ?? back)?.sessionId, reselect: back?.reselect,
      onStarting: () => {
        if (saved) return;
        this.k.say(scope, "system", `${role.name} joined · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
        this.k.log(scope, "milestone", `${role.name} started`, roleId, profileId);
      },
    });
    // A failed cross-round reopen may choose again without receiving any instructions.
    // Count only the startup that succeeded, so current notes stay current.
    repository.stepAttempts = (repository.stepAttempts ?? 0) + 1;
    if (reviewWork) reviewWork.attempts = (reviewWork.attempts ?? 0) + 1;
    const notBack = opened.reopenFailure;
    if (reopen && opened.reopenFailure) again = opened.reopenFailure;
    const { run } = opened;
    options.started?.();
    this.k.runs.set(taskId, run);
    // From the agent's start until its cleanup is over, the run counts on a later start only with that cleanup's record.
    const acceptanceCleanup = role.result === "checks" && task.acceptanceRun ? this.k.beginAcceptanceCleanup(task) : undefined;
    this.k.syncIdleSleep();
    if (!ADAPTERS[profile.toolId]?.usageReader?.liveSession) this.k.readUsage(profile.toolId);
    const picked = run.reopened !== undefined;
    const sandbox = this.sandboxState(scope, opened.off, roleId, profileId, picked);
    if (task.agent) task.agent.sandbox = sandbox;
    // Handing the same conversation back continues its work. A fresh conversation or a Petrina
    // restart is still another attempt, so neither can enter the timing history.
    if (picked && handback && same?.handbackBoot === this.k.boot && repository.stepAttempts > 1) repository.stepAttempts -= 1;
    const wentBack = picked && !reopen && back !== undefined;
    // A fix round records whether the Builder actually continued its own conversation, by result kind.
    if (role.result === "build" && task.fixing && !same) journeyStep.builderConversation = wentBack ? "resumed" : "new";
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
    // the old note; a reopened one keeps the open question until the conversation hears the answer, and the
    // readiness recheck it already spent until its participant completes a turn and saves its next continuation.
    const asked = picked ? reopen?.asked : undefined;
    const readinessWait = picked ? (reopen ?? back)?.readinessWait : undefined;
    if (role.result !== "delivery") {
      repository.conversation = { ...(this.repositoryCopies.get(worktree) ? { repositoryCopies: this.repositoryCopies.get(worktree) } : {}), step, roleId, profileId, role, access, ...(role.result === "build" ? { plannedProfileId: plannedId, builderTree: options.builderTree } : {}), toolId: profile.toolId, model, sessionId: run.sessionId, ...(head ? { head } : {}), startedAt, ...(asked ? { asked } : {}), ...(picked ? { briefed: true } : {}), ...(picked && same?.context ? { context: same.context } : {}), ...(picked && handback ? { handback } : {}), ...(picked && same?.capacityContinue ? { capacityContinue: true } : {}), ...(readinessWait ? { readinessWait } : {}) };
      const pending = screen?.member && task.hunt?.screenTurns?.[screen.member];
      // Keep the latest reopened or replacement conversation when this member yields to a peer.
      if (pending) pending.conversation = repository.conversation;
    }
    this.k.commitNow(scope);
    const headBefore = !role.canEdit ? head : undefined;
    const checkSettings = async (reply?: TurnResult, result?: T) => {
      const maintenance = task.maintenance;
      if (maintenance?.role.id !== roleId || !run.lastTurn) return;
      const notes = run.lastTurn;
      const model = notes.changed.model ?? notes.modelSeen ?? run.settings.model;
      const effort = notes.changed.effort ?? run.settings.effort;
      if (sameModel(profile.toolId, profile.modelId ?? profile.model, model) && effort === profile.effort && !notes.rerouted) return;
      if (!role.canEdit && headBefore) {
        const status = await git.worktreeStatus(worktree);
        if (status.head !== headBefore || !status.clean) maintenance.readOnlyWrites = true;
      }
      const requested = `${profile.model} · ${profile.effort} effort`;
      const actual = `${model ?? "unconfirmed model"} · ${effort ?? "unconfirmed effort"} effort`;
      const stageId = task.plan!.stages[task.stageIndex]!.id;
      if (reply) {
        maintenance.pendingReply = { stageId, text: reply.text, stopReason: reply.stopReason, ...(reply.streamed ? { streamed: true } : {}) };
        delete maintenance.pendingResult;
      } else maintenance.pendingResult = { stageId, value: result };
      maintenance.settingsDecision = { requested, actual, at: Date.now() };
      this.k.pauseStep(task);
      task.state = "needs-you"; task.holdsSlot = false; delete task.agent;
      task.statusLine = "The tool reported different settings. Choose whether to keep or stop this run.";
      this.k.s.inbox.push({ id: `maintenance-settings-${task.id}`, taskId: task.id, kind: "maintenance-settings", title: "Unexpected maintenance agent settings", body: `Requested: ${requested}\nReported: ${actual}\nKeeping this run accepts the work as produced. Delivery still needs its usual checks and approval. The routine keeps its saved profile.`, at: Date.now(), blocking: true });
      this.k.commitNow(task);
      throw new Aborted();
    };
    try {
      if (task.maintenance?.role.id === roleId) {
        const confirmed = run.settings;
        if (confirmed.model !== (profile.modelId ?? profile.model) || confirmed.effort !== profile.effort) throw new MaintenanceProfileProblem(`The maintenance profile could not be confirmed. Requested ${profile.model} at ${profile.effort}; reported ${confirmed.model ?? "no model"} at ${confirmed.effort ?? "no effort"}. Check the tool settings, then retry this run. No maintenance instructions were sent.`);
      }
      // The last moment to notice a pause before the agent gets any work.
      if (signal.aborted || !live()) throw new Aborted();
      let openingMessages: ReturnType<typeof takeMessages> = [];
      const withBackground = async (): Promise<Section[]> => {
        const sections = [...currentStepAssignment(task, roleId), ...await given(), ...(repository.prBackground ? [{ title: "Pull request background", body: pullRequestBackground(repository.prBackground) }] : [])];
        // A fresh start hears the step's earlier attempts in a section of its own; a return continues the conversation that heard them.
        openingMessages = this.reserveOpening(scope, sections, options.member, true);
        return sections;
      };
      // Why this conversation is fresh rather than the saved one, when Petrina recorded a reason.
      const freshReason = wentBack || picked ? undefined : back ? (notBack ?? "the tool did not reopen the earlier conversation") : !saved && offered ? options.freshReason ?? "the tool or model changed since the earlier conversation" : saved ? again : options.freshReason;
      let pending: PendingInput | undefined;
      let opening: string;
      if (wentBack) {
        // Its job as it stands now and the context, from the same sections a fresh conversation gets.
        const givenSections = [...await withBackground(), ...(back?.continuedSections ?? [])];
        const previous = back?.context ?? (repository.builderSession?.sessionId === run.sessionId ? repository.builderSession.context : undefined);
        const prepared = await this.prepareTurnPrompt(scope, role, run.sessionId, givenSections, repository.conversation, {
          packet: role.result === "build" || options.designContext || options.reviewContext,
          previous, design: options.designContext, knownSections: back?.knownSections,
          findings: options.reviewFindings,
        });
        const sections = prepared.sections;
        opening = continuePrompt({ task: repositoryView(scope), product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.usableProfiles(), worktree, branch: repository.branch ?? "planning", base: repository.baseSha ?? repository.base ?? "", defaultBranch: repository.source?.start.branch ?? product.defaultBranch ?? "main", access, sections, ...(screenWords ? { screen: screenWords } : {}) }, { refreshRole: prepared.refreshRole, recordJob: (job, supplied) => { pending = this.recordJourneyInput(scope, roleId, profileId, sections, "continued", options.requestedProfileId ?? plannedId, options.selectionReason, options.reviewerKey, run.settings, job, { supplied, omitted: prepared.omitted, sessionId: run.sessionId, ...(options.place !== undefined ? { place: options.place } : {}), ...(options.readiness ? { readiness: options.readiness } : {}) }); } });
      } else if (picked) {
        // One line about the restart (or the hand back, or that it may now use the screen), then only what the conversation
        // has not heard: the answer to its open question, and messages still in line.
        const answer = asked?.answer !== undefined ? { question: asked.question, text: asked.answer } : undefined;
        if (repository.conversation) {
          delete repository.conversation.asked;
          delete repository.conversation.handback;
        }
        const capacityContinue = !!repository.conversation?.capacityContinue && !handback && !forScreen;
        if (repository.conversation?.capacityContinue) {
          delete repository.conversation.capacityContinue;
          const sessionId = repository.conversation.sessionId;
          this.forgetCapacityResume(task, (entry) => entry.sessionId === sessionId);
        }
        opening = handback ? handBackPrompt(handback, []) : forScreen ? screenPrompt(forScreen.reason, []) : capacityContinue ? capacityContinuePrompt() : restartPrompt(where!, { ...(answer ? { answer } : {}), messages: [] });
        const sections = [...currentStepAssignment(task, roleId), ...(repository.prBackground ? [{ title: "Refreshed pull request background", body: pullRequestBackground(repository.prBackground) }] : [])];
        pending = this.recordJourneyInput(scope, roleId, profileId, sections, "continued", options.requestedProfileId ?? plannedId, options.selectionReason, options.reviewerKey, run.settings, opening, { sessionId: run.sessionId, resumed: true, ...(options.place !== undefined ? { place: options.place } : {}), ...(options.readiness ? { readiness: options.readiness } : {}) });
        opening += sections.map(({ title, body }) => `\n\n## ${title}\n${body}`).join("");
      } else {
        // Starting the step again: everything the coordinator said in it so far, in order, and after a restart, where it was.
        const files = where && !handback && head && worktree ? await git.changedSince(worktree, head) : [];
        if (signal.aborted || !live()) throw new Aborted();
        let sections = await withBackground();
        const earlier = repository.stepAttempts > 1 ? ((task.stepNotes ?? []) as StepNote[]).filter(note => backgroundMessage(task, note.id, options.member)) : [];
        if (earlier.length) this.k.log(scope, "you", `Handed on ${earlier.length} thing${earlier.length === 1 ? "" : "s"} you said in an earlier attempt at this step`, roleId, profileId);
        if (options.copy) sections.push({ title: OWN_COPY, body: ownCopy(head ?? "") });
        // A fresh replacement still needs the recovery reminder when every note is
        // waiting for delivery in the opening's separate instruction section.
        if (repository.stepAttempts > 1 && task.stepNotes?.length) sections.push({ title: EARLIER_ATTEMPT, body: formatStepNotes(earlier) });
        if (handback) sections.push({ title: HANDED_BACK, body: formatHandBack(handback, again ?? "") });
        else if (where && tookOver) sections.push({ title: TOOK_OVER, body: formatTakeOver({ ...where, files }, this.k.named(tookOver.id), this.lastWords(scope, roleId, tookOver.id, startedAt), refusal) });
        else if (where) sections.push({ title: forScreen ? WHERE_YOU_WERE_SCREEN : WHERE_YOU_WERE, body: formatWhereYouWere({ ...where, files }, again ?? "", forScreen ? "screen" : "restart") });
        if (role.result === "findings" || (role.result === "build" || options.designContext || options.reviewContext) && repository.conversation) {
          sections = (await this.prepareTurnPrompt(scope, role, run.sessionId, sections, repository.conversation, { packet: true, findings: options.reviewFindings })).sections;
        }
        opening = buildPrompt({ task: repositoryView(scope), product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.usableProfiles(), worktree: workingCopy, branch: repository.branch ?? "planning", base: repository.baseSha ?? repository.base ?? "", defaultBranch: repository.source?.start.branch ?? product.defaultBranch ?? "main", access, sections, ...(screenWords ? { screen: screenWords } : {}) }, (job, supplied) => { pending = this.recordJourneyInput(scope, roleId, profileId, sections, "fresh", options.requestedProfileId ?? plannedId, options.selectionReason, options.reviewerKey, run.settings, job, { supplied, ...(freshReason ? { freshReason } : {}), sessionId: run.sessionId, ...(options.place !== undefined ? { place: options.place } : {}), ...(options.readiness ? { readiness: options.readiness } : {}) }); });
      }
      if (screen) screen.heard = true;
      // What it is about to hear is on disk first: a restart after this does not hand it over again.
      if (signal.aborted || !live()) throw new Aborted();
      this.k.commitNow(scope);
      // A reopened conversation carries on after the interruption; a fresh one gets its first instructions.
      const askScreen = options.member ? (reason: string) => this.saveScreenTurn(scope, role, profile, options.member!, worktree, repository.conversation, reason) : undefined;
      const result = await this.converse(scope, run, agent, opening, picked && !wentBack ? "continue" : "first", role, profileId, schema, signal, { ...options, main: !options.copy, openingMessages, beforeContinue: checkSettings, ...(askScreen ? { askScreen } : {}), pendingInput: () => pending });
      await checkSettings(undefined, result);
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
      // Undone commits and tracked edits are saved first, so an acceptance run never counts on the restored product.
      await completeAll([
        ...protectedCopies.map(async (copy) => {
          const state = await git.worktreeStatus(copy.path);
          const commits = state.head !== copy.sha;
          await this.k.noteRestoredAcceptance(scope, role, copy.productId, copy.path, copy.sha, { commits, edits: state.trackedChanged });
          if (commits) await git.resetTo(copy.path, copy.sha);
          if (!state.clean) await git.discardChanges(copy.path);
          const why = role.canEdit ? `which may change only ${this.k.productLabel(repository.productId)} in this step` : "which is read-only";
          if (commits) this.k.log(scope, "warn", `Undid commits in ${this.k.productLabel(copy.productId)} from ${role.name}, ${why}`);
          if (state.trackedChanged) this.k.log(scope, "warn", `Undid changes in ${this.k.productLabel(copy.productId)} from ${role.name}, ${why}`);
        }),
        // A read-only role leaves its primary copy as found, including commits and tracked changes.
        ...(!role.canEdit && headBefore ? [(async () => {
          const state = await git.worktreeStatus(worktree);
          if (task.maintenance?.role.id === roleId && (state.head !== headBefore || !state.clean)) task.maintenance.readOnlyWrites = true;
          await this.k.noteRestoredAcceptance(scope, role, repository.productId, worktree, headBefore, { commits: state.head !== headBefore, edits: state.trackedChanged });
          if (state.head !== headBefore) {
            await git.resetTo(worktree, headBefore);
            this.k.log(scope, "warn", `Undid commits from ${role.name}, which is read-only`);
          }
          if (!state.clean) {
            await git.discardChanges(worktree);
            this.k.log(scope, "warn", `Undid changes from ${role.name}, which is read-only`);
          }
        })()] : []),
      ]);
      // Its undone changes, if any, are saved; a close since the last save keeps them in the cleanup's record.
      if (acceptanceCleanup) this.k.endAcceptanceCleanup(scope, acceptanceCleanup);
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
    options: ConversationOptions & { check?: Check<T>; used?: (profileId: Id) => void; room?: (toolId: Id, profile: AgentProfile) => boolean; seat?: Id; selectionReason?: string; reviewerKey?: string; seats?: readonly string[]; key?: string; member?: string; agent?: ActiveAgent; refresh?: boolean } = {},
  ): Promise<T> {
    const { task } = scope;
    if (!this.k.role(roleId, task) || !this.k.productOf(scope) || !(task.maintenance?.profile.id === plannedId || this.k.profile(plannedId))) throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
    if (signal.aborted) throw new Aborted();
    const key = options.key ?? `${roleId}:${plannedId}`;
    let role = task.hunt?.roles?.[key];
    // Out of usage: a stand-in looks at the change instead, told what the first one had said. With none, the
    // group (not this agent) makes the task wait: the others carry on, and this one is left for later.
    let stopped: { profileId: Id; error: UsageLimited | ModelAtCapacity; at: number } | undefined;
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
      // The reserved seat's words belong to its first attempt. Every later choice replaces both, even with none,
      // so a stand-in never repeats why the first start was fresh.
      let selectionReason = options.selectionReason;
      let freshReason = options.freshReason;
      let readiness = options.readiness;
      if (accepted) profile = accepted;
      else {
        const choice = this.k.choose(plannedId, scope, roleId, options.room, options.reviewerKey);
        if (!choice) throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
        if (choice.kind === "none") {
          // A member adds no place for a readiness check: the check starts or is joined, and the group waits as usual.
          if (choice.readiness && !this.k.admissionsClosed) void this.k.readiness.resolve(choice.readiness);
          // The group waits. A full model is not a usage limit: peers finish, and this seat stays for the same profile.
          // When the account is out as well, the wait is that limit's.
          if (stopped?.error instanceof ModelAtCapacity) {
            this.prepareCapacityRetry(scope, roleId, stopped.profileId, stopped.error, options.member);
            throw waitingFor(choice.waiting);
          }
          // The group waits, and this agent is started again after: that attempt is a retry.
          if (stopped) this.k.tracking.owesRetry(scope, roleId, plannedId);
          throw new WaitingForUsage(choice.waiting);
        }
        profile = choice.profile;
        selectionReason = choice.reason;
        freshReason = choice.freshReason;
        readiness = choice.readiness;
      }
      if (stopped?.error instanceof ModelAtCapacity && (stopped.profileId === profile.id || sameCapacityModel(stopped.error, profile))) {
        this.prepareCapacityRetry(scope, roleId, stopped.profileId, stopped.error, options.member);
        throw new WaitingForCapacity(this.capacityWords(scope, stopped.profileId));
      }
      // Every new choice, including after a failed cross-round reopen, must fit this member's seat.
      if (!accepted && options.room && !options.room(profile.toolId, profile)) {
        const tool = this.k.s.tools.find((entry) => entry.id === profile.toolId)?.name ?? profile.toolId;
        if (stopped && !(stopped.error instanceof ModelAtCapacity)) this.k.tracking.owesRetry(scope, roleId, plannedId);
        throw new WaitingForUsage(`Waiting for a free ${tool} slot`);
      }
      if (stopped && stopped.profileId === profile.id) throw stopped.error;
      this.k.tracking.attempt(scope, roleId, plannedId, profile, stopped !== undefined);
      if (!role) {
        role = structuredClone(this.k.role(roleId, task)!);
        if (task.hunt) {
          task.hunt.roles = { ...task.hunt.roles, [key]: role };
          this.k.commitNow(scope);
        }
      }
      options.used?.(profile.id);
      const previous = task.hunt?.work?.[key];
      const work = {
        ...previous,
        attempts: previous?.attempts ?? 0,
        clock: previous?.clock ? resumeClock(previous.clock, Date.now()) : startClock(repositoryView(scope), roleId, Date.now()),
      };
      delete work.waiting;
      task.hunt!.work = { ...task.hunt!.work, [key]: work };
      const active = [task.agent, ...(task.helpers ?? [])].find((agent) => agent?.reviewKey === key);
      if (active) active.profileId = profile.id;
      this.k.showReviewWork(task);
      this.k.commitNow(scope);
      const since = Date.now();
      try {
        return await this.attemptTogether(scope, role, profile, copy, given, schema, signal, { ...options, key, refresh, plannedId, selectionReason, freshReason, readiness, member: options.member ?? key, ...(stopped ? { took: { from: this.k.named(stopped.profileId), words: this.lastWords(scope, roleId, stopped.profileId, stopped.at), ...(stopped.error instanceof ModelAtCapacity ? { refusal: "the selected model is at capacity" } : stopped.error.retry ? { refusal: stopped.error.reason } : {}) } } : {}) });
      } catch (error) {
        if (signal.aborted) throw error;
        if (this.discardUnavailableParticipant(scope, roleId, error, options.reviewerKey)) continue;
        if (error instanceof ModelAtCapacity) {
          refresh = true;
          work.clock = pauseClock(work.clock, Date.now());
          // This member stopped working: a peer's retry no longer says the others continue.
          this.k.showReviewWork(task);
          this.keepWords(scope, roleId, profile.id, error);
          // Peers keep working. The group waits only once this member's short retries, or its stand-in, are exhausted.
          if (this.deferCapacity(scope, roleId, profile.id, error, plannedId, options.member)) throw new WaitingForCapacity(this.capacityWords(scope, profile.id));
          stopped = { profileId: profile.id, error, at: since };
          continue;
        }
        if (!(error instanceof UsageLimited)) throw error;
        refresh = true;
        // This member has stopped, even while its peers keep working. A stand-in resumes its clock.
        work.clock = pauseClock(work.clock, Date.now());
        this.k.showReviewWork(task);
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
  private async attemptTogether<T>(scope: RepositoryContext, role: Role, profile: AgentProfile, copy: string, given: Given, schema: z.ZodType<T>, signal: AbortSignal, options: ConversationOptions & { key: string; check?: Check<T>; member: string; plannedId: Id; selectionReason?: string; reviewerKey?: string; seats?: readonly string[]; took?: { from: string; words: string; refusal?: string }; agent?: ActiveAgent; refresh?: boolean }): Promise<T> {
    const { task, work: repository } = scope;
    await holdUnconfirmed(this.k, scope, options.member, signal, options.key);
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
    const journeyStep = beginAgentStep(task, journeyRole, profileId, Date.now(), this.k.s.roles, [...new Set([...team, profileId])], repository);
    // The step expects a result from every planned position, whoever starts or stands in: a seat waiting for usage or a slot is still a seat.
    if (options.seats) journeyStep.seats = [...options.seats];
    if (role.result === "build") journeyStep.buildProductId = repository.productId;
    if (["findings", "votes"].includes(role.result) && task.hunt?.input) journeyStep.reviewInput = structuredClone(task.hunt.input);
    this.k.commit(scope);
    const agent: TurnAgent = { roleId, profile, waits: new WaitClock(), journeyId: journeyStep.id, agentSeat: options.reviewerKey ?? options.key ?? roleId };
    const offered = typeof options.resume === "function" ? await options.resume(profile, role) : options.resume;
    // A same-round capacity wait is not an older round's saved review. Reopen that conversation for a short continue.
    const held = !offered ? task.capacityResume?.find((entry) => entry.roleId === roleId && entry.profileId === profileId && entry.member === options.member) : undefined;
    const opened = await this.openAgentRun(scope, role, profile, copy, signal, agent, {
      main: false, reviewKey: options.key, sessionId: offered?.sessionId ?? held?.sessionId, reselect: offered?.reselect,
      onStarting: () => {
        if (options.took) {
          const words = `${role.name} on ${this.k.named(profileId)} took over from ${options.took.from}, which ${options.took.refusal ? `could not continue (${options.took.refusal})` : "ran out of usage"}`;
          this.k.say(scope, "system", words, roleId, profileId);
          this.k.log(scope, "milestone", words, roleId, profileId);
        } else {
          this.k.say(scope, "system", `${role.name} joined · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
          this.k.log(scope, "milestone", `${role.name} started`, roleId, profileId);
        }
      },
    });
    if (opened.reopenFailure) this.k.log(scope, "status", `Could not go back to its own review conversation (${opened.reopenFailure}), so it started fresh`, roleId, profileId);
    const { run, off } = opened;
    const work = task.hunt?.work?.[options.key];
    if (work) work.attempts = (work.attempts ?? 0) + 1;
    options.started?.();
    const wentBack = offered !== undefined && run.reopened !== undefined;
    const capacityBack = held !== undefined && run.reopened !== undefined;
    if (held) this.forgetCapacityResume(task, (entry) => entry.roleId === roleId && entry.profileId === profileId && entry.member === options.member);
    if (wentBack) this.k.log(scope, "status", "Went back to its own review conversation from the previous round", roleId, profileId);
    // Its group's record of it, shown in the header or among the helpers, says whether it is sandboxed.
    const sandbox = this.sandboxState(scope, off, roleId, profileId);
    if (options.agent) options.agent.sandbox = sandbox;
    this.k.commit(scope);
    const runs = this.k.helperRuns.get(taskId) ?? new Set();
    this.k.helperRuns.set(taskId, runs.add(run));
    this.k.syncIdleSleep();
    if (!ADAPTERS[profile.toolId]?.usageReader?.liveSession) this.k.readUsage(profile.toolId);
    const head = await git.head(copy).catch(() => undefined);
    try {
      if (signal.aborted || !this.k.task(taskId)) throw new Aborted();
      const givenSections = [...currentStepAssignment(task, roleId), ...await given(), ...(wentBack ? offered?.continuedSections ?? [] : []), ...(repository.prBackground ? [{ title: "Pull request background", body: pullRequestBackground(repository.prBackground) }] : []), { title: OWN_COPY, body: ownCopy(head ?? "") }];
      // A parallel opening has no earlier-attempt section: a fresh one keeps the step's heard guidance as background.
      const openingMessages = this.reserveOpening(scope, givenSections, options.member, wentBack);
      if (signal.aborted) throw new Aborted();
      if (options.took) givenSections.push({ title: TOOK_OVER, body: formatReviewTakeOver(options.took.from, options.took.words, options.took.refusal) });
      const note: ConversationNote = { ...(this.repositoryCopies.get(copy) ? { repositoryCopies: this.repositoryCopies.get(copy) } : {}), step: stepKey(task), roleId, profileId, role, access: { canEdit: role.canEdit }, toolId: profile.toolId, model: profile.modelId ?? profile.model, sessionId: run.sessionId, ...(head ? { head } : {}), startedAt: Date.now(), briefed: true };
      const prepared = await this.prepareTurnPrompt(scope, role, run.sessionId, givenSections, note, { packet: options.reviewContext, previous: wentBack ? offered?.context : undefined, findings: options.reviewFindings, supplyHistory: !capacityBack });
      const sections = prepared.sections;
      const promptContext = { task: repositoryView(scope), product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.usableProfiles(), worktree: copy, branch: repository.branch ?? "planning", base: repository.baseSha ?? repository.base ?? "", defaultBranch: repository.source?.start.branch ?? product.defaultBranch ?? "main", sections };
      let pending: PendingInput | undefined;
      const freshReason = wentBack || capacityBack ? undefined : offered || held ? (opened.reopenFailure ?? "the earlier review conversation was not reopened") : options.freshReason;
      const recordJob = (job: string, supplied: readonly Section[]) => { pending = this.recordJourneyInput(scope, roleId, profileId, sections, wentBack ? "continued" : "fresh", options.plannedId, options.selectionReason, options.reviewerKey, run.settings, job, { supplied, omitted: prepared.omitted, ...(freshReason ? { freshReason } : {}), sessionId: run.sessionId, ...(options.place !== undefined ? { place: options.place } : {}), ...(options.readiness ? { readiness: options.readiness } : {}) }); };
      const continued = capacityContinuePrompt();
      const opening = capacityBack ? [continued, ...currentStepAssignment(task, roleId).map(({ title, body }) => `## ${title}\n${body}`)].join("\n\n") : wentBack ? continuePrompt(promptContext, { refreshRole: prepared.refreshRole, recordJob }) : buildPrompt(promptContext, recordJob);
      if (capacityBack) pending = this.recordJourneyInput(scope, roleId, profileId, currentStepAssignment(task, roleId), "continued", options.plannedId, options.selectionReason, options.reviewerKey, run.settings, continued, { sessionId: run.sessionId, resumed: true, ...(options.place !== undefined ? { place: options.place } : {}), ...(options.readiness ? { readiness: options.readiness } : {}) });
      const result = await this.converse(scope, run, agent, opening, capacityBack ? "continue" : "first", role, profileId, schema, signal, {
        ...options,
        main: false,
        openingMessages,
        reviewKey: options.key,
        askScreen: (reason) => this.saveScreenTurn(scope, role, profile, options.member, copy, note, reason),
        pendingInput: () => pending,
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
  private async converse<T>(scope: RepositoryContext, run: AgentRun, agent: TurnAgent, opening: string, reason: TurnReason, role: Role, profileId: Id, schema: z.ZodType<T>, signal: AbortSignal, options: { check?: Check<T>; main: boolean; openingMessages?: ReturnType<typeof takeMessages>; member?: string; askScreen?: (reason: string) => boolean; reviewKey?: string; reviewerKey?: string; beforeContinue?: (reply: TurnResult) => Promise<void>; pendingInput?: () => PendingInput | undefined }): Promise<T> {
    const messages = options.main || options.member ? new MessageTurn(this.k, scope, run, agent.profile, role.id, options.member, options.reviewerKey, signal) : undefined;
    messages?.start();
    try { return await this.conversation(scope, run, agent, opening, reason, role, profileId, schema, signal, options, messages); }
    finally { messages?.dispose(); }
  }

  private async conversation<T>(scope: RepositoryContext, run: AgentRun, agent: TurnAgent, opening: string, reason: TurnReason, role: Role, profileId: Id, schema: z.ZodType<T>, signal: AbortSignal, options: { check?: Check<T>; main: boolean; openingMessages?: ReturnType<typeof takeMessages>; member?: string; askScreen?: (reason: string) => boolean; reviewKey?: string; reviewerKey?: string; beforeContinue?: (reply: TurnResult) => Promise<void>; pendingInput?: () => PendingInput | undefined }, messages?: MessageTurn): Promise<T> {
    const { task, work: repository } = scope;
    const by = { roleId: role.id, profileId };
    // Every message to the agent and the reply it waits for is one entry in the work log.
    let previousReply: TurnResult | undefined;
    let pendingOpening: string | undefined;
    let inputAttached = false;
    const send = async (text: string, why: TurnReason, reserved?: ReturnType<typeof takeMessages>) => {
      if (signal.aborted) throw new Aborted();
      if (previousReply) await options.beforeContinue?.(previousReply);
      if (pendingOpening) { text = `${pendingOpening}\n\n${text}`; pendingOpening = undefined; }
      // Reserve at the handoff, after context preparation. Background deduplication must
      // never stand in for delivery, including for notes arriving while context was built.
      const batch = reserved ?? [...(!inputAttached ? options.openingMessages ?? [] : []), ...(options.main || options.member ? takeMessages(task, options.member, inputAttached ? 12_000 : Infinity) : [])];
      // Stop-and-send can arrive ahead of an opening reservation while its packet is saved.
      batch.sort((a, b) => task.queued.findIndex(message => message.id === a.id) - task.queued.findIndex(message => message.id === b.id));
      const instructions = batch.length ? { title: "Messages from the coordinator, in order", body: batch.map((message, index) => `${index + 1}. ${message.text}`).join("\n") } : undefined;
      if (instructions) text += `\n\n## ${instructions.title}\n${instructions.body}\n\nTake all of them into account. When you are done, end with the result block again.`;
      // The exact text goes to disk once, and the journey keeps its reference, before the agent hears it.
      if (!inputAttached) {
        // Same-step reopens record this send below as an update; fresh starts and
        // returns to earlier conversations show its instructions in the opening sections.
        await this.attachInput(scope, options.pendingInput?.(), text, [...(browser ? [{ title: "Browser instructions", body: browser }] : []), ...(instructions ? [instructions] : [])], why === "first" && instructions ? [instructions] : []);
        inputAttached = true;
      }
      if (why !== "first") {
        const step = openStep(task);
        if (step?.kind === "agent") {
          let input = step.agentInputs?.findLast(entry => entry.roleId === role.id && entry.profileId === profileId && entry.reviewerKey === options.reviewerKey);
          if (!input) {
            input = { at: Date.now(), roleId: role.id, profileId, ...(options.reviewerKey !== undefined ? { reviewerKey: options.reviewerKey } : {}), taskTitle: task.title, mode: "continued", sections: [], sessionId: run.sessionId };
            step.agentInputs = [...(step.agentInputs ?? []), input];
          }
          const exact = await saveExactMessage(this.k.dataDir, task.id, text);
          if (signal.aborted) throw new Aborted();
          input.updates = [...(input.updates ?? []), { at: Date.now(), reason: why, text, ...(exact ? { exact } : {}) }];
          this.k.commitNow(scope);
        }
      }
      let reply: TurnResult;
      try {
        messages?.preparePrompt(batch);
        reply = await this.k.tracking.turn(scope, agent, run, text, why, signal);
      } catch (error) {
        // The turn can stop before this conversation is marked briefed. A full model still has to be reopenable.
        if (error instanceof ModelAtCapacity && options.main) this.briefed(scope);
        throw error;
      }
      await messages?.settled(reply);
      previousReply = reply;
      return reply;
    };
    const sendQueued = (batch: ReturnType<typeof takeMessages>) => {
      return send("Continue with the coordinator's instructions below.", "message", batch);
    };
    const mayAsk = mayAskScreen(role);
    const browser = run.browser ? (run.reopened ? `Browser capture folder for this turn: ${run.browser.directory}. Earlier pages and browser logins are gone; the same browser and output rules apply.` : browserPrompt(run.browser.directory)) : undefined;
    const pending = task.maintenance?.role.id === role.id && task.maintenance.settingsDecision?.choice === "keep" ? task.maintenance.pendingReply : undefined;
    const accepted = pending?.stageId === task.plan?.stages[task.stageIndex]?.id ? pending : undefined;
    const replayedReply: TurnResult | undefined = accepted ? { ...accepted, changed: {}, rerouted: false, helpers: 0 } : undefined;
    let reply = replayedReply ?? await send(browser ? `${opening}\n\n${browser}` : opening, reason);
    if (accepted) {
      delete task.maintenance!.pendingReply;
      if (!run.reopened) pendingOpening = browser ? `${opening}\n\n${browser}` : opening;
    }
    // A replacement has not heard its opening yet when it is only replaying an older reply.
    if (options.main && (!accepted || run.reopened)) this.briefed(scope);
    for (let repairs = 0; ; ) {
      if (signal.aborted) throw new Aborted();
      // The whole ending is the tool's capacity stop, with no finished result after it. Do not ask for a repair.
      const fullText = ADAPTERS[agent.profile.toolId]?.interruptions?.capacity?.(reply.text, reply.text);
      if (fullText) {
        const full = new ModelAtCapacity(agent.profile.toolId, agent.profile.modelId ?? agent.profile.model, profileId, run.sessionId);
        if (fullText.retryAfterMs !== undefined) full.retryAfterMs = fullText.retryAfterMs;
        full.said = reply.text;
        full.streamed = reply.streamed;
        if (options.main) this.briefed(scope);
        throw full;
      }
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
      if (parsed.ok !== true || reply.stopReason === "cancelled") await options.beforeContinue?.(reply);
      if ((options.main || options.member) && current.queued.length) await options.beforeContinue?.(reply);
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
          this.k.commitNow(scope);
          throw new ScreenWait();
        }
        // Given at once, in this conversation: the agent keeps its slot.
        await holdUnconfirmed(this.k, scope, options.member, signal, options.reviewKey);
        current.screen!.heard = true;
        this.k.commitNow(scope);
        reply = await send(screenPrompt(current.screen!.reason, []), "continue");
        continue;
      }
      // Keeping a saved question accepts that question, even when instructions are waiting.
      const heldQuestion = reply === replayedReply && parsed.ok === "input";
      const batch = !heldQuestion && (options.main || options.member) ? takeMessages(current, options.member) : [];
      if (batch.length) {
        reply = await sendQueued(batch);
        continue;
      }
      if (reply.stopReason === "cancelled") {
        await holdUnconfirmed(this.k, scope, options.member, signal, options.reviewKey);
        reply = await send("Continue where you left off. When you are done, end with the result block.", "continue");
        continue;
      }
      if (parsed.ok === "input") {
        this.k.say(scope, "agent", parsed.question, role.id, profileId);
        this.k.log(scope, "warn", `Asked you: ${parsed.question}`, role.id, profileId);
        const answer = await this.wait(scope, "question", parsed.question, true, { options: parsed.options }, signal, "Waiting for your answer", by, options.main, options.reviewKey);
        await holdUnconfirmed(this.k, scope, options.member, signal, options.reviewKey);
        // Heard from here on: a restart does not hand the answer over again.
        const note = repository.conversation;
        if (note && (options.main || (note.roleId === role.id && note.profileId === profileId))) delete note.asked;
        this.k.commitNow(scope);
        reply = await send(`${heldQuestion ? `Question: ${parsed.question}\n\n` : ""}The coordinator answered: ${answer}\n\nContinue. When you are done, end with the result block.`, "answer");
        continue;
      }
      await holdUnconfirmed(this.k, scope, options.member, signal, options.reviewKey);
      // A recovery decision may explicitly authorize resending. It must reach this
      // participant before its earlier result can finish the step.
      const recovered = options.main || options.member ? takeMessages(current, options.member) : [];
      if (recovered.length) {
        reply = await sendQueued(recovered);
        continue;
      }
      let error: string | undefined;
      if (reportLine) this.k.pendingReportIds.add(reportLine.id);
      try {
        error = parsed.ok === true ? await options.check?.(parsed.value) : parsed.ok === "screen" ? NO_SCREEN_HERE : parsed.error;
        if (parsed.ok === true && !error) {
          // Validation may await I/O. Notes arriving during it still reach this agent before its result is accepted.
          if ((options.main || options.member) && current.queued.length) await options.beforeContinue?.(reply);
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
            if (images.length && !run.browser) throw new Error("This role has no browser capture folder. Omit pictures from this result.");
            saved = run.browser ? await preserveCaptures(run.browser.directory, storage, images, signal) : [];
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
              if ((options.main || options.member) && current.queued.length) await options.beforeContinue?.(reply);
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
              const inputIndex = step?.agentInputs?.findLastIndex((input) => input.roleId === role.id && input.profileId === profileId && input.reviewerKey === options.reviewerKey) ?? -1;
              if (step) step.agentResults = [...(step.agentResults ?? []), { roleId: role.id, profileId, productId: scope.work.productId, at: finishedAt, value: parsed.value, ...(inputIndex >= 0 ? { inputIndex } : {}), ...(saved.length ? { images: saved } : {}) }];
              // The result ends the agent's work. Saving its pictures is Petrina's time.
              if (options.main) this.k.pauseStep(current, finishedAt);
              const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
              if (work?.clock) work.clock = pauseClock(work.clock, finishedAt);
              // Durable references are saved before the agent stops or its working copy is cleaned.
              this.k.commitNow(scope);
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
      await options.beforeContinue?.(reply);
      repairs += 1;
      if (repairs > 2) throw new Error(`${role.name} did not hand back a usable result: ${error}`);
      this.k.tracking.redo(current, role.id, agent.profile);
      reply = await send(repairPrompt(error ?? ""), "redo");
    }
  }

  /** Shared startup, callbacks and reopen fallback for main turns and parallel members. */
  private async openAgentRun(scope: RepositoryContext, role: Role, profile: AgentProfile, cwd: string, signal: AbortSignal, agent: TurnAgent,
    options: { main: boolean; reviewKey?: string; sessionId?: string; reselect?: boolean; onStarting?: () => void }): Promise<{ run: AgentRun; off?: string; reopenFailure?: string }> {
    const { task } = scope, roleId = role.id, profileId = profile.id;
    const callbacks = {
      onMessage: this.messageStream(scope, roleId, profileId, signal, options.main),
      onActivity: () => {},
      onToolActivity: (event: ToolActivityEvent) => {
        const current = this.k.task(task.id);
        if (!current || (signal.aborted && event.turnEndedAt === undefined)) return;
        if (options.main && event.invocation) this.briefed(scope);
        const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
        const summary = recordToolActivity(current, agent.journeyId, { seat: options.reviewKey ?? agent.agentSeat ?? roleId, roleId, profileId, productId: scope.work.productId }, event);
        if (!summary) return;
        const line = summary.runningTool?.description ?? "Continuing work";
        const active = current.state === "running" || current.state === "needs-you";
        if (work && active) {
          work.toolActivity = summary;
          work.activity = line;
          this.k.showReviewWork(current);
        } else if (options.main && active) {
          current.toolActivity = summary;
          // While the tool retries by itself, an update to an earlier call does not replace that status.
          if (current.state === "running" && !current.retrying) current.statusLine = line;
        }
        if (event.invocation) {
          const invocation = event.invocation;
          const existing = current.session.find(line => line.toolInvocationId === invocation.id);
          if (existing) existing.text = invocation.description;
          else if (event.isNew) this.k.say(scope, "activity", invocation.description, roleId, profileId, invocation.id);
        }
        this.k.commit(scope);
      },
      onPlanStep: (line: string) => {
        const current = this.k.task(task.id), text = plainTodo(line);
        if (!current || !text || signal.aborted) return;
        if (options.main) this.briefed(scope);
        if (current.state !== "running" && current.state !== "needs-you") return;
        const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
        if (!options.main && !work) return;
        if (work) {
          if (work.todo === text) return;
          work.todo = text;
          this.k.showReviewWork(current);
        } else {
          if (current.todo === text) return;
          current.todo = text;
        }
        if (!options.main || current.timeline.at(-1)?.text !== text) this.k.log(scope, "status", text, roleId, profileId);
        this.k.noteTodo(scope);
      },
      onRetrying: (report?: NativeRetryReport) => this.showRetrying(scope, role, profile, report, signal, options),
      onPermission: (info: PermissionInfo) => this.permission(scope, info, signal, { roleId, profileId }, agent.waits, options.reviewKey),
      onLog: (text: string) => void this.k.agentLog(task.id, text),
      onCleanupIncomplete: () => { if (this.k.task(task.id)) this.k.log(scope, "warn", CLEANUP_INCOMPLETE); },
      onUsage: (info: import("./usage.js").UsageInfo) => this.k.recordUsage(info),
      onAccountUsage: (reports: readonly import("./usage.js").UsageInfo[]) => this.k.recordAccountUsage(profile.toolId, reports),
    };
    // New, reopened and replacement conversations share the engine's browser folders and recovery.
    const browser = opensBrowser(role, this.k.options);
    const browserTempRoot = this.k.options.browserTempRoot;
    const start = (sessionId?: string) => this.inSandbox(profile, (sandbox) => {
      // Resolve the command for each process, including a fallback or sandbox retry.
      const command = this.k.options.agentCommand?.(profile);
      return AgentRun.start({ profile, ...(command ? { command } : {}), env: this.envFor(), ...(sandbox ? { sandbox } : {}),
        cwd, browser, browserRoot: join(this.k.dataDir, "browser-temp"), ...(browserTempRoot ? { browserTempRoot } : {}), signal,
        ...(sessionId ? { reopen: sessionId, ...(this.k.options.reopenTimeoutMs ? { reopenTimeoutMs: this.k.options.reopenTimeoutMs } : {}) } : {}),
        ...(this.k.options.startTimeoutMs ? { startTimeoutMs: this.k.options.startTimeoutMs } : {}), callbacks,
      });
    }).catch(async (error: unknown) => {
      if (sessionId !== undefined || signal.aborted || error instanceof SandboxUnavailable) throw error;
      throw await this.tools.problem(profile.toolId, error);
    });
    // Ordinary starts remain visible even when the tool fails to open. A cross-round
    // reopen is only a probe until it succeeds, and must not announce abandoned work.
    let announced = false;
    const announce = () => {
      if (announced || signal.aborted) return;
      announced = true;
      options.onStarting?.();
    };
    let reopenFailure: string | undefined;
    if (options.sessionId) {
      if (!options.reselect) announce();
      try {
        const opened = await start(options.sessionId);
        announce();
        return opened;
      } catch (error) {
        if (signal.aborted || !(error instanceof ReopenFailed)) throw error;
        if (options.reselect) throw new ParticipantUnavailable(`the tool could not reopen its saved conversation (${error.message})`);
        reopenFailure = error.message;
      }
    }
    announce();
    return { ...await start(), ...(reopenFailure ? { reopenFailure } : {}) };
  }

  private discardUnavailableParticipant(scope: RepositoryContext, roleId: Id, error: unknown, reviewerKey?: string): boolean {
    if (!(error instanceof ParticipantUnavailable)) return false;
    if (!discardParticipant(scope, this.k.role(roleId, scope.task)!, error.message, reviewerKey)) return false;
    const kind = this.k.role(roleId, scope.task)?.result === "findings" ? "review conversation" : "conversation";
    this.k.log(scope, "status", `Could not go back to its own ${kind}: ${error.message}. Choosing this seat again before sending instructions.`, roleId);
    this.k.commitNow(scope);
    return true;
  }

  /**
   * The agent's own tool says it is retrying the turn by itself, or (no report) that the retry is over. Petrina
   * only shows it: no prompt, no retry loop of its own and no capacity record. Only this agent's own run clears its status.
   */
  private showRetrying(scope: RepositoryContext, role: Role, profile: AgentProfile, report: NativeRetryReport | undefined, signal: AbortSignal, options: { main: boolean; reviewKey?: string }): void {
    const current = this.k.task(scope.task.id);
    if (!current || (report && signal.aborted)) return;
    const tool = this.k.s.tools.find((entry) => entry.id === profile.toolId)?.name ?? ADAPTERS[profile.toolId]?.name ?? profile.toolId;
    const words = report ? retryingWords(tool, report.cause) : undefined;
    const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
    const starting = words !== undefined && (work ? work.retrying : current.retrying) === undefined;
    if (work) {
      if (work.retrying === words) return;
      if (words) work.retrying = words;
      else delete work.retrying;
      this.k.showReviewWork(current);
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
    if (starting) this.k.log(scope, "warn", `${role.name}: ${words}`, role.id, profile.id);
    this.k.commit(scope);
  }

  /** Refresh removable notes, then reserve before an immutable packet can expose them. */
  private reserveOpening(scope: RepositoryContext, sections: Section[], member: string | undefined, earlierCarried: boolean): ReturnType<typeof takeMessages> {
    const index = sections.findIndex(section => section.title.startsWith("The coordinator's notes on this task"));
    if (index >= 0) sections.splice(index, 1, ...coordinatorNotes(scope, member, earlierCarried));
    const maintenance = scope.task.maintenance;
    if (maintenance?.pendingReply && maintenance.settingsDecision?.choice === "keep") return [];
    return takeMessages(scope.task, member, Infinity);
  }

  private async prepareTurnPrompt(scope: RepositoryContext, role: Role, sessionId: string, sections: Section[], note: ConversationNote | undefined,
    options: { packet?: boolean; previous?: BuilderContext; design?: boolean; knownSections?: readonly string[]; findings?: readonly import("@petrina/core").Finding[]; supplyHistory?: boolean }): Promise<{ sections: Section[]; refreshRole: boolean; omitted?: readonly { title: string; digest: string }[] }> {
    const prepared: Awaited<ReturnType<typeof builderContext>> = options.packet ? await builderContext(this.k.dataDir, repositoryView(scope), role, sessionId, sections, options.previous, { design: options.design, knownSections: options.knownSections, findings: options.findings }) : { sections };
    if (note && options.packet) {
      if (prepared.snapshot) note.context = prepared.snapshot;
      else delete note.context;
    }
    const supplied = options.supplyHistory === false ? { sections: prepared.sections } : await supplyReviewHistory(scope, prepared.sections, { continued: !!options.previous });
    if (supplied.retained) this.k.commitNow(scope);
    return { sections: supplied.sections, refreshRole: !options.previous || prepared.snapshot?.scope !== options.previous.scope, ...(prepared.omitted ? { omitted: prepared.omitted } : {}) };
  }

  private saveScreenTurn(scope: RepositoryContext, role: Role, profile: AgentProfile, member: string, copy: string, note: ConversationNote | undefined, reason: string): boolean {
    const { task, work: repository } = scope;
    if (!this.k.task(task.id)?.hunt || !note) return false;
    const conversation = structuredClone(note);
    task.hunt!.screenTurns = { ...task.hunt!.screenTurns, [member]: { reason, at: Date.now(), copy, conversation } };
    if (task.screen) this.k.log(scope, "status", SCREEN_WORDS.asked(reason), role.id, profile.id);
    const granted = !task.screen && this.k.askScreen(task, role.id, profile.id, reason, member);
    if (granted) repository.conversation = conversation;
    this.k.commitNow(scope);
    return granted;
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
    if (signal.aborted) throw new Aborted();
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
    if (kind === "question" && note && (main || owns)) this.k.commitNow(scope);
    else this.k.commit(scope);
    try {
      return await this.k.waitForReply(id, signal);
    } finally {
      if (work && !signal.aborted) {
        const pending = this.k.s.inbox.find((item) => item.taskId === task.id && item.blocking && item.reviewKey === reviewKey);
        if (pending) work.waiting = pending.kind === "permission" ? "Waiting for your permission" : "Waiting for your answer";
        else {
          delete work.waiting;
          if (work.clock) work.clock = resumeClock(work.clock, Date.now());
        }
        this.k.showReviewWork(task);
        this.k.commitNow(scope);
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

  /**
   * A full model retries the same conversation before anyone else takes the step.
   * True while short continues remain: the caller waits and reopens this conversation.
   * False once those continues are sent: the caller may hand the step on, or wait when a switch is not allowed.
   */
  private deferCapacity(scope: RepositoryContext, roleId: Id, profileId: Id, error: ModelAtCapacity, plannedId: Id, member?: string): boolean {
    const { task } = scope;
    const sameRetry = (entry: { roleId: Id; profileId: Id; member?: string }) => entry.roleId === roleId && entry.profileId === profileId && entry.member === member;
    const tried = task.capacityRetries?.find(sameRetry)?.tried ?? 0;
    const delay = capacityRetryDelay(tried, error.retryAfterMs);
    if (delay !== undefined) {
      const next = { toolId: error.toolId, modelId: error.modelId, profileId, roleId, tried: tried + 1, ...(member ? { member } : {}) };
      task.capacityRetries = [...(task.capacityRetries ?? []).filter((entry) => !sameRetry(entry)), next];
      // Set before the commit inside recordModelCapacity, so a schedule during that save cannot hand the step on.
      // plannedId is the step's original profile, so a replacement's short retry still holds that step.
      const pause = { toolId: error.toolId, modelId: error.modelId, profileId, roleId, plannedId, ...(member ? { member } : {}) };
      task.capacityPaused = [...(task.capacityPaused ?? []).filter((entry) => !sameRetry(entry)), pause];
      this.k.recordModelCapacity(task, roleId, profileId, error, delay);
      this.prepareCapacityRetry(scope, roleId, profileId, error, member);
      return true;
    }
    // The short continues are used up. Drop the hold so this choice can hand the step on, and keep the model
    // full so it does not start the five-second delay again.
    const paused = (task.capacityPaused ?? []).filter((entry) => !sameRetry(entry));
    if (paused.length) task.capacityPaused = paused;
    else delete task.capacityPaused;
    this.k.recordModelCapacity(task, roleId, profileId, error, Math.max(MODEL_CAPACITY_WAIT_MS, error.retryAfterMs ?? 0));
    return false;
  }

  /** Remember the full model and, when this conversation is the one that stopped, reopen it with a short continue. */
  private prepareCapacityRetry(scope: RepositoryContext, roleId: Id, profileId: Id, error: ModelAtCapacity, member?: string): void {
    const { task, work: repository } = scope;
    const profile = this.k.profile(profileId);
    const note = repository.conversation;
    const model = profile?.modelId ?? profile?.model;
    if (note && profile && note.roleId === roleId && note.profileId === profileId && note.toolId === profile.toolId && note.model === model) note.capacityContinue = true;
    if (error.sessionId && profile && model) {
      const next = { sessionId: error.sessionId, profileId, roleId, toolId: profile.toolId, model, ...(member ? { member } : {}) };
      const others = (task.capacityResume ?? []).filter((entry) => !(entry.roleId === roleId && entry.profileId === profileId && entry.member === member));
      task.capacityResume = [...others, next];
    }
  }

  /** Drop the saved resumes that match. Another reviewer working beside this one keeps its own. */
  private forgetCapacityResume(task: { capacityResume?: { sessionId: string; profileId: Id; roleId: Id; toolId: Id; model: string; member?: string }[] }, match: (entry: { sessionId: string; profileId: Id; roleId: Id; member?: string }) => boolean): void {
    const kept = (task.capacityResume ?? []).filter((entry) => !match(entry));
    if (kept.length) task.capacityResume = kept;
    else delete task.capacityResume;
  }

  /** What the task says while it waits to try this profile's model again. */
  private capacityWords(scope: RepositoryContext, profileId: Id): string {
    const { task } = scope;
    const profile = this.k.profile(profileId);
    const model = profile?.modelId ?? profile?.model;
    const until = task.modelCapacity?.find((entry) => entry.until > Date.now() && entry.toolId === profile?.toolId && entry.modelId === model)?.until ?? Date.now() + MODEL_CAPACITY_WAIT_MS;
    return capacityWaiting(until, Date.now());
  }

  /** The agent showed it has its instructions: from now on a restart may reopen its conversation. */
  private briefed(scope: RepositoryContext): void {
    const { work: repository } = scope;
    if (!repository.conversation || repository.conversation.briefed) return;
    repository.conversation.briefed = true;
    this.k.commitNow(scope);
  }
}
