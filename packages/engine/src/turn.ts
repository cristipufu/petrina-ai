import { ModelAtCapacity, UsageLimited } from "@petrina/agent-runtime/usage";
import {
  AgentMessages,
  immediateMessageClock,
  slotWait,
  takeMessages,
  type ActiveAgent,
  type AgentProfile,
  type BuilderContext,
  type ConversationNote,
  type Finding,
  type Id,
  type Role,
  type TurnReason,
} from "@petrina/core";
import {
  MaintenanceSettings,
  ModelCapacity,
  ParticipantInputs,
  repositoryView,
  TurnRecovery,
  type AgentMessage,
  type AgentSession,
  type RepositoryContext,
  type TurnResult,
} from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { z } from "zod";
import { builderContext } from "./builder-context.js";
import { coordinatorNotes, type Section } from "./context.js";
import type { ContextOmission } from "./coordinator-note-context.js";
import { saveExactMessage } from "./exact-input.js";
import { inputManifest, numberInputManifest } from "./input-manifest.js";
import {
  Aborted,
  Kernel,
  MaintenanceProfileProblem,
  ScreenWait,
  SourceRefreshRequired,
} from "./kernel.js";
import { lastWords, proseOf, type WhereYouWere } from "./prompts.js";
import { supplyReviewHistory } from "./review-history.js";
import { contractFor } from "./roles.js";
import type { Sources } from "./sources.js";
import type { ToolChecks } from "./tool-checks.js";
import type { TurnAgent } from "./tracking.js";
import { runTurnConversation, type TurnResultCheck as Check } from "./turn-conversation.js";
import {
  executeMainTurnAttempt,
  type ConversationOptions,
  type Given,
  type TurnAttemptCollaborators,
  type TurnOptions,
} from "./turn-main-attempt.js";
import { executeParallelTurnAttempt, type ParallelAttemptOptions } from "./turn-parallel-attempt.js";
import {
  buildWhereYouWere,
  discardUnavailableTurnParticipant,
  openTurnAgentRun,
  waitForCoordinatorReply,
  type CoordinatorReplyRequest,
  type OpenAgentRunOptions,
  type PendingInput,
} from "./turn-session.js";
import { capacityWaiting, WaitingForCapacity, waitingFor, WaitingForUsage } from "./usage.js";

// One agent working one step: opening or reopening its conversation, its instructions, the turns until
// it hands back a valid result, and what it asks the coordinator on the way.

export class Turns implements TurnAttemptCollaborators {
  readonly repositoryCopies = new Map<string, Readonly<Record<string, string>>>();
  readonly copyHeads = new Map<string, string>();
  readonly recovery: TurnRecovery;
  readonly maintenanceSettings: MaintenanceSettings;
  private readonly inputs: ParticipantInputs;

