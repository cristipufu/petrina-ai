import { openStep, type Id } from "@petrina/core";
import type { RepositoryContext } from "./repository-context.js";
import type { AgentMessage, SessionSettings } from "./ports/agents.js";
import type {
  InputSection,
  PendingParticipantInput,
  ParticipantInputDetails,
  ParticipantInputEffects,
  ParticipantInputHost,
  ParticipantContextPreparation
} from "./ports/participant-input.js";

/** The actual input handoff: capture at preparation, attach the exact outgoing message, and retain public updates. */
export class ParticipantInputs {
  constructor(private readonly host: ParticipantInputHost, private readonly effects: ParticipantInputEffects) {}

  capture(scope: RepositoryContext, roleId: Id, profileId: Id, sections: readonly InputSection[], mode: "fresh" | "continued", plannedId: Id, selectionReason: string | undefined, reviewerKey: string | undefined, confirmedSettings: SessionSettings, instructions: string, extra: ParticipantInputDetails = {}): PendingParticipantInput | undefined {
    const { task, work } = scope;
    const step = openStep(task);
    if (step?.kind !== "agent") return undefined;
    const stage = task.plan?.stages[task.stageIndex];
    const designReview = stage?.kind === "converge" && roleId === (stage.reviewerRoleId ?? "design-reviewer");
    const seats = designReview ? stage?.reviewerProfileIds : stage?.profileIds;
    const index = reviewerKey !== undefined ? Number(reviewerKey) : seats?.indexOf(plannedId) ?? -1;
    const assignedRole = designReview ? stage?.reviewerRoleId ?? "design-reviewer" : stage?.roleIds?.[index] ?? stage?.roleId;
    const assignment = assignedRole === roleId ? (designReview ? stage?.reviewerAssignments : stage?.assignments)?.[index] : undefined;
    const previous = step.agentInputs?.findLast(entry => entry.roleId === roleId && entry.profileId === profileId && entry.reviewerKey === reviewerKey);
    const reason = selectionReason || previous?.selectionReason;
    if (reason && /^(Kept its own conversation|Started a fresh conversation:)/.test(reason)) this.host.status(scope, reason, roleId, profileId);
    const input = {
      productId: work.productId,
      stepAttempts: work.stepAttempts ?? 0,
      versions: {
        ...(work.baseSha ? { base: work.baseSha } : {}),
        ...(work.reviewedSha ? { reviewed: work.reviewedSha } : {}),
        ...(work.reviewedTree ? { reviewedTree: work.reviewedTree } : {}),
        ...(work.checks ? { checks: {
        at: work.checks.at,
        sha: work.checks.sha,
        tree: work.checks.tree,
        definition: work.checks.definition,
        passed: work.checks.results.every((run) => run.ok),
        count: work.checks.results.length,
        ...(work.checks.provenance ? { node: work.checks.provenance.nodeId } : {})
      } } : {})
      },
      ...(step.reviewInput ? { reviewInput: this.effects.clone(step.reviewInput) } : {}),
      at: this.host.now(), instructions, requestedProfileId: plannedId,
      ...(reason ? { selectionReason: reason } : {}),
      ...(reviewerKey !== undefined ? { reviewerKey } : {}),
      ...(extra.place !== undefined ? { place: extra.place } : {}),
      ...(assignment ? { assignment: this.effects.clone(assignment) } : {}),
      ...(confirmedSettings ? { confirmedSettings } : {}),
      roleId, profileId, taskTitle: task.title,
      ...(mode === "fresh" ? { taskDescription: task.description } : {}),
      ...(task.plan?.stages[task.stageIndex]?.title ? { stageTitle: task.plan.stages[task.stageIndex]!.title } : {}),
      sections: sections.map(({ title, body }) => ({ title, body })), mode,
      ...(extra.resumed ? { resumed: true } : {}),
      manifest: this.effects.manifest(instructions, extra.supplied ?? sections, extra.omitted, extra.supplied !== undefined),
      ...(extra.freshReason ? { freshReason: extra.freshReason } : {}),
      ...(extra.readiness ? { readiness: this.effects.clone(extra.readiness) } : {}),
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    };
    return { stepId: step.id, input };
  }

  async attach(scope: RepositoryContext, pending: PendingParticipantInput | undefined, text: string, additions: readonly InputSection[] = [], openingSections: readonly InputSection[] = []): Promise<void> {
    if (!pending) return;
    const { task } = scope;
    const step = task.journey?.find(entry => entry.id === pending.stepId);
    if (!step) return;
    const exact = await this.effects.saveExact(task.id, text);
    const input = {
      ...pending.input,
      sections: [
      ...pending.input.sections,
      ...openingSections
    ].filter(section => section.body),
      ...(additions.length ? { manifest: this.effects.numberManifest([
      ...(pending.input.manifest ?? []),
      ...this.effects.manifest(
      "",
      additions,
      [],
      true
    )
    ]) } : {}),
      ...(exact ? { exact } : {})
    } as NonNullable<typeof step.agentInputs>[number];
    step.agentInputs = [...(step.agentInputs ?? []), input];
    this.host.checkpoint(scope);
  }

  async prepare<S extends InputSection>(scope: RepositoryContext, request: ParticipantContextPreparation<S>): Promise<{
    sections: S[];
    refreshRole: boolean;
    omitted?: readonly import("./ports/participant-input.js").InputOmission[]
  }> {
    const prepared = request.packet ? await request.prepare() : { sections: request.sections };
    if (request.note && request.packet) {
      if (prepared.snapshot) request.note.context = prepared.snapshot;
      else delete request.note.context;
    }
    const supplied = !request.supplyHistory ? { sections: prepared.sections } : await request.history(prepared.sections, !!request.previous);
    if (supplied.retained) this.host.checkpoint(scope);
    return {
      sections: supplied.sections,
      refreshRole: !request.previous || prepared.snapshot?.scope !== request.previous.scope,
      ...(prepared.omitted ? { omitted: prepared.omitted } : {})
    };
  }

  stream(scope: RepositoryContext, roleId: Id, profileId: Id, reviewerKey: string | undefined, signal: AbortSignal, main = false): (message: AgentMessage) => void {
    const { task } = scope;
    let last: { key: number; line: Id } | undefined;
    return message => {
      if (!this.host.current(scope) || this.host.stopped() || signal.aborted) return;
      if (main) this.host.briefed(scope);
      const saved = last;
      const line = saved?.key === message.id ? task.session.find(entry => entry.id === saved.line) : undefined;
      if (line) {
        if (line.text === message.text) return;
        line.text = message.text;
        this.host.noteStream(scope);
      } else {
        this.host.say(scope, message.text, roleId, profileId, reviewerKey);
        last = { key: message.id, line: task.session.at(-1)!.id };
        this.host.commit(scope);
      }
    };
  }
}
