import {
  backgroundMessage,
  takeMessages,
  type AgentProfile,
  type BuilderContext,
  type ConversationNote,
  type Finding,
  type Id,
  type Product,
  type ReadinessRecheck,
  type ReadinessWait,
  type Role,
  type StepNote,
  type TurnReason,
} from "@petrina/core";
import {
  repositoryView,
  type AgentSession,
  type MaintenanceSettings,
  type ParticipantInputCaptureRequest,
  type RepositoryContext,
  type TurnRecovery,
  type TurnResult,
} from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { z } from "zod";
import type { Section } from "./context.js";
import type { ContextOmission } from "./coordinator-note-context.js";
import { Aborted, type Kernel } from "./kernel.js";
import {
  buildPrompt,
  capacityContinuePrompt,
  continuePrompt,
  currentStepAssignment,
  EARLIER_ATTEMPT,
  formatHandBack,
  formatStepNotes,
  formatTakeOver,
  formatWhereYouWere,
  HANDED_BACK,
  handBackPrompt,
  OWN_COPY,
  ownCopy,
  pullRequestBackground,
  restartPrompt,
  screenPrompt,
  TOOK_OVER,
  WHERE_YOU_WERE,
  WHERE_YOU_WERE_SCREEN,
  type WhereYouWere,
} from "./prompts.js";
import type { Sources } from "./sources.js";
import type { ToolChecks } from "./tool-checks.js";
import type { TurnAgent } from "./tracking.js";
import type { TurnResultCheck as Check } from "./turn-conversation.js";
import {
  usableTurnProfiles,
  type OpenAgentRunOptions,
  type PendingInput,
} from "./turn-session.js";

export type Given = () => Section[] | Promise<Section[]>;

export type ResumeConversation = {
  sessionId: string;
  toolId: Id;
  model: string;
  context?: BuilderContext;
  knownSections?: readonly string[];
  continuedSections?: readonly Section[];
  reselect?: boolean;
  readinessWait?: ReadinessWait;
};

export interface ConversationOptions {
  freshReason?: string;
  readiness?: ReadinessRecheck;
  resume?:
    | ResumeConversation
    | ((profile: AgentProfile, role: Role) => ResumeConversation | undefined | Promise<ResumeConversation | undefined>);
  reviewContext?: boolean;
  reviewFindings?: readonly Finding[];
  started?: () => void;
  completed?: (note: ConversationNote, profile: AgentProfile, role: Role) => void;
  place?: string;
}

export interface TurnOptions<T> extends ConversationOptions {
  builderTree?: string;
  initialHead?: string;
  initialCompanionHeads?: Readonly<Record<Id, string>>;
  requestedProfileId?: Id;
  selectionReason?: string;
  status?: string;
  check?: Check<T>;
  copy?: string;
  designContext?: boolean;
  used?: (profileId: Id) => void;
  reviewerKey?: string;
  seats?: readonly string[];
  reviewKey?: string;
  member?: string;
  room?: (toolId: Id, profile: AgentProfile) => boolean;
}

export interface TurnAttemptCollaborators {
  readonly k: Kernel;
  readonly tools: ToolChecks;
  readonly sources: Sources;
  readonly recovery: TurnRecovery;
  readonly maintenanceSettings: MaintenanceSettings;
  readonly repositoryCopies: Map<string, Readonly<Record<string, string>>>;
  readonly copyHeads: Map<string, string>;
  openAgentRun(
    scope: RepositoryContext,
    role: Role,
    profile: AgentProfile,
    cwd: string,
    signal: AbortSignal,
    agent: TurnAgent,
    options: OpenAgentRunOptions,
  ): Promise<{ run: AgentSession; off?: string; reopenFailure?: string }>;
  prepareTurnPrompt(
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
  ): Promise<{ sections: Section[]; refreshRole: boolean; omitted?: readonly ContextOmission[] }>;
  recordJourneyInput(request: ParticipantInputCaptureRequest): PendingInput | undefined;
  reserveOpening(
    scope: RepositoryContext,
    sections: readonly Section[],
    member: string | undefined,
    earlierCarried: boolean,
  ): { sections: Section[]; messages: ReturnType<typeof takeMessages> };
  lastWords(scope: RepositoryContext, roleId: Id, profileId: Id, since: number): string;
  whereYouWere(scope: RepositoryContext, role: Role, since: number): WhereYouWere;
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
  }): Promise<T>;
}

