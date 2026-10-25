import { summaryAt } from '../../fixtures/summary.js';
import { describe, expect, it } from "vitest";

import { beginAgentStep, journeyView, legacyJourney, type JourneyTask, type JourneyView } from "../../../src/journey.js";
import { BUILT_IN_ROLES } from "../../../src/library.js";

import type { State, Task } from "../../../src/model.js";

const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });

const boxes = (view: JourneyView) => view.nodes.map((node) => `${node.name}: ${node.state}`);

describe("tasks that ran before journeys were recorded", () => {
  it("show one box per finished stage, the live and faint steps as usual, and a quiet note", () => {
    const { state, task } = summaryAt('code-reviewer');
    const { journey: _gone, ...old } = task;
    const view = journeyView(old as Task, contextOf(state));
    // The reviewers look at once: one live box for all of them, then the delivery check.
    expect(boxes(view)).toEqual(["Planner: done", "Architect: done", "Your design check: done", "Builder: done", "Code reviewers: now", "Your delivery check: next", "Publish delivery: ahead"]);
    expect(view.nodes[4]!.team).toEqual(old.plan!.stages.find((stage) => stage.kind === "review-chain")!.profileIds);
    expect(view.nodes.slice(0, 4).every((node) => node.legacy && node.startedAt === undefined)).toBe(true);
    expect(view.note).toMatch(/Earlier rounds were not recorded/);
  });

  it("keep the coordinator's step they wait at, from when it was asked", () => {
    const { state, task } = summaryAt('architect');
    const old = { ...task, journey: undefined, agent: undefined, state: 'needs-you' as const, stageIndex: 1 };
    const question = { id: 'design-check', taskId: old.id, kind: 'design' as const, title: 'Approve the brief', at: 42, blocking: false };
    state.inbox.push(question);
    const steps = legacyJourney(old, state.inbox, BUILT_IN_ROLES);
    expect(steps.at(-1)).toMatchObject({ kind: "you", waitsFor: "design", startedAt: question.at });
    expect(steps.at(-1)!.legacy).toBeUndefined();
  });

  it("keep the step under way, with the question it waits on under it", () => {
    const { state, task: initial } = summaryAt('architect');
    const { journey: _gone, ...old } = { ...initial, state: 'needs-you' as const };
    const question = { id: 'question', taskId: old.id, kind: 'question' as const, title: 'Formal or casual?', roleId: 'architect', profileId: 'opus-high', at: 42, blocking: true };
    state.inbox.push(question);
    const steps = legacyJourney(old, state.inbox, BUILT_IN_ROLES);
    expect(steps.at(-1)).toMatchObject({ kind: "agent", roleId: "architect", stageId: old.plan!.stages[0]!.id, round: 1, sub: 0, startedAt: old.agent!.since, asks: [{ id: question.id, kind: "question", title: "Formal or casual?" }] });
    const view = journeyView({ ...old, journey: steps } as Task, contextOf(state));
    expect(boxes(view).slice(0, 4)).toEqual(["Planner: done", "Architect: you", "Design reviewer: next", "Your design check: ahead"]);
    // Answering it continues the same box.
    const task: JourneyTask = { ...old, journey: steps };
    expect(beginAgentStep(task, "architect", old.agent!.profileId, 43, BUILT_IN_ROLES)).toBe(steps.at(-1));
  });
});
