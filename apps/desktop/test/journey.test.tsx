import { act, useSyncExternalStore } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Window as HappyWindow } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemoState, createPortfolioDemo, journeyView, JOURNEY_WORDS, type JourneyView, type State, type Task } from '@petrina/core';
import { App } from '../src/App';
import { JourneyEdge, JourneyList, spokenStep } from '../src/components/Journey';
import { layoutJourney } from '../src/journeyLayout';
import { deliveryText, lookup } from '../src/lib';
import { repairedReviewFixture } from './reviewRoundFixture';

let simulator: Simulator;
const live = { link: 'live', desktop: false };
const empty: never[] = [];
vi.mock('../src/engine', () => ({
  mode: 'demo', desktop: false,
  startClock: () => () => {},
  useEngineStatus: () => live,
  useUnsent: () => empty,
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => simulator.getState()),
  sim: new Proxy({}, { get: (_, name) => name === 'synced' ? () => true : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));

const NOW = 1_000_000_000_000;
let root: Root;
let host: HTMLDivElement;
const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });
const taskOf = (state: State, id: string): Task => state.tasks.find((task) => task.id === id)!;
async function key(name: string) { await act(async () => { (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); }); }
async function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

beforeEach(() => localStorage.clear());
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('the journey as a list, for screen readers and the keyboard', () => {
  const state = createDemoState(NOW);
  const view = journeyView(taskOf(state, 'pricing-refresh'), contextOf(state));
  const find = lookup(state);

  it('keeps long failure diagnostics in details without expanding the diagram arrows', () => {
    const failed = { ...view.nodes[2]!, state: 'failed' as const, reason: 'The provider refused this request. '.repeat(100) };
    const long = { ...view, nodes: [failed, view.nodes[3]!] };
    const short = { ...long, nodes: [{ ...failed, reason: 'stuck' }, view.nodes[3]!] };
    const geometry = (view: JourneyView) => {
      const { items, ...layout } = layoutJourney(view, 820, 16, 'Started');
      return { ...layout, items: items.map(({ node: _node, ...item }) => item) };
    };
    expect(geometry(long)).toEqual(geometry(short));
    expect(spokenStep(failed, 2, find, state.now)).toContain(`Stopped because: ${failed.reason}`);
  });

  it('reads each step: number, name, state, tool and model, time, outcome and why it moved on', async () => {
    const selected: string[] = [];
    await render(<JourneyList view={view} find={find} now={state.now} onFocusStep={() => {}} onSelect={(id) => selected.push(id)} />);
    const list = host.querySelector('ol')!;
    expect(list.getAttribute('aria-label')).toBe(`Journey, ${view.nodes.length} steps`);
    const items = [...list.querySelectorAll('li')].map((item) => item.textContent);
    expect(items[3]).toBe('4. Code reviewer. Done. Codex · sol · high effort. 9m elapsed. 1 important. Moved on: sent back: 1 important.');
    expect(items[7]).toMatch(/^8\. Your delivery check\. Waiting for you\. Waiting \d+m so far\. Reviews done/);
    expect(items[8]).toBe('9. Publish delivery. Next.');
  });

  it('is one tab stop on the live step; the arrow keys move through it and Enter opens a step', async () => {
    const selected: string[] = [];
    const focused: (string | undefined)[] = [];
    await render(<JourneyList view={view} find={find} now={state.now} onFocusStep={(id) => focused.push(id)} onSelect={(id) => selected.push(id)} />);
    const items = [...host.querySelectorAll('li')];
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[7]]);
    expect(items[7]!.getAttribute('aria-current')).toBe('step');
    await act(async () => items[7]!.focus());
    await key('ArrowUp');
    expect(document.activeElement).toBe(items[6]);
    await key('Home');
    expect(document.activeElement).toBe(items[0]);
    await key('End');
    expect(document.activeElement).toBe(items.at(-1));
    await key('ArrowLeft');
    await key('Enter');
    expect(selected).toEqual([view.nodes[7]!.id]);
    expect(focused.at(-1)).toBe(view.nodes[7]!.id);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it('says what a question or permission asked, and how you answered', () => {
    const asking = journeyView(taskOf(state, 'guest-checkout'), contextOf(state));
    const builder = asking.nodes.findIndex((node) => node.name === 'Builder');
    expect(spokenStep(asking.nodes[builder]!, builder, find, state.now)).toMatch(/Builder\. Waiting for you\. Codex · sol · high effort\. \d+m elapsed so far\. Waiting for your permission\. Permission: Add a new package: Stripe\.js\. Waiting for you\.$/);
  });
});

