import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemoState, createFirstRunDemo, type State } from '@petrina/core';
import { useSyncExternalStore } from 'react';
import { App } from '../src/App';

let simulator: Simulator;
/** First run's Start: held until the test says how the engine answered. */
let answer: { resolve: (id: string) => void; reject: (error: Error) => void } | undefined;
const live = { link: 'live', desktop: false, synced: true };
const empty: never[] = [];
vi.mock('../src/engine', () => {
  class Lost extends Error {}
  class Late extends Error {}
  const own: Record<string, (...args: never[]) => unknown> = {
    startFirstTask: () => new Promise((resolve, reject) => (answer = { resolve, reject })),
    setSetupStep: () => undefined,
    synced: () => true,
    checkTools: () => undefined,
    findClones: async () => [],
  };
  return {
    mode: 'demo', desktop: false, Lost, Late,
    failureText: (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
    plainReason: (text: string) => text,
    newClientId: () => 'client-1',
    startClock: () => () => {},
    useEngineStatus: () => live,
    useUnsent: () => empty,
    useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => simulator.getState()),
    sim: new Proxy({}, { get: (_, name) => own[name as string] ?? ((...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args)) }),
  };
});

let root: Root;
let host: HTMLDivElement;
const text = (selector: string) => host.querySelector(selector)?.textContent ?? '';
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(target: HTMLElement) { await act(async () => { target.click(); }); }
async function type(selector: string, value: string) { await act(async () => {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}); }
async function mount(state: State) {
  simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<App />));
}
beforeEach(() => { localStorage.clear(); answer = undefined; });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

/** The board right after first run, its first task stuck because Claude Code isn't logged in. */
function stuckFirstTask(approvePlan: boolean): State {
  const demo = createDemoState(1_000_000_000);
  const task = { ...demo.tasks[0]!, approvePlan, state: 'failed' as const, stageIndex: -1, statusLine: "Stuck: Claude Code isn't logged in" };
  return {
    ...demo,
    tasks: [task],
    inbox: [{ id: 'stuck-1', taskId: task.id, kind: 'stuck', title: `Claude Code isn't logged in, so “${task.title}” is stuck`, at: demo.now, blocking: false, toolId: 'claude-code', toolProblem: 'logged-out' }],
    setup: { done: true, platform: 'darwin', checks: [{ id: 'claude-code', status: 'logged-out' }], firstTaskId: task.id },
  };
}

describe('first run', () => {
  for (const approvePlan of [true, false]) {
    it(`never promises a plan, or says nobody is stuck, while the first task is stuck (plan first ${approvePlan ? 'on' : 'off'})`, async () => {
      await mount(stuckFirstTask(approvePlan));
      const tip = text('[aria-label="What happens next"]');
      expect(tip).toContain('is stuck');
      expect(tip).not.toMatch(/plan|approv|has started/i);
      await click(button('Show Needs you'));
      expect(text('.inbox-sub')).toBe('1 task is stuck until you act on it.');
      expect(text('.inbox')).not.toMatch(/nobody is stuck/i);
    });
  }

  it('offers Add a product on the empty board after Skip setup in the demo', async () => {
    await mount(createFirstRunDemo(1_000_000_000).state);
    await click(button('Skip setup'));
    const offers = [...host.querySelectorAll<HTMLButtonElement>('.board-empty button')];
    expect(offers.map((entry) => entry.textContent?.trim())).toEqual(['Add a product', 'New task']);
    // Nothing to write a task for yet.
    expect(offers[1]!.disabled).toBe(true);
    await click(offers[0]!);
    expect(host.querySelector('[role=dialog][aria-labelledby="add-product-title"]')).not.toBeNull();
  });

  /** The Tools screen with these answers. */
  const onTools = (checks: NonNullable<State['setup']>['checks']) => {
    const demo = createFirstRunDemo(1_000_000_000).state;
    return { ...demo, setup: { ...demo.setup!, step: 'tools' as const, checks } };
  };
  const rows = () => [...host.querySelectorAll('.tool-row strong')].map((entry) => entry.textContent);

  it('shows no Grok row when Grok is not installed', async () => {
    const demo = createFirstRunDemo(1_000_000_000).state;
    await mount(onTools([...demo.setup!.checks, { id: 'grok', status: 'not-installed' }]));
    expect(rows()).toEqual(['Claude Code', 'Codex', 'GitHub CLI']);
    expect(button('Continue').disabled).toBe(false);
  });

  it('shows Grok when it is installed, and lets you go on with Grok alone', async () => {
    await mount(onTools([
      { id: 'claude-code', status: 'logged-out' },
      { id: 'codex', status: 'not-installed' },
      { id: 'grok', status: 'ready' },
      { id: 'gh', status: 'ready', account: 'octocat' },
      { id: 'git', status: 'ready' },
      { id: 'node', status: 'ready' },
    ]));
    expect(rows()).toEqual(['Claude Code', 'Codex', 'Grok', 'GitHub CLI']);
    expect(button('Continue').disabled).toBe(false);
    expect(text('.setup-notes')).toBe("Only Grok is set up, so agents will review each other's work on the same tool, and setting up Claude Code or Codex gives a second opinion.");
  });

  it('keeps every choice as it was sent while Start shows Starting…, and gives them back with the draft if saving fails', async () => {
    const demo = createFirstRunDemo(1_000_000_000).state;
    await mount({ ...demo, products: [createDemoState(1_000_000_000).products[0]!], setup: { ...demo.setup!, step: 'task' } });
    await type('input[aria-label="What do you want done?"]', 'Add a greeting');
    await click(button('More options'));
    const choices = () => [...host.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.task-form [role=radio], .task-form input[type=checkbox], .task-form .idea, .task-form select')];
    expect(choices().length).toBeGreaterThan(8);
    expect(choices().every((entry) => !entry.disabled)).toBe(true);

    await click(button('Start'));
    expect(button('Starting…').disabled).toBe(true);
    expect(choices().every((entry) => entry.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="What do you want done?"]')!.readOnly).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Details"]')!.readOnly).toBe(true);

    await act(async () => answer!.reject(new Error("Petrina's engine could not take it.")));
    expect(text('.setup-error')).toContain('Try again');
    expect(choices().every((entry) => !entry.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="What do you want done?"]')!.value).toBe('Add a greeting');
  });
});
