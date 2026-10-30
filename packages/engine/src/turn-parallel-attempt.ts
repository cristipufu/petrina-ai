import { isAuthRequired } from "@petrina/agent-runtime/failures";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { UsageLimited } from "@petrina/agent-runtime/usage";
import {
  beginAgentStep,
  openStep,
  type ActiveAgent,
  type AgentProfile,
  type ConversationNote,
  type Id,
  type Product,
  type Role,
} from "@petrina/core";
import { repositoryView, type RepositoryContext } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { WaitClock } from "@petrina/storage/worklog";
import type { z } from "zod";
import type { Section } from "./context.js";
import { Aborted, ScreenWait, stepKey } from "./kernel.js";
import { holdUnconfirmed } from "./messages.js";
import {
  buildPrompt,
  capacityContinuePrompt,
  continuePrompt,
  currentStepAssignment,
  formatReviewTakeOver,
  OWN_COPY,
  ownCopy,
  proseOf,
  pullRequestBackground,
  TOOK_OVER,
} from "./prompts.js";
import type { TurnAgent } from "./tracking.js";
import type { TurnResultCheck as Check } from "./turn-conversation.js";
import type { ConversationOptions, Given, TurnAttemptCollaborators } from "./turn-main-attempt.js";
import {
  ensureToolReady,
  resolveSandboxState,
  usableTurnProfiles,
  type PendingInput,
} from "./turn-session.js";

export interface ParallelAttemptOptions<T> extends ConversationOptions {
  key: string;
  check?: Check<T>;
  member: string;
  plannedId: Id;
  selectionReason?: string;
  reviewerKey?: string;
  seats?: readonly string[];
  took?: { from: string; words: string; refusal?: string };
  agent?: ActiveAgent;
  refresh?: boolean;
}

