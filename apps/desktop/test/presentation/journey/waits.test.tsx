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
import { blocksDependents, historyItem, beginAgentStep, syncRuntimeWaitJourney, Simulator, repositoryTaskView, createDemoState, type State, type Task, type DeepMutable } from "@petrina/core";
import { App } from '../../../src/App';
import { Journey } from "../../../src/components/Journey";
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

  it('shows a runtime wait reason and recorded prerequisite outcomes in its journey and details', async () => {
    const state = createDemoState(NOW), task = taskOf(state, 'pricing-refresh') as DeepMutable<Task>;
    task.state = 'waiting'; task.agent = undefined; task.helpers = undefined; task.journey = [];
    const view = { held: true, phase: 'active' as const, reason: 'Final Linux validation needs the capacity fix.', prerequisites: [{ id: 'guest-checkout', title: 'Fix the capacity tests', state: 'cancelled', landed: false, decisionNeeded: true }] };
    syncRuntimeWaitJourney(task, view, NOW - 100);
    await mount(state); await openTask(task.id);
    const node = task.journey!.at(-1)!;
    const spoken = host.querySelector(`.journey-list li[data-step-id="${node.id}"]`)!;
    expect(spoken.textContent).toContain('Reason for waiting: Final Linux validation needs the capacity fix.');
    expect(host.querySelector('.jn-tool[title*="Final Linux validation"]')?.textContent).toContain('cancelled');
    await act(async () => (spoken as HTMLElement).click());
    expect(host.querySelector('.journey-details')?.textContent).toContain('Reason for waiting');
    expect(host.querySelector('.journey-details')?.textContent).toContain(view.reason);
    expect(host.querySelector('.journey-details')?.textContent).toContain('cancelled · your decision is needed');
  });

  it('removes a released partial review hold and keeps its real seat results and conversation starts', async () => {
    const state = createDemoState(NOW), task = taskOf(state, 'pricing-refresh') as DeepMutable<Task>;
    task.state = 'waiting'; task.agent = undefined; task.helpers = undefined; task.journey = [];
    task.stageIndex = task.plan!.stages.findIndex(stage => stage.roleId === 'code-reviewer');
    const first = state.profiles[0]!.id, second = state.profiles[1]!.id;
    const group = beginAgentStep(task, 'code-reviewer', first, NOW - 100, state.roles, [first, second]);
    group.seats = ['reviewer:0', 'reviewer:1'];
    group.agentInputs = [{ roleId: 'code-reviewer', profileId: first, reviewerKey: '0', taskTitle: task.title, mode: 'fresh', sections: [] }];
    group.agentResults = [{ roleId: 'code-reviewer', profileId: first, at: NOW - 50, inputIndex: 0, value: { summary: 'First seat finished its independent review.' } }];
    const accepted = structuredClone(group.agentResults);
    const held = { held: true, phase: 'active' as const, reason: 'Final validation needs the capacity fix.', prerequisites: [{ id: 'guest-checkout', title: 'Capacity fix', state: 'still in progress', landed: false, decisionNeeded: false }] };
    syncRuntimeWaitJourney(task, held, NOW - 40);
    expect(group.outcome).toBe('1 of 2 reported; waiting for prerequisites');
    syncRuntimeWaitJourney(task, { ...held, held: false, phase: 'released', releaseReason: 'All required tasks landed' }, NOW - 20);
    expect(group.agentResults).toEqual(accepted);
    expect(group.endedAt).toBeUndefined();
    expect(group.waitReason).toBeUndefined();
    expect(group.waitsOn).toBeUndefined();
    expect(group.waitStates).toBeUndefined();
    expect(group.outcome).toBeUndefined();
    group.agentInputs = [...group.agentInputs!, { roleId: 'code-reviewer', profileId: second, reviewerKey: '1', taskTitle: task.title, mode: 'continued', resumed: true, sections: [] }];
    task.state = 'running'; task.statusLine = 'Code reviewer is finishing the remaining seat';
    task.agent = { roleId: 'code-reviewer', profileId: second, reviewKey: '1', since: NOW - 10, step: 0 };
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${group.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).not.toContain('waiting for prerequisites');
    expect(details.textContent).not.toContain('Reason for waiting');
    expect(details.textContent).toContain(task.statusLine);
    expect([...details.querySelectorAll('.journey-input-mode')].map(node => node.textContent)).toEqual(['Fresh conversation', 'Continued conversation']);
    expect(task.journey).toHaveLength(1);
    expect(task.journey![0]!.agentResults).toEqual(accepted);
  });
});

