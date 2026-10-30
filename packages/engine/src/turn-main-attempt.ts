import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isAuthRequired } from "@petrina/agent-runtime/failures";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import {
  beginAgentStep,
  endAgentStep,
  JOURNEY_WORDS,
  limitOf,
  openStep,
  recordAcceptanceStart,
  resumeClock,
  SCREEN_WORDS,
  startClock,
  stepMayChange,
  type AgentProfile,
  type Id,
  type Pool,
  type Product,
} from "@petrina/core";
import {
  repositoryView,
  type RepositoryContext,
  type TurnResult,
} from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { WaitClock } from "@petrina/storage/worklog";
import type { z } from "zod";
import { Aborted, stepKey } from "./kernel.js";
import { holdUnconfirmed } from "./messages.js";
import { mayAskScreen } from "./prompts.js";
import type { TurnAgent } from "./tracking.js";
import {
  prepareTurnOpeningPrompt,
  type ConversationOptions,
  type Given,
  type ResumeConversation,
  type TurnAttemptCollaborators,
  type TurnOptions,
} from "./turn-opening-prompt.js";
import {
  ensureToolReady,
  resolveSandboxState,
  restoreProtectedCopies,
} from "./turn-session.js";

export type {
  ConversationOptions,
  Given,
  ResumeConversation,
  TurnAttemptCollaborators,
  TurnOptions,
};

