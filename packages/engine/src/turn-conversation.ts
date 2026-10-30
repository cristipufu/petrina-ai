import { rm } from "node:fs/promises";
import { join } from "node:path";
import { preserveCaptures } from "@petrina/agent-runtime/captures";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { ModelAtCapacity } from "@petrina/agent-runtime/usage";
import {
  openStep,
  pauseClock,
  recordAgentResult,
  screenReason,
  takeMessages,
  type Id,
  type Role,
  type TurnReason,
} from "@petrina/core";
import type { AgentSession, RepositoryContext, TurnResult } from "@petrina/orchestrator";
import type { z } from "zod";
import type { Section } from "./context.js";
import { saveExactMessage } from "./exact-input.js";
import { Aborted, ScreenWait, type Kernel } from "./kernel.js";
import { holdUnconfirmed, MessageTurn } from "./messages.js";
import {
  browserPrompt,
  mayAskScreen,
  parseResult,
  proseOf,
  repairPrompt,
  screenPrompt,
} from "./prompts.js";
import type { TurnAgent } from "./tracking.js";
import type { PendingInput, WaitForCoordinatorFn } from "./turn-session.js";

/** Turns a valid but incomplete result into what the agent is asked to repair, or undefined when it is complete. */
export type TurnResultCheck<T> = (value: T) => string | undefined | Promise<string | undefined>;

/** What an agent that may not ask for the screen hears when it asks anyway: it never pauses its step or its group. */
const NO_SCREEN_HERE =
  "you cannot ask for the screen in this step. Finish without it, and list any check that needs the screen in your result";

export interface TurnConversationOptions<T> {
  check?: TurnResultCheck<T>;
  main: boolean;
  openingMessages?: ReturnType<typeof takeMessages>;
  member?: string;
  askScreen?: (reason: string) => boolean;
  reviewKey?: string;
  reviewerKey?: string;
  beforeContinue?: (reply: TurnResult) => Promise<void>;
  pendingInput?: () => PendingInput | undefined;
  attachInput: (
    scope: RepositoryContext,
    pending: PendingInput | undefined,
    text: string,
    additions: readonly Section[],
    openingSections: readonly Section[],
  ) => Promise<void>;
  markBriefed: (scope: RepositoryContext) => void;
  wait: WaitForCoordinatorFn;
}

export interface TurnConversationRequest<T> {
  k: Kernel;
  scope: RepositoryContext;
  run: AgentSession;
  agent: TurnAgent;
  opening: string;
  reason: TurnReason;
  role: Role;
  profileId: Id;
  schema: z.ZodType<T>;
  signal: AbortSignal;
  options: TurnConversationOptions<T>;
}

/**
 * Turns until the agent hands back a valid result: its words go to the session, its questions to the
 * coordinator, and an unusable result back to it twice at most. Each parallel conversation hears
 * its own share of the coordinator's messages. An open question stays with the conversation that asked it.
 */
export async function runTurnConversation<T>(request: TurnConversationRequest<T>): Promise<T> {
  const { k, scope, run, agent, role, signal, options } = request;
  const messages =
    options.main || options.member
      ? new MessageTurn(k, scope, run, agent.profile, role.id, options.member, options.reviewerKey, signal)
      : undefined;
  messages?.start();
  try {
    return await executeConversationLoop(request, messages);
  } finally {
    messages?.dispose();
  }
}

