import { endAgentStep, openProofs, openStep, refreshProofs, stepKey, type Id } from "@petrina/core";
import { routeAcceptance } from "./acceptance-routing.js";
import type { AcceptanceResults } from "./acceptance-results.js";
import type { AcceptanceRoutingHost } from "./ports/acceptance.js";
import type { AcceptanceStepEffects, AcceptanceStepHost } from "./ports/acceptance-step.js";
import type { RepositoryContext } from "./repository-context.js";

/** Own one acceptance attempt from its starting observation through its recorded result and route. */
export class AcceptanceStep {
  constructor(private readonly host: AcceptanceStepHost, private readonly effects: AcceptanceStepEffects,
    private readonly results: Pick<AcceptanceResults, "record">, private readonly routing: AcceptanceRoutingHost) {}

  async run(scope: RepositoryContext, input: {
    roleId: Id;
    profileId: Id;
    canEdit(): boolean;
    used?(profileId: Id): void
  }, signal: AbortSignal): Promise<{
    testedVersions: Record<Id, string>;
    next?: "continue" | "stop"
  }> {
    const { task, work: repository } = scope;
    const { roleId, profileId } = input;
    let by = profileId;
    const continuing = repository.conversation?.roleId === roleId && repository.conversation.step === stepKey(task);
    let committed: Readonly<Record<Id, string>> | undefined;
    if (!task.acceptanceRun || !continuing) {
      const interrupted = openStep(task);
      const lost = interrupted?.kind === "agent" ? interrupted.proofRun?.restored : undefined;
      if (lost) endAgentStep(
        task,
        {
        outcome: "Stopped before a result",
        reason: `${lost.products.length ? "Petrina undid changes during this attempt" : "Petrina could not confirm what this attempt's cleanup undid"}; the next run starts fresh`,
        tone: "back"
      },
        this.host.now()
      );
      const observed = await this.effects.committedCode(task);
      committed = observed.heads;
      refreshProofs(task, observed.versions);
      task.acceptanceRun = { versions: observed.versions, changes: observed.changes, requestIds: openProofs(task).map(request => request.id) };
      this.host.checkpoint();
    }
    const run = task.acceptanceRun;
    let testedVersions = { ...run.versions };
    const rawResult = await this.effects.turn(scope, { roleId, profileId, ...(committed ? { committed } : {}),
      used: id => {
        by = id;
        input.used?.(id);
      },
      check: value => {
        const ids = value.proofAnswers.map(answer => answer.id);
        if (new Set(ids).size !== ids.length || ids.some(id => !run.requestIds.includes(id)) || run.requestIds.some(id => !ids.includes(id))) return `Answer every open proof request exactly once by id in proofAnswers, with pass, fail, or blocked and evidence. Required ids: ${run.requestIds.join(", ") || "none"}.`;
        const missing = task.brief?.acceptance.filter(item => !value.checks.some(check => check.text === item.text));
        return missing?.length ? `Report pass, fail, or blocked for every acceptance item, using its exact text. For blocked checks, include a reason naming what prevented verification. These are missing:\n${missing.map(item => `- ${item.text}`).join("\n")}` : undefined;
      },
    }, signal);
    if (input.canEdit()) {
      await this.effects.saveEdits(scope, roleId, by);
      testedVersions = await this.effects.versions(task);
    }
    const currentVersions = input.canEdit() || !task.proofRequests?.length ? testedVersions : await this.effects.versions(task);
    const recorded = await this.results.record(scope, { roleId, profileId: by, report: rawResult, run, testedVersions, currentVersions });
    const next = routeAcceptance(this.routing, scope, recorded);
    return { testedVersions, ...(next ? { next } : {}) };
  }
}
