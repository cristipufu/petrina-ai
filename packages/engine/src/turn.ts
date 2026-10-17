// One agent working one step: opening or reopening its conversation, its instructions, the turns until
// it hands back a valid result, and what it asks the coordinator on the way.

import type { AgentProfile, Id, InboxKind, Product, Role, StepNote, Task } from "@petrina/core";
import type { z } from "zod";
import { AgentRun, ReopenFailed, type PermissionInfo } from "./acp-run.js";
import * as git from "./git.js";
import { agentEnv } from "./env.js";
import { buildPrompt, EARLIER_ATTEMPT, formatHandBack, formatStepNotes, formatWhereYouWere, HANDED_BACK, handBackPrompt, MAX_DONE, parseResult, proseOf, repairPrompt, restartPrompt, WHERE_YOU_WERE, type WhereYouWere } from "./prompts.js";
import { ADAPTERS } from "./tools.js";
import { Kernel, Aborted, type MTask } from "./kernel.js";

export class Turns {
  constructor(private readonly k: Kernel) {}

  /**
   * One agent, one stage: run turns until it hands back a valid result. `status` keeps the task's
   * status line fixed while the agent works; `check` turns a valid but incomplete result into a repair.
   * `given` builds the opening instructions' sections, only when a fresh conversation gets them.
   * After a restart, the step's agent picks up its own conversation when the tool can reopen it.
   */
  async turn<T>(
    task: MTask,
    roleId: Id,
    profileId: Id,
    given: () => { title: string; body: string }[],
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: { status?: string; check?: (value: T) => string | undefined } = {},
  ): Promise<T> {
    const role = this.k.role(roleId);
    const profile = this.k.profile(profileId);
    const product = this.k.productOf(task);
    if (!role || !profile || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profileId}`);
    const taskId = task.id;
    // Paused, cancelled or stopped while getting here: no agent starts, and the task stays as the coordinator left it.
    if (signal.aborted) throw new Aborted();

    // A conversation noted before a restart: the same step and role carry on from where it was. Only the
    // same tool and model reopen it, and never the shipper: interrupted shipping is checked first.
    const step = this.stepKey(task);
    const model = profile.modelId ?? profile.model;
    const saved = task.conversation;
    const same = saved && saved.step === step && saved.roleId === roleId ? saved : undefined;
    // A conversation that never showed it got its instructions (Petrina stopped in between) starts again instead.
    const reopen = same && same.briefed && roleId !== "shipper" && same.toolId === profile.toolId && same.model === model ? same : undefined;
    let again = saved && !reopen ? (same ? (same.briefed || roleId === "shipper" ? "it now runs on a different tool or model" : "it had not received its instructions yet") : "the saved conversation was for another step") : undefined;
    const startedAt = same?.startedAt ?? Date.now();
    // Handed back by the coordinator: the note of what changed, until the agent hears it.
    const handback = same?.handback;
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
    const command = this.k.options.agentCommand?.(profile);
    const env = await this.envFor(task, roleId);
    // The working copy as the step first found it: what the summary compares with, and what a read-only role leaves.
    const head = same?.head ?? (task.worktree ? await git.head(task.worktree).catch(() => undefined) : undefined);
    const start = (sessionId?: string) =>
      AgentRun.start({
        profile,
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
        cwd: task.worktree!,
        signal,
        ...(sessionId ? { reopen: sessionId, ...(this.k.options.reopenTimeoutMs ? { reopenTimeoutMs: this.k.options.reopenTimeoutMs } : {}) } : {}),
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
          onPermission: (info) => this.permission(taskId, info, signal, { roleId, profileId }),
          onLog: (text) => void this.k.agentLog(taskId, text),
        },
      });
    let run: AgentRun | undefined;
    if (reopen) {
      try {
        run = await start(reopen.sessionId);
      } catch (error) {
        if (signal.aborted || !(error instanceof ReopenFailed)) throw error;
        again = error.message;
      }
    }
    run ??= await start();
    this.k.runs.set(taskId, run);
    const picked = run.reopened !== undefined;
    const where = saved ? this.whereYouWere(task, role, startedAt) : undefined;
    if (picked && handback) {
      this.k.say(task, "system", `${role.name} took the step back on the same conversation · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", "Took the step back on the same conversation", roleId, profileId);
    } else if (handback) {
      this.k.say(task, "system", `${role.name} carried on in a fresh conversation, with your note, because the one you drove could not be reopened · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", `Carried on in a fresh conversation: ${again}`, roleId, profileId);
    } else if (picked) {
      this.k.say(task, "system", `${role.name} picked up where it left off · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", "Picked up where it left off", roleId, profileId);
    } else if (saved) {
      this.k.say(task, "system", `${role.name} started this step again · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
      this.k.log(task, "milestone", `Started this step again: ${again}`, roleId, profileId);
    }
    // On disk before the agent gets any work, so a restart from here on can reopen it. A fresh one replaces
    // the old note; a reopened one keeps the open question until the conversation hears the answer.
    const asked = picked ? reopen?.asked : undefined;
    if (roleId !== "shipper") task.conversation = { step, roleId, profileId, toolId: profile.toolId, model, sessionId: run.sessionId, ...(head ? { head } : {}), startedAt, ...(asked ? { asked } : {}), ...(picked ? { briefed: true } : {}), ...(picked && handback ? { handback } : {}) };
    this.k.commitNow();
    const headBefore = !role.canEdit ? head : undefined;
    try {
      // The last moment to notice a pause before the agent gets any work.
      if (signal.aborted || !live()) throw new Aborted();
      let opening: string;
      if (picked) {
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
        else if (where) sections.push({ title: WHERE_YOU_WERE, body: formatWhereYouWere({ ...where, files }, again ?? "") });
        opening = buildPrompt({ task: task as unknown as Task, product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.k.s.profiles as AgentProfile[], worktree: task.worktree!, branch: task.branch!, base: task.baseSha ?? task.base!, defaultBranch: product.defaultBranch ?? "main", sections });
      }
      // What it is about to hear is on disk first: a restart after this does not hand it over again.
      this.k.commitNow();
      return await this.converse(task, run, opening, role, profileId, schema, signal, { ...options, main: true });
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
   * One agent working beside others on the same step (reviewers looking at once, voters): always a fresh
   * conversation, never reopened after a restart, so the caller saves what it hands back as it arrives.
   * It keeps no notes on the task, leaves the status line to its group, and the group cleans up after it.
   */
  async parallel<T>(
    task: MTask,
    roleId: Id,
    profileId: Id,
    given: () => { title: string; body: string }[],
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: { check?: (value: T) => string | undefined } = {},
  ): Promise<T> {
    const role = this.k.role(roleId);
    const profile = this.k.profile(profileId);
    const product = this.k.productOf(task);
    if (!role || !profile || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profileId}`);
    if (signal.aborted) throw new Aborted();
    const taskId = task.id;
    this.k.say(task, "system", `${role.name} joined · ${this.k.describe(roleId, profileId)}`, roleId, profileId);
    this.k.log(task, "milestone", `${role.name} started`, roleId, profileId);
    this.k.commit();
    const command = this.k.options.agentCommand?.(profile);
    const run = await AgentRun.start({
      profile,
      ...(command ? { command } : {}),
      env: await this.envFor(task, roleId),
      cwd: task.worktree!,
      signal,
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
        onPermission: (info) => this.permission(taskId, info, signal, { roleId, profileId }),
        onLog: (text) => void this.k.agentLog(taskId, text),
      },
    });
    const runs = this.k.helperRuns.get(taskId) ?? new Set();
    this.k.helperRuns.set(taskId, runs.add(run));
    try {
      if (signal.aborted || !this.k.task(taskId)) throw new Aborted();
      const opening = buildPrompt({ task: task as unknown as Task, product: product as Product, role, roles: this.k.s.roles as Role[], profiles: this.k.s.profiles as AgentProfile[], worktree: task.worktree!, branch: task.branch!, base: task.baseSha ?? task.base!, defaultBranch: product.defaultBranch ?? "main", sections: given() });
      return await this.converse(task, run, opening, role, profileId, schema, signal, { ...options, main: false });
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
  private async converse<T>(task: MTask, run: AgentRun, opening: string, role: Role, profileId: Id, schema: z.ZodType<T>, signal: AbortSignal, options: { check?: (value: T) => string | undefined; main: boolean }): Promise<T> {
    const by = { roleId: role.id, profileId };
    let reply = await run.prompt(opening);
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
        reply = await run.prompt(`Message from the coordinator: ${message.text}\n\nTake it into account. When you are done, end with the result block again.`);
        continue;
      }
      if (reply.stopReason === "cancelled") {
        reply = await run.prompt("Continue where you left off. When you are done, end with the result block.");
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
        reply = await run.prompt(`The coordinator answered: ${answer}\n\nContinue. When you are done, end with the result block.`);
        continue;
      }
      const error = parsed.ok === true ? options.check?.(parsed.value) : parsed.error;
      if (parsed.ok === true && !error) return parsed.value;
      repairs += 1;
      if (repairs > 2) throw new Error(`${role.name} did not hand back a usable result: ${error}`);
      reply = await run.prompt(repairPrompt(error ?? ""));
    }
  }

