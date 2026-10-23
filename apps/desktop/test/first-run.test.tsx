import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemoState, createFirstRunDemo, type CheckStatus, type State } from '@petrina/core';
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
beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); answer = undefined; });
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
    expect(host.querySelector('[role=dialog][aria-label="Add a product"]')).not.toBeNull();
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

  for (const surface of ['first run', 'Agents'] as const) {
    for (const status of ['unknown', 'not-installed', 'ready', 'unchecked'] as const) {
      it(`shows Git and Node.js advice for ${status} in ${surface}`, async () => {
        const detail = "Petrina couldn't prepare the temporary folder it uses for checks. System detail.";
        const checks = [
          { id: 'claude-code' as const, status: 'ready' as const },
          { id: 'git' as const, status, detail },
          { id: 'node' as const, status, detail },
        ];
        const state = onTools(checks);
        if (surface === 'Agents') history.replaceState(null, '', '/agents');
        await mount(surface === 'Agents' ? { ...state, setup: { ...state.setup!, done: true } } : state);
        for (const [id, name] of [['git', 'Git'], ['node', 'Node.js']]) {
          const row = host.querySelector<HTMLElement>(`.tool-row[aria-label^="${name}:"]`);
          if (status === 'ready' || status === 'unchecked') {
            expect(row).toBeNull();
            continue;
          }
          expect(row).not.toBeNull();
          expect(row!.textContent).toContain(status === 'unknown' ? "Couldn't check" : 'Not installed');
          expect(row!.querySelector('a')!.textContent).toContain(`${name} guide`);
          if (status === 'unknown') {
            expect(row!.querySelector('.command')).toBeNull();
            await click(row!.querySelector('button')!);
            expect(row!.textContent).toContain(detail);
          } else {
            expect(row!.querySelector('.command')!.textContent).toContain(id === 'git' ? 'xcode-select --install' : 'brew install node');
          }
        }
        expect(button('Check again')).toBeDefined();
        if (surface === 'first run') expect(button('Continue').disabled).toBe(status === 'not-installed' || status === 'unchecked');
      });
    }
  }

  for (const status of ['unknown', 'not-installed', 'ready'] as const) {
    it(`follows a missing tool's latest ${status} check in Stuck advice`, async () => {
      const state = stuckFirstTask(false);
      const task = { ...state.tasks[0]!, statusLine: "Stuck: Git isn't installed" };
      const title = `Git isn't installed, so “${task.title}” is stuck`;
      const detail = "Petrina couldn't prepare the temporary folder it uses for checks. Latest system reason.";
      await mount({
        ...state, tasks: [task],
        inbox: [{ ...state.inbox[0]!, title, toolId: 'git', toolProblem: 'not-installed', detail: 'Old diagnosis' }],
        setup: { ...state.setup!, checks: [{ id: 'git', status, detail }] },
      });
      await click(button('Show Needs you'));
      expect(text('.ask-title')).toBe(title);
      expect(button('Retry')).toBeDefined();
      if (status === 'unknown') {
        expect(text('.ask')).toContain("The latest check of Git couldn't run");
        expect(text('.ask')).toContain("can't confirm it is missing; Retry carries on");
        expect(host.querySelector('.ask .command')).toBeNull();
        await click(button('Details'));
        expect(text('.ask .detail')).toBe(detail);
        expect(text('.ask')).not.toContain('Old diagnosis');
      } else if (status === 'not-installed') {
        expect(text('.ask .command')).toContain('xcode-select --install');
      } else {
        expect(text('.ask')).toContain('Git is ready now, so Retry carries on.');
        expect(host.querySelector('.ask .command')).toBeNull();
      }
      expect(simulator.getState().tasks[0]!.statusLine).toBe("Stuck: Git isn't installed");
    });
  }

  for (const problem of ['wont-start', 'logged-out'] as const) {
    it(`keeps ${problem} advice when the latest tool check is uncertain`, async () => {
      const state = stuckFirstTask(false);
      await mount({ ...state,
        inbox: [{ ...state.inbox[0]!, toolProblem: problem, detail: 'Original task failure' }],
        setup: { ...state.setup!, checks: [{ id: 'claude-code', status: 'unknown' as CheckStatus, detail: 'Latest uncertain check' }] },
      });
      await click(button('Show Needs you'));
      expect(text('.ask .command')).toContain(problem === 'wont-start' ? 'claude --version' : 'claude auth login');
      await click(button('Details'));
      expect(text('.ask .detail')).toBe('Original task failure');
    });
  }

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
