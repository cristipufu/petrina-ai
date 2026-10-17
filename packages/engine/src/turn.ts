// One agent working one step: opening or reopening its conversation, its instructions, the turns until
// it hands back a valid result, and what it asks the coordinator on the way.

import { limitOf, slotWait, type AgentProfile, type Id, type InboxKind, type Pool, type Product, type Role, type StepNote, type Task, type TurnReason } from "@petrina/core";
import type { z } from "zod";
import { AgentRun, ReopenFailed, type PermissionInfo } from "./acp-run.js";
import * as git from "./git.js";
import { agentEnv } from "./env.js";
import { buildPrompt, continuePrompt, EARLIER_ATTEMPT, OWN_COPY, ownCopy, formatHandBack, formatReviewTakeOver, formatStepNotes, formatTakeOver, formatWhereYouWere, HANDED_BACK, handBackPrompt, lastWords, MAX_DONE, parseResult, proseOf, repairPrompt, restartPrompt, TOOK_OVER, WHERE_YOU_WERE, type WhereYouWere } from "./prompts.js";
import { UsageLimited, WaitingForUsage } from "./usage.js";
import { ADAPTERS } from "./tools.js";
import { Kernel, Aborted, type MTask } from "./kernel.js";
import type { TurnAgent } from "./tracking.js";
import { WaitClock } from "./worklog.js";

/** Turns a valid but incomplete result into what the agent is asked to repair, or undefined when it is complete. */
type Check<T> = (value: T) => string | undefined | Promise<string | undefined>;

/** `used` hears which profile worked each attempt: a stand-in when the planned one was out of usage. */
interface TurnOptions<T> {
  status?: string;
  check?: Check<T>;
  resume?: { sessionId: string; toolId: Id; model: string };
  used?: (profileId: Id) => void;
}

export class Turns {
  constructor(private readonly k: Kernel) {}

  /**
   * One agent, one stage: run turns until it hands back a valid result. `status` keeps the task's
   * status line fixed while the agent works; `check` turns a valid but incomplete result into a repair.
   * `given` builds the opening instructions' sections, only when a fresh conversation gets them.
   * After a restart, the step's agent picks up its own conversation when the tool can reopen it.
   * `resume` names an earlier step's conversation to go back to (same tool and model): the agent keeps what
   * it knew there, compactions and all, and hears only its job now. When it cannot reopen, a fresh one starts.
   * The profile is the planned one: while its tool or model is out of usage another works the step (see
   * `Kernel.choose`). An agent that runs out in the middle hands over to that stand-in in a fresh conversation,
   * told what the first one did and said; with no stand-in the task waits, and the first agent's conversation
   * is reopened when a limit ends.
   */
  async turn<T>(task: MTask, roleId: Id, plannedId: Id, given: () => { title: string; body: string }[], schema: z.ZodType<T>, signal: AbortSignal, options: TurnOptions<T> = {}): Promise<T> {
    if (!this.k.role(roleId) || !this.k.productOf(task) || !this.k.profile(plannedId)) throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
    let stopped: { profileId: Id; error: UsageLimited } | undefined;
    for (;;) {
      const choice = this.k.choose(plannedId, task, roleId, (toolId) => !slotWait(this.k.getState(), { taskId: task.id, toolId }))!;
      if (choice.kind === "none") {
        // Stopped by a limit and waiting for the reset: the step's next attempt is a retry.
        if (stopped) this.k.tracking.owesRetry(task, roleId, plannedId);
        this.k.waitForUsage(task, choice.waiting);
        throw new WaitingForUsage(choice.waiting);
      }
      const { profile } = choice;
      // The tool said it was out while running something it should not have limited: the step cannot go on.
      if (stopped?.profileId === profile.id) throw stopped.error;
      if (stopped && this.k.profile(stopped.profileId)?.toolId !== profile.toolId) {
        // Another tool's seat: it qualifies for a slot like any agent.
        const wait = slotWait(this.k.getState(), { taskId: task.id, toolId: profile.toolId });
        if (wait) {
          this.k.tracking.owesRetry(task, roleId, plannedId);
          this.k.waitForUsage(task, wait);
          throw new WaitingForUsage(wait);
        }
      }
      this.k.tracking.attempt(task, roleId, plannedId, profile, stopped !== undefined);
      options.used?.(profile.id);
      // Said where the coordinator will see it: a security review that could not stay off the builder's tool.
      const builder = this.k.profile(task.plan?.stages.find((stage) => stage.roleId === "builder")?.profileIds[0] ?? "");
      if (roleId === "security-reviewer" && choice.kind === "substitute" && builder?.toolId === profile.toolId && !task.timeline.some((entry) => entry.text.startsWith("Security review on the builder's tool"))) {
        this.k.log(task, "warn", `Security review on the builder's tool (${this.k.named(profile.id)}): ${this.k.named(plannedId)} is out of usage, and no other tool is free`);
      }
      try {
        return await this.attempt(task, roleId, profile, given, schema, signal, options);
      } catch (error) {
        if (!(error instanceof UsageLimited) || signal.aborted) throw error;
        this.keepWords(task, roleId, profile.id, error);
        this.k.recordLimit(task, roleId, profile.id, error);
        stopped = { profileId: profile.id, error };
      }
    }
  }

