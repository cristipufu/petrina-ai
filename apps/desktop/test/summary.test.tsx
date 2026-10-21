import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemoState } from '@petrina/core';
import { App } from '../src/App';

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

let root: Root;
let host: HTMLDivElement;
const card = (id: string) => host.querySelector<HTMLElement>(`.card[data-task-id="${id}"]`)!;
const text = (element: Element | null | undefined) => element?.textContent?.trim();
async function open(id: string) { await act(async () => card(id).querySelector<HTMLButtonElement>('.card-open')!.click()); }

beforeEach(async () => {
  localStorage.clear();
  const state = createDemoState(1_000_000_000);
  simulator = new Simulator(state, { tickMs: 2_200 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<App />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('what each task says at a glance', () => {
  it('keeps completed command evidence private and counts repeated actions in the conversation', async () => {
    const state = simulator.getState();
    const task = structuredClone(state.tasks.find(task => task.id === 'login-loop')!);
    task.todo = undefined;
    task.statusLine = 'Continuing work';
    task.toolActivity = { actionCount: 2, lastActivity: 'Running a command' };
    const step = [...task.journey!].reverse().find(step => step.kind === 'agent')!;
    step.toolActivity = { tester: task.toolActivity };
    step.toolInvocations = [{ id: 'command', turnId: 'turn', toolCallId: 'native', description: 'Running a command', kind: 'execute', command: 'PRIVATE_COMMAND && PRIVATE_CODE', title: 'PRIVATE_TITLE', paths: ['/PRIVATE_PATH'], startedAt: state.now - 2, updatedAt: state.now - 1, endedAt: state.now - 1, status: 'completed', seat: 'tester', roleId: 'tester', profileId: 'sol-high', productId: task.productId }];
    task.session = [1, 2].map(index => ({ id: `repeated-${index}`, toolInvocationId: `invocation-${index}`, at: state.now, from: 'activity', text: 'Running a command', step: step.id }));
    simulator = new Simulator({ ...state, tasks: state.tasks.map(entry => entry.id === task.id ? task : entry) });
    await act(async () => root.render(<App />));
    expect(text(card(task.id).querySelector('.card-status'))).toBe('Continuing work');
    expect(host.textContent).not.toContain('PRIVATE_');
    await open(task.id);
    expect(host.querySelector('.now')!.textContent).toContain('Continuing work');
    expect(host.textContent).not.toContain('PRIVATE_');
    await act(async () => host.querySelector<HTMLButtonElement>('#tab-session')!.click());
    const group = host.querySelector<HTMLDetailsElement>('[data-line="repeated-1"]')!;
    expect(text(group.querySelector('summary'))).toBe('2 agent actions');
    await act(async () => { group.open = true; group.dispatchEvent(new Event('toggle')); });
    expect(group.querySelectorAll('li')).toHaveLength(2);
    expect(host.textContent).not.toContain('PRIVATE_');
    await act(async () => host.querySelector<HTMLElement>('.journey-list [aria-current="step"]')!.click());
    expect(host.textContent).not.toContain('PRIVATE_');
  });

  it('keeps the to-do item on the card while its actions change, with Next only in the details', async () => {
    const working = card('login-loop');
    expect(text(working.querySelector('.card-status'))).toBe('Trying to prove “done” wrong');
    expect(working.textContent).not.toContain('Next:');
    expect(working.querySelector('.card-open')!.getAttribute('aria-describedby')).toBe('status-login-loop');
    // Tool activity moves on; the card's main line stays.
    await act(async () => simulator.tick());
    expect(simulator.getState().tasks.find((task) => task.id === 'login-loop')!.statusLine).toBe('Running the tests');
    expect(text(card('login-loop').querySelector('.card-status'))).toBe('Trying to prove “done” wrong');
  });

  it('says what a task waits for first, without Next on any Board card', () => {
    expect(text(card('guest-checkout').querySelector('.card-status'))).toBe('Waiting for your permission');
    for (const card of host.querySelectorAll('.card')) expect(card.textContent).not.toContain('Next:');
  });

  it('shows the to-do item, the latest action, the time left and Next under Right now', async () => {
    await open('login-loop');
    expect(text(host.querySelector('.task-list-item[aria-current="true"] .task-list-status'))).toBe('Trying to prove “done” wrong');
    const now = host.querySelector('.now')!;
    expect(text(now.querySelector('.what'))).toMatch(/^Trying to prove “done” wrong · /);
    expect([...now.querySelectorAll('.now-line')].map(text)).toEqual(['Reading the code', 'About 30 minutes left', 'Next: your OK to ship, or fixes by the builder if blocking issues are found']);
  });

  it('while the agent waits on you, says what it waits for and keeps the to-do item it was on', async () => {
    await open('guest-checkout');
    const now = host.querySelector('.now')!;
    expect(text(now.querySelector('.what'))).toMatch(/^Waiting for your permission/);
    const lines = [...now.querySelectorAll('.now-line')].map(text);
    expect(lines[0]).toBe('Connecting guest checkout to the backend');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Next: /);
  });

  it('does not add the wait for an answer to the time worked on the step', async () => {
    await open('guest-checkout');
    const time = () => text(host.querySelector('.now .what .num'));
    const before = time();
    // Keep the permission open while ten minutes pass on the demo clock.
    await act(async () => simulator.tick(simulator.getState().now + 10 * 60_000));
    expect(time()).toBe(before);
    expect(host.querySelector('.now')!.textContent).not.toMatch(/minutes left|hour.*left|longer than usual/);
  });

  it('leaves out the quiet action when it repeats the to-do item', async () => {
    const state = simulator.getState();
    simulator = new Simulator({ ...state, tasks: state.tasks.map((task) => task.id === 'login-loop' ? { ...task, statusLine: task.todo! } : task) });
    await act(async () => root.render(<App />));
    await open('login-loop');
    expect([...host.querySelectorAll('.now .now-line')].map(text)).toEqual(['About 30 minutes left', 'Next: your OK to ship, or fixes by the builder if blocking issues are found']);
  });

  it('updates Next immediately when the Plan tab changes who does a coming step', async () => {
    await open('weekly-digest');
    await act(async () => host.querySelector<HTMLButtonElement>('.sheet [role="tab"][id="tab-plan"]')!.click());
    const who = host.querySelector<HTMLSelectElement>('select[aria-label="Who does design"]')!;
    expect(who).not.toBeNull();
    await act(async () => { who.value = 'sol-xhigh'; who.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => host.querySelector<HTMLButtonElement>('.sheet [role="tab"][id="tab-overview"]')!.click());
    expect(host.querySelector('.now')!.textContent).toContain('Next: design (Codex · sol), then design review (Codex · sol)');
  });

  it('gives the Agents page tiles the same main line as the cards', async () => {
    await act(async () => host.querySelector<HTMLAnchorElement>('.rail a[title="Agents (A)"]')!.click());
    const tiles = [...host.querySelectorAll('.tile .card-status')].map(text);
    expect(tiles).toContain('Trying to prove “done” wrong');
    expect(tiles).toContain('Waiting for your permission');
  });

  it('keeps following your call visible without a to-do list and shows the latest action in the sheet', async () => {
    const state = simulator.getState();
    const source = state.tasks.find((task) => task.id === 'gift-cards')!;
    const { todo: _todo, ...task } = source;
    const stage = task.plan!.stages[task.stageIndex]!;
    simulator = new Simulator({ ...state, inbox: state.inbox.filter((item) => item.taskId !== task.id), tasks: state.tasks.map((entry) => entry.id === task.id ? {
      ...task, state: 'running', sub: 0, holdsSlot: true, statusLine: 'Running a command',
      agent: { roleId: 'architect', profileId: 'opus-high', since: state.now, step: 0 },
      call: { stageId: stage.id, text: 'Keep the simpler flow.', open: [], at: state.now },
    } : entry) });
    await act(async () => root.render(<App />));
    expect(text(card('gift-cards').querySelector('.card-status'))).toBe('The architect is following your call');
    await open('gift-cards');
    expect(text(host.querySelector('.now .what'))).toMatch(/^The architect is following your call · /);
    expect(text(host.querySelector('.now .now-line'))).toBe('Running a command');
  });
});
