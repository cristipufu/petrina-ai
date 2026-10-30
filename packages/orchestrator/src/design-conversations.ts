import { designConversationScope, type AgentProfile, type ConversationNote, type Id, type Role, type SourcePointer } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import { participantConversation } from "./participant-conversation.js";
import { repositoryView, type RepositoryContext } from "./repository-context.js";

export interface DesignConversationHost {
  profile(id: Id): AgentProfile | undefined;
  profiles(): readonly AgentProfile[];
  role(id: Id): Role | undefined;
  digest(serialized: string): string;
  conversation(scope: RepositoryContext): ConversationNote | undefined;
  contextIntact(context: ConversationNote["context"]): Promise<boolean>;
  unavailable(reason: string): Error;
}

/** Actual completed design participants and their return eligibility; transport and immutable packet reads are effects. */
export class DesignConversations {
  constructor(private readonly host: DesignConversationHost) {}

  participant(scope: RepositoryContext, stage: NonNullable<RuntimeTask["plan"]>["stages"][number], side: "author" | "reviewer", roleId: Id, plannedId: Id) {
    const { task, work } = scope;
    const key = JSON.stringify([stage.id, side, work.productId]);
    const planned = structuredClone(this.host.profile(plannedId));
    let actual = planned;
    return {
      resume: async (actual: AgentProfile) => {
        if (!planned) return;
        const saved = participantConversation(
          {
          profiles: this.host.profiles(),
          digest: text => this.host.digest(text)
        },
          scope,
          this.host.role(roleId)!,
          planned
        );
        if (!saved?.prior || saved.reason || saved.actual?.id !== actual.id) return;
        const prior = saved.prior;
        if (!(await this.host.contextIntact(prior.context))) throw this.host.unavailable("its saved context is unavailable");
        return {
          ...prior,
          reselect: true,
          ...(side === "author" && task.brief && "briefDigest" in prior && prior.briefDigest === this.host.digest(JSON.stringify(task.brief)) ? { knownSections: ["Design brief"] } : {})
        };
      },
      used: (id: Id) => { actual = structuredClone(this.host.profile(id)); },
      remember: () => {
        const note = this.host.conversation(scope);
        if (!note?.briefed || note.roleId !== roleId) return;
        task.designSessions = {
          ...task.designSessions,
          [key]: {
          scope: designConversationScope(
          repositoryView(scope),
          note.role ?? this.host.role(roleId),
          planned,
          actual,
          text => this.host.digest(text)
        ),
          plannedProfileId: plannedId,
          profileId: note.profileId,
          toolId: note.toolId,
          model: note.model,
          sessionId: note.sessionId,
          ...(note.context ? { context: note.context } : {}),
          ...(side === "author" ? { briefDigest: this.host.digest(JSON.stringify(task.brief)) } : {})
        }
        };
      },
    };
  }
}

/** The accepted brief projection, shared with native convergence after its actual response validation. */
export function recordDesignBrief(task: Pick<RuntimeTask, "brief">, result: {
  summary: string;
  forUsers: string[];
  areas: string[];
  acceptance: string[];
  risks: string[]
}, sourcePointers: SourcePointer[]): void {
  task.brief = {
    summary: result.summary,
    forUsers: result.forUsers,
    areas: result.areas,
    acceptance: result.acceptance.map(text => ({ text })),
    risks: result.risks,
    ...(sourcePointers.length ? { sourcePointers } : {})
  };
}

export function recordDesignAnswers(task: Pick<RuntimeTask, "objections">, answers: Iterable<{
  id: Id;
  status: "accepted" | "rejected";
  answer: string
}>): void {
  for (const answer of answers) {
    const objection = task.objections.find(entry => entry.id === answer.id);
    if (objection && objection.status === "open") {
      objection.status = answer.status;
      objection.answer = answer.answer;
    }
  }
}

export function recordDesignObjections(task: Pick<RuntimeTask, "objections">, result: { objections: {
  text: string;
  blocking: boolean
}[] }, reviewer: Id, round: number, id: () => Id): {
  before: number;
  blocking: number
} {
  const before = task.objections.length;
  for (const objection of result.objections) task.objections.push({
    id: id(),
    round,
    text: objection.text,
    blocking: objection.blocking,
    raisedBy: reviewer,
    status: "open"
  });
  return { before, blocking: result.objections.filter(objection => objection.blocking).length };
}