  /** What an agent had said when it ran out of usage joins the session, so the one taking over can be told. */
  private keepWords(task: MTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    const prose = error.said ? proseOf(error.said) : undefined;
    if (prose) this.k.say(task, "agent", prose.length > 2400 ? `${prose.slice(0, 2400)}…` : prose, roleId, profileId);
  }

  /** An agent's last messages in a step, most recent first, as many as fit. */
  private lastWords(task: MTask, roleId: Id, profileId: Id, since: number): string {
    return lastWords(
      task.session
        .filter((line) => line.from === "agent" && line.roleId === roleId && line.profileId === profileId && line.at >= since)
        .map((line) => line.text)
        .reverse(),
    );
  }

  /** One attempt at the step by one agent on one profile. */
  private async attempt<T>(task: MTask, roleId: Id, profile: AgentProfile, given: () => { title: string; body: string }[], schema: z.ZodType<T>, signal: AbortSignal, options: TurnOptions<T>): Promise<T> {
    const role = this.k.role(roleId);
    const product = this.k.productOf(task);
    if (!role || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profile.id}`);
    const profileId = profile.id;
    const taskId = task.id;
    // Paused, cancelled or stopped while getting here: no agent starts, and the task stays as the coordinator left it.
    if (signal.aborted) throw new Aborted();

    // A conversation noted before a restart: the same step and role carry on from where it was. Only the
    // same tool and model reopen it, and never the Release Manager: interrupted shipping is checked first.
    const step = this.stepKey(task);
    const model = profile.modelId ?? profile.model;
    const saved = task.conversation;
    const same = saved && saved.step === step && saved.roleId === roleId ? saved : undefined;
    // A conversation that never showed it got its instructions (Petrina stopped in between) starts again instead.
    const reopen = same && same.briefed && roleId !== "release-manager" && same.toolId === profile.toolId && same.model === model ? same : undefined;
    let again = saved && !reopen ? (same ? (same.briefed || roleId === "release-manager" ? "it now runs on a different tool or model" : "it had not received its instructions yet") : "the saved conversation was for another step") : undefined;
    // Back to an earlier step's conversation, unless this step already has one of its own.
    const back = !saved && options.resume?.toolId === profile.toolId && options.resume.model === model ? options.resume : undefined;
    const startedAt = same?.startedAt ?? Date.now();
    // Handed back by the coordinator: the note of what changed, until the agent hears it.
    const handback = same?.handback;
    // An agent that ran out of usage in this step is who this one takes over from.
    const before = same && !reopen && !back ? this.k.profile(same.profileId) : undefined;
    const tookOver = before && limitOf(this.k.getState().pool as Pool, before, Date.now()) ? before : undefined;
    task.stepAttempts = (task.stepAttempts ?? 0) + 1;

    task.agent = { roleId, profileId, since: Date.now(), step: 0 };
    task.state = "running";
    task.holdsSlot = true;
    task.column = this.k.columnFor(task);
    if (saved) {
      task.statusLine = options.status ?? `${role.name} is getting back to work`;
    } else {
      task.statusLine = options.status ?? `${role.name} is starting`;
      this.k.say(task, "system", `${role.name} joined · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", `${role.name} started`, roleId, profileId);
    }
    this.k.commitNow();

