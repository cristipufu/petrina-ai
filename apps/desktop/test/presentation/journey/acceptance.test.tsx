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
import { Simulator, type State } from "@petrina/core";
import { App } from '../../../src/App';
import { acceptanceFixture, laterTester } from '../../fixtures/acceptance';

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

let root: Root;

let host: HTMLDivElement;

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

  it.each([false, true])('keeps acceptance evidence on its source and repair trigger for custom roles=%s', async (custom) => {
    const fixture = acceptanceFixture(custom);
    const { state, task } = fixture;
    task.journey = [...task.journey!, laterTester(fixture)];
    await mount(state); await openTask(task.id);
    const select = async (id: string) => {
      await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${id}"]`)!.click());
      return host.querySelector('.journey-details')!;
    };
    let details = await select('j65');
    expect(details.querySelectorAll('.journey-check-list li')).toHaveLength(4);
    expect(details.querySelectorAll('.journey-check-list .label.ok')).toHaveLength(3);
    expect(details.querySelectorAll('.journey-check-list .label.bad')).toHaveLength(1);
    expect(details.textContent).toContain('First recorded timeout diagnostic');
    expect(details.textContent).toContain('Second recorded timeout diagnostic');
    expect(details.textContent).not.toContain('Acceptance requirement');
    details = await select('command-repair');
    expect(details.textContent).not.toContain('Acceptance requirement');
    expect(details.textContent).not.toContain('Failed checks that triggered this fix');
    details = await select('repair');
    expect(details.textContent).toContain('Failed checks that triggered this fix');
    expect(details.querySelectorAll('.journey-check-list li')).toHaveLength(7);
    expect(details.textContent).toContain('Original failure reason 25');
    details = await select('j14');
    expect(details.querySelectorAll('.journey-check-list .label.ok')).toHaveLength(18);
    expect(details.querySelectorAll('.journey-check-list .label.bad')).toHaveLength(7);
    expect(details.textContent).toContain('Original observation 25');
    details = await select('later-tester');
    expect(details.querySelectorAll('.journey-check-list .label.ok')).toHaveLength(24);
    expect(details.querySelectorAll('.journey-check-list .label.bad')).toHaveLength(0);
    expect(details.textContent).toContain('Could not verify');
    expect(details.textContent).toContain('New observation 24');
  });

  it.each(['missing trigger', 'missing evidence', 'blocked'])('leaves acceptance repair evidence unavailable or unconfirmed: %s', async (variant) => {
    const { state, task } = acceptanceFixture(true);
    const tester = task.journey![0]!;
    const repair = task.journey![1]!;
    if (variant === 'missing trigger') delete repair.trigger;
    if (variant === 'missing evidence') delete tester.acceptanceChecks;
    if (variant === 'blocked') tester.acceptanceChecks = [{ text: 'Unavailable account probe', result: 'blocked', reason: 'Account unavailable' }];
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>('.journey-list li[data-step-id="repair"]')!.click());
    let details = host.querySelector('.journey-details')!;
    expect(details.textContent).not.toContain('Failed checks that triggered this fix');
    expect(details.textContent).not.toContain('Acceptance requirement');
    if (variant !== 'blocked') expect(details.textContent).toContain('Acceptance trigger details unavailable');
    await act(async () => host.querySelector<HTMLElement>('.journey-list li[data-step-id="j14"]')!.click());
    details = host.querySelector('.journey-details')!;
    if (variant === 'missing evidence') expect(details.textContent).toContain('Acceptance results unavailable for this step');
    if (variant === 'blocked') { expect(details.textContent).toContain('Could not verify'); expect(details.querySelectorAll('.label.bad')).toHaveLength(0); }
  });

  it('describes a running Tester as in progress without borrowing results', async () => {
    const { state, task } = acceptanceFixture(true);
    task.journey = task.journey!.slice(0, 1);
    const tester = task.journey![0]!;
    delete tester.endedAt;
    delete tester.end;
    delete tester.acceptanceChecks;
    delete tester.agentResults;
    task.state = 'running';
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>('.journey-list li[data-step-id="j14"]')!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Acceptance testing in progress. No results recorded yet.');
    expect(details.textContent).not.toContain('unavailable');
    expect(details.textContent).not.toContain('Acceptance requirement');
  });
});