describe('the journey in the task sheet', () => {
  async function mount(state: State) {
    simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
    await render(<App />);
  }
  async function openTask(id: string) {
    await act(async () => host.querySelector<HTMLElement>(`.card-open[aria-describedby~="status-${id}"]`)!.click());
  }

  it('shows fixed, reopened and new findings for the selected review round, with an honest total', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const fixture = repairedReviewFixture();
    task.journey = fixture.steps;
    task.findings = [...fixture.review.result!.findings!];
    await mount(state);
    await openTask(task.id);
    await act(async () => host.querySelectorAll<HTMLElement>('.journey-list li')[2]!.click());
    const details = host.querySelector('.journey-details')!;
    expect([...details.querySelectorAll('.journey-review-counts dt')].map((element) => element.textContent)).toEqual(['Fixed', 'Reopened', 'New']);
    expect([...details.querySelectorAll('.journey-review-counts dd')].map((element) => element.textContent)).toEqual(['3', '4', '2']);
    expect(details.querySelector('.journey-facts')?.textContent).toContain('6 important');
    const groups = [...details.querySelectorAll('.journey-review-group')];
    expect(groups.map((element) => element.querySelector('summary')?.textContent)).toEqual(['Reopened4', 'New2', 'Fixed3']);
    expect(groups[0]?.textContent).toContain('A failing variant on the reviewed version');
    expect(groups[1]?.textContent).toContain('new-1');
    expect(groups[2]?.textContent).toContain('A focused repair for old-4');
    expect(host.querySelectorAll('.journey-list li')[2]?.textContent).toContain('6 important');
  });

  it.each(['builder', 'architect', 'code-reviewer', 'tester', 'verifier'])('keeps message and terminal controls in the active %s node across its tabs', async (roleId) => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'guest-checkout');
    const role = state.roles.find((entry) => entry.id === roleId)!;
    task.state = 'running';
    task.agent = { roleId, profileId: 'codex-high', since: NOW - 1000, step: 0 };
    task.holdsSlot = true;
    delete task.helpers;
    delete task.conversation;
    state.inbox = state.inbox.filter((item) => item.taskId !== task.id);
    const prior = { ...task.journey![0]!, id: 'earlier', roleId: 'researcher', endedAt: NOW - 1000 };
    task.journey = [prior, { ...prior, id: 'active', roleId, profileId: 'codex-high', startedAt: NOW - 1000, endedAt: undefined, outcome: undefined, reason: undefined }];
    await mount(state);
    await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>('.journey-list [aria-current="step"]')!.click());
    const footer = host.querySelector('.task-agent-footer')!;
    expect(footer.textContent).toContain(`Message the ${role.name.toLowerCase()}`);
    expect(footer.textContent).toContain('Take over in terminal');
    expect(footer.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    for (const tab of ['timeline', 'conversation', 'overview']) {
      await act(async () => host.querySelector<HTMLButtonElement>(`[data-journey-tab="${tab}"]`)!.click());
      expect(host.querySelector('.task-agent-footer')).toBe(footer);
    }
    await act(async () => footer.querySelector<HTMLButtonElement>('.composer-toggle')!.click());
    const field = footer.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Keep this guidance');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => footer.querySelector<HTMLButtonElement>('.composer-toggle')!.click());
    expect(footer.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    expect(footer.textContent).toContain('Draft');
    expect(footer.textContent).toContain('Take over in terminal');
    await act(async () => footer.querySelector<HTMLButtonElement>('.composer-toggle')!.click());
    expect(footer.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this guidance');
    await act(async () => host.querySelector<HTMLElement>('.journey-list li')!.click());
    expect(host.querySelector('.task-agent-footer')).toBeNull();
  });

  it('shows review findings, design objections and the architect’s answers in their own nodes', async () => {
    const state = createDemoState(NOW);
    await mount(state);
    await openTask('guest-checkout');
    const select = async (role: string, round: number) => {
      const task = taskOf(simulator.getState(), 'guest-checkout');
      const index = task.journey!.findIndex((step) => step.roleId === role && step.round === round);
      await act(async () => [...host.querySelectorAll<HTMLElement>('.journey-list li')][index]!.click());
    };
    await select('design-reviewer', 1);
    expect(host.querySelector('.journey-details .issues')?.textContent).toContain('The brief does not say');
    expect(host.querySelector('.journey-details .issues')?.textContent).toContain('Blocking');
    await select('architect', 2);
    expect(host.querySelector('.journey-details .issues')?.textContent).toContain('Changed the design to cover it.');
    await act(async () => host.querySelector<HTMLButtonElement>('.step-panel-bar button')!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.task-list-item')].find((item) => item.textContent?.includes('Refresh the pricing page'))!.click());
    const task = taskOf(simulator.getState(), 'pricing-refresh');
    const index = task.journey!.findIndex((step) => step.roleId === 'code-reviewer' && step.round === 1);
    await act(async () => [...host.querySelectorAll<HTMLElement>('.journey-list li')][index]!.click());
    expect(host.querySelector('.journey-details .issues')?.textContent).toContain('plus sign');
    expect(host.querySelector('.journey-details .issues')?.textContent).toContain('Important');
  });

  it('collapses Session actions by default while leaving public messages visible', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'guest-checkout');
    task.session = [
      { id: 'message', from: 'agent', text: 'I found the case that needs a fix.', roleId: 'builder', at: NOW - 10 },
      ...['Reading the code', 'Checking the result'].map((text, index) => ({ id: `action-${index}`, from: 'activity' as const, text, roleId: 'builder', at: NOW - 9 + index })),
    ];
    await mount(state);
    await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>('#tab-session')!.click());
    const actions = host.querySelector<HTMLDetailsElement>('.session-activity')!;
    expect(actions.open).toBe(false);
    expect(actions.querySelector('summary')!.textContent).toBe('2 agent actions');
    expect(host.querySelector('.chat .bubble')?.textContent).toBe('I found the case that needs a fix.');
    expect(host.querySelector('.session-head')?.textContent).not.toContain('Take over');
    expect(host.querySelector('.task-agent-footer')?.textContent).toContain('Take over in terminal');
  });

  it('opens first in the Overview, and keeps the timeline and conversation in their own tabs', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    expect(host.querySelector('.workspace-journey h2')?.textContent).toContain('Task flow');
    expect(host.querySelector('.task-list')).not.toBeNull();
    expect(host.querySelector('.task-detail-panel #journey-details-title')).toBeNull();
    const reviewer = [...host.querySelectorAll<HTMLElement>('.journey-list li')].find((item) => item.textContent?.startsWith('4. Code reviewer'))!;
    await act(async () => reviewer.focus());
    await key('Enter');
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Code reviewer');
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('sent back: 1 important');
    await act(async () => details.querySelector<HTMLButtonElement>('[data-journey-tab="timeline"]')!.click());
    expect([...details.querySelectorAll('.tl .text')].map((entry) => entry.textContent)).toContain('Sent back to the builder: 1 important');

    // The selected run's conversation is read inline, without changing the task tab.
    await act(async () => details.querySelector<HTMLButtonElement>('[data-journey-tab="conversation"]')!.click());
    expect(details.querySelector('.step-conversation')?.getAttribute('aria-label')).toBe("This step's conversation");
    expect(host.querySelector('.step-panel-bar')?.textContent).toContain('Step details');
    expect([...details.querySelectorAll('button')].some((button) => button.textContent?.includes('Read this step'))).toBe(false);
  });

  it('explains a Builder fix assignment and shows the exact failed Tester check', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const builder = task.journey!.find((step) => step.roleId === 'builder')!;
    builder.agentInputs = [{ roleId: 'builder', profileId: builder.profileId!, taskTitle: task.title, taskDescription: task.description, stageTitle: 'Build', sections: [{ title: 'Implementation brief', body: 'Build the requested checkout changes.' }], mode: 'fresh' }];
    const tester = task.journey!.findLast((step) => step.work === 'checks' && step.endedAt !== undefined)!;
    delete tester.acceptanceChecks;
    tester.reason = 'one acceptance check failed';
    tester.outcome = '1 acceptance check failed';
    const testerIndex = task.journey!.indexOf(tester);
    task.journey = [...task.journey!.slice(0, testerIndex + 1), { ...builder, id: 'builder-fix-test', fixing: true, startedAt: NOW - 100, endedAt: NOW, builderConversation: 'resumed', reason: undefined, outcome: 'Fixes ready', agentInputs: [{ roleId: 'builder', profileId: builder.profileId!, taskTitle: task.title, stageTitle: 'Build', sections: [{ title: 'Review findings', body: 'The checkout total drops the selected shipping fee.' }], mode: 'continued' }] }];
    const fixInput = task.journey!.at(-1)!.agentInputs![0]!;
    fixInput.requestedProfileId = state.profiles[0]!.id;
    fixInput.selectionReason = 'The planned profile reached its weekly limit.';
    fixInput.confirmedSettings = { model: 'confirmed-model', effort: 'high' };
    fixInput.instructions = 'Correct the missing shipping fee, then check the total after changing delivery.';
    fixInput.updates = [{ at: NOW, reason: 'answer', text: 'The coordinator answered: keep the selected delivery method.' }];
    task.findings = [...task.findings, { id: 'finding-fix-1', text: 'The checkout total drops the selected shipping fee.', severity: 'blocking', raisedBy: 'code-reviewer', confirmedBy: [], status: 'open', answer: { fixed: false, text: 'The work still needs a correction.', at: NOW }, evidence: 'The displayed total excludes shipping after changing the delivery method.' }];
    task.brief = { summary: 'Keep the checkout total accurate.', forUsers: [], areas: [], risks: [], acceptance: [
      { text: 'Type checks and all tests pass.', verification: 'failed', met: false },
      { text: 'The total includes the selected shipping fee.', verification: 'passed', met: true },
    ] };
    await mount(state);
    await openTask('pricing-refresh');
    const firstBuilderItem = [...host.querySelectorAll<HTMLElement>('.journey-list li')].find((item) => /^\d+\. Builder\./.test(item.textContent ?? ''))!;
    await act(async () => firstBuilderItem.click());
    expect(host.querySelector('.journey-details')?.textContent).toContain('Task request');
    expect(host.querySelector('.journey-details')?.textContent).toContain(task.description);
    const builderItem = host.querySelector<HTMLElement>('.journey-list li[data-step-id="builder-fix-test"]')!;
    await act(async () => builderItem.click());
    let details = host.querySelector('.journey-details')!;
    expect(details.textContent).not.toContain('Task request');
    expect(details.textContent).not.toContain(task.description);
    expect(details.textContent).toContain('Input given to Builder');
    expect(details.querySelector('.journey-job')?.textContent).toContain(fixInput.instructions);
    expect(details.querySelector('.journey-input-updates')?.textContent).toContain(fixInput.updates[0]!.text);
    expect(details.textContent).toContain('Agent choice');
    expect(details.textContent).toContain('The planned profile reached its weekly limit.');
    expect(details.textContent).toContain('Tool confirmed at start: confirmed-model');
    expect(details.textContent).toContain('Type checks and all tests pass.');
    expect(details.textContent).not.toContain('Builder conversation');
    expect(details.textContent).toContain('Findings assigned to this fix');
    expect(details.textContent).toContain('The checkout total drops the selected shipping fee.');

    const testerItem = [...host.querySelectorAll<HTMLElement>('.journey-list li')].find((item) => item.textContent?.includes('Automated checks, round 2'))!;
    await act(async () => testerItem.click());
    details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Type checks and all tests pass.');
    expect(details.textContent).toContain('Failed');
    const acceptanceItems = [...details.querySelectorAll('.journey-check-list li')].map((item) => item.textContent ?? '');
    expect(acceptanceItems[0]).toContain('The total includes the selected shipping fee.');
    expect(acceptanceItems[1]).toContain('Type checks and all tests pass.');
  });

  it('names each automated check and its result on that journey step', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const checkStep = task.journey!.findLast((step) => step.kind === 'petrina' && step.work === 'checks')!;
    checkStep.productChecks = [{ name: 'Type check', result: 'pass' }, { name: 'Tests', result: 'fail' }];
    await mount(state);
    await openTask('pricing-refresh');
    const checkItem = host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${checkStep.id}"]`)!;
    await act(async () => checkItem.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Type check');
    expect(details.textContent).toContain('Passed');
    expect(details.textContent).toContain('Tests');
    expect(details.textContent).toContain('Failed');
  });
  it('shows running and pending checks beside completed results', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const step = task.journey!.findLast((step) => step.kind === 'petrina' && step.work === 'checks')!;
    step.productChecks = [{ name: 'Type check', result: 'pass', startedAt: NOW - 60_000, endedAt: NOW - 50_000 }, { name: 'Tests', result: 'running', startedAt: NOW - 120_000 }, { name: 'Commit message hook', result: 'pending' }];
    await mount(state);
    await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${step.id}"]`)!.click());
    const items = [...host.querySelectorAll('.journey-details .journey-check-list li')].map((item) => item.textContent);
    expect(items[0]).toContain('PassedType check');
    expect(items[1]).toContain('RunningTests2m so far');
    expect(items[2]).toContain('PendingCommit message hook');
  });

  it('shows the failed test behind a delivery checkpoint, not just “checks still fail”', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const deliveryIndex = task.journey!.findIndex((step) => step.kind === 'you' && step.waitsFor === 'delivery');
    const checkStep = task.journey!.find((step) => step.kind === 'petrina' && step.work === 'checks')!;
    task.journey = [...task.journey!.slice(0, deliveryIndex), { ...checkStep, id: 'checks-before-delivery', startedAt: NOW - 100, endedAt: NOW - 10 }, ...task.journey!.slice(deliveryIndex)];
    task.checks = { at: NOW, definition: 'current', results: [
      { name: 'Type check', command: 'bun run typecheck', ok: true, ms: 10, output: 'passed' },
      { name: 'Tests', command: 'bun run test', ok: false, ms: 100, output: '@petrina/engine:test  | (fail) reviews after a usage handoff > keeps a real reviewer handoff independent with 1 pool slots and one slot per tool [66762.68ms]\n@petrina/engine:test  | error: Timed out waiting for the independent reviews' },
      { name: 'Desktop shell', command: 'cargo check', ok: true, ms: 10, output: 'passed' },
    ] };
    await mount(state);
    await openTask('pricing-refresh');
    const delivery = task.journey!.find((step) => step.kind === 'you' && step.waitsFor === 'delivery')!;
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${delivery.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Checks behind this delivery decision');
    expect(details.textContent).toContain('Tests');
    expect(details.textContent).toContain('Failed');
    expect(details.textContent).toContain('keeps a real reviewer handoff independent');
    expect(details.textContent).toContain('Timed out waiting for the independent reviews');
  });

  it('uses footer marks instead of parentheses in flow and selected-step titles', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const builder = task.journey!.find((step) => step.kind === 'agent' && step.roleId === 'builder')!;
    const check = task.journey!.find((step) => step.kind === 'petrina' && step.work === 'checks')!;
    task.journey = [{ ...check, id: 'check-round-3', round: 3 }, { ...check, id: 'check-round-3-repeat', round: 3 }];
    const view = journeyView(task, contextOf(state));
    expect(view.nodes[0]).toMatchObject({ name: 'Automated checks (round 3)', flowName: 'Automated checks', roundMark: 3 });
    expect(view.nodes[1]).toMatchObject({ name: 'Automated checks (round 3, again)', flowName: 'Automated checks', roundMark: 3, repeatMark: true });
    const spoken = spokenStep(view.nodes[1]!, 1, lookup(state), NOW);
    expect(spoken).not.toContain('(');
    expect(spoken).toContain('Automated checks, round 3, repeated');

    const fixes = Array.from({ length: 6 }, (_, index) => ({ ...builder, id: `fix-${index}`, stageId: 'fix-stage', round: 1, fixing: true, endedAt: NOW - index - 1 }));
    task.journey = [...fixes, { ...builder, id: 'fix-7', stageId: 'fix-stage', round: 1, fixing: true, endedAt: undefined, startedAt: NOW }];
    const fix = journeyView(task, contextOf(state)).nodes.find((node) => node.id === 'fix-7')!;
    expect(fix).toMatchObject({ name: 'Builder (fixes 7)', flowName: 'Builder', fixMark: 7 });

    task.journey = [
      { ...check, id: 'update-1', stageId: 'update-stage', work: 'update', round: 1, endedAt: NOW - 1 },
      { ...check, id: 'update-2', stageId: 'update-stage', work: 'update', round: 1, endedAt: undefined, startedAt: NOW },
    ];
    expect(journeyView(task, contextOf(state)).nodes.find((node) => node.id === 'update-2')).toMatchObject({ name: 'Update branch (again)', flowName: 'Update branch', updateMark: true, repeatMark: true });

    task.journey = [
      { ...builder, id: 'tester-1', roleId: 'tester', stageId: 'test-stage', round: 2, fixing: false, update: false, endedAt: NOW - 1 },
      { ...builder, id: 'tester-2', roleId: 'tester', stageId: 'test-stage', round: 2, fixing: false, update: false, endedAt: undefined, startedAt: NOW },
    ];
    state.roles.find((role) => role.id === 'tester')!.name = 'Verifiers';
    expect(journeyView(task, contextOf(state)).nodes.find((node) => node.id === 'tester-2')).toMatchObject({ name: 'Verifiers (round 2, again)', flowName: 'Verifiers', roundMark: 2, repeatMark: true });
    await mount(state);
    await openTask('pricing-refresh');
    await act(async () => host.querySelector<HTMLElement>('.journey-list li[data-step-id="tester-2"]')!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.querySelector('#journey-details-title')?.textContent).toContain('Verifiers');
    expect(details.querySelector('#journey-details-title')?.textContent).not.toContain('(');
    const canvasStep = host.querySelector<HTMLElement>('.react-flow__node[data-id="tester-2"] .jn-name')!;
    expect(canvasStep.closest('.jn.k-box')?.querySelector('.jn-foot .jn-step-marks')).not.toBeNull();
    expect(canvasStep.textContent).not.toContain('(');
  });

  it('labels an older planner profile as planned, without claiming it actually ran', async () => {
    const state = createDemoState(NOW);
    await mount({ ...state, tasks: state.tasks.map((task) => {
      if (task.id !== 'pricing-refresh') return task;
      const { journey: _gone, ...older } = task;
      return older;
    }) });
    await openTask('pricing-refresh');
    const planner = host.querySelector<HTMLElement>('.journey-list li')!;
    expect(planner.textContent).toContain('Planned: Claude Code');
    await act(async () => planner.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Planned tool and model');
    expect(details.textContent).toContain('who actually ran it, its time and outcome were not recorded');
  });

  it('stops following the live step while you read another one, until Back to now', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    const backToNow = () => [...host.querySelectorAll<HTMLButtonElement>('.journey-controls button')].find((button) => button.textContent === 'Back to now');
    expect(backToNow()).toBeUndefined();
    // Choosing the live step keeps following it.
    const items = () => [...host.querySelectorAll<HTMLElement>('.journey-list li')];
    await act(async () => items()[7]!.focus());
    await key('Enter');
    expect(backToNow()).toBeUndefined();
    // Moving to an earlier step, by keyboard or click, stops following.
    await key('ArrowUp');
    expect(backToNow()).toBeDefined();
    await act(async () => backToNow()!.click());
    expect(backToNow()).toBeUndefined();
    await act(async () => items()[1]!.click());
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Builder');
    expect(backToNow()).toBeDefined();
    // A handoff while you read keeps the diagram where it is: still not following.
    await act(async () => { simulator.setPoolPaused(false); simulator.tick(); simulator.tick(); });
    expect(backToNow()).toBeDefined();
  });

  it('keeps the flow visible across detail tabs and switches tasks from the adjacent list', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    const workspace = host.querySelector('.task-workspace');
    const canvas = host.querySelector('.journey-canvas');
    await act(async () => host.querySelector<HTMLElement>('#tab-plan')!.click());
    expect(host.querySelector('.journey-canvas')).toBe(canvas);
    expect(host.querySelector('.task-detail-panel')?.textContent).toContain('Why this plan');
    await act(async () => [...host.querySelectorAll<HTMLElement>('.journey-list li')][1]!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.journey-detail-tabs [data-journey-tab="conversation"]')!.click());
    expect(host.querySelector('.task-global-details')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('.task-detail-panel #journey-details-title')?.textContent).toContain('Builder');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.step-panel-bar button')][0]!.click());
    expect(host.querySelector('#tab-plan')?.getAttribute('aria-selected')).toBe('true');
    const other = [...host.querySelectorAll<HTMLButtonElement>('.task-list-item')].find((button) => button.textContent?.includes('Guest checkout'))!;
    await act(async () => other.click());
    expect(host.querySelector('.task-workspace')).toBe(workspace);
    expect(host.querySelector('.sheet-title')?.textContent).toBe('Guest checkout');
    expect(host.querySelector('.task-detail-panel #journey-details-title')).toBeNull();
    expect(host.querySelector('.task-list-item[aria-current="true"]')?.textContent).toContain('Guest checkout');
    // The current permission can be answered without closing the task or finding it in the inbox.
    const allow = [...host.querySelectorAll<HTMLButtonElement>('.task-decisions button')].find((button) => button.textContent === 'Allow')!;
    await act(async () => allow.click());
    expect(simulator.getState().inbox.some((item) => item.taskId === 'guest-checkout' && item.kind === 'permission')).toBe(false);
    expect(host.querySelector('.task-workspace')).toBe(workspace);
    const ids = [...host.querySelectorAll<HTMLElement>('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stops following when the live step you are reading hands off', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    const backToNow = () => [...host.querySelectorAll<HTMLButtonElement>('.journey-controls button')].find((button) => button.textContent === 'Back to now');
    await act(async () => [...host.querySelectorAll<HTMLElement>('.journey-list li')][7]!.click());
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Your delivery check');
    expect(backToNow()).toBeUndefined();
    // You approve the delivery elsewhere while its details are open: the diagram stays with the step you read.
    const check = simulator.getState().inbox.find((item) => item.taskId === 'pricing-refresh' && item.kind === 'delivery')!;
    await act(async () => simulator.approve(check.id));
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Your delivery check');
    expect(backToNow()).toBeDefined();
    await act(async () => backToNow()!.click());
    expect(backToNow()).toBeUndefined();
  });

  it('keeps reading a step in place when the hidden Session receives a message', async () => {
    await mount(createDemoState(NOW));
    await openTask('pricing-refresh');
    await act(async () => host.querySelector<HTMLElement>('#tab-session')!.click());
    const scroller = host.querySelector<HTMLElement>('.task-detail-panel .sheet-scroll')!;
    Object.defineProperty(scroller, 'scrollHeight', { value: 900, configurable: true });
    await act(async () => [...host.querySelectorAll<HTMLElement>('.journey-list li')][1]!.click());
    expect(host.querySelector('.session-head')).toBeNull();
    scroller.scrollTop = 45;
    await act(async () => simulator.sendMessage('pricing-refresh', 'A new note while I read this step'));
    expect(scroller.scrollTop).toBe(45);
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Builder');
  });

  it('offers zoom, the whole journey, and labels every control', async () => {
    await mount(createPortfolioDemo(NOW).state);
    const usage = simulator.getState().tasks.find((task) => task.title === 'Usage dashboard' && task.state === 'done')!;
    await act(async () => host.querySelector<HTMLElement>('.rail a[title="History"]')!.click());
    await act(async () => host.querySelector<HTMLElement>(`.history-card[data-task-id="${usage.id}"]`)!.click());
    const controls = [...host.querySelectorAll('.journey-controls button')].map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(controls).toEqual(['Zoom in', 'Zoom out', 'Show the whole journey']);
    expect(host.querySelector('.journey-list')?.getAttribute('aria-label')).toBe('Journey, 20 steps');
    expect(host.querySelector('.journey-flow')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('unusual endings in words', () => {
  const state = createDemoState(NOW);
  const merged = taskOf(state, 'sentry');
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

describe('the journey layout', () => {
  const state = createPortfolioDemo(NOW).state;
  const usage = journeyView(state.tasks.find((task) => task.title === 'Usage dashboard' && task.state === 'done')!, contextOf(state));

  it.each(['back', 'stuck'] as const)('keeps a %s arrow’s colour when its target starts working or waits', (tone) => {
    for (const target of [
      { state: 'now', run: 'working' },
      { state: 'now', run: 'paused' },
      { state: 'now', run: 'waiting' },
      { state: 'you' },
      { state: 'done' },
    ] as const) {
      const view: JourneyView = {
        start: { kind: 'started', at: NOW },
        nodes: [
          { id: 'from', name: 'Builder', kind: 'agent', state: tone === 'stuck' ? 'failed' : 'done', tone, asks: [], reason: tone === 'stuck' ? 'stuck' : 'changes asked' },
          { id: 'to', name: 'Next step', kind: target.state === 'you' ? 'you' : 'agent', tone: 'on', asks: [], ...target },
        ],
      };
      const arrow = layoutJourney(view, 820, 16, 'Started').edges.find((edge) => edge.source === 'from')!;
      expect(arrow.kind).toBe(tone);
      expect(arrow.labelTone).toBe(tone);
      expect(arrow.live).toBe(target.state === 'now' && target.run === 'working');
    }
  });

  it('wraps rows like text, down to one box per row, with the arrow running back under each row', () => {
    for (const width of [2000, 820, 560, 260]) {
      const layout = layoutJourney(usage, width, 16, 'Started 22h ago');
      const rows = new Map<number, typeof layout.items>();
      for (const item of layout.items) rows.set(item.row, [...(rows.get(item.row) ?? []), item]);
      for (const items of rows.values()) {
        // Nothing in a row overlaps, and everything fits in the width.
        items.slice(1).forEach((item, index) => expect(item.x).toBeGreaterThanOrEqual(items[index]!.x + items[index]!.width));
        expect(items.at(-1)!.x + items.at(-1)!.width).toBeLessThanOrEqual(Math.max(width, 24 + 192));
      }
      if (width <= 260) expect([...rows.values()].every((items) => items.length === 1)).toBe(true);
      for (const edge of layout.edges.filter((entry) => entry.wraps)) {
        // The arrow between rows runs below everything in the row it leaves.
        const from = layout.items.find((item) => item.id === edge.source)!;
        const bottom = Math.max(...rows.get(from.row)!.map((item) => item.y + item.height));
        expect(edge.labelY).toBeGreaterThan(bottom);
      }
    }
  });

  it('reserves the full arrow explanation beside boxes and below wrapped rows', () => {
    const reason = [
      JOURNEY_WORDS.landed(['Guest checkout with receipts and saved payment methods for returning customers', 'Account settings with workspace invitations and a complete billing history', 'An accessible reporting dashboard with monthly exports and timezone support']),
      JOURNEY_WORDS.othersCancelled(['Order confirmation emails with delivery tracking for international customers']),
    ].join('; ');
    const view: JourneyView = {
      start: { kind: 'started', at: NOW - 60_000 },
      nodes: [
        { id: 'wait', name: 'Waiting for others', kind: 'wait', state: 'done', tone: 'on', asks: [], reason },
        { id: 'planner', name: 'Planner', kind: 'agent', state: 'now', tone: 'on', asks: [] },
      ],
    };
    for (const [width, rem] of [[2000, 16], [820, 16], [560, 16], [260, 16], [820, 32]] as const) {
      const layout = layoutJourney(view, width, rem, 'Started');
      const label = layout.edges.find((edge) => edge.source === 'wait')!;
      const bottom = label.labelY;
      const top = bottom - label.labelHeight;
      expect(label.label).toBe(reason);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeLessThanOrEqual(layout.height);
      expect(label.labelX - label.labelWidth / 2).toBeGreaterThanOrEqual(0);
      expect(label.labelX + label.labelWidth / 2).toBeLessThanOrEqual(layout.width);
      for (const box of layout.items) {
        const overlaps = label.labelX - label.labelWidth / 2 < box.x + box.width && label.labelX + label.labelWidth / 2 > box.x && top < box.y + box.height && bottom > box.y;
        expect(overlaps, `label crosses ${box.id} at ${width}px / ${rem}px text`).toBe(false);
      }
    }
  });

  it('grows with enlarged text, so fewer boxes fit on a row', () => {
    const normal = layoutJourney(usage, 820, 16, 'Started');
    const large = layoutJourney(usage, 820, 32, 'Started');
    const perRow = (layout: typeof normal) => Math.max(...[...new Set(layout.items.map((item) => item.row))].map((row) => layout.items.filter((item) => item.row === row).length));
    expect(perRow(large)).toBeLessThan(perRow(normal));
  });
});

describe('the live arrow with reduced motion', () => {
  it.each(['back', 'stuck', 'on'] as const)('stays solid and stronger after %s, keeping its colour', async (tone) => {
    const device = (window as unknown as HappyWindow).happyDOM.settings.device;
    const previous = device.prefersReducedMotion;
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
    device.prefersReducedMotion = 'reduce';
    document.head.append(style);
    try {
      const view: JourneyView = {
        start: { kind: 'started', at: NOW },
        nodes: [
          { id: 'from', name: 'Code reviewer', kind: 'agent', state: 'done', tone, asks: [] },
          { id: 'to', name: 'Builder (fixes)', kind: 'agent', state: 'now', run: 'working', tone: 'on', asks: [] },
        ],
      };
      const edge = (run: 'working' | 'paused' | 'waiting', finished = false) => {
        view.nodes[1] = { ...view.nodes[1]!, state: finished ? 'done' : 'now', run };
        const arrow = layoutJourney(view, 820, 16, 'Started').edges.find((entry) => entry.source === 'from')!;
        return <JourneyEdge data={{ ...arrow, tip: 8, motion: arrow.live && !window.matchMedia('(prefers-reduced-motion: reduce)').matches }} />;
      };
      await render(<svg>{edge('working')}</svg>);
      const live = getComputedStyle(host.querySelector('.je-line')!);
      const width = Number.parseFloat(live.strokeWidth);
      const colour = live.stroke;
      expect(width).toBeGreaterThan(2);
      expect(live.strokeDasharray).toBe('none');
      expect(live.animation).toBe('none');
      // Finished send-backs, paused steps and waiting for a slot must not get live emphasis.
      for (const [run, finished] of [['working', true], ['paused', false], ['waiting', false]] as const) {
        await act(async () => root.render(<svg>{edge(run, finished)}</svg>));
        const resting = getComputedStyle(host.querySelector('.je-line')!);
        expect(Number.parseFloat(resting.strokeWidth)).toBeLessThan(width);
        if (tone !== 'on') expect(resting.stroke).toBe(colour);
      }
    } finally {
      style.remove();
      device.prefersReducedMotion = previous;
    }
  });
});