    const live = () => this.k.task(taskId);
    const env = this.envFor();
    // How its turns are written down in the work log, with its own waits for the coordinator left out of its time.
    const agent: TurnAgent = { roleId, profile, waits: new WaitClock() };
    // The working copy as the step first found it: what the summary compares with, and what a read-only role leaves.
    const head = same?.head ?? (task.worktree ? await git.head(task.worktree).catch(() => undefined) : undefined);
    // Tests: the command is asked for every agent process, so a test can tell a reopen attempt from the fresh start after it.
    const start = (sessionId?: string, command = this.k.options.agentCommand?.(profile)) =>
      AgentRun.start({
        profile,
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
        cwd: task.worktree!,
        signal,
        ...(sessionId ? { reopen: sessionId, ...(this.k.options.reopenTimeoutMs ? { reopenTimeoutMs: this.k.options.reopenTimeoutMs } : {}) } : {}),
        ...(this.k.options.startTimeoutMs ? { startTimeoutMs: this.k.options.startTimeoutMs } : {}),
        callbacks: {
          onActivity: (line) => {
            const current = live();
            if (current) this.briefed(current);
            if (!current || current.state !== "running") return;
            current.statusLine = options.status ?? line;
            this.k.say(current, "activity", line, roleId, profileId);
            this.k.commit();
          },
          onPlanStep: (line) => {
            const current = live();
            if (!current) return;
            this.briefed(current);
            if (current.state === "running") current.statusLine = options.status ?? line;
            if (current.timeline.at(-1)?.text !== line) this.k.log(current, "status", line, roleId, profileId);
            this.k.commit();
          },
          onPermission: (info) => this.permission(taskId, info, signal, { roleId, profileId }, agent.waits),
          onLog: (text) => void this.k.agentLog(taskId, text),
          onUsage: (info) => this.k.recordUsage(info),
        },
      });
    let run: AgentRun | undefined;
    let notBack: string | undefined;
    if (reopen ?? back) {
      try {
        run = await start((reopen ?? back)!.sessionId);
      } catch (error) {
        if (signal.aborted || !(error instanceof ReopenFailed)) throw error;
        if (reopen) again = error.message;
        else notBack = error.message;
      }
    }
    run ??= await start();
    this.k.runs.set(taskId, run);
    const picked = run.reopened !== undefined;
    const wentBack = picked && !reopen && back !== undefined;
    const where = saved ? this.whereYouWere(task, role, startedAt) : undefined;
    if (wentBack) {
      this.k.say(task, "system", `${role.name} went back to its own conversation from the last step · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", "Went back to its own conversation from the last step", roleId, profileId);
    } else if (back) {
      this.k.log(task, "milestone", `Could not go back to its own conversation (${notBack ?? "the tool did not reopen it"}), so it started a fresh one with what it reported`, roleId, profileId);
    }
    if (wentBack) {
      // Said above.
    } else if (picked && handback) {
      this.k.say(task, "system", `${role.name} took the step back on the same conversation · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", "Took the step back on the same conversation", roleId, profileId);
    } else if (handback) {
      this.k.say(task, "system", `${role.name} carried on in a fresh conversation, with your note, because the one you drove could not be reopened · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", `Carried on in a fresh conversation: ${again}`, roleId, profileId);
    } else if (picked) {
      this.k.say(task, "system", `${role.name} picked up where it left off · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", "Picked up where it left off", roleId, profileId);
    } else if (tookOver) {
      const words = `${role.name} on ${this.k.named(profileId)} took over from ${this.k.named(tookOver.id)}, which ran out of usage`;
      this.k.say(task, "system", words, roleId, profileId);
      this.k.log(task, "milestone", words, roleId, profileId);
    } else if (saved) {
      this.k.say(task, "system", `${role.name} started this step again · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", `Started this step again: ${again}`, roleId, profileId);
    }
    // On disk before the agent gets any work, so a restart from here on can reopen it. A fresh one replaces
    // the old note; a reopened one keeps the open question until the conversation hears the answer.
    const asked = picked ? reopen?.asked : undefined;
    if (roleId !== "release-manager") task.conversation = { step, roleId, profileId, toolId: profile.toolId, model, sessionId: run.sessionId, ...(head ? { head } : {}), startedAt, ...(asked ? { asked } : {}), ...(picked ? { briefed: true } : {}), ...(picked && handback ? { handback } : {}) };
    this.k.commitNow();
    const headBefore = !role.canEdit ? head : undefined;
    try {
      // The last moment to notice a pause before the agent gets any work.
      if (signal.aborted || !live()) throw new Aborted();
      let opening: string;
      if (wentBack) {
        // Its job as it stands now and the context, from the same sections a fresh conversation gets.
        opening = continuePrompt({ task: task as unknown as Task, product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.k.s.profiles as AgentProfile[], worktree: task.worktree!, branch: task.branch!, base: task.baseSha ?? task.base!, defaultBranch: product.defaultBranch ?? "main", sections: given() });
      } else if (picked) {
        // One line about the restart (or the hand back), then only what the conversation has not heard: the answer to its open question, and messages still in line.
        const answer = asked?.answer !== undefined ? { question: asked.question, text: asked.answer } : undefined;
        if (task.conversation) {
          delete task.conversation.asked;
          delete task.conversation.handback;
        }
        const messages = task.queued.splice(0);
        for (const message of messages) {
          this.k.say(task, "you", message.text);
          this.k.log(task, "you", `You said: ${message.text}`);
        }
        const texts = messages.map((message) => message.text);
        opening = handback ? handBackPrompt(handback, texts) : restartPrompt(where!, { ...(answer ? { answer } : {}), messages: texts });
      } else {
        // Starting the step again: everything the coordinator said in it so far, in order, and after a restart, where it was.
        const files = where && !handback && head && task.worktree ? await git.changedSince(task.worktree, head) : [];
        if (signal.aborted || !live()) throw new Aborted();
        const earlier = task.stepAttempts > 1 ? ((task.stepNotes ?? []) as StepNote[]) : [];
        if (earlier.length) this.k.log(task, "you", `Handed on ${earlier.length} thing${earlier.length === 1 ? "" : "s"} you said in an earlier attempt at this step`, roleId, profileId);
        const sections = [...given()];
        if (earlier.length) sections.push({ title: EARLIER_ATTEMPT, body: formatStepNotes(earlier) });
        if (handback) sections.push({ title: HANDED_BACK, body: formatHandBack(handback, again ?? "") });
        else if (where && tookOver) sections.push({ title: TOOK_OVER, body: formatTakeOver({ ...where, files }, this.k.named(tookOver.id), this.lastWords(task, roleId, tookOver.id, startedAt)) });
        else if (where) sections.push({ title: WHERE_YOU_WERE, body: formatWhereYouWere({ ...where, files }, again ?? "") });
        opening = buildPrompt({ task: task as unknown as Task, product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.k.s.profiles as AgentProfile[], worktree: task.worktree!, branch: task.branch!, base: task.baseSha ?? task.base!, defaultBranch: product.defaultBranch ?? "main", sections });
      }
      // What it is about to hear is on disk first: a restart after this does not hand it over again.
      this.k.commitNow();
      // A reopened conversation carries on after the interruption; a fresh one gets its first instructions.
      return await this.converse(task, run, agent, opening, picked && !wentBack ? "continue" : "first", role, profileId, schema, signal, { ...options, main: true });
    } finally {
      this.k.runs.delete(taskId);
      run.close();
      // A read-only role runs in its tool's automatic mode, so it could change things: leave the
      // working copy exactly as the step first found it, commits and uncommitted changes alike.
      if (headBefore && task.worktree && (await git.head(task.worktree).catch(() => headBefore)) !== headBefore) {
        await git.resetTo(task.worktree, headBefore);
        this.k.log(task, "warn", `Undid commits from ${role.name}, which is read-only`);
      }
      if (!role.canEdit && task.worktree && !(await git.isClean(task.worktree).catch(() => true))) {
        await git.discardChanges(task.worktree);
        this.k.log(task, "warn", `Undid changes from ${role.name}, which is read-only`);
      }
    }
  }

  /**
   * One agent working beside others on the same step (reviewers looking at once, voters), in a working copy
   * of its own (`copy`) so none disturbs another: always a fresh conversation, never reopened after a
   * restart, so the caller saves what it hands back as it arrives. It keeps no notes on the task and leaves
   * the status line to its group.
   */
  async parallel<T>(
    task: MTask,
    roleId: Id,
    plannedId: Id,
    copy: string,
    given: () => { title: string; body: string }[],
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: { check?: Check<T>; used?: (profileId: Id) => void; room?: (toolId: Id) => boolean; seat?: Id } = {},
  ): Promise<T> {
    if (!this.k.role(roleId) || !this.k.productOf(task) || !this.k.profile(plannedId)) throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
    if (signal.aborted) throw new Aborted();
    // Out of usage: a stand-in looks at the change instead, told what the first one had said. With none, the
    // group (not this agent) makes the task wait: the others carry on, and this one is left for later.
    let stopped: { profileId: Id; error: UsageLimited; at: number } | undefined;
    // The group already reserved `seat` (the card shows it). Choosing again after that reservation sees a
    // full pool and would start the first full stand-in instead, so the first attempt uses the reserved profile.
    let first = true;
    for (;;) {
      const accepted = first && options.seat ? this.k.profile(options.seat) : undefined;
      first = false;
      let profile: AgentProfile;
      if (accepted) profile = accepted;
      else {
        const choice = this.k.choose(plannedId, task, roleId, options.room);
        if (!choice) throw new Error(`Unknown role or profile: ${roleId} on ${plannedId}`);
        if (choice.kind === "none") {
          // The group waits, and this agent is started again after: that attempt is a retry.
          if (stopped) this.k.tracking.owesRetry(task, roleId, plannedId);
          throw new WaitingForUsage(choice.waiting);
        }
        profile = choice.profile;
      }
      // A later stand-in still has to fit the seat this member already holds. With no room, the group waits.
      if (stopped && options.room && !options.room(profile.toolId)) {
        const tool = this.k.s.tools.find((entry) => entry.id === profile.toolId)?.name ?? profile.toolId;
        this.k.tracking.owesRetry(task, roleId, plannedId);
        throw new WaitingForUsage(`Waiting for a free ${tool} slot`);
      }
      if (stopped && stopped.profileId === profile.id) throw stopped.error;
      this.k.tracking.attempt(task, roleId, plannedId, profile, stopped !== undefined);
      options.used?.(profile.id);
      const since = Date.now();
      try {
        return await this.attemptTogether(task, roleId, profile, copy, given, schema, signal, { ...options, ...(stopped ? { took: { from: this.k.named(stopped.profileId), words: this.lastWords(task, roleId, stopped.profileId, stopped.at) } } : {}) });
      } catch (error) {
        if (!(error instanceof UsageLimited) || signal.aborted) throw error;
        this.keepWords(task, roleId, profile.id, error);
        this.k.recordLimit(task, roleId, profile.id, error);
        stopped = { profileId: profile.id, error, at: since };
      }
    }
  }

  /** One attempt of a parallel agent. `took`: whom it takes over from, and what that agent had said. */
  private async attemptTogether<T>(task: MTask, roleId: Id, profile: AgentProfile, copy: string, given: () => { title: string; body: string }[], schema: z.ZodType<T>, signal: AbortSignal, options: { check?: Check<T>; took?: { from: string; words: string } }): Promise<T> {
    const role = this.k.role(roleId);
    const product = this.k.productOf(task);
    if (!role || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profile.id}`);
    const profileId = profile.id;
    const taskId = task.id;
    if (options.took) {
      const words = `${role.name} on ${this.k.named(profileId)} took over from ${options.took.from}, which ran out of usage`;
      this.k.say(task, "system", words, roleId, profileId);
      this.k.log(task, "milestone", words, roleId, profileId);
    } else {
      this.k.say(task, "system", `${role.name} joined · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", `${role.name} started`, roleId, profileId);
    }
    this.k.commit();
    const agent: TurnAgent = { roleId, profile, waits: new WaitClock() };
    const command = this.k.options.agentCommand?.(profile);
    const run = await AgentRun.start({
      profile,
      ...(command ? { command } : {}),
      env: this.envFor(),
      cwd: copy,
      signal,
      ...(this.k.options.startTimeoutMs ? { startTimeoutMs: this.k.options.startTimeoutMs } : {}),
      callbacks: {
        onActivity: (line) => {
          const current = this.k.task(taskId);
          if (!current) return;
          this.k.say(current, "activity", line, roleId, profileId);
          this.k.commit();
        },
        onPlanStep: (line) => {
          const current = this.k.task(taskId);
          if (current && !current.timeline.slice(-5).some((entry) => entry.text === line && entry.profileId === profileId)) this.k.log(current, "status", line, roleId, profileId);
          this.k.commit();
        },
        onPermission: (info) => this.permission(taskId, info, signal, { roleId, profileId }, agent.waits),
        onLog: (text) => void this.k.agentLog(taskId, text),
        onUsage: (info) => this.k.recordUsage(info),
      },
    });
    const runs = this.k.helperRuns.get(taskId) ?? new Set();
    this.k.helperRuns.set(taskId, runs.add(run));
    try {
      if (signal.aborted || !this.k.task(taskId)) throw new Aborted();
      const sections = [...given(), { title: OWN_COPY, body: ownCopy(await git.head(copy).catch(() => "")) }];
      if (options.took) sections.push({ title: TOOK_OVER, body: formatReviewTakeOver(options.took.from, options.took.words) });
      const opening = buildPrompt({ task: task as unknown as Task, product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.k.s.profiles as AgentProfile[], worktree: copy, branch: task.branch!, base: task.baseSha ?? task.base!, defaultBranch: product.defaultBranch ?? "main", sections });
      return await this.converse(task, run, agent, opening, "first", role, profileId, schema, signal, { ...options, main: false });
    } finally {
      runs.delete(run);
      run.close();
    }
  }

  /**
   * Turns until the agent hands back a valid result: its words go to the session, its questions to the
   * coordinator, and an unusable result back to it twice at most. Only the step's main agent hears the
   * coordinator's messages as they come and keeps its open question across a restart.
   */
  private async converse<T>(task: MTask, run: AgentRun, agent: TurnAgent, opening: string, reason: TurnReason, role: Role, profileId: Id, schema: z.ZodType<T>, signal: AbortSignal, options: { check?: Check<T>; main: boolean }): Promise<T> {
    const by = { roleId: role.id, profileId };
    // Every message to the agent and the reply it waits for is one entry in the work log.
    const send = (text: string, why: TurnReason) => this.k.tracking.turn(this.k.task(task.id) ?? task, agent, run, text, why, signal);
    let reply = await send(opening, reason);
    if (options.main) this.briefed(task);
    for (let repairs = 0; ; ) {
      if (signal.aborted) throw new Aborted();
      const current = this.k.task(task.id);
      if (!current) throw new Aborted();
      const prose = proseOf(reply.text);
      if (prose) this.k.say(current, "agent", prose.length > 2400 ? `${prose.slice(0, 2400)}…` : prose, role.id, profileId);
      const message = options.main ? current.queued.shift() : undefined;
      if (message) {
        this.k.say(current, "you", message.text);
        this.k.log(current, "you", `You said: ${message.text}`);
        this.k.commitNow();
        reply = await send(`Message from the coordinator: ${message.text}\n\nTake it into account. When you are done, end with the result block again.`, "message");
        continue;
      }
      if (reply.stopReason === "cancelled") {
        reply = await send("Continue where you left off. When you are done, end with the result block.", "continue");
        continue;
      }
      const parsed = parseResult(reply.text, schema);
      if (parsed.ok === "input") {
        this.k.say(current, "agent", parsed.question, role.id, profileId);
        this.k.log(current, "warn", `Asked you: ${parsed.question}`, role.id, profileId);
        const answer = await this.wait(current, "question", parsed.question, true, { options: parsed.options }, signal, "Waiting for your answer", by, options.main);
        // Heard from here on: a restart does not hand the answer over again.
        if (options.main && current.conversation) delete current.conversation.asked;
        this.k.commitNow();
        reply = await send(`The coordinator answered: ${answer}\n\nContinue. When you are done, end with the result block.`, "answer");
        continue;
      }
      const error = parsed.ok === true ? await options.check?.(parsed.value) : parsed.error;
      if (parsed.ok === true && !error) return parsed.value;
      repairs += 1;
      if (repairs > 2) throw new Error(`${role.name} did not hand back a usable result: ${error}`);
      this.k.tracking.redo(current, role.id, agent.profile);
      reply = await send(repairPrompt(error ?? ""), "redo");
    }
  }

  /**
   * What every agent runs with: the coordinator's own environment and logins, with nothing waiting for a typed
   * answer, in the background (tools that would pop a browser tab stay quiet, and Petrina's own `open` refuses).
   */
  private envFor(): NodeJS.ProcessEnv {
    return agentEnv(process.env);
  }

  /** The tool's own safety check flagged something: the coordinator decides. Petrina adds no rules of its own. */
  private async permission(taskId: Id, info: PermissionInfo, signal: AbortSignal, by: { roleId: Id; profileId: Id }, waits: WaitClock): Promise<"allow" | "deny"> {
    const task = this.k.task(taskId);
    if (!task) return "deny";
    const tool = ADAPTERS[this.k.profile(by.profileId)?.toolId ?? ""]?.name ?? "The agent's tool";
    const detail = info.command ?? info.paths.join("\n");
    const main = task.agent?.profileId === by.profileId && task.agent.roleId === by.roleId;
    // Waiting for the coordinator is not agent work: the wait is left out of the turn's working time.
    waits.start(taskId);
    try {
      const answer = await this.wait(task, "permission", info.title, true, { body: `${tool}'s own safety check wants your OK before this.`, ...(detail ? { detail } : {}) }, signal, "Waiting for your permission", by, main);
      return answer === "allow" ? "allow" : "deny";
    } finally {
      waits.stop(taskId);
    }
  }

  private wait(task: MTask, kind: InboxKind, title: string, blocking: boolean, extra: { body?: string; options?: string[]; detail?: string }, signal: AbortSignal, status: string, by: { roleId: Id; profileId: Id }, main: boolean): Promise<string> {
    const id = this.k.raise(task, kind, title, blocking, extra, by);
    task.statusLine = status;
    if (kind === "question" && main && task.conversation) {
      // A question survives a restart for the conversation that asked it.
      task.conversation.asked = { itemId: id, question: title };
      this.k.commitNow();
    } else {
      this.k.commit();
    }
    return new Promise<string>((resolve, reject) => {
      this.k.waiting.set(id, { resolve, reject });
      signal.addEventListener("abort", () => reject(new Aborted()), { once: true });
    });
  }

  /** Which step a task is on: its stage (or the plan), the design round and the reviewer position. */
  private stepKey(task: MTask): string {
    if (task.stageIndex < 0) return "plan";
    const stage = task.plan?.stages[task.stageIndex];
    return `${stage?.id ?? task.stageIndex} round ${stage ? (task.rounds[stage.id] ?? 1) : 1} position ${task.sub}${task.fixing ? " fixing" : ""}`;
  }

  /** The step in the coordinator's words, for an agent coming back to it. */
  private stepTitle(task: MTask): string {
    if (task.stageIndex < 0) return "Planning";
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return "this step";
    if (stage.kind === "converge") return `${stage.title}, round ${task.rounds[stage.id] ?? 1}`;
    if (stage.kind === "review-chain") return `${stage.title}, round ${task.rounds[stage.id] ?? 1}`;
    return task.fixing ? `${stage.title}, fixing review findings` : stage.title;
  }

  /** Where an agent was in its step: the stage, its role, and its last activity and plan steps since the step started. */
  private whereYouWere(task: MTask, role: Role, since: number): WhereYouWere {
    const done = [
      ...task.session.filter((line) => line.from === "activity" && line.roleId === role.id && line.at >= since),
      ...task.timeline.filter((entry) => entry.tone === "status" && entry.roleId === role.id && entry.at >= since),
    ]
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.text)
      .filter((text, index, all) => text !== all[index - 1]);
    return { stage: this.stepTitle(task), role: role.name, done: done.slice(-MAX_DONE) };
  }

  /** The agent showed it has its instructions: from now on a restart may reopen its conversation. */
  private briefed(task: MTask): void {
    if (!task.conversation || task.conversation.briefed) return;
    task.conversation.briefed = true;
    this.k.commitNow();
  }
}