/** One attempt of a parallel agent. `took`: whom it takes over from, and what that agent had said. */
export async function executeParallelTurnAttempt<T>(
  deps: TurnAttemptCollaborators,
  scope: RepositoryContext,
  role: Role,
  profile: AgentProfile,
  copy: string,
  given: Given,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  options: ParallelAttemptOptions<T>,
): Promise<T> {
  const { k, tools, sources, recovery } = deps;
  const { task, work: repository } = scope;
  await holdUnconfirmed(k, scope, options.member, signal, options.key);
  const roleId = role.id;
  const product = k.repositoryOf(scope);
  if (!role || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profile.id}`);
  const profileId = profile.id;
  ensureToolReady(tools, profile);
  if (options.refresh !== false) await sources.refresh(scope);
  const taskId = task.id;
  if (options.agent) {
    options.agent.profileId = profileId;
    delete options.agent.sandbox;
  }
  const stage = task.plan?.stages[task.stageIndex];
  const journeyRole =
    stage?.kind === "review-chain" && !repository.portReview && stage.roleIds?.includes(roleId)
      ? stage.roleId
      : roleId;
  const group = openStep(task);
  const team =
    group?.kind === "agent" && group.roleId === journeyRole
      ? (group.team ?? (group.profileId ? [group.profileId] : []))
      : [];
  const journeyStep = beginAgentStep(
    task,
    journeyRole,
    profileId,
    Date.now(),
    k.s.roles,
    [...new Set([...team, profileId])],
    repository,
  );
  if (options.seats) journeyStep.seats = [...options.seats];
  if (role.result === "build") journeyStep.buildProductId = repository.productId;
  if (["findings", "votes"].includes(role.result) && task.hunt?.input) journeyStep.reviewInput = structuredClone(task.hunt.input);
  k.commit(scope);
  const agent: TurnAgent = {
    roleId,
    profile,
    waits: new WaitClock(),
    journeyId: journeyStep.id,
    agentSeat: options.reviewerKey ?? options.key ?? roleId,
  };
  const offered = typeof options.resume === "function" ? await options.resume(profile, role) : options.resume;
  const held = !offered
    ? task.capacityResume?.find(
        (entry) => entry.roleId === roleId && entry.profileId === profileId && entry.member === options.member,
      )
    : undefined;
  const opened = await deps.openAgentRun(scope, role, profile, copy, signal, agent, {
    main: false,
    reviewKey: options.key,
    reviewerKey: options.reviewerKey,
    sessionId: offered?.sessionId ?? held?.sessionId,
    reselect: offered?.reselect,
    onStarting: () => {
      if (options.took) {
        const words = `${role.name} on ${k.named(profileId)} took over from ${options.took.from}, which ${options.took.refusal ? `could not continue (${options.took.refusal})` : "ran out of usage"}`;
        k.say(scope, "system", words, roleId, profileId);
        k.log(scope, "milestone", words, roleId, profileId);
      } else {
        k.say(scope, "system", `${role.name} joined · ${k.describe(roleId, profileId)}`, roleId, profileId);
        k.log(scope, "milestone", `${role.name} started`, roleId, profileId);
      }
    },
  });
  const { run, off } = opened;
  const runs = k.helperRuns.get(taskId) ?? new Set();
  k.helperRuns.set(taskId, runs.add(run));
  let turnFailure: { error: unknown } | undefined;
  try {
    if (opened.reopenFailure) {
      k.log(scope, "status", `Could not go back to its own review conversation (${opened.reopenFailure}), so it started fresh`, roleId, profileId);
    }
    const work = task.hunt?.work?.[options.key];
    if (work) work.attempts = (work.attempts ?? 0) + 1;
    options.started?.();
    const wentBack = offered !== undefined && run.reopened !== undefined;
    const capacityBack = held !== undefined && run.reopened !== undefined;
    if (held) {
      recovery.capacity.forget(
        task,
        (entry) => entry.roleId === roleId && entry.profileId === profileId && entry.member === options.member,
      );
    }
    if (wentBack) k.log(scope, "status", "Went back to its own review conversation from the previous round", roleId, profileId);
    const sandbox = resolveSandboxState(k, scope, off, roleId, profileId);
    if (options.agent) options.agent.sandbox = sandbox;
    k.commit(scope);
    k.syncIdleSleep();
    if (!ADAPTERS[profile.toolId]?.usageReader?.liveSession) k.readUsage(profile.toolId);
    const knownHead = deps.copyHeads.get(copy);
    deps.copyHeads.delete(copy);
    const head = (!options.took && !held ? knownHead : undefined) ?? (await git.head(copy).catch(() => undefined));
    if (signal.aborted || !k.task(taskId)) throw new Aborted();
    const givenSections = [
      ...currentStepAssignment(task, roleId),
      ...(await given()),
      ...(wentBack ? (offered?.continuedSections ?? []) : []),
      ...(repository.prBackground ? [{ title: "Pull request background", body: pullRequestBackground(repository.prBackground) }] : []),
      { title: OWN_COPY, body: ownCopy(head ?? "") },
    ];
    const openingMessages = deps.reserveOpening(scope, givenSections, options.member, wentBack);
    if (signal.aborted) throw new Aborted();
    if (options.took) givenSections.push({ title: TOOK_OVER, body: formatReviewTakeOver(options.took.from, options.took.words, options.took.refusal) });
    const copies = deps.repositoryCopies.get(copy);
    const note: ConversationNote = {
      ...(copies ? { repositoryCopies: copies } : {}),
      step: stepKey(task),
      roleId,
      profileId,
      role,
      access: { canEdit: role.canEdit },
      toolId: profile.toolId,
      model: profile.modelId ?? profile.model,
      sessionId: run.sessionId,
      ...(head ? { head } : {}),
      startedAt: Date.now(),
      briefed: true,
    };
    const prepared = await deps.prepareTurnPrompt(scope, role, run.sessionId, givenSections, note, {
      packet: options.reviewContext,
      previous: wentBack ? offered?.context : undefined,
      findings: options.reviewFindings,
      supplyHistory: !capacityBack,
    });
    const sections = prepared.sections;
    const promptContext = {
      task: repositoryView(scope),
      product: product as Product,
      role,
      roles: k.s.roles as Role[],
      profiles: usableTurnProfiles(k),
      tools: k.s.tools,
      worktree: copy,
      branch: repository.branch ?? "planning",
      base: repository.baseSha ?? repository.base ?? "",
      defaultBranch: repository.source?.start.branch ?? product.defaultBranch ?? "main",
      sections,
    };
    let pending: PendingInput | undefined;
    const freshReason =
      wentBack || capacityBack
        ? undefined
        : offered || held
          ? (opened.reopenFailure ?? "the earlier review conversation was not reopened")
          : options.freshReason;
    const extraMeta = {
      sessionId: run.sessionId,
      ...(options.place !== undefined ? { place: options.place } : {}),
      ...(options.readiness ? { readiness: options.readiness } : {}),
    };
    const recordJob = (job: string, supplied: readonly Section[]) => {
      pending = deps.recordJourneyInput(
        scope,
        roleId,
        profileId,
        sections,
        wentBack ? "continued" : "fresh",
        options.plannedId,
        options.selectionReason,
        options.reviewerKey,
        run.settings,
        job,
        { ...extraMeta, supplied, omitted: prepared.omitted, ...(freshReason ? { freshReason } : {}) },
      );
    };
    const continued = capacityContinuePrompt();
    const opening = capacityBack
      ? [continued, ...currentStepAssignment(task, roleId).map(({ title, body }) => `## ${title}\n${body}`)].join("\n\n")
      : wentBack
        ? continuePrompt(promptContext, { refreshRole: prepared.refreshRole, recordJob })
        : buildPrompt(promptContext, recordJob);
    if (capacityBack) {
      pending = deps.recordJourneyInput(
        scope,
        roleId,
        profileId,
        currentStepAssignment(task, roleId),
        "continued",
        options.plannedId,
        options.selectionReason,
        options.reviewerKey,
        run.settings,
        continued,
        { ...extraMeta, resumed: true },
      );
    }
    const result = await deps.converse(scope, run, agent, opening, capacityBack ? "continue" : "first", role, profileId, schema, signal, {
      ...options,
      main: false,
      openingMessages,
      reviewKey: options.key,
      askScreen: (reason) => k.screens.saveTurn(scope, role.id, profile.id, options.member, copy, note, reason),
      pendingInput: () => pending,
    });
    options.completed?.(note, profile, role);
    return result;
  } catch (error) {
    turnFailure = { error };
    if (isAuthRequired(error)) {
      const problem = await tools.problem(profile.toolId, error);
      turnFailure = { error: problem };
      throw problem;
    }
    if (error instanceof UsageLimited && !signal.aborted && task.screen?.granted && task.screen.member === options.member) {
      if (!error.streamed) {
        const prose = error.said ? proseOf(error.said) : undefined;
        if (prose) k.participantSay(scope, "agent", prose.length > 2400 ? `${prose.slice(0, 2400)}…` : prose, roleId, profileId, options.reviewerKey);
      }
      k.recordLimit(task, roleId, profileId, error);
      k.tracking.owesRetry(scope, roleId, options.plannedId);
      k.waitForScreen(task);
      error = new ScreenWait();
    }
    if (error instanceof ScreenWait) {
      void k.stopAgent(taskId, run).catch(() => undefined);
      runs.delete(run);
      k.syncIdleSleep();
    }
    throw error;
  } finally {
    if (runs.has(run)) {
      try {
        await k.stopAgent(taskId, run);
      } catch (cleanup) {
        if (turnFailure) {
          throw new AggregateError([turnFailure.error, cleanup], "The agent turn failed and its cleanup was not confirmed");
        }
        throw cleanup;
      } finally {
        runs.delete(run);
        k.syncIdleSleep();
      }
    }
  }
}