  constructor(
    readonly k: Kernel,
    readonly tools: ToolChecks,
    readonly sources: Sources,
  ) {
    this.inputs = new ParticipantInputs(
      {
        now: () => Date.now(),
        current: (scope) => k.task(scope.task.id) === scope.task,
        stopped: () => k.stopped,
        status: (scope, reason, roleId, profileId) => k.log(scope, "status", reason, roleId, profileId),
        checkpoint: (scope) => k.commitNow(scope),
        commit: (scope) => k.commit(scope),
        noteStream: (scope) => k.noteStream(scope),
        say: (scope, text, roleId, profileId, reviewerKey, record = true) =>
          k.participantSay(scope, "agent", text, roleId, profileId, reviewerKey, undefined, record),
        recordPublicText: (taskId, line, message) => k.store.publicText.append(taskId, line, message),
        briefed: (scope) => this.briefed(scope),
      },
      {
        clone: structuredClone,
        manifest: inputManifest,
        numberManifest: numberInputManifest,
        saveExact: (taskId, text) => saveExactMessage(k.dataDir, taskId, text),
      },
    );
    this.maintenanceSettings = new MaintenanceSettings(
      {
        now: () => Date.now(),
        pauseStep: (task) => k.pauseStep(task),
        addDecision: (item) => {
          k.s.inbox.push(item);
        },
        checkpoint: (task) => k.commitNow(task),
        aborted: () => new Aborted(),
        unconfirmed: (message) => new MaintenanceProfileProblem(message),
      },
      { readOnlyStatus: (worktree) => git.worktreeStatus(worktree) },
    );
    const capacity = new ModelCapacity({
      profile: (id) => k.profile(id),
      now: () => Date.now(),
      record: (task, roleId, profileId, error, waitMs) =>
        k.recordModelCapacity(task, roleId, profileId, error, waitMs),
      words: capacityWaiting,
    });
    this.recovery = new TurnRecovery(
      {
        now: () => Date.now(),
        catalog: {
          profile: (id) => k.profile(id),
          role: (id, task) => k.role(id, task),
          choose: (request, scope, room) => k.choose(request.profileId, scope, request.roleId, room, request.reviewerKey),
        },
        readiness: {
          hold: (task, need) => k.readiness.hold(task, need),
          resolveHeld: (need, signal) => k.readiness.resolveHeld(need, signal),
          resolve: (need) => k.readiness.resolve(need),
        },
        admissionsClosed: (task) => k.taskAdmissionsClosed(task),
        admissionWait: (task) => k.taskAdmissionWait(task),
        sourceRefreshDue: (task) => k.taskSourceRefreshDue(task),
        slotWait: (task, profile, toolId) => slotWait(k.activeState(), { ...profile, taskId: task.id, toolId }),
        toolName: (id) => k.s.tools.find((tool) => tool.id === id)?.name ?? id,
        attempt: (scope, roleId, plannedId, profile, retry) =>
          k.tracking.attempt(scope, roleId, plannedId, profile, retry),
        owesRetry: (scope, roleId, plannedId) => k.tracking.owesRetry(scope, roleId, plannedId),
        keepWords: (scope, roleId, profileId, reviewerKey, error) =>
          this.keepWords(scope, roleId, profileId, reviewerKey, error),
        waitForUsage: (task, words) => k.waitForUsage(task, words),
        recordLimit: (task, roleId, profileId, error) => k.recordLimit(task, roleId, profileId, error),
        waitForScreen: (task) => k.waitForScreen(task),
        discardUnavailable: (scope, roleId, error, reviewerKey) =>
          discardUnavailableTurnParticipant(k, scope, roleId, error, reviewerKey),
        beforeMainAttempt: (scope, roleId, profile) => {
          const { task, work: repository } = scope;
          const role = this.k.role(roleId, task);
          if (!role || !contractFor(role).awayFromBuilder) return;
          const builder = this.k.profile(
            task.plan?.stages.find((stage) => this.k.role(stage.roleId, task)?.result === "build")?.profileIds[0] ?? "",
          );
          const builderTool = repository.builderSession?.toolId ?? builder?.toolId;
          const prefix = `${role.name.replace(/\s+reviewer$/i, " review")} on the builder's tool`;
          if (builderTool === profile.toolId && !task.timeline.some((entry) => entry.text.startsWith(prefix))) {
            this.k.log(
              scope,
              "warn",
              `${prefix} (${this.k.named(profile.id)}): no other tool is available for this review`,
            );
          }
        },
        showReviewWork: (task) => k.showReviewWork(task),
        checkpoint: (scope) => k.commitNow(scope),
      },
      {
        capacity: (error): error is ModelAtCapacity => error instanceof ModelAtCapacity,
        usage: (error): error is UsageLimited => error instanceof UsageLimited,
        waiting: waitingFor,
        usageWait: (words) => new WaitingForUsage(words),
        capacityWait: (words) => new WaitingForCapacity(words),
        aborted: () => new Aborted(),
        sourceRefresh: () => new SourceRefreshRequired(),
        screenWait: () => new ScreenWait(),
      },
      capacity,
    );
  }

  /** Wait for screen yields that released their seat before their process had exited. */
  releasedStops(taskId: Id): Promise<void> {
    return this.k.agentCleanup.wait(taskId);
  }

  async turn<T>(
    scope: RepositoryContext,
    roleId: Id,
    plannedId: Id,
    given: Given,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: TurnOptions<T> = {},
  ): Promise<T> {
    const { task } = scope;
    if (
      !this.k.role(roleId, task)
      || !(task.maintenance?.profile.id === plannedId || task.direct?.profile.id === plannedId || this.k.profile(plannedId))
      || (this.k.role(roleId, task)?.result !== "plan" && !this.k.productOf(scope))
    ) {
      throw new Error(`Unknown role or product: ${roleId} on ${plannedId}`);
    }
    let firstAttempt = true;
    return this.recovery.main({
      scope,
      roleId,
      plannedId,
      signal,
      get room() {
        return options.room;
      },
      reviewerKey: options.reviewerKey,
      member: options.member,
      used: (id) => options.used?.(id),
      attempt: (profile, choice) => {
        const initial = firstAttempt;
        firstAttempt = false;
        return this.attempt(scope, roleId, plannedId, profile, given, schema, signal, {
          ...options,
          ...(initial ? {} : { initialHead: undefined, initialCompanionHeads: undefined }),
          selectionReason: [options.selectionReason, choice.reason].filter(Boolean).join(" "),
          ...(choice.freshReason ? { freshReason: choice.freshReason } : {}),
          ...(choice.readiness ? { readiness: choice.readiness } : {}),
        });
      },
    });
  }

