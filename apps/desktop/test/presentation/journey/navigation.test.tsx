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
import { Simulator, repositoryTaskView, createDemoState, createPortfolioDemo, journeyView, type State, type Task } from "@petrina/core";
import { App } from '../../../src/App';
import { spokenStep } from "../../../src/components/Journey";
import { lookup } from "../../../src/lib";

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

const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });

const taskOf = (state: State, id: string): Task => state.tasks.find((task) => task.id === id)!;

async function key(name: string) { await act(async () => { (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); }); }

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
    const message = host.querySelector('.chat .bubble')!;
    expect(message.querySelector('.message-markdown')?.textContent).toBe('I found the case that needs a fix.');
    expect(message.querySelector('.message-recording-note')?.textContent).toBe('This older record does not establish whether the message is complete or its original length.');
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
    expect(host.querySelector('.journey-list')?.getAttribute('aria-label')).toBe(`Journey, ${journeyView(usage, contextOf(simulator.getState())).nodes.length} steps`);
    expect(host.querySelector('.journey-flow')?.getAttribute('aria-hidden')).toBe('true');
  });
});

it.each(['local', 'release'] as const)('opens a shared task delivered by %s alongside an open pull request', async (delivery) => {
  const state = createDemoState(NOW);
  const [first, second] = state.products;
  const base = state.tasks.find(task => task.state === 'done' && task.pr)!;
  const pr = { number: 44, url: 'https://example.test/44', state: 'open' as const, openedAt: NOW };
  const work: NonNullable<Task['repositories']>[number] = { productId: second!.id, delivery, completedStages: [], ...(delivery === 'local' ? { landed: { branch: 'main', sha: 'abc' } } : { release: { tag: 'v1.2.3', url: 'https://example.test/v1.2.3' } }) };
  const task = repositoryTaskView({ ...base, id: 'shared-delivery', title: 'Shared delivery regression', productId: second!.id, activeProductId: second!.id, state: 'pr-open', repositories: [
    { productId: first!.id, delivery: 'pull-request', completedStages: [], pr }, work,
  ] }, work);
  simulator = new Simulator({ ...state, tasks: [task], inbox: [], pool: { ...state.pool, paused: true } });
  history.replaceState(null, '', '/tasks/shared-delivery?demo');
  await render(<App />);
  expect(host.querySelector('.sheet-title')).not.toBeNull();
  expect(host.textContent).toContain(delivery === 'local' ? 'Delivered locally to main' : 'Released v1.2.3');
  expect(host.textContent).toContain('Pull request #44');
});