async function executeConversationLoop<T>(
  request: TurnConversationRequest<T>,
  messages?: MessageTurn,
): Promise<T> {
  const { k, scope, run, agent, opening, reason, role, profileId, schema, signal, options } = request;
  const { task, work: repository } = scope;
  const by = { roleId: role.id, profileId };
  // Every message to the agent and the reply it waits for is one entry in the work log.
  let previousReply: TurnResult | undefined;
  let pendingOpening: string | undefined;
  let inputAttached = false;
  const mayAsk = mayAskScreen(role);
  const browser = run.browser
    ? run.reopened
      ? `Browser capture folder for this turn: ${run.browser.directory}. Earlier pages and browser logins are gone; the same browser and output rules apply.`
      : browserPrompt(run.browser.directory)
    : undefined;

  const send = async (text: string, why: TurnReason, reserved?: ReturnType<typeof takeMessages>) => {
    if (signal.aborted) throw new Aborted();
    if (previousReply) await options.beforeContinue?.(previousReply);
    if (pendingOpening) {
      text = `${pendingOpening}\n\n${text}`;
      pendingOpening = undefined;
    }
    // Reserve at the handoff, after context preparation. Background deduplication must
    // never stand in for delivery, including for notes arriving while context was built.
    const batch =
      reserved
      ?? [
        ...(!inputAttached ? (options.openingMessages ?? []) : []),
        ...(options.main || options.member ? takeMessages(task, options.member, inputAttached ? 12_000 : Infinity) : []),
      ];
    // Stop-and-send can arrive ahead of an opening reservation while its packet is saved.
    batch.sort(
      (a, b) =>
        task.queued.findIndex((message) => message.id === a.id)
        - task.queued.findIndex((message) => message.id === b.id),
    );
    const instructions = batch.length
      ? {
          title: "Messages from the coordinator, in order",
          body: batch.map((message, index) => `${index + 1}. ${message.text}`).join("\n"),
        }
      : undefined;
    if (instructions) {
      text += `\n\n## ${instructions.title}\n${instructions.body}\n\nTake all of them into account. When you are done, end with the result block again.`;
    }
    // The exact text goes to disk once, and the journey keeps its reference, before the agent hears it.
    if (!inputAttached) {
      // Same-step reopens record this send below as an update; fresh starts and
      // returns to earlier conversations show its instructions in the opening sections.
      await options.attachInput(
        scope,
        options.pendingInput?.(),
        text,
        [...(browser ? [{ title: "Browser instructions", body: browser }] : []), ...(instructions ? [instructions] : [])],
        why === "first" && instructions ? [instructions] : [],
      );
      inputAttached = true;
    }
    if (why !== "first") {
      const step = openStep(task);
      if (step?.kind === "agent") {
        let input = step.agentInputs?.findLast(
          (entry) =>
            entry.roleId === role.id && entry.profileId === profileId && entry.reviewerKey === options.reviewerKey,
        );
        if (!input) {
          input = {
            at: Date.now(),
            roleId: role.id,
            profileId,
            ...(options.reviewerKey !== undefined ? { reviewerKey: options.reviewerKey } : {}),
            taskTitle: task.title,
            mode: "continued",
            sections: [],
            sessionId: run.sessionId,
          };
          step.agentInputs = [...(step.agentInputs ?? []), input];
        }
        const exact = await saveExactMessage(k.dataDir, task.id, text);
        if (signal.aborted) throw new Aborted();
        input.updates = [...(input.updates ?? []), { at: Date.now(), reason: why, text, ...(exact ? { exact } : {}) }];
        k.commitNow(scope);
      }
    }
    let reply: TurnResult;
    try {
      messages?.preparePrompt(batch);
      reply = await k.tracking.turn(scope, agent, run, text, why, signal);
    } catch (error) {
      // The turn can stop before this conversation is marked briefed. A full model still has to be reopenable.
      if (error instanceof ModelAtCapacity && options.main) options.markBriefed(scope);
      throw error;
    }
    await messages?.settled(reply);
    previousReply = reply;
    return reply;
  };

  const sendQueued = (batch: ReturnType<typeof takeMessages>) =>
    send("Continue with the coordinator's instructions below.", "message", batch);

  const pending =
    task.maintenance?.role.id === role.id && task.maintenance.settingsDecision?.choice === "keep"
      ? task.maintenance.pendingReply
      : undefined;
  const accepted = pending?.stageId === task.plan?.stages[task.stageIndex]?.id ? pending : undefined;
  const replayedReply: TurnResult | undefined = accepted
    ? { ...accepted, changed: {}, rerouted: false, helpers: 0 }
    : undefined;
  let reply = replayedReply ?? (await send(browser ? `${opening}\n\n${browser}` : opening, reason));
  if (accepted) {
    delete task.maintenance!.pendingReply;
    if (!run.reopened) pendingOpening = browser ? `${opening}\n\n${browser}` : opening;
  }
  // A replacement has not heard its opening yet when it is only replaying an older reply.
  if (options.main && (!accepted || run.reopened)) options.markBriefed(scope);
  for (let repairs = 0; ; ) {
    if (signal.aborted) throw new Aborted();
    // The whole ending is the tool's capacity stop, with no finished result after it. Do not ask for a repair.
    const fullText = ADAPTERS[agent.profile.toolId]?.interruptions?.capacity?.(reply.text, reply.text);
    if (fullText) {
      const full = new ModelAtCapacity(
        agent.profile.toolId,
        agent.profile.modelId ?? agent.profile.model,
        profileId,
        run.sessionId,
      );
      if (fullText.retryAfterMs !== undefined) full.retryAfterMs = fullText.retryAfterMs;
      full.said = reply.text;
      full.streamed = reply.streamed;
      if (options.main) options.markBriefed(scope);
      throw full;
    }
    const current = k.task(task.id);
    if (!current) throw new Aborted();
    const prose = proseOf(reply.text);
    if (prose && !reply.streamed) {
      k.participantSay(
        scope,
        "agent",
        prose.length > 2400 ? `${prose.slice(0, 2400)}…` : prose,
        role.id,
        profileId,
        options.reviewerKey,
      );
    }
    // A streamed reply is already in the conversation. Pictures stay on that report, not on later activity,
    // nor on a peer's words on the same role and profile, which name another start.
    const own =
      openStep(current)?.agentInputs?.findLastIndex(
        (input) =>
          input.roleId === role.id && input.profileId === profileId && input.reviewerKey === options.reviewerKey,
      ) ?? -1;
    const reportLine = prose
      ? reply.streamed
        ? [...current.session]
            .reverse()
            .find(
              (line) =>
                line.from === "agent"
                && line.roleId === role.id
                && line.profileId === profileId
                && (own < 0 || line.inputIndex === undefined || line.inputIndex === own),
            )
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
      } else if (
        !(options.askScreen
          ? options.askScreen(screenReason(parsed.reason))
          : k.askScreen(current, role.id, profileId, screenReason(parsed.reason)))
      ) {
        if (options.main) k.pauseStep(current);
        const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
        if (work?.clock) work.clock = pauseClock(work.clock, Date.now());
        k.commitNow(scope);
        throw new ScreenWait();
      }
      // Given at once, in this conversation: the agent keeps its slot.
      await holdUnconfirmed(k, scope, options.member, signal, options.reviewKey);
      current.screen!.heard = true;
      k.commitNow(scope);
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
      await holdUnconfirmed(k, scope, options.member, signal, options.reviewKey);
      reply = await send("Continue where you left off. When you are done, end with the result block.", "continue");
      continue;
    }
    if (parsed.ok === "input") {
      k.participantSay(scope, "agent", parsed.question, role.id, profileId, options.reviewerKey);
      k.log(scope, "warn", `Asked you: ${parsed.question}`, role.id, profileId);
      const answer = await options.wait({
        scope,
        kind: "question",
        title: parsed.question,
        blocking: true,
        extra: { options: parsed.options },
        signal,
        status: "Waiting for your answer",
        by,
        main: options.main,
        reviewKey: options.reviewKey,
      });
      await holdUnconfirmed(k, scope, options.member, signal, options.reviewKey);
      // Heard from here on: a restart does not hand the answer over again.
      const note = repository.conversation;
      if (note && (options.main || (note.roleId === role.id && note.profileId === profileId))) delete note.asked;
      k.commitNow(scope);
      reply = await send(
        `${heldQuestion ? `Question: ${parsed.question}\n\n` : ""}The coordinator answered: ${answer}\n\nContinue. When you are done, end with the result block.`,
        "answer",
      );
      continue;
    }
    await holdUnconfirmed(k, scope, options.member, signal, options.reviewKey);
    // A recovery decision may explicitly authorize resending. It must reach this
    // participant before its earlier result can finish the step.
    const recovered = options.main || options.member ? takeMessages(current, options.member) : [];
    if (recovered.length) {
      reply = await sendQueued(recovered);
      continue;
    }
    let error: string | undefined;
    if (reportLine) k.pendingReportIds.add(reportLine.id);
    try {
      error =
        parsed.ok === true
          ? await options.check?.(parsed.value)
          : parsed.ok === "screen"
            ? NO_SCREEN_HERE
            : parsed.error;
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
        const storage = join(k.dataDir, "captures", task.id);
        let saved: Awaited<ReturnType<typeof preserveCaptures>> | undefined;
        try {
          if (images.length && !run.browser) {
            throw new Error("This role has no browser capture folder. Omit pictures from this result.");
          }
          saved = run.browser ? await preserveCaptures(run.browser.directory, storage, images, signal) : [];
        } catch (captureError) {
          if (signal.aborted || captureError instanceof Aborted) throw new Aborted();
          error = captureError instanceof Error ? captureError.message : "The chosen pictures could not be saved.";
        }
        if (saved) {
          let attached = false;
          try {
            const live = k.task(current.id) ?? current;
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
            if (options.member) k.screenGroups.get(task.id)?.finished(options.member);
            if (saved.length) {
              let host = reportLine ? live.session.find((line) => line.id === reportLine.id) : undefined;
              if (!host) {
                k.participantSay(
                  live,
                  "agent",
                  reportLine?.text ?? (parsed.value as { summary?: string }).summary ?? "Report ready",
                  role.id,
                  profileId,
                  options.reviewerKey,
                );
                host = live.session.at(-1);
              }
              host!.images = saved;
            }
            const step = openStep(live);
            const inputIndex =
              step?.agentInputs?.findLastIndex(
                (input) =>
                  input.roleId === role.id && input.profileId === profileId && input.reviewerKey === options.reviewerKey,
              ) ?? -1;
            if (step) {
              recordAgentResult(step, {
                roleId: role.id,
                profileId,
                productId: scope.work.productId,
                at: finishedAt,
                value: parsed.value,
                ...(inputIndex >= 0 ? { inputIndex } : {}),
                ...(saved.length ? { images: saved } : {}),
              });
            }
            // The result ends the agent's work. Saving its pictures is Petrina's time.
            if (options.main) k.pauseStep(current, finishedAt);
            const work = options.reviewKey ? current.hunt?.work?.[options.reviewKey] : undefined;
            if (work?.clock) work.clock = pauseClock(work.clock, finishedAt);
            // Durable references are saved before the agent stops or its working copy is cleaned.
            k.commitNow(scope);
            attached = true;
            return parsed.value;
          } finally {
            if (!attached) {
              await Promise.all(saved.map((image) => rm(join(storage, `${image.id}.png`), { force: true })));
            }
          }
        }
      }
    } finally {
      if (reportLine) k.pendingReportIds.delete(reportLine.id);
    }
    await options.beforeContinue?.(reply);
    repairs += 1;
    if (repairs > 2) throw new Error(`${role.name} did not hand back a usable result: ${error}`);
    k.tracking.redo(current, role.id, agent.profile);
    reply = await send(repairPrompt(error ?? ""), "redo");
  }
}
