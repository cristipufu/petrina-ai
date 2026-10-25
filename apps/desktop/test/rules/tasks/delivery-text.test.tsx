// @vitest-environment node
import { oneTaskFixture } from "../../fixtures/state";
import { describe, expect, it } from "vitest";
import { journeyView, type State, type Task } from "@petrina/core";
import { deliveryText } from "../../../src/lib";

const NOW = 1_000_000_000_000;

const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });

describe('unusual endings in words', () => {
  const state = oneTaskFixture(NOW);

  const merged: Task = { ...state.tasks[0]!, state: 'done', pr: { number: 44, url: 'https://example.test/44', openedAt: NOW - 1000, state: 'merged' } };

  it('a closed pull request is not awaiting merge, and Mark as done delivers nothing', () => {
    expect(deliveryText(merged)).toEqual({ text: `Pull request #${merged.pr!.number} merged`, done: true });
    for (const prState of [undefined, 'open'] as const) {
      // Older saved records may predate the required pull-request state.
      const pr = { ...merged.pr!, state: prState } as NonNullable<Task['pr']>;
      expect(deliveryText({ ...merged, state: 'done', pr })).toEqual({ text: `Pull request #${pr.number} closed without merging`, done: false });
      expect(deliveryText({ ...merged, state: 'pr-open', pr })).toEqual({ text: `Pull request #${pr.number} · awaiting merge`, done: false });
    }
    expect(deliveryText({ ...merged, pr: { ...merged.pr!, state: 'closed' } })).toEqual({ text: `Pull request #${merged.pr!.number} closed without merging`, done: false });
    expect(deliveryText({ ...merged, state: 'cancelled', pr: { ...merged.pr!, state: 'closed' } })).toEqual({ text: `Pull request #${merged.pr!.number} closed without merging`, done: false });
    const { pr: _none, ...marked } = merged;
    expect(deliveryText(marked)).toEqual({ text: 'Marked as done · delivery not confirmed', done: false });
    // A pull request a later lookup found does not deliver work you marked done, here or at the journey's end.
    for (const prState of ['open', 'merged', 'closed'] as const) {
      const found = { ...marked, state: 'done' as const, pr: { ...merged.pr!, state: prState }, cleanup: { markedDone: true, pullRequest: 'none' as const } };
      expect(deliveryText(found)).toEqual({ text: 'Marked as done · delivery not confirmed', done: false });
      expect(journeyView(found, contextOf(state)).end).toEqual({ text: 'Marked as done · delivery not confirmed', state: 'unconfirmed' });
    }
  });

  it('keeps updated pull requests distinct while preserving older closed outcomes', () => {
    const product = state.products.find((entry) => entry.id === merged.productId)!;
    const pr = { ...merged.pr!, state: 'open' as const };
    const source: NonNullable<Task['source']> = {
      product,
      start: { kind: 'pull-request', number: pr.number, url: pr.url, headRepo: product.repo, branch: 'review-work' },
      destination: { mode: 'pull-request', kind: 'update-pr', repo: product.repo, branch: 'review-work' },
      confirmed: true,
    };
    expect(deliveryText({ ...merged, source, state: 'pr-open', pr })).toEqual({ text: `Updated PR #${pr.number} · awaiting merge`, done: false });
    for (const prState of [undefined, 'open', 'closed'] as const) {
      const saved = { ...pr, state: prState } as NonNullable<Task['pr']>;
      expect(deliveryText({ ...merged, source, state: 'done', pr: saved })).toEqual({ text: `Pull request #${pr.number} closed without merging`, done: false });
    }
    expect(deliveryText({ ...merged, source })).toEqual({ text: `Pull request #${pr.number} merged`, done: true });
  });
});
