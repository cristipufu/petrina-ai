import { createTaskState, type Product, type TaskSource } from "@petrina/core";
import { SourceBackground, type SourceBackgroundEffects, type SourceBackgroundPullRequest } from "../../src/source-background.js";
import { executionFor, restoreRepositoryState } from "../../src/repository-context.js";

/** Explicit remote observations. No clone, subprocess, account or native GitHub response parser. */
export function sourceBackgroundFixture() {
  const product: Product = { id: "product", name: "Product", repo: "acme/demo", tone: "blue" };
  const task = createTaskState({ productId: product.id, title: "Cache source background", backlog: true }, [product],
    { id: "task", timelineId: "created", now: 100, priority: 0 });
  restoreRepositoryState(task);
  const scope = executionFor(task);
  const source: TaskSource = { product, confirmed: true,
    start: { kind: "pull-request", number: 7, url: "https://github.com/acme/demo/pull/7", headRepo: "acme/demo", branch: "review-work" },
    destination: { kind: "update-pr", mode: "pull-request", repo: "acme/demo", branch: "review-work" } };
  scope.work.source = source;
  const state = { calls: [] as string[], prs: [{ number: 7, url: "https://github.com/acme/demo/pull/7", state: "open", title: "Original PR title", body: "Original description", headRepo: "acme/demo", branch: "review-work", head: "head" }] as SourceBackgroundPullRequest[] };
  let now = 100;
  class Effects implements SourceBackgroundEffects {
    checkpoints = 0;
    async serial<T>(productId: string, read: () => Promise<T>): Promise<T> { if (productId !== product.id) throw new Error('Unexpected product'); return read(); }
    async readPullRequest(repo: string, number: number): Promise<SourceBackgroundPullRequest> {
      if (repo !== product.repo) throw new Error('Unexpected repository');
      state.calls.push('PR ' + number);
      const pr = state.prs.find(pr => pr.number === number);
      if (!pr) throw new Error('No scripted PR ' + number);
      return structuredClone(pr);
    }
    async background(repo: string, pr: SourceBackgroundPullRequest): Promise<string> {
      if (repo !== product.repo) throw new Error('Unexpected repository'); state.calls.push('Background ' + pr.number);
      return 'PR #' + pr.number + ': ' + pr.title;
    }
    checkpoint() { this.checkpoints++; }
    now() { return now; }
  }
  const effects = new Effects();
  return { task, scope, effects, sources: new SourceBackground(effects), now: () => now, advance: (ms: number) => { now += ms; },
    github: () => state, setGitHub: (change: (github: typeof state) => void) => change(state) };
}
