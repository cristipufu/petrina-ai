import {
  answerByCall,
  beginYouStep,
  CALL_WORDS,
  designRoundEnd,
  endAgentStep,
  followingCall,
  hintProducts,
  JOURNEY_WORDS,
  recordStepResult,
  unanswered,
  type CallAnswer,
  type DesignCall,
  type Id,
  type SourcePointer,
  type Stage,
  type Task,
} from "@petrina/core";
import {
  recordDesignAnswers,
  recordDesignBrief,
  recordDesignObjections,
  type DesignConversations,
} from "./design-conversations.js";
import type { RuntimeTask } from "./model.js";
import type {
  DesignStage,
  DesignWorkflowEffects,
  DesignWorkflowHost,
} from "./ports/design-workflow.js";
import type { RepositoryContext } from "./repository-context.js";
import { checkSourceHints } from "./source-hints.js";

export function designWorkKey(task: Pick<RuntimeTask, "rounds" | "designRevision">, stageId: string): string {
  return `${stageId}:author:${task.rounds[stageId] ?? 1}:${task.designRevision ?? 0}`;
}

/** Portable design convergence, multi-product author progression, and coordinator-call settlement. */
export class DesignWorkflow {
  constructor(
    private readonly conversations: DesignConversations,
    private readonly host: DesignWorkflowHost,
    private readonly effects: DesignWorkflowEffects,
  ) {}

