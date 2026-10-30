import { JOURNEY_WORDS, lastIndexWhere, petrinaMoment } from "@petrina/core";
import type { RepositoryContext, RepositoryWork } from "./repository-context.js";
import type { BeginSourceConflictEffects, FinishSourcePortEffects, SourceConflictHost, SourceConflictObservation } from "./ports/source-conflicts.js";

/** Conflict bookkeeping and port-review decisions; Git observations remain with the adapter. */
export class SourceConflicts {
  constructor(private readonly host: SourceConflictHost) {}

  async begin(scope: RepositoryContext, observation: SourceConflictObservation, effects: BeginSourceConflictEffects): Promise<"conflict"> {
    const { task, work: repository } = scope;
    const { sourceName, reviewed, gained } = observation;
    const commits = `${gained} new commit${gained === 1 ? "" : "s"}`;
    const builder = lastIndexWhere(task.plan?.stages ?? [], (stage) => this.host.role(stage.roleId, task)?.result === "build" && stage.kind === "do");
    if (builder < 0) throw new Error(`${sourceName === "main" ? "Main" : sourceName} moved on and the work conflicts with it, but the plan has no builder to bring it up to date`);
    // On disk before the working copy moves: a restart in between finds the update and opens it again.
    // Only a completed review of this exact code permits the later review to cover the port alone.
    const head = reviewed ? await effects.head() : undefined;
    repository.updating = { from: observation.from, onto: observation.onto, ...(head ? { head } : {}), files: observation.files, ...(observation.notes.length ? { notes: observation.notes } : {}) };
    if (task.reviewSessions) {
      // Each dropped seat's next start says why it is fresh, even after a pause or restart in between.
      // Seats with no saved conversation (first reviews, or already dropped by an earlier conflict) keep what they had.
      const why = `${sourceName} conflicted with the change${task.repositories ? ` in ${this.host.productName(scope) ?? repository.productId}` : ""}, so the Builder had to port it`;
      const dropped = structuredClone(task.reviewFreshReasons ?? {});
      for (const [stageId, seats] of Object.entries(task.reviewSessions)) for (const seat of Object.keys(seats)) dropped[stageId] = { ...dropped[stageId], [seat]: why };
      task.reviewFreshReasons = dropped;
      delete task.reviewSessions;
      this.host.note(scope, "status", "Reviewer conversations will start fresh because the Builder must port the change after conflicts");
    }
    // The builder ports the change by hand: whatever was approved before, the coordinator checks it again.
    delete repository.approvedSha;
    delete repository.approvedPatch;
    delete repository.approvedFor;
    repository.baseSha = observation.onto;
    repository.base = observation.ontoRef;
    if (task.repositories) {
      // A post-wait update examines companions even after one conflict. Save all unfinished
      // owners before opening markers, retaining the existing repair's cursor and return step.
      // A conflict added for a new owner does not turn that owner's port into a findings repair.
      const repair = task.repair;
      if (repair) {
        if (!repair.products.slice(repair.index).includes(repository.productId)) task.repair = {
          ...repair,
          products: [...repair.products, repository.productId],
          portProducts: [...new Set([...(repair.portProducts ?? []), repository.productId])],
        };
      } else task.repair = {
        products: [repository.productId], index: 0, returnStage: task.stageIndex, kind: "review",
        portProducts: task.fixing ? [] : [repository.productId],
      };
    }
    task.stageIndex = builder;
    task.sub = 0;
    // An update after a prerequisite wait can reach a Builder repair that is already owed.
    // The same turn must still answer its findings and reuse its saved conversation.
    this.host.checkpoint();
    await effects.open();
    const files = observation.files.length === 1 ? "1 file conflicts" : `${observation.files.length} files conflict`;
    // A moment of Petrina's own on the journey: why the builder gets the work back.
    petrinaMoment(task, "update", { outcome: JOURNEY_WORDS.mainMoved(observation.files.length, sourceName), reason: JOURNEY_WORDS.conflicts(sourceName), tone: "back" }, this.host.now());
    this.host.note(scope, "warn", `${sourceName === "main" ? "Main" : sourceName} moved on (${commits}) and ${files} with this work, so the builder brings it up to date`);
    this.host.changed();
    return "conflict";
  }

}

/** Complete a port using only the saved review and explicit repository observations. */
export async function finishSourcePort(scope: RepositoryContext, updating: NonNullable<RepositoryWork["updating"]>, effects: FinishSourcePortEffects): Promise<void> {
  const { task, work: repository } = scope;
  // A first review, an unreviewed fix, or work beyond the conflicts needs the whole planned review.
  // Check the saved code too: older updates recorded a head without recording any completed review.
  const reviewed = !task.fixing && updating.head && repository.reviewedTree && repository.reviewedTree === await effects.treeOf(updating.head);
  const merged = reviewed ? await effects.merge(updating.onto, updating.head!) : undefined;
  const portOnly = merged && (await effects.changedFiles(merged.tree)).every((file) => updating.files.includes(file));
  delete repository.updating;
  delete repository.reviewedSha;
  delete task.hunt;
  delete repository.portReview;
  if (portOnly && updating.head) repository.portReview = { from: updating.from, head: updating.head, onto: updating.onto, files: updating.files };
  else delete repository.reviewedTree;
}
