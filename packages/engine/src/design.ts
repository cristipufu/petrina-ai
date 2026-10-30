// Native design convergence adapter; portable convergence and coordinator-call routing live in @petrina/orchestrator.

import { DesignConversations, DesignWorkflow, type RepositoryContext } from "@petrina/orchestrator";
import type { Context } from "./context.js";
import type { Kernel, MutableStage } from "./kernel.js";
import { conversationDigest, ParticipantUnavailable } from "./participant-conversation.js";
import { formatObjections } from "./prompts.js";
import { reviewContextIntact } from "./review-context.js";
import { BriefResult, ObjectionsResult } from "./roles.js";
import type { Turns } from "./turn.js";

export { designConversationScope } from "./participant-conversation.js";

export class Design {
  private readonly workflow: DesignWorkflow;

  constructor(k: Kernel, turns: Turns, context: Context) {
    const conversations = new DesignConversations({
      profile: (id) => k.profile(id),
      profiles: () => k.s.profiles,
      role: (id) => k.role(id),
      digest: (text) => conversationDigest(text),
      conversation: (scope) => scope.work.conversation,
      contextIntact: (saved) => reviewContextIntact(saved),
      unavailable: (reason) => new ParticipantUnavailable(reason),
    });
    this.workflow = new DesignWorkflow(
      conversations,
      {
        now: () => Date.now(),
        id: (prefix) => k.id(prefix),
        role: (id) => k.role(id),
        formatObjections,
        note: (scope, tone, text, roleId, profileId) => k.log(scope, tone, text, roleId, profileId),
        finishStep: (scope) => k.finishStep(scope),
        rerun: (task) => k.rerun(task),
        recordDesignRound: (scope, stage, reviewer, round, objectionCount, blockingCount) =>
          k.tracking.designRound(scope, stage, reviewer, round, objectionCount, blockingCount),
        recordDesignEnd: (scope, stage, round, outcome) => k.tracking.designEnd(scope, stage, round, outcome),
        endStage: (scope, outcome) => k.tracking.endStage(scope, outcome),
        raiseDisagreement: (scope, title, body) => {
          k.raise(scope, "disagreement", title, false, { body });
        },
        checkpoint: () => k.commitNow(),
        changed: () => k.commit(),
      },
      {
        runAuthorTurn: (scope, input, signal) =>
          turns.turn(
            scope,
            input.roleId,
            input.profileId,
            () => context.sectionsFor(scope, input.roleId),
            BriefResult,
            signal,
            {
              ...(input.status ? { status: input.status } : {}),
              resume: input.resume as Parameters<Turns["turn"]>[6] extends { resume?: infer R } ? R : never,
              designContext: true,
              used: input.used,
              check: input.check,
            },
          ),
        runReviewerTurn: (scope, input, signal) =>
          turns.turn(
            scope,
            input.roleId,
            input.profileId,
            () => context.sectionsFor(scope, input.roleId),
            ObjectionsResult,
            signal,
            {
              resume: input.resume as Parameters<Turns["turn"]>[6] extends { resume?: infer R } ? R : never,
              designContext: true,
              used: input.used,
            },
          ),
        saveRoleEdits: (scope, roleId, profileId) => k.saveRoleEdits(scope, roleId, profileId),
      },
    );
  }

  runConverge(scope: RepositoryContext, stage: MutableStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    return this.workflow.runConverge(scope, stage, signal);
  }
}
