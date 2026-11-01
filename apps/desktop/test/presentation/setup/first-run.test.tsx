vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemoState, createFirstRunDemo, type CheckStatus, type State } from '@petrina/core';
import { useSyncExternalStore } from 'react';
import { App } from '../../../src/App';

let simulator: Simulator;

let submitted: Record<string, unknown> | undefined;

let answer: { resolve: (id: string) => void; reject: (error: Error) => void } | undefined;
let pickedFolder: string | null = null;
let addedPaths: string[] = [];

const live = { link: 'live', desktop: false, synced: true };

const empty: never[] = [];

vi.mock('../../../src/engine', () => {
  class Lost extends Error {}
  class Late extends Error {}
  const own: Record<string, (...args: never[]) => unknown> = {
    startFirstTask: (input: Record<string, unknown>) => { submitted = input; return new Promise((resolve, reject) => (answer = { resolve, reject })); },
    setSetupStep: () => undefined,
    synced: () => true,
    checkTools: () => undefined,
    findClones: async () => [],
    pickFolder: async () => pickedFolder,
    addProduct: async (chosenPath: string) => {
      addedPaths.push(chosenPath);
      const product = { id: 'petrina-ai', name: 'Petrina AI', repo: 'cristipufu/petrina-ai', path: chosenPath, tone: 'blue' as const };
      simulator.addProduct(product);
      return product.id;
    },
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

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); answer = undefined; submitted = undefined; pickedFolder = null; addedPaths = []; });

afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

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
    ]));
    expect(rows()).toEqual(['Claude Code', 'Codex', 'Grok', 'GitHub CLI']);
    expect(button('Continue').disabled).toBe(false);
    expect(text('.setup-notes')).toBe("Only Grok is set up, so agents will review each other's work on the same tool, and setting up Claude Code or Codex gives a second opinion.");
  });

  for (const surface of ['first run', 'Agents'] as const) {
    for (const status of ['unknown', 'not-installed', 'ready', 'unchecked'] as const) {
      it(`shows Git advice for ${status} in ${surface}`, async () => {
        const detail = "Petrina couldn't prepare the temporary folder it uses for checks. System detail.";
        const checks = [
          { id: 'claude-code' as const, status: 'ready' as const },
          { id: 'git' as const, status, detail },
        ];
        const state = onTools(checks);
        if (surface === 'Agents') history.replaceState(null, '', '/agents');
        await mount(surface === 'Agents' ? { ...state, setup: { ...state.setup!, done: true } } : state);
        const row = host.querySelector<HTMLElement>('.tool-row[aria-label^="Git:"]');
        if (status === 'ready' || status === 'unchecked') {
          expect(row).toBeNull();
        } else {
          expect(row).not.toBeNull();
          expect(row!.textContent).toContain(status === 'unknown' ? "Couldn't check" : 'Not installed');
          expect(row!.querySelector('a')!.textContent).toContain('Git guide');
          if (status === 'unknown') {
            expect(row!.querySelector('.command')).toBeNull();
            await click(row!.querySelector('button')!);
            expect(row!.textContent).toContain(detail);
          } else {
            expect(row!.querySelector('.command')!.textContent).toContain('xcode-select --install');
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


  const firstTask = () => {
    const demo = createFirstRunDemo(1_000_000_000).state;
    return { ...demo, products: [createDemoState(1_000_000_000).products[0]!], setup: { ...demo.setup!, step: 'task' as const } };
  };

  it('labels fields and ideas, explains the empty button, and focuses a picked idea', async () => {
    await mount(firstTask());
    const title = host.querySelector<HTMLInputElement>('#first-task-title')!;
    const details = host.querySelector<HTMLTextAreaElement>('#first-task-details')!;
    expect(host.querySelector('label[for="first-task-title"]')!.textContent).toBe('What do you want done?');
    expect(host.querySelector('label[for="first-task-details"]')!.textContent).toBe('Details Optional');
    expect(title.maxLength).toBe(200);
    expect(details.maxLength).toBe(8000);
    expect(text('.setup-product')).toBe('Product' + firstTask().products[0]!.name);
    expect(button('Start task').disabled).toBe(true);
    expect(button('Start task').getAttribute('aria-describedby')).toBe('first-task-missing');
    expect(text('#first-task-missing')).toBe('Write what you want done, or pick an idea.');
    expect(host.querySelector('.ideas')!.getAttribute('aria-labelledby')).toBe('starter-ideas');
    expect(text('#starter-ideas')).toBe('Not sure where to start? Try one of these small tasks:');
    await click(host.querySelector<HTMLButtonElement>('.idea')!);
    expect(title.value).toBe(text('.idea'));
    expect(host.querySelector('.idea.on')).not.toBeNull();
    expect(document.activeElement).toBe(title);
    expect(button('Start task').disabled).toBe(false);
    expect(host.querySelector('#first-task-missing')).toBeNull();
    await type('#first-task-title', '   ');
    expect(button('Start task').disabled).toBe(true);
  });

  it('explains the plan and summarises changes without offering a queue position', async () => {
    await mount(firstTask());
    expect(text('.toggle-hint')).toBe("You'll see the squad's plan and approve it before anyone starts work.");
    await click(host.querySelector<HTMLInputElement>('.first-task-plan input')!);
    expect(text('.toggle-hint')).toBe('The squad starts as soon as the plan is ready.');
    expect(text('#first-task-summary')).toBe('Feature · Open a pull request · Asks before shipping');
    expect(button('More options').getAttribute('aria-expanded')).toBe('false');
    await click(button('More options'));
    expect(button('More options').getAttribute('aria-expanded')).toBe('true');
    expect(text('.task-form')).not.toContain('Place in the queue');
    expect(text('.kind-description')).toBe('Designed, built and reviewed');
    await click(button('Bug fix'));
    expect(text('.kind-description')).toBe('Builder and two reviewers');
    await click(button('Commit to main'));
    await click(host.querySelector<HTMLInputElement>('.more-options input')!);
    await click(button('More options'));
    expect(text('#first-task-summary')).toBe('Bug fix · Commit to main · Ships without asking');
    expect(button('More options').getAttribute('aria-describedby')).toBe('first-task-summary');
  });

  it('resets delivery choices to the selected product defaults', async () => {
    const state = firstTask();
    const other = { ...state.products[0]!, id: 'local-product', name: 'Local product', delivery: 'local' as const, approveDelivery: false };
    await mount({ ...state, products: [state.products[0]!, other] });
    expect(text('#first-task-summary')).toBe('Feature · Commit to main · Ships without asking');
    const select = host.querySelector<HTMLSelectElement>('.setup-product select')!;
    await act(async () => { select.value = state.products[0]!.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(text('#first-task-summary')).toBe('Feature · Open a pull request · Asks before shipping');
  });

  it('starts on Enter at the default queue place despite an older saved choice', async () => {
    localStorage.setItem('petrina.demo.firstTask', JSON.stringify({ title: 'Saved task', description: 'Saved context', position: 'top' }));
    await mount(firstTask());
    await act(async () => host.querySelector('#first-task-title')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(submitted).toMatchObject({ title: 'Saved task', description: 'Saved context', position: 'bottom', approvePlan: true, kind: 'feature' });
    expect(button('Starting…').disabled).toBe(true);
    expect(host.querySelector('#first-task-missing')).toBeNull();
  });

  for (const field of ['title', 'description']) {
    it('preserves an older oversized ' + field + ' and explains how to recover', async () => {
      const long = 'x'.repeat(field === 'title' ? 201 : 8001);
      localStorage.setItem('petrina.demo.firstTask', JSON.stringify({ title: 'Saved task', [field]: long }));
      await mount(firstTask());
      const selector = field === 'title' ? '#first-task-title' : '#first-task-details';
      expect(host.querySelector<HTMLInputElement>(selector)!.value).toBe(long);
      expect(text('#first-task-length')).toContain(field === 'title' ? '200' : '8,000');
      expect(button('Start task').disabled).toBe(true);
      await act(async () => {
        const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
        const proto = field === 'title' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, 'x'.repeat(field === 'title' ? 200 : 8000));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(host.querySelector('#first-task-length')).toBeNull();
      expect(button('Start task').disabled).toBe(false);
    });
  }

  it('keeps every choice as it was sent while Start task shows Starting…, and gives them back with the draft if saving fails', async () => {
    const demo = createFirstRunDemo(1_000_000_000).state;
    await mount({ ...demo, products: [createDemoState(1_000_000_000).products[0]!], setup: { ...demo.setup!, step: 'task' } });
    await type('input[aria-label="What do you want done?"]', 'Add a greeting');
    await click(button('More options'));
    const choices = () => [...host.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.task-form [role=radio], .task-form input[type=checkbox], .task-form .idea, .task-form select')];
    expect(choices().length).toBeGreaterThan(8);
    expect(choices().every((entry) => !entry.disabled)).toBe(true);

    await click(button('Start task'));
    expect(button('Starting…').disabled).toBe(true);
    expect(choices().every((entry) => entry.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="What do you want done?"]')!.readOnly).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Details"]')!.readOnly).toBe(true);

    await act(async () => answer!.reject(new Error("Petrina's engine could not take it.")));
    expect(text('.setup-error')).toContain('Try again');
    expect(choices().every((entry) => !entry.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="What do you want done?"]')!.value).toBe('Add a greeting');
  });

  it('picks a folder via Choose folder… in First-Run and in Add a product, ignoring cancelled dialogs', async () => {
    const demo = createFirstRunDemo(1_000_000_000).state;
    await mount({ ...demo, setup: { ...demo.setup!, step: 'product' } });

    // Cancelled picker leaves input empty and adds nothing.
    pickedFolder = null;
    await click(button('Choose folder…'));
    expect(addedPaths).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('#setup-path')!.value).toBe('');

    // Selecting a repository folder adds the product and advances to First task.
    pickedFolder = '/Users/dev/Documents/Github/petrina-ai';
    await click(button('Choose folder…'));
    expect(addedPaths).toEqual(['/Users/dev/Documents/Github/petrina-ai']);
    expect(host.querySelector('input[aria-label="What do you want done?"]')).not.toBeNull();
  });

  it('fills Folder of the local clone and suggests the product Name via Choose folder… in Add a product', async () => {
    await mount(createFirstRunDemo(1_000_000_000).state);
    await click(button('Skip setup'));
    await click(button('Add a product'));

    pickedFolder = '/Users/dev/Documents/Github/petrina-ai';
    await click(button('Choose folder…'));

    const folderInput = host.querySelector<HTMLInputElement>('input[aria-label="Folder of the local clone"]')!;
    const inputs = [...host.querySelectorAll<HTMLInputElement>('[role=dialog] input.field')];
    expect(folderInput.value).toBe('/Users/dev/Documents/Github/petrina-ai');
    expect(inputs[1]!.value).toBe('Petrina AI');
  });
});
