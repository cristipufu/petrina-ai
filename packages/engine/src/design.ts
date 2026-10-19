import { repositoryView, type RepositoryContext } from "./repository-context.js";
import { designWorkKey } from "./repositories.js";
import { createHash } from "node:crypto";
// Design convergence: the architect writes the brief and a design reviewer objects, round after round,
// until nothing blocking is left; and following the coordinator's call when the architects disagree.

import { answerByCall, beginYouStep, CALL_WORDS, endAgentStep, followingCall, JOURNEY_WORDS as W, recordStepResult, unanswered, type CallAnswer, type DesignCall, type Id, type Task, designRoundEnd, type Stage } from "@petrina/core";
import { formatObjections } from "./prompts.js";
import { BriefResult, ObjectionsResult } from "./roles.js";
import { Kernel, type MStage, type MTask } from "./kernel.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A return is valid only for the same role, profiles, request and approved product sources. */
export function designConversationScope(task: Task, role: unknown, planned: unknown, actual: unknown): string {
  return digest({ role, planned, actual, productId: task.productId, path: task.worktree, title: task.title, request: task.description, source: task.source, base: task.baseSha, copies: task.repositories?.map((work) => ({ productId: work.productId, path: work.worktree, base: work.baseSha, source: work.source })) });
}

export class Design {
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context) {}

  private participant(scope: RepositoryContext, stage: MStage, side: "author" | "reviewer", roleId: Id, plannedId: Id) {
    const { task, work: repository } = scope;
    const key = JSON.stringify([stage.id, side, repository.productId]);
    const planned = structuredClone(this.k.profile(plannedId));
    const prior = task.designSessions?.[key];
    const valid = prior && prior.plannedProfileId === plannedId && prior.scope === designConversationScope(repositoryView(scope), this.k.role(roleId), planned, this.k.profile(prior.profileId));
    if (prior && !valid && !repository.conversation) this.k.log(scope, "status", "Started a fresh design conversation: its role, profile, request or starting point changed", roleId, plannedId);
    const resume = valid ? { ...prior, ...(side === "author" && task.brief && prior.briefDigest === digest(task.brief) ? { knownSections: ["Design brief"] } : {}) } : undefined;
    let actual = planned;
    return {
      resume,
      used: (id: Id) => { actual = structuredClone(this.k.profile(id)); },
      remember: () => {
        const note = repository.conversation;
        if (!note?.briefed || note.roleId !== roleId) return;
        task.designSessions = { ...task.designSessions, [key]: { scope: designConversationScope(repositoryView(scope), note.role ?? this.k.role(roleId), planned, actual), plannedProfileId: plannedId, profileId: note.profileId, toolId: note.toolId, model: note.model, sessionId: note.sessionId, ...(note.context ? { context: note.context } : {}), ...(side === "author" ? { briefDigest: digest(task.brief) } : {}) } };
      },
    };
  }

  async runConverge(scope: RepositoryContext, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task } = scope;
    if (followingCall(task as unknown as Task)) return this.followCall(scope, stage, signal);
    const round = task.rounds[stage.id] ?? 1;
    if (task.sub === 0) {
      const profileId = stage.profileIds[0] ?? "opus-xhigh";
      const participant = this.participant(scope, stage, "author", stage.roleId, profileId);
      let by = profileId;
      // Every objection the architect is shown gets its answer: none is accepted or rejected by default.
      const due = task.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
      // Answers add up across repairs, so the architect can hand back just the ones it left out.
      const given = new Map<string, { id: string; status: "accepted" | "rejected"; answer: string }>();
      const result = await this.turns.turn(scope, stage.roleId, profileId, () => this.context.sectionsFor(scope, stage.roleId), BriefResult, signal, {
        resume: participant.resume,
        designContext: true,
        used: (id) => { by = id; participant.used(id); },
        check: (value) => {
          for (const answer of value.answers) given.set(answer.id, answer);
          const missing = task.objections.filter((objection) => due.includes(objection.id) && !given.has(objection.id));
          return missing.length ? `every objection you were shown needs an answer by id, accepted or rejected with your reason, and these have none:\n${formatObjections(missing as Task["objections"])}` : undefined;
        },
      });
      const sourcePointers = result.sourcePointers ?? task.brief?.sourcePointers;
      task.brief = { summary: result.summary, forUsers: result.forUsers, areas: result.areas, acceptance: result.acceptance.map((text) => ({ text })), risks: result.risks, ...(sourcePointers?.length ? { sourcePointers } : {}) };
      for (const answer of given.size ? given.values() : result.answers) {
        const objection = task.objections.find((entry) => entry.id === answer.id);
        if (objection && objection.status === "open") {
          objection.status = answer.status;
          objection.answer = answer.answer;
        }
      }
      participant.remember();
      this.k.log(scope, "done", round === 1 ? "Design brief ready" : "Answered every objection", stage.roleId, by);
      recordStepResult(task, { objections: task.objections.filter((objection) => due.includes(objection.id)) });
      endAgentStep(task, round === 1 ? { outcome: W.wroteBrief, reason: W.briefReady } : { outcome: W.answeredAll, reason: W.objectionsAnswered }, Date.now());
      await this.k.saveRoleEdits(scope, stage.roleId, by);
      await this.k.undoReadOnly(scope, stage.roleId);
      this.k.finishStep(scope);
      if (this.k.rerun(task)) return "continue";
      if (this.nextProduct(scope, stage)) return "continue";
      task.sub = 1;
      this.k.commit();
      return "continue";
    }
    const reviewerRole = stage.reviewerRoleId ?? "design-reviewer";
    const reviewerProfile = stage.reviewerProfileIds?.[0] ?? "sol-xhigh";
    const participant = this.participant(scope, stage, "reviewer", reviewerRole, reviewerProfile);
    let reviewer = reviewerProfile;
    const result = await this.turns.turn(scope, reviewerRole, reviewerProfile, () => this.context.sectionsFor(scope, reviewerRole), ObjectionsResult, signal, { resume: participant.resume, designContext: true, used: (id) => { reviewer = id; participant.used(id); } });
    participant.remember();
    const before = task.objections.length;
    for (const objection of result.objections) {
      task.objections.push({ id: this.k.id(`${task.id}-obj`), round, text: objection.text, blocking: objection.blocking, raisedBy: reviewer, status: "open" });
    }
    const blocking = result.objections.filter((objection) => objection.blocking).length;
    recordStepResult(task, { objections: task.objections.slice(before) });
    endAgentStep(task, blocking ? { outcome: W.objections(result.objections.length, blocking), reason: W.blocking(blocking), tone: "back" } : { outcome: W.objections(result.objections.length, 0), reason: W.noBlocking }, Date.now());
    await this.k.undoReadOnly(scope, reviewerRole);
    this.k.finishStep(scope);
    if (this.k.rerun(task)) return "continue";
    this.k.tracking.designRound(scope, stage, { roleId: reviewerRole, profileId: reviewer }, round, result.objections.length, blocking);
    const end = designRoundEnd(blocking, round, stage as Stage);
    if (end === "settled") {
      // Nobody decides on non-blocking points raised in the last round: they stay as follow-ups, never "rejected".
      for (const objection of task.objections) if (objection.status === "open" && !objection.blocking) objection.status = "noted";
      this.k.log(scope, "done", "Design settled: no blocking objections", reviewerRole, reviewer);
      this.k.tracking.designEnd(scope, stage, round, "settled");
      task.stageIndex += 1;
      task.sub = 0;
      this.k.commit();
      return "continue";
    }
    this.k.log(scope, "warn", `Raised ${result.objections.length} objection${result.objections.length === 1 ? "" : "s"}, ${blocking} blocking`, reviewerRole, reviewer);
    if (end === "disagreement") {
      this.k.tracking.designEnd(scope, stage, round, "to-you");
      delete task.agent;
      task.holdsSlot = false;
      task.statusLine = "The architects disagree. Your call";
      beginYouStep(task, "call", Date.now());
      this.k.raise(scope, "disagreement", `The architects disagree on “${task.title}”`, false, { body: CALL_WORDS.disagreement });
      this.k.commitNow();
      return "stop";
    }
    task.rounds[stage.id] = round + 1;
    task.sub = 0;
    this.k.commit();
    return "continue";
  }

  private nextProduct(scope: RepositoryContext, stage: MStage): boolean {
    const { task, work: repository } = scope;
    if (!task.repositories || !this.k.role(stage.roleId)?.canEdit) return false;

    const key = designWorkKey(task, stage.id);
    const own = task.repositories.find((work) => work.productId === repository.productId)!;
    own.completedStages = [...new Set([...own.completedStages, key])];
    const next = task.repositories.find((work) => !work.completedStages.includes(key));
    task.activeProductId = next?.productId ?? task.leadProductId ?? task.repositories[0]!.productId;
    this.k.commitNow();
    return !!next;
  }

  /** The coordinator made the call: the architect updates the brief to follow it, then the design goes to the coordinator's check. */
  private async followCall(scope: RepositoryContext, stage: MStage, signal: AbortSignal): Promise<"continue"> {
    const { task } = scope;
    const call = task.call!;
    const profileId = stage.profileIds[0] ?? "opus-xhigh";
    const participant = this.participant(scope, stage, "author", stage.roleId, profileId);
    let by = profileId;
    const revising = !task.objections.some((objection) => objection.status === "open");
    // Answers add up across repairs, so the architect can hand back just the ones it left out.
    const answers = new Map<Id, CallAnswer>();
    const result = await this.turns.turn(scope, stage.roleId, profileId, () => this.context.sectionsFor(scope, stage.roleId), BriefResult, signal, {
      status: CALL_WORDS.following,
      resume: participant.resume,
      designContext: true,
      used: (id) => { by = id; participant.used(id); },
      check: (value) => {
        for (const answer of value.answers) answers.set(answer.id, answer);
        const missing = unanswered(task.objections as Task["objections"], call as DesignCall, [...answers.values()]);
        return missing.length ? `every objection listed for an answer needs one by id, and these have none:\n${formatObjections(missing)}` : undefined;
      },
    });
    const sourcePointers = result.sourcePointers ?? task.brief?.sourcePointers;
    task.brief = { summary: result.summary, forUsers: result.forUsers, areas: result.areas, acceptance: result.acceptance.map((text) => ({ text })), risks: result.risks, ...(sourcePointers?.length ? { sourcePointers } : {}) };
    task.objections = answerByCall(task.objections as Task["objections"], call as DesignCall, [...answers.values()]) as MTask["objections"];
    participant.remember();
    recordStepResult(task, { objections: task.objections.filter((objection) => answers.has(objection.id) || call.open.includes(objection.id)) });
    this.k.log(scope, "done", revising ? CALL_WORDS.revised : CALL_WORDS.updated, stage.roleId, by);
    endAgentStep(task, { outcome: W.followed, reason: W.followsCall }, Date.now());
    await this.k.saveRoleEdits(scope, stage.roleId, by);
    await this.k.undoReadOnly(scope, stage.roleId);
    this.k.finishStep(scope);
    if (this.nextProduct(scope, stage)) return "continue";
    this.k.tracking.endStage(scope, "settled");
    this.k.log(scope, "done", CALL_WORDS.settled);
    if (this.k.rerun(task)) return "continue";
    // The design check comes next, maybe after steps such as Screens: the call made sure there is one.
    task.stageIndex += 1;
    task.sub = 0;
    this.k.commit();
    return "continue";
  }
}
