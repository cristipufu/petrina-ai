import { completeAll, reviewConversationScope, type AgentProfile, type ConversationNote, type Id, type Role, type Stage } from "@petrina/core";
import { participantConversation } from "./participant-conversation.js";
import { repositoryView, scopesFor, type RepositoryContext } from "./repository-context.js";
import type { ReviewBaseEffects, ReviewBaseUpdate, ReviewConversationEffects, ReviewConversationHost } from "./ports/review-conversations.js";

/** Completed reviewer conversations belong to a stage and seat, independently of native transport. */
export class ReviewConversations {
  constructor(private readonly host: ReviewConversationHost, private readonly effects: ReviewConversationEffects) {}

  participant(scope: RepositoryContext, stage: Stage, seat: Id, plannedId: Id) {
    const { task } = scope;
    const round = task.rounds[stage.id] ?? 1;
    const planned = structuredClone(this.host.profile(plannedId));
    return {
      reviewContext: true,
      resume: async (actual: AgentProfile, role: Role) => {
        if (!planned) return;
        const saved = participantConversation({ profiles: this.host.profiles(), digest: text => this.host.digest(text) }, scope, role, planned, seat);
        if (!saved || saved.reason || saved.actual?.id !== actual.id) return;
        const prior = task.reviewSessions?.[stage.id]?.[seat];
        if (!prior) return;
        if (!prior.bases) throw this.host.unavailable("its saved repository bases are unavailable");
        if (!(await this.effects.contextIntact(prior.context))) throw this.host.unavailable("its saved context is unavailable");
        const updates = await this.effects.baseUpdates(scope, prior.bases, task.hunt?.input?.heads ?? {});
        if (updates.reason) throw this.host.unavailable(updates.reason);
        return { ...prior, reselect: true, continuedSections: updates.sections };
      },
      started: () => {
        // An interrupted attempt must never return to an older completed round after starting new work.
        const saved = task.reviewSessions?.[stage.id];
        const dropped = task.reviewFreshReasons?.[stage.id];
        if (!saved?.[seat] && !dropped?.[seat]) return;
        delete saved?.[seat];
        if (dropped?.[seat]) {
          delete dropped[seat];
          if (!Object.keys(dropped).length) delete task.reviewFreshReasons![stage.id];
          if (!Object.keys(task.reviewFreshReasons!).length) delete task.reviewFreshReasons;
        }
        this.host.checkpoint();
      },
      completed: (note: ConversationNote, actual: AgentProfile, role: Role) => {
        task.reviewSessions = { ...task.reviewSessions, [stage.id]: {
          ...task.reviewSessions?.[stage.id],
          [seat]: { scope: reviewConversationScope(repositoryView(scope), stage.id, seat, role, planned, actual, text => this.host.digest(text)), bases: reviewBases(scope), round,
            plannedProfileId: plannedId, profileId: actual.id, toolId: note.toolId, model: note.model, sessionId: note.sessionId, ...(note.context ? { context: note.context } : {}) },
        } };
        this.host.checkpoint();
      },
    };
  }
}

export function reviewBases(scope: RepositoryContext): Record<Id, string> {
  return Object.fromEntries(scopesFor(scope.task).flatMap(({ work }) => work.baseSha ? [[work.productId, work.baseSha]] : []));
}

/** Forward execution bases can continue the immutable approved source; all observations are operation scoped. */
export async function reviewBaseUpdates(scope: RepositoryContext, bases: Readonly<Record<Id, string>> | undefined, heads: Readonly<Record<Id, string>>, effects: ReviewBaseEffects): Promise<ReviewBaseUpdate> {
  const scopes = scopesFor(scope.task);
  if (!bases || Object.keys(bases).length !== scopes.length) return { sections: [], reason: "its saved repository bases are unavailable" };
  const updates: string[] = [];
  for (const bound of scopes) {
    const { work } = bound;
    const before = bases[work.productId], base = work.baseSha, head = heads[work.productId];
    if (!before || !base || !head || !work.worktree) return { sections: [], reason: "its saved repository bases are unavailable" };
    if (work.portReview || work.updating) return { sections: [], reason: "the change requires a conflict port review" };
    if (before === base) continue;
    if (!(await effects.contains(bound, base, before))) return { sections: [], reason: "its starting branch's history was replaced or diverged" };
    let incoming: readonly string[] = [], changed: readonly string[] = [], count = "";
    await completeAll([
      effects.changedFiles(bound, before, base).then(value => { incoming = value; }),
      effects.changedFiles(bound, base, head).then(value => { changed = value; }),
      effects.count(bound, before, base).then(value => { count = value; }),
    ]);
    const overlap = incoming.filter(file => changed.includes(file));
    const commits = Number(count.trim());
    if (!Number.isSafeInteger(commits) || commits < 1) throw new Error("Could not count the starting branch's incoming commits for review.");
    const branch = work.source?.start.branch ?? "main", source = branch === "main" ? "Main" : branch;
    const incremental = work.reviewedSha
      ? `Read the incremental comparison too. ${source}'s incoming changes are not in the incremental comparison: it contains only this task's changes since the last round, carried onto the new base.`
      : "No incremental comparison is available. Review the complete change.";
    updates.push(`### ${work.source?.product.name ?? work.productId} (${work.productId})\nOld base: ${before}\nNew base: ${base}\n${source} gained ${commits} commit${commits === 1 ? "" : "s"}.\nExact commit under review: ${head}\nThe change was carried onto the new base without an engine conflict port.\nFiles the starting branch changed that this task also changes; read their current versions again:\n${overlap.map(file => `- ${JSON.stringify(file)}`).join("\n") || "None."}\nRead the complete prepared comparison against ${base} and its current base review guide. ${incremental} Inspect the incoming range ${before}..${base} and its interactions wherever relevant, including beyond the files listed above. Review all code that now requires review, not only the Builder's fixes.`);
  }
  return { sections: updates.length ? [{ title: "The review base advanced since your last review", body: updates.join("\n\n") }] : [] };
}