describe('prerequisite outcomes in Waiting for others details', () => {
  const pr = { number: 44, url: 'https://example.test/44', openedAt: NOW };

  const local = { productId: 'local', delivery: 'local' as const, completedStages: [], landed: { branch: 'main', sha: 'abc' } };

  const merged = { productId: 'merged', delivery: 'pull-request' as const, completedStages: [], pr: { ...pr, state: 'merged' as const } };

  const open = { ...merged, productId: 'companion', pr: { ...pr, number: 55, state: 'open' as const } };

  const closed = { ...open, pr: { ...open.pr, state: 'closed' as const } };

  const unpushed = { ...local, productId: 'unpushed', localUpdate: { ...local.landed, pushed: false } };

  const pushed = { ...unpushed, localUpdate: { ...local.landed, pushed: true } };

  const cases = [
    { name: 'merged delivery with an unpushed companion commit', works: [merged, unpushed], state: 'done', words: 'not landed yet', blocks: true },
    { name: 'unpushed commit shown beside a merged companion', works: [unpushed, merged], state: 'done', words: 'not landed yet', blocks: true },
    { name: 'merged delivery with a pushed companion commit', works: [merged, pushed], state: 'done', words: 'landed', blocks: false },
    { name: 'local delivery with an open companion', works: [local, open], state: 'pr-open', words: 'not landed yet: awaiting merge', blocks: true },
    { name: 'merged delivery with a closed companion', works: [merged, closed], state: 'pr-open', words: 'did not land: closed without merging', blocks: true },
    { name: 'fully landed shared work', works: [local, merged], state: 'done', words: 'landed', blocks: false },
    { name: 'a single open pull request', works: [open], state: 'pr-open', words: 'not landed yet: awaiting merge', blocks: true },
    { name: 'a single merged pull request', works: [merged], state: 'done', words: 'landed', blocks: false },
    { name: 'a single closed pull request', works: [closed], state: 'done', words: 'did not land: closed without merging', blocks: true },
  ] as const;

  for (const historical of [false, true]) {
    it.each(cases)(`shows $name using ${historical ? 'History' : 'live'} evidence`, async ({ works, state: taskState, words, blocks }) => {
      const demo = createDemoState(NOW);
      const base = taskOf(demo, 'dark-mode');
      const prerequisite = repositoryTaskView({ ...base, state: historical ? 'done' : taskState, repositories: works }, works[0]!);
      const waiting = taskOf(demo, 'tag-search');
      const state: State = { ...demo, tasks: historical ? [waiting] : [waiting, prerequisite], history: historical ? { ...demo.history!, dependencies: [{ ...historyItem(prerequisite), blocksDependents: blocks }] } : undefined };
      expect(blocksDependents(prerequisite)).toBe(blocks);
      await render(<Journey task={waiting} state={state} find={lookup(state)} onPlan={() => {}} onReadSession={() => {}} />);
      await act(async () => host.querySelector<HTMLElement>('.journey-list li')!.click());
      expect(host.querySelector('#journey-details-title')!.textContent).toContain('Waiting for others');
      expect(host.querySelector('.journey-waits')!.textContent).toBe(`“${prerequisite.title}” ${words}`);
    });
  }

  it('keeps the recorded title when a prerequisite is unavailable', async () => {
    const demo = createDemoState(NOW);
    const waiting = taskOf(demo, 'tag-search');
    const state = { ...demo, tasks: [waiting], history: undefined };
    await render(<Journey task={waiting} state={state} find={lookup(state)} onPlan={() => {}} onReadSession={() => {}} />);
    await act(async () => host.querySelector<HTMLElement>('.journey-list li')!.click());
    expect(host.querySelector('.journey-waits')!.textContent).toBe('“Dark mode” no longer on the board');
  });
});
