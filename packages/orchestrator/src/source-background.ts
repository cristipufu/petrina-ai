import type { RepositoryContext } from "./repository-context.js";
import type { SourcePullRequest } from "./ports/source.js";

export interface SourceBackgroundPullRequest extends SourcePullRequest { title: string; body: string; head: string }
/** Read-only source observations; native GitHub query formatting and serialization remain adapters. */
export interface SourceBackgroundEffects {
  serial<T>(productId: string, read: () => Promise<T>): Promise<T>;
  readPullRequest(repo: string, number: number): Promise<SourceBackgroundPullRequest>;
  background(repo: string, pr: SourceBackgroundPullRequest): Promise<string>;
  checkpoint(scope: RepositoryContext): void;
  now(): number;
}

export class SourceBackground {
  private readonly backgroundReads = new WeakMap<RepositoryContext["work"], { source: string; at: number }>();
  constructor(private readonly effects: SourceBackgroundEffects) {}
  async refresh(scope: RepositoryContext, force = false): Promise<void> {
    const { task, work: repository } = scope;
    if (task.repositories && (repository.pr || repository.release || repository.landed)) return;
    if (repository.source?.start.kind !== "pull-request") return;
    return this.effects.serial(repository.productId, async () => {
      // Prompt background may be shared briefly; fetch/delivery identity checks bypass this cache.
      const cached = this.backgroundReads.get(repository);
      if (!force && cached?.source === JSON.stringify(repository.source) && this.effects.now() - cached.at < 15_000) return;
      await this.readBackground(scope);
    });
  }

  private async readBackground(scope: RepositoryContext): Promise<void> {
    const { work: repository } = scope;
    const source = repository.source;
    if (source?.start.kind !== "pull-request") return;
    const pr = await this.effects.readPullRequest(source.product.repo, source.start.number);
    if (pr.headRepo.toLowerCase() !== source.start.headRepo.toLowerCase() || pr.branch !== source.start.branch) throw new Error("The pull request's working repository or branch changed. Publishing is stopped; the approved destination stays unchanged.");
    if (pr.state !== "open") throw new Error(`PR #${pr.number} is ${pr.state}. Publishing is stopped and the task's work is preserved.`);
    const text = await this.effects.background(source.product.repo, pr);
    repository.prBackground = { readAt: this.effects.now(), head: pr.head, text };
    this.backgroundReads.set(repository, { source: JSON.stringify(source), at: repository.prBackground.readAt });
    this.effects.checkpoint(scope);
  }
}