  async runConverge(scope: RepositoryContext, stage: DesignStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task } = scope;
    if (followingCall(task)) {
      return this.followCall(scope, stage, signal);
    }
    const round = task.rounds[stage.id] ?? 1;
    if (task.sub === 0) {
      return this.runAuthorRound(scope, stage, round, signal);
    }
    return this.runReviewerRound(scope, stage, round, signal);
  }

  private async runAuthorRound(
    scope: RepositoryContext,
    stage: DesignStage,
    round: number,
    signal: AbortSignal,
  ): Promise<"continue"> {
    const { task } = scope;
    const profileId = stage.profileIds[0] ?? "opus-xhigh";
    const participant = this.conversations.participant(scope, stage, "author", stage.roleId, profileId);
    let actualAuthor = profileId;
    // Every objection the architect is shown gets its answer: none is accepted or rejected by default.
    const due = task.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
    // Answers add up across repairs, so the architect can hand back just the ones it left out.
    const given = new Map<string, { id: string; status: "accepted" | "rejected"; answer: string }>();
    const result = await this.effects.runAuthorTurn(
      scope,
      {
        roleId: stage.roleId,
        profileId,
        resume: participant.resume,
        used: (id) => {
          actualAuthor = id;
          participant.used(id);
        },
        check: (value) => {
          for (const answer of value.answers) {
            given.set(answer.id, answer);
          }
          const missing = task.objections.filter((objection) => due.includes(objection.id) && !given.has(objection.id));
          return missing.length
            ? `every objection you were shown needs an answer by id, accepted or rejected with your reason, and these have none:\n${this.host.formatObjections(missing as Task["objections"])}`
            : undefined;
        },
      },
      signal,
    );
    const sourcePointers = this.sourceHints(scope, result.sourcePointers, stage.roleId, actualAuthor);
    recordDesignBrief(task, result, sourcePointers);
    recordDesignAnswers(task, given.size ? given.values() : result.answers);
    participant.remember();
    this.host.note(
      scope,
      "done",
      round === 1 ? "Design brief ready" : "Answered every objection",
      stage.roleId,
      actualAuthor,
    );
    recordStepResult(task, { objections: task.objections.filter((objection) => due.includes(objection.id)) });
    endAgentStep(
      task,
      round === 1
        ? { outcome: JOURNEY_WORDS.wroteBrief, reason: JOURNEY_WORDS.briefReady }
        : { outcome: JOURNEY_WORDS.answeredAll, reason: JOURNEY_WORDS.objectionsAnswered },
      this.host.now(),
    );
    await this.effects.saveRoleEdits(scope, stage.roleId, actualAuthor);
    this.host.finishStep(scope);
    if (this.host.rerun(task)) {
      return "continue";
    }
    if (this.nextProduct(scope, stage)) {
      return "continue";
    }
    task.sub = 1;
    this.host.changed();
    return "continue";
  }

  private async runReviewerRound(
    scope: RepositoryContext,
    stage: DesignStage,
    round: number,
    signal: AbortSignal,
  ): Promise<"continue" | "stop"> {
    const { task } = scope;
    const reviewerRole = stage.reviewerRoleId ?? "design-reviewer";
    const reviewerProfile = stage.reviewerProfileIds?.[0] ?? "sol-xhigh";
    const participant = this.conversations.participant(scope, stage, "reviewer", reviewerRole, reviewerProfile);
    let actualReviewer = reviewerProfile;
    const result = await this.effects.runReviewerTurn(
      scope,
      {
        roleId: reviewerRole,
        profileId: reviewerProfile,
        resume: participant.resume,
        used: (id) => {
          actualReviewer = id;
          participant.used(id);
        },
      },
      signal,
    );
    participant.remember();
    const { before, blocking } = recordDesignObjections(task, result, actualReviewer, round, () =>
      this.host.id(`${task.id}-obj`),
    );
    recordStepResult(task, { objections: task.objections.slice(before) });
    endAgentStep(
      task,
      blocking
        ? {
            outcome: JOURNEY_WORDS.objections(result.objections.length, blocking),
            reason: JOURNEY_WORDS.blocking(blocking),
            tone: "back",
          }
        : {
            outcome: JOURNEY_WORDS.objections(result.objections.length, 0),
            reason: JOURNEY_WORDS.noBlocking,
          },
      this.host.now(),
    );
    this.host.finishStep(scope);
    if (this.host.rerun(task)) {
      return "continue";
    }
    this.host.recordDesignRound(
      scope,
      stage,
      { roleId: reviewerRole, profileId: actualReviewer },
      round,
      result.objections.length,
      blocking,
    );
    const end = designRoundEnd(blocking, round, stage as Stage);
    if (end === "settled") {
      // Nobody decides on non-blocking points raised in the last round: they stay as follow-ups, never "rejected".
      for (const objection of task.objections) {
        if (objection.status === "open" && !objection.blocking) {
          objection.status = "noted";
        }
      }
      this.host.note(scope, "done", "Design settled: no blocking objections", reviewerRole, actualReviewer);
      this.host.recordDesignEnd(scope, stage, round, "settled");
      task.stageIndex += 1;
      task.sub = 0;
      this.host.changed();
      return "continue";
    }
    this.host.note(
      scope,
      "warn",
      `Raised ${result.objections.length} objection${result.objections.length === 1 ? "" : "s"}, ${blocking} blocking`,
      reviewerRole,
      actualReviewer,
    );
    if (end === "disagreement") {
      this.host.recordDesignEnd(scope, stage, round, "to-you");
      delete task.agent;
      task.holdsSlot = false;
      task.statusLine = "The architects disagree. Your call";
      beginYouStep(task, "call", this.host.now());
      this.host.raiseDisagreement(scope, `The architects disagree on “${task.title}”`, CALL_WORDS.disagreement);
      this.host.checkpoint();
      return "stop";
    }
    task.rounds[stage.id] = round + 1;
    task.sub = 0;
    this.host.changed();
    return "continue";
  }

  /**
   * The brief's optional hints, each checked against the task's current products. A supplied list replaces the earlier
   * one with its valid entries; an omitted list keeps the earlier hints that still qualify. What is left out is noted.
   */
  private sourceHints(scope: RepositoryContext, supplied: unknown, roleId: Id, by: Id): SourcePointer[] {
    const { task } = scope;
    const hints = checkSourceHints(supplied === undefined ? task.brief?.sourcePointers : supplied, hintProducts(task));
    if (hints.left) {
      this.host.note(scope, "status", hints.left, roleId, by);
    }
    return hints.pointers;
  }

  private nextProduct(scope: RepositoryContext, stage: DesignStage): boolean {
    const { task, work: repository } = scope;
    if (!task.repositories || !this.host.role(stage.roleId)?.canEdit) {
      return false;
    }
    const key = designWorkKey(task, stage.id);
    const own = task.repositories.find((work) => work.productId === repository.productId)!;
    own.completedStages = [...new Set([...own.completedStages, key])];
    const next = task.repositories.find((work) => !work.completedStages.includes(key));
    task.activeProductId = next?.productId ?? task.leadProductId ?? task.repositories[0]!.productId;
    this.host.checkpoint();
    return Boolean(next);
  }

  /** The coordinator made the call: the architect updates the brief to follow it, then the design goes to the coordinator's check. */
  private async followCall(scope: RepositoryContext, stage: DesignStage, signal: AbortSignal): Promise<"continue"> {
    const { task } = scope;
    const call = task.call!;
    const profileId = stage.profileIds[0] ?? "opus-xhigh";
    const participant = this.conversations.participant(scope, stage, "author", stage.roleId, profileId);
    let actualAuthor = profileId;
    const revising = !task.objections.some((objection) => objection.status === "open");
    // Answers add up across repairs, so the architect can hand back just the ones it left out.
    const answers = new Map<Id, CallAnswer>();
    const result = await this.effects.runAuthorTurn(
      scope,
      {
        roleId: stage.roleId,
        profileId,
        status: CALL_WORDS.following,
        resume: participant.resume,
        used: (id) => {
          actualAuthor = id;
          participant.used(id);
        },
        check: (value) => {
          for (const answer of value.answers) {
            answers.set(answer.id, answer);
          }
          const missing = unanswered(task.objections as Task["objections"], call as DesignCall, [...answers.values()]);
          return missing.length
            ? `every objection listed for an answer needs one by id, and these have none:\n${this.host.formatObjections(missing)}`
            : undefined;
        },
      },
      signal,
    );
    const sourcePointers = this.sourceHints(scope, result.sourcePointers, stage.roleId, actualAuthor);
    recordDesignBrief(task, result, sourcePointers);
    task.objections = answerByCall(
      task.objections as Task["objections"],
      call as DesignCall,
      [...answers.values()],
    ) as RuntimeTask["objections"];
    participant.remember();
    recordStepResult(task, {
      objections: task.objections.filter(
        (objection) => answers.has(objection.id) || call.open.includes(objection.id),
      ),
    });
    this.host.note(scope, "done", revising ? CALL_WORDS.revised : CALL_WORDS.updated, stage.roleId, actualAuthor);
    endAgentStep(task, { outcome: JOURNEY_WORDS.followed, reason: JOURNEY_WORDS.followsCall }, this.host.now());
    await this.effects.saveRoleEdits(scope, stage.roleId, actualAuthor);
    this.host.finishStep(scope);
    if (this.nextProduct(scope, stage)) {
      return "continue";
    }
    this.host.endStage(scope, "settled");
    this.host.note(scope, "done", CALL_WORDS.settled);
    if (this.host.rerun(task)) {
      return "continue";
    }
    // The design check comes next, maybe after steps such as Screens: the call made sure there is one.
    task.stageIndex += 1;
    task.sub = 0;
    this.host.changed();
    return "continue";
  }
}
