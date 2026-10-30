import { cleanPoint, endAgentStep, GUIDE_FILE, hasPoint, JOURNEY_WORDS, type Id } from "@petrina/core";
import { beginInternalStep } from "./side-step.js";
import type { RepositoryContext } from "./repository-context.js";
import type { GuideProposalsEffects, GuideProposalsHost } from "./ports/guide-proposals.js";

/** Review misses produce coordinator choices without taking over the Builder's saved step. */
export class GuideProposals {
  constructor(private readonly host: GuideProposalsHost, private readonly effects: GuideProposalsEffects) {}

  accept(itemId: Id): void {
    const item = this.host.takeItem(itemId);
    const task = item && this.host.task(item.taskId);
    const product = task && (item.productId ? this.host.current().products.find(entry => entry.id === item.productId) : this.host.productOf(task));
    const point = cleanPoint(item?.body ?? "");
    if (!point || !task || !product) return;
    const existing = product.reviewGuide?.find(line => line.text === point);
    if (existing?.incorporatedOn) {
      existing.at = this.host.now();
      existing.fromTask = task.id;
      delete existing.writtenOn;
      delete existing.incorporatedOn;
    } else if (!existing) product.reviewGuide = [...(product.reviewGuide ?? []), { text: point, at: this.host.now(), fromTask: task.id }];
    this.host.log(task, "you", `You added to the review guide: ${point}`);
    this.host.checkpoint(task);
  }

  decline(itemId: Id): void {
    const item = this.host.current().inbox.find(entry => entry.id === itemId && entry.kind === "guide");
    if (!item) return;
    this.host.takeItem(itemId);
    const task = this.host.task(item.taskId);
    if (task) this.host.log(task, "you", "You left the review guide as it is");
    this.host.checkpoint(task);
  }

  async propose(scope: RepositoryContext, signal: AbortSignal): Promise<void> {
    const { task, work } = scope;
    const product = this.host.productOf(scope), miss = task.miss;
    if (!product || !miss || !work.worktree) return;
    const restore = beginInternalStep({ checkpoint: () => this.host.checkpointNow() }, scope, "guide-keeper");
    const keeper = this.host.profile();
    let ran: Id = keeper;
    try {
      const guide = await this.effects.guide(scope);
      const result = await this.effects.turn(scope, { note: miss.note, guide }, keeper, signal, id => { ran = id; });
      this.host.releaseScreen(task);
      restore();
      const proposed = !!result.missed && !!result.line && !hasPoint(guide, result.line);
      endAgentStep(task, { outcome: proposed ? JOURNEY_WORDS.guidePoint : JOURNEY_WORDS.noGuidePoint, reason: JOURNEY_WORDS.backToBuilder }, this.host.now());
      if (!result.missed || !result.line) this.host.log(scope, "done", `Nothing for the review guide: ${result.why}`, "guide-keeper", ran);
      else if (hasPoint(guide, result.line)) this.host.log(scope, "done", "The review guide already has that point", "guide-keeper", ran);
      else {
        const state = task.state;
        this.host.offer(scope, `Add a point to ${product.name}'s review guide?`, { body: result.line, detail: `${result.why} It goes into ${GUIDE_FILE}, which AGENTS.md points every agent to, in Petrina or in your own sessions.` });
        task.state = state;
        this.host.log(scope, "done", `Proposed a point for the review guide: ${result.line}`, "guide-keeper", ran);
      }
    } catch (error) {
      if (signal.aborted || this.effects.interrupted(error)) throw error;
      this.host.releaseScreen(task);
      restore();
      if (this.effects.deferred(error)) throw error;
      this.host.failed(scope, error, ran);
      endAgentStep(task, { outcome: JOURNEY_WORDS.couldNotFinish, reason: JOURNEY_WORDS.backToBuilder }, this.host.now());
      this.host.log(scope, "warn", "The Guide keeper could not finish, so nothing was proposed for the review guide");
    }
    delete task.miss;
    this.host.checkpoint();
  }
}