/** One attempt at the step by one agent on one profile. */
export async function executeMainTurnAttempt<T>(
  deps: TurnAttemptCollaborators,
  scope: RepositoryContext,
  roleId: Id,
  plannedId: Id,
  profile: AgentProfile,
  given: Given,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  options: TurnOptions<T>,
): Promise<T> {
  const { k, tools, sources, recovery, maintenanceSettings } = deps;
  const { task, work: repository } = scope;
  let role = k.role(roleId, task);
  const product =
    k.repositoryOf(scope)
    ?? (role?.result === "plan" ? { id: "", name: "To be chosen", repo: "", tone: "blue" as const } : undefined);
  if (!role || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profile.id}`);
  const profileId = profile.id;
  const workingCopy = repository.worktree ?? join(k.dataDir, "planning", task.id);
  if (!repository.worktree) mkdirSync(workingCopy, { recursive: true });
  const taskId = task.id;
  const worktree = options.copy ?? workingCopy;
  if (signal.aborted) throw new Aborted();
  await holdUnconfirmed(k, scope, options.member, signal, options.reviewKey);
  ensureToolReady(tools, profile);
  if (role.result !== "plan") await sources.refresh(scope, Boolean(repository.conversation || task.fixing));

  const step = stepKey(task);
  const model = profile.modelId ?? profile.model;
  const saved = repository.conversation;
  const same = saved && saved.step === step && saved.roleId === roleId ? saved : undefined;
  role = structuredClone(same?.role ?? role);
  const access =
    same?.access
    ?? (task.retest
      ? { canEdit: false, afterReview: role.canEdit }
      : stepMayChange(role, task.plan?.stages ?? [], task.stageIndex));
  role.canEdit = access.canEdit;
  if (access.afterReview && !same) {
    k.log(scope, "warn", `${role.name} works read-only on this task: its step comes after the final review`, roleId, profileId);
  }
  const reopen =
    same
    && same.briefed
    && role.result !== "delivery"
    && same.toolId === profile.toolId
    && same.model === model
    && (role.result !== "build" || !same.plannedProfileId || same.plannedProfileId === plannedId)
      ? same
      : undefined;
  let again =
    saved && !reopen
      ? same
        ? same.briefed || role.result === "delivery"
          ? (options.readiness && options.freshReason) || "it now runs on a different tool or model"
          : "it had not received its instructions yet"
        : "the saved conversation was for another step"
      : undefined;
  const offered = typeof options.resume === "function" ? await options.resume(profile, role) : options.resume;
  const back = !saved && offered?.toolId === profile.toolId && offered.model === model ? offered : undefined;
  if (!saved && offered && !back && !options.freshReason) {
    k.log(scope, "status", "Started a fresh conversation: the tool or model changed", roleId, profileId);
  }
  const startedAt = same?.startedAt ?? Date.now();
  const handback = same?.handback;
  const before = same && !reopen && !back ? k.profile(same.profileId) : undefined;
  const now = Date.now();
  const previousLimit = before ? limitOf(k.activeState().pool as Pool, before, now) : undefined;
  const capacityHold = before
    ? task.modelCapacity?.find(
        (entry) => entry.until > now && entry.toolId === before.toolId && entry.modelId === (before.modelId ?? before.model),
      )
    : undefined;
  const tookOver = previousLimit || capacityHold ? before : undefined;
  const refusal = capacityHold ? "the selected model is at capacity" : previousLimit?.retry ? previousLimit.reason : undefined;
  if (capacityHold && before) recovery.capacity.forget(task, (entry) => entry.roleId === roleId && entry.profileId === before.id);
  const screen =
    task.screen?.granted
    && task.screen.roleId === roleId
    && task.screen.profileId === profileId
    && (!options.member || task.screen.member === options.member)
      ? task.screen
      : undefined;
  const forScreen = screen && !screen.heard ? screen : undefined;
  const screenWords = screen ? { reason: screen.reason } : mayAskScreen(role) ? ("ask" as const) : undefined;
  const admission = { task, profile, roleId, step, ...(options.reviewKey ? { reviewKey: options.reviewKey } : {}) };
  k.agentAdmission.participant.qualify(admission, signal);
  if (!same) delete task.todo;
  const reviewWork = options.reviewKey ? task.hunt?.work?.[options.reviewKey] : undefined;
  if (reviewWork) {
    reviewWork.clock = reviewWork.clock ? resumeClock(reviewWork.clock, Date.now()) : startClock(repositoryView(scope), roleId, Date.now());
    delete reviewWork.waiting;
    task.stepClock = reviewWork.clock;
  } else {
    task.stepClock = same && task.stepClock ? resumeClock(task.stepClock, Date.now()) : startClock(repositoryView(scope), roleId, Date.now());
  }

  k.agentAdmission.participant.activate(admission);
  const previous = openStep(task);
  if (previous?.kind === "agent" && previous.roleId === roleId && !previous.team && previous.profileId !== profileId) {
    endAgentStep(task, { outcome: JOURNEY_WORDS.handedOn, reason: JOURNEY_WORDS.agentChanged, tone: "back" }, Date.now());
  }
  const stage = task.plan?.stages[task.stageIndex];
  const journeyRole =
    options.copy && stage?.kind === "review-chain" && !repository.portReview && stage.roleIds?.includes(roleId)
      ? stage.roleId
      : roleId;
  const team =
    previous?.kind === "agent" && previous.roleId === journeyRole
      ? (previous.team ?? (previous.profileId ? [previous.profileId] : []))
      : [];
  const journeyStep = beginAgentStep(
    task,
    journeyRole,
    profileId,
    Date.now(),
    k.s.roles,
    options.copy ? [...new Set([...team, profileId])] : undefined,
    repository,
  );
  if (options.seats) journeyStep.seats = [...options.seats];
  if (role.result === "build") journeyStep.buildProductId = repository.productId;
  recordAcceptanceStart(task, journeyStep, role.result, structuredClone);
  if (["findings", "votes"].includes(role.result) && task.hunt?.input) journeyStep.reviewInput = structuredClone(task.hunt.input);
  task.statusLine = options.status ?? (saved ? `${role.name} is getting back to work` : `${role.name} is starting`);
  if (same) {
    same.role = role;
    same.access = access;
  }
  if (role.canEdit && repository.worktree) k.stepOwnership.admitEditable(scope, step);
  k.commitNow(scope);

  const live = () => k.task(taskId);
  const agent: TurnAgent = {
    roleId,
    profile,
    waits: new WaitClock(),
    journeyId: journeyStep.id,
    agentSeat: options.reviewerKey ?? options.reviewKey ?? roleId,
  };
  const knownCopyHead = options.copy ? deps.copyHeads.get(options.copy) : undefined;
  if (options.copy) deps.copyHeads.delete(options.copy);
  const [head, protectedCopies] = await Promise.all([
    same?.head
      ?? ((!tookOver ? (knownCopyHead ?? options.initialHead) : undefined)
        ?? (options.copy ?? repository.worktree ? git.head(worktree).catch(() => undefined) : undefined)),
    task.repositories && !options.copy
      ? Promise.all(
          task.repositories
            .filter((work) => work.worktree && work.productId !== repository.productId)
            .map(async (work) => {
              const knownCompanion = !tookOver ? options.initialCompanionHeads?.[work.productId] : undefined;
              return {
                productId: work.productId,
                path: work.worktree!,
                sha: knownCompanion && git.isSha(knownCompanion) ? knownCompanion : await git.head(work.worktree!),
              };
            }),
        )
      : [],
  ]);
  const opened = await deps.openAgentRun(scope, role, profile, worktree, signal, agent, {
    main: true,
    reviewKey: options.reviewKey,
    reviewerKey: options.reviewerKey,
    sessionId: (reopen ?? back)?.sessionId,
    reselect: back?.reselect,
    onStarting: () => {
      if (saved) return;
      k.say(scope, "system", `${role.name} joined · ${k.describe(roleId, profileId)}`, roleId, profileId);
      k.log(scope, "milestone", `${role.name} started`, roleId, profileId);
    },
  });
  repository.stepAttempts = (repository.stepAttempts ?? 0) + 1;
  if (reviewWork) reviewWork.attempts = (reviewWork.attempts ?? 0) + 1;
  const notBack = opened.reopenFailure;
  if (reopen && opened.reopenFailure) again = opened.reopenFailure;
  const { run } = opened;
  const headBefore = !role.canEdit ? head : undefined;
  let acceptanceCleanup: string | undefined;
  let turnFailure: { error: unknown } | undefined;
  try {
    options.started?.();
    k.runs.set(taskId, run);
    acceptanceCleanup = role.result === "checks" && task.acceptanceRun ? k.beginAcceptanceCleanup(task) : undefined;
    k.syncIdleSleep();
    if (!ADAPTERS[profile.toolId]?.usageReader?.liveSession) k.readUsage(profile.toolId);
    const picked = run.reopened !== undefined;
    const sandbox = resolveSandboxState(k, scope, opened.off, roleId, profileId, picked);
    if (task.agent) task.agent.sandbox = sandbox;
    if (picked && handback && same?.handbackBoot === k.boot && repository.stepAttempts > 1) repository.stepAttempts -= 1;
    const wentBack = picked && !reopen && back !== undefined;
    if (role.result === "build" && task.fixing && !same) journeyStep.builderConversation = wentBack ? "resumed" : "new";
    const where = saved ? deps.whereYouWere(scope, role, startedAt) : undefined;
    if (wentBack) {
      k.say(scope, "system", `${role.name} went back to its own conversation from the last step · ${k.describe(roleId, profileId)}`, roleId, profileId);
      k.log(scope, "status", "Went back to its own conversation from the last step", roleId, profileId);
    } else if (back) {
      k.log(
        scope,
        "status",
        `Could not go back to its own conversation (${notBack ?? "the tool did not reopen it"}), so it started a fresh one with what it reported`,
        roleId,
        profileId
      );
    }
    if (!wentBack) {
      if (picked && handback) {
        k.say(scope, "system", `${role.name} took the step back on the same conversation · ${k.describe(roleId, profileId)}`, roleId, profileId);
        k.log(scope, "milestone", "Took the step back on the same conversation", roleId, profileId);
      } else if (handback) {
        k.say(
          scope,
          "system",
          `${role.name} carried on in a fresh conversation, with your note, because the one you drove could not be reopened · ${k.describe(
          roleId,
          profileId
        )}`,
          roleId,
          profileId
        );
        k.log(scope, "milestone", `Carried on in a fresh conversation: ${again}`, roleId, profileId);
      } else if (picked) {
        k.say(scope, "system", `${role.name} picked up where it left off · ${k.describe(roleId, profileId)}`, roleId, profileId);
        k.log(scope, "milestone", forScreen ? SCREEN_WORDS.pickedUp : "Picked up where it left off", roleId, profileId);
      } else if (tookOver) {
        const words = `${role.name} on ${k.named(profileId)} took over from ${k.named(tookOver.id)}, which ${refusal ? `could not continue (${refusal})` : "ran out of usage"}`;
        k.say(scope, "system", words, roleId, profileId);
        k.log(scope, "milestone", words, roleId, profileId);
      } else if (saved) {
        k.say(scope, "system", `${role.name} started this step again · ${k.describe(roleId, profileId)}`, roleId, profileId);
        k.log(scope, "milestone", `Started this step again: ${again}`, roleId, profileId);
      }
    }
    const asked = picked ? reopen?.asked : undefined;
    const readinessWait = picked ? (reopen ?? back)?.readinessWait : undefined;
    if (role.result !== "delivery") {
      const copies = deps.repositoryCopies.get(worktree);
      repository.conversation = {
        ...(copies ? { repositoryCopies: copies } : {}),
        step,
        roleId,
        profileId,
        role,
        access,
        ...(role.result === "build" ? { plannedProfileId: plannedId, builderTree: options.builderTree } : {}),
        toolId: profile.toolId,
        model,
        sessionId: run.sessionId,
        ...(head ? { head } : {}),
        startedAt,
        ...(asked ? { asked } : {}),
        ...(picked ? { briefed: true } : {}),
        ...(picked && same?.context ? { context: same.context } : {}),
        ...(picked && handback ? { handback } : {}),
        ...(picked && same?.capacityContinue ? { capacityContinue: true } : {}),
        ...(readinessWait ? { readinessWait } : {}),
      };
      const pendingScreen = screen?.member && task.hunt?.screenTurns?.[screen.member];
      if (pendingScreen) pendingScreen.conversation = repository.conversation;
    }
    k.commitNow(scope);
    const checkSettings = (reply?: TurnResult, result?: T) =>
      maintenanceSettings.check(task, {
        role,
        profile,
        settings: run.settings,
        lastTurn: run.lastTurn,
        worktree,
        headBefore,
        reply,
        result,
      });
    if (task.maintenance?.role.id === roleId) maintenanceSettings.confirm(profile, run.settings);
    if (signal.aborted || !live()) throw new Aborted();
    const { opening, openingMessages, pending } = await prepareTurnOpeningPrompt({
      deps,
      scope,
      roleId,
      plannedId,
      profileId,
      role,
      product: product as Product,
      access,
      screenWords,
      workingCopy,
      worktree,
      given,
      options,
      run,
      signal,
      isLive: () => Boolean(live()),
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
    });
    if (screen) screen.heard = true;
    if (signal.aborted || !live()) throw new Aborted();
    k.commitNow(scope);
    const askScreen = options.member
      ? (reason: string) => k.screens.saveTurn(scope, role.id, profile.id, options.member!, worktree, repository.conversation, reason)
      : undefined;
    const result = await deps.converse(scope, run, agent, opening, picked && !wentBack ? "continue" : "first", role, profileId, schema, signal, {
      ...options,
      main: !options.copy,
      openingMessages,
      beforeContinue: checkSettings,
      ...(askScreen ? { askScreen } : {}),
      pendingInput: () => pending,
    });
    await checkSettings(undefined, result);
    if (repository.conversation) options.completed?.(repository.conversation, profile, role);
    return result;
  } catch (error) {
    turnFailure = { error };
    if (isAuthRequired(error)) {
      const problem = await tools.problem(profile.toolId, error);
      turnFailure = { error: problem };
      throw problem;
    }
    throw error;
  } finally {
    try {
      const stopped = k.stopAgent(taskId, run);
      if (k.runs.get(taskId) === run) k.runs.delete(taskId);
      k.syncIdleSleep();
      await stopped;
      await restoreProtectedCopies(k, scope, role, worktree, headBefore, protectedCopies);
      if (acceptanceCleanup) k.endAcceptanceCleanup(scope, acceptanceCleanup);
    } catch (cleanup) {
      if (turnFailure) {
        throw new AggregateError([turnFailure.error, cleanup], "The agent turn failed and its cleanup was not confirmed");
      }
      throw cleanup;
    }
  }
}