  async parallel<T>(
    scope: RepositoryContext,
    roleId: Id,
    plannedId: Id,
    copy: string,
    given: Given,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: ConversationOptions & {
      check?: Check<T>;
      used?: (profileId: Id) => void;
      room?: (toolId: Id, profile: AgentProfile) => boolean;
      seat?: Id;
      selectionReason?: string;
      reviewerKey?: string;
      seats?: readonly string[];
      key?: string;
      member?: string;
      agent?: ActiveAgent;
      refresh?: boolean;
    } = {},
  ): Promise<T> {
    const { task } = scope;
    if (
      !this.k.role(roleId, task)
      || !this.k.productOf(scope)
      || !(task.maintenance?.profile.id === plannedId || task.direct?.profile.id === plannedId || this.k.profile(plannedId))
    ) {
      throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
    }
    return this.recovery.member({
      scope,
      roleId,
      plannedId,
      signal,
      get room() {
        return options.room;
      },
      reviewerKey: options.reviewerKey,
      member: options.member,
      used: (id) => options.used?.(id),
      roomCheck: (toolId, profile) => options.room!(toolId, profile),
      key: options.key,
      seat: options.seat,
      selectionReason: options.selectionReason,
      freshReason: options.freshReason,
      readiness: options.readiness,
      refresh: options.refresh,
      attempt: (role, profile, selected) => {
        const { key, refresh, plannedId: selectedPlan, selectionReason, freshReason, readiness, took } = selected;
        return this.attemptTogether(scope, role, profile, copy, given, schema, signal, {
          ...options,
          key,
          refresh,
          plannedId: selectedPlan,
          selectionReason,
          freshReason,
          readiness,
          member: options.member ?? key,
          ...(took
            ? {
                took: {
                  from: this.k.named(took.profileId),
                  words: this.lastWords(scope, roleId, took.profileId, took.at),
                  ...(took.refusal !== undefined ? { refusal: took.refusal } : {}),
                },
              }
            : {}),
        });
      },
    });
  }

  refresh(scope: RepositoryContext): Promise<void> {
    return this.sources.refresh(scope);
  }

  private attempt<T>(
    scope: RepositoryContext,
    roleId: Id,
    plannedId: Id,
    profile: AgentProfile,
    given: Given,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: TurnOptions<T>,
  ): Promise<T> {
    return executeMainTurnAttempt(this, scope, roleId, plannedId, profile, given, schema, signal, options);
  }

  private attemptTogether<T>(
    scope: RepositoryContext,
    role: Role,
    profile: AgentProfile,
    copy: string,
    given: Given,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: ParallelAttemptOptions<T>,
  ): Promise<T> {
    return executeParallelTurnAttempt(this, scope, role, profile, copy, given, schema, signal, options);
  }

  openAgentRun(
    scope: RepositoryContext,
    role: Role,
    profile: AgentProfile,
    cwd: string,
    signal: AbortSignal,
    agent: TurnAgent,
    options: OpenAgentRunOptions,
  ): Promise<{ run: AgentSession; off?: string; reopenFailure?: string }> {
    return openTurnAgentRun({
      k: this.k,
      tools: this.tools,
      scope,
      role,
      profile,
      cwd,
      signal,
      agent,
      options,
      hooks: {
        onMessage: this.messageStream(scope, role.id, profile.id, options.reviewerKey, signal, options.main),
        markBriefed: (s) => this.briefed(s),
        wait: (request) => this.wait(request),
      },
    });
  }

  converse<T>(request: {
    scope: RepositoryContext;
    run: AgentSession;
    agent: TurnAgent;
    opening: string;
    reason: TurnReason;
    role: Role;
    profileId: Id;
    schema: z.ZodType<T>;
    signal: AbortSignal;
    options: {
      check?: Check<T>;
      main: boolean;
      openingMessages?: ReturnType<typeof takeMessages>;
      member?: string;
      askScreen?: (reason: string) => boolean;
      reviewKey?: string;
      reviewerKey?: string;
      beforeContinue?: (reply: TurnResult) => Promise<void>;
      pendingInput?: () => PendingInput | undefined;
    };
  }): Promise<T> {
    return runTurnConversation({
      ...request,
      k: this.k,
      options: {
        ...request.options,
        attachInput: (s, pending, text, additions, openingSections) =>
          this.attachInput(s, pending, text, additions, openingSections),
        markBriefed: (s) => this.briefed(s),
        recordProse: (s, roleId, profileId, reviewerKey, prose, interrupted) =>
          this.recordProse(s, roleId, profileId, reviewerKey, prose, interrupted),
        wait: (replyRequest) => this.wait(replyRequest),
      },
    });
  }