  /** What an agent runs with. GitHub credentials only for a shipper that publishes to GitHub; local delivery needs none. */
  private async envFor(task: MTask, roleId: Id): Promise<NodeJS.ProcessEnv> {
    const base = roleId === "shipper" && task.delivery !== "local" ? process.env : agentEnv(process.env, await this.k.emptyGhConfig());
    // Agents work in the background: tools that would pop a browser tab stay quiet, and Petrina's own `open` refuses.
    return { ...base, BROWSER: "none", PETRINA_AGENT: "1" };
  }

  /** The tool's own safety check flagged something: the coordinator decides. Petrina adds no rules of its own. */
  private async permission(taskId: Id, info: PermissionInfo, signal: AbortSignal, by: { roleId: Id; profileId: Id }): Promise<"allow" | "deny"> {
    const task = this.k.task(taskId);
    if (!task) return "deny";
    const tool = ADAPTERS[this.k.profile(by.profileId)?.toolId ?? ""]?.name ?? "The agent's tool";
    const detail = info.command ?? info.paths.join("\n");
    const main = task.agent?.profileId === by.profileId && task.agent.roleId === by.roleId;
    const answer = await this.wait(task, "permission", info.title, true, { body: `${tool}'s own safety check wants your OK before this.`, ...(detail ? { detail } : {}) }, signal, "Waiting for your permission", by, main);
    return answer === "allow" ? "allow" : "deny";
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
