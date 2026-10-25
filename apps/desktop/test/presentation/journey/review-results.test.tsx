vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateTitle, Simulator, createDemoState, type State, type Task } from "@petrina/core";
import { App } from '../../../src/App';
import { repairedReviewFixture } from '../../fixtures/review-round';

let simulator: Simulator;

const live = { link: 'live', desktop: false };

const empty: never[] = [];

vi.mock('../../../src/engine', () => ({
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

const taskOf = (state: State, id: string): Task => state.tasks.find((task) => task.id === id)!;

async function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

beforeEach(() => localStorage.clear());

afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('the journey in the task sheet', () => {
  async function mount(state: State) {
    simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
    await render(<App />);
  }

  async function openTask(id: string) {
    await act(async () => host.querySelector<HTMLElement>(`.card-open[aria-describedby~="status-${id}"]`)!.click());
  }

  it.each(['light', 'dark'])('offers final verification without approving delivery after an exhausted review in %s', async theme => {
    localStorage.setItem('petrina.theme', theme);
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    task.reviewDecision = { stageId: 'review', round: 3, accepted: false };
    const item = state.inbox.find(entry => entry.taskId === task.id && entry.kind === 'delivery')!;
    item.title = gateTitle(task, 'delivery');
    await mount(state);
    await openTask(task.id);
    const request = [...host.querySelectorAll<HTMLElement>('.ask')].find(element => element.textContent?.includes(item.title))!;
    expect(request).toBeTruthy();
    expect(request.querySelector('.ask-actions .lead')?.textContent).toContain('Continue to final checks');
    await act(async () => request.querySelector<HTMLButtonElement>('.ask-actions .lead')!.click());
    const next = simulator.getState();
    expect(taskOf(next, task.id).reviewDecision?.accepted).toBe(true);
    expect(taskOf(next, task.id).state).toBe('needs-you');
    expect(next.inbox.find(entry => entry.taskId === task.id && entry.kind === 'delivery')!.id).not.toBe(item.id);
    expect([...host.querySelectorAll('.ask-actions .lead')].some(button => button.textContent?.includes('Continue to final checks'))).toBe(false);
  });

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

  it.each(['code-reviewer', 'verifier'])('labels settled evidence on a still-open %s step by its result kind', async roleId => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'guest-checkout');
    task.state = 'running';
    task.agent = { roleId, profileId: 'sol-high', since: NOW - 1000, step: 0 };
    task.holdsSlot = true;
    delete task.helpers; delete task.conversation;
    state.inbox = state.inbox.filter(item => item.taskId !== task.id);
    task.journey = [{ id: 'settled-open', kind: 'agent', roleId, profileId: 'sol-high', round: 1, sub: 0, startedAt: NOW - 1000, result: { findingsSettled: true, findings: [{ id: 'waiting-vote', text: 'A report waiting for voting', status: 'open', severity: 'blocking', raisedBy: 'sol-high', confirmedBy: [] }] } }];
    await mount(state);
    await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>('.journey-list li')!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.querySelector('.journey-review')).toBeNull();
    expect(details.textContent).toContain(roleId === 'verifier' ? 'Settled decisions for this vote step.' : 'Settled decisions for this review round.');
    expect(details.textContent).not.toContain(roleId === 'verifier' ? 'Settled decisions for this review round.' : 'Settled decisions for this vote step.');
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

  it.each([false, true])('keeps a real repair report neutral with a check finding=%s', async (checkFinding) => {
    const state = createDemoState(NOW), task = taskOf(state, 'pricing-refresh');
    const builder = task.journey!.findLast(step => step.roleId === 'builder')!;
    builder.fixing = true;
    if (checkFinding) builder.findingIds = ['repair'];
    else delete builder.findingIds; // Older saved returns can retain answers without a separate assignment list.
    builder.builderReturn = { productId: task.productId, changed: true, claimedFixes: 1, outcome: 'Changes returned; 1 fix claimed' };
    builder.agentResults = [{ roleId: 'builder', profileId: builder.profileId!, at: NOW - 1, value: { summary: 'Added the startup guard.' } }];
    builder.result = { findings: [{ id: 'repair', text: checkFinding ? 'Check failed: Tests' : 'The greeting needs a guard', raisedBy: checkFinding ? 'petrina' : 'sol-high', confirmedBy: [], severity: 'blocking', status: 'open', answer: { fixed: true, text: 'Added the startup guard.', at: NOW - 1 } }] };
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${builder.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Builder’s report');
    expect(details.textContent).toContain('Added the startup guard.');
    expect(details.textContent).toContain('Findings assigned to this fix');
    expect(details.textContent?.split(checkFinding ? 'Check failed: Tests' : 'The greeting needs a guard')).toHaveLength(2);
    expect(details.textContent).not.toContain('Findings from this step');
    expect(details.textContent).not.toContain('Builder’s explanation — not independently confirmed');
  });

  it('keeps a renamed Builder with no assigned findings free of reviewer finding headings', async () => {
    const state = createDemoState(NOW), task = taskOf(state, 'pricing-refresh');
    const role = state.roles.find(role => role.result === 'build')!;
    role.id = 'repair-specialist'; role.name = 'Repair specialist';
    const builder = task.journey!.findLast(step => step.roleId === 'builder')!;
    builder.roleId = role.id; builder.fixing = true; builder.findingIds = [];
    builder.result = { findings: [] };
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${builder.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Findings assigned to this fix');
    expect(details.textContent).not.toContain('Findings from this step');
    expect(details.textContent).not.toContain('No findings were raised or confirmed');
  });
});