  private attachInput(
    scope: RepositoryContext,
    pending: PendingInput | undefined,
    text: string,
    additions: readonly Section[] = [],
    openingSections: readonly Section[] = [],
  ): Promise<void> {
    return this.inputs.attach(scope, pending, text, additions, openingSections);
  }

  private wait(request: CoordinatorReplyRequest): Promise<string> {
    return waitForCoordinatorReply(this.k, request);
  }

  whereYouWere(scope: RepositoryContext, role: Role, since: number): WhereYouWere {
    return buildWhereYouWere(scope, role, since);
  }

  recordJourneyInput(request: Parameters<ParticipantInputs["capture"]>[0]): PendingInput | undefined {
    return this.inputs.capture(request);
  }

  reserveOpening(
    scope: RepositoryContext,
    sections: readonly Section[],
    member: string | undefined,
    earlierCarried: boolean,
  ): { sections: Section[]; messages: ReturnType<typeof takeMessages> } {
    const index = sections.findIndex((section) => section.title.startsWith("The coordinator's notes on this task"));
    const resolvedSections =
      index >= 0
        ? [
            ...sections.slice(0, index),
            ...coordinatorNotes(scope, member, earlierCarried),
            ...sections.slice(index + 1),
          ]
        : [...sections];
    const maintenance = scope.task.maintenance;
    const messages =
      maintenance?.pendingReply && maintenance.settingsDecision?.choice === "keep"
        ? []
        : takeMessages(scope.task, member, Infinity);
    return { sections: resolvedSections, messages };
  }

  async prepareTurnPrompt(
    scope: RepositoryContext,
    role: Role,
    sessionId: string,
    sections: Section[],
    note: ConversationNote | undefined,
    options: {
      packet?: boolean;
      previous?: BuilderContext;
      design?: boolean;
      knownSections?: readonly string[];
      findings?: readonly Finding[];
      supplyHistory?: boolean;
    },
  ): Promise<{ sections: Section[]; refreshRole: boolean; omitted?: readonly ContextOmission[] }> {
    return this.inputs.prepare(scope, {
      packet: Boolean(options.packet),
      note,
      previous: options.previous,
      sections,
      supplyHistory: options.supplyHistory !== false,
      prepare: () =>
        builderContext(this.k.dataDir, repositoryView(scope), role, sessionId, sections, options.previous, {
          design: options.design,
          knownSections: options.knownSections,
          findings: options.findings,
        }),
      history: (supplied, continued) => supplyReviewHistory(scope, supplied, { continued }),
    });
  }

  lastWords(scope: RepositoryContext, roleId: Id, profileId: Id, since: number): string {
    const { task } = scope;
    return lastWords(
      task.session
        .filter((line) => line.from === "agent" && line.roleId === roleId && line.profileId === profileId && line.at >= since)
        .map((line) => line.text)
        .reverse(),
    );
  }

  private keepWords(
    scope: RepositoryContext,
    roleId: Id,
    profileId: Id,
    reviewerKey: string | undefined,
    error: { said?: string; streamed?: boolean },
  ): void {
    if (error.streamed) return;
    const prose = error.said ? proseOf(error.said) : undefined;
    if (prose) this.recordProse(scope, roleId, profileId, reviewerKey, prose, true);
  }

  private recordProse(
    scope: RepositoryContext,
    roleId: Id,
    profileId: Id,
    reviewerKey: string | undefined,
    prose: string,
    interrupted = false,
  ): void {
    const messages = new AgentMessages(immediateMessageClock, this.messageStream(scope, roleId, profileId, reviewerKey));
    messages.push(prose);
    messages.boundary(interrupted);
  }

  private messageStream(
    scope: RepositoryContext,
    roleId: Id,
    profileId: Id,
    reviewerKey: string | undefined,
    signal?: AbortSignal,
    main = false,
  ): (message: AgentMessage) => boolean {
    return this.inputs.stream(scope, roleId, profileId, reviewerKey, signal, main);
  }

  private briefed(scope: RepositoryContext): void {
    const { work: repository } = scope;
    if (!repository.conversation || repository.conversation.briefed) return;
    repository.conversation.briefed = true;
    this.k.commitNow(scope);
  }
}