export async function prepareTurnOpeningPrompt<T>(params: {
  deps: TurnAttemptCollaborators;
  scope: RepositoryContext;
  roleId: Id;
  plannedId: Id;
  profileId: Id;
  role: Role;
  product: Product;
  access: { canEdit: boolean; afterReview?: boolean };
  screenWords: { reason: string } | "ask" | undefined;
  workingCopy: string;
  worktree: string;
  given: Given;
  options: TurnOptions<T>;
  run: AgentSession;
  signal: AbortSignal;
  isLive: () => boolean;
  wentBack: boolean;
  picked: boolean;
  back: ResumeConversation | undefined;
  notBack: string | undefined;
  saved: ConversationNote | undefined;
  offered: ResumeConversation | undefined;
  again: string | undefined;
  asked: ConversationNote["asked"] | undefined;
  handback: string | undefined;
  forScreen: { reason: string } | undefined;
  where: WhereYouWere | undefined;
  head: string | undefined;
  tookOver: AgentProfile | undefined;
  refusal: string | undefined;
  startedAt: number;
}): Promise<{
  opening: string;
  openingMessages: ReturnType<typeof takeMessages>;
  pending: PendingInput | undefined;
}> {
  const {
    deps,
    scope,
    roleId,
    plannedId,
    profileId,
    role,
    product,
    access,
    screenWords,
    workingCopy,
    worktree,
    given,
    options,
    run,
    signal,
    isLive,
    wentBack,
    picked,
    back,
    notBack,
    saved,
    offered,
    again,
    asked,
    handback,
    forScreen,
    where,
    head,
    tookOver,
    refusal,
    startedAt,
  } = params;
  const { k, recovery } = deps;
  const { task, work: repository } = scope;

  let openingMessages: ReturnType<typeof takeMessages> = [];
  const withBackground = async (): Promise<Section[]> => {
    const rawSections = [
      ...currentStepAssignment(task, roleId),
      ...(await given()),
      ...(repository.prBackground
        ? [{ title: "Pull request background", body: pullRequestBackground(repository.prBackground) }]
        : []),
    ];
    const reserved = deps.reserveOpening(scope, rawSections, options.member, true);
    openingMessages = reserved.messages;
    return reserved.sections;
  };
  const freshReason =
    wentBack || picked
      ? undefined
      : back
        ? (notBack ?? "the tool did not reopen the earlier conversation")
        : !saved && offered
          ? (options.freshReason ?? "the tool or model changed since the earlier conversation")
          : saved
            ? again
            : options.freshReason;
  let pending: PendingInput | undefined;
  let opening: string;
  const requestedPlan = options.requestedProfileId ?? plannedId;
  const extraMeta = {
    sessionId: run.sessionId,
    ...(options.place !== undefined ? { place: options.place } : {}),
    ...(options.readiness ? { readiness: options.readiness } : {}),
  };
  const promptBase = {
    task: repositoryView(scope),
    product,
    role,
    roles: k.s.roles as Role[],
    profiles: usableTurnProfiles(k),
    tools: k.s.tools,
    branch: repository.branch ?? "planning",
    base: repository.baseSha ?? repository.base ?? "",
    defaultBranch: repository.source?.start.branch ?? product.defaultBranch ?? "main",
    access,
    ...(screenWords ? { screen: screenWords } : {}),
  };

  if (wentBack) {
    const givenSections = [...(await withBackground()), ...(back?.continuedSections ?? [])];
    const previousContext =
      back?.context
      ?? (repository.builderSession?.sessionId === run.sessionId ? repository.builderSession.context : undefined);
    const prepared = await deps.prepareTurnPrompt(scope, role, run.sessionId, givenSections, repository.conversation, {
      packet: role.result === "build" || options.designContext || options.reviewContext,
      previous: previousContext,
      design: options.designContext,
      knownSections: back?.knownSections,
      findings: options.reviewFindings,
    });
    const sections = prepared.sections;
    opening = continuePrompt(
      { ...promptBase, worktree, sections },
      {
        refreshRole: prepared.refreshRole,
        recordJob: (job, supplied) => {
          pending = deps.recordJourneyInput({
            scope,
            roleId,
            profileId,
            sections,
            mode: "continued",
            plannedId: requestedPlan,
            selectionReason: options.selectionReason,
            reviewerKey: options.reviewerKey,
            confirmedSettings: run.settings,
            instructions: job,
            extra: {
              ...extraMeta,
              supplied,
              omitted: prepared.omitted,
            },
          });
        },
      },
    );
  } else if (picked) {
    const answer = asked?.answer !== undefined ? { question: asked.question, text: asked.answer } : undefined;
    if (repository.conversation) {
      delete repository.conversation.asked;
      delete repository.conversation.handback;
    }
    const capacityContinue = Boolean(repository.conversation?.capacityContinue && !handback && !forScreen);
    if (repository.conversation?.capacityContinue) {
      delete repository.conversation.capacityContinue;
      const sessionId = repository.conversation.sessionId;
      recovery.capacity.forget(task, (entry) => entry.sessionId === sessionId);
    }
    opening = handback
      ? handBackPrompt(handback, [])
      : forScreen
        ? screenPrompt(forScreen.reason, [])
        : capacityContinue
          ? capacityContinuePrompt()
          : restartPrompt(where!, { ...(answer ? { answer } : {}), messages: [] });
    const sections = [
      ...currentStepAssignment(task, roleId),
      ...(repository.prBackground
        ? [{ title: "Refreshed pull request background", body: pullRequestBackground(repository.prBackground) }]
        : []),
    ];
    pending = deps.recordJourneyInput({
      scope,
      roleId,
      profileId,
      sections,
      mode: "continued",
      plannedId: requestedPlan,
      selectionReason: options.selectionReason,
      reviewerKey: options.reviewerKey,
      confirmedSettings: run.settings,
      instructions: opening,
      extra: {
        ...extraMeta,
        resumed: true,
      },
    });
    opening += sections.map(({ title, body }) => `\n\n## ${title}\n${body}`).join("");
  } else {
    const files = where && !handback && head && worktree ? await git.changedSince(worktree, head) : [];
    if (signal.aborted || !isLive()) throw new Aborted();
    let sections = await withBackground();
    const earlier =
      (repository.stepAttempts ?? 0) > 1
        ? ((task.stepNotes ?? []) as StepNote[]).filter((note) => backgroundMessage(task, note.id, options.member))
        : [];
    if (earlier.length) {
      k.log(
        scope,
        "you",
        `Handed on ${earlier.length} thing${earlier.length === 1 ? "" : "s"} you said in an earlier attempt at this step`,
        roleId,
        profileId,
      );
    }
    if (options.copy) sections.push({ title: OWN_COPY, body: ownCopy(head ?? "") });
    if ((repository.stepAttempts ?? 0) > 1 && task.stepNotes?.length) {
      sections.push({ title: EARLIER_ATTEMPT, body: formatStepNotes(earlier) });
    }
    if (handback) sections.push({ title: HANDED_BACK, body: formatHandBack(handback, again ?? "") });
    else if (where && tookOver) {
      sections.push({
        title: TOOK_OVER,
        body: formatTakeOver(
          { ...where, files },
          k.named(tookOver.id),
          deps.lastWords(scope, roleId, tookOver.id, startedAt),
          refusal,
        ),
      });
    } else if (where) {
      sections.push({
        title: forScreen ? WHERE_YOU_WERE_SCREEN : WHERE_YOU_WERE,
        body: formatWhereYouWere({ ...where, files }, again ?? "", forScreen ? "screen" : "restart"),
      });
    }
    if (
      role.result === "findings"
      || ((role.result === "build" || options.designContext || options.reviewContext) && repository.conversation)
    ) {
      sections = (
        await deps.prepareTurnPrompt(scope, role, run.sessionId, sections, repository.conversation, {
          packet: true,
          findings: options.reviewFindings,
        })
      ).sections;
    }
    opening = buildPrompt({ ...promptBase, worktree: workingCopy, sections }, (job, supplied) => {
      pending = deps.recordJourneyInput({
        scope,
        roleId,
        profileId,
        sections,
        mode: "fresh",
        plannedId: requestedPlan,
        selectionReason: options.selectionReason,
        reviewerKey: options.reviewerKey,
        confirmedSettings: run.settings,
        instructions: job,
        extra: {
          ...extraMeta,
          supplied,
          ...(freshReason ? { freshReason } : {}),
        },
      });
    });
  }

  return { opening, openingMessages, pending };
}
