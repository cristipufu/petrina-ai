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
import { Simulator, createDemoState, DEMO_TRIGGERS, type State } from '@petrina/core';
import { useSyncExternalStore } from 'react';
import { App } from '../../../src/App';

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

const NOW = 1_000_000_000;

const QUICK_NOTE = 'quick-note';

let root: Root;

let host: HTMLDivElement;

const all = <T extends HTMLElement = HTMLElement>(selector: string) => Array.from(host.querySelectorAll<T>(selector));

function el<T extends HTMLElement = HTMLElement>(selector: string): T { const found = host.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!; }

const byText = (selector: string, text: string) => { const found = all(selector).find((node) => node.textContent?.includes(text)); expect(found, `${selector} with “${text}”`).toBeDefined(); return found!; };

async function click(node: HTMLElement) { await act(async () => { node.click(); }); }

async function width(value: number) { await act(async () => { Object.defineProperty(window, 'innerWidth', { value, configurable: true }); window.dispatchEvent(new Event('resize')); }); }

const card = () => el(`[data-task-id="${QUICK_NOTE}"]`);

const task = () => simulator.getState().tasks.find((entry) => entry.id === QUICK_NOTE)!;

const poolButton = () => all('button').find((node) => node.getAttribute('aria-label')?.startsWith('Agents at work'));

async function mount(state: State = createDemoState(NOW)) {
  // The clock stays still here, so the pool can run: a paused pool would hold the screen request like any other agent.
  simulator = new Simulator(state, { triggers: DEMO_TRIGGERS });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<App />));
}

beforeEach(async () => { localStorage.clear(); await width(1440); await mount(); });

afterEach(async () => { try { await act(async () => root.unmount()); } finally { host.remove(); vi.restoreAllMocks(); } });

describe('agents may use the screen', () => {
  it('shows a task waiting for the screen in Waiting, with the reason and Allow now on the card', async () => {
    const reason = DEMO_TRIGGERS['quick-note|builder|1|3']!.title;
    expect(card().closest('section')?.querySelector('h2')?.textContent).toContain('Waiting');
    expect(card().querySelector('.flag')?.textContent).toBe('Waiting for the screen');
    expect(card().querySelector('.card-status')?.textContent).toBe(`Needs the screen for: ${reason}`);
    expect(card().getAttribute('aria-label')).toBe('Quick note window opens behind others, Waiting for the screen');
    await click(byText(`[data-task-id="${QUICK_NOTE}"] .card-ask button`, 'Allow now'));
    expect(task().state).toBe('running');
    expect(task().screen?.granted).toBe(true);
    expect(card().querySelector('.card-ask')).toBeNull();
  });

  it('takes Allow now on the first click: pressing a card does not scroll it away from under the pointer', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const button = card().querySelector<HTMLButtonElement>('.card-ask button')!;
    scroll.mockClear();
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(card().classList.contains('selected')).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      button.click();
    });
    expect(task().screen?.granted).toBe(true);
  });

  it('lists the request quietly, last in the inbox, with Allow now as its one button and no toast', async () => {
    const items = all('.inbox-item');
    const last = items.at(-1)!;
    expect(last.querySelector('.ask-kind')?.textContent).toContain('Screen');
    expect(last.querySelector('.ask')?.classList.contains('blocking')).toBe(false);
    expect(Array.from(last.querySelectorAll('.ask-actions button')).map((node) => node.textContent)).toEqual(['Allow now']);
    expect(all('.toast').some((node) => node.textContent?.includes('Needs the screen'))).toBe(false);
    expect(el('.blocking-pill').textContent).toContain('2');
    await click(last.querySelector<HTMLButtonElement>('.ask-actions button')!);
    expect(all('.inbox-item .ask-kind').some((node) => node.textContent?.includes('Screen'))).toBe(false);
  });

  it('offers Off, For an hour and On in the pool menu, and marks the pool button only while screen use is on', async () => {
    expect(poolButton()!.querySelector('.screen-mark')).toBeNull();
    expect(poolButton()!.getAttribute('aria-label')).not.toContain('screen');
    await click(poolButton()!);
    const choices = () => all('.screen-use [role=radio]');
    expect(choices().map((node) => node.textContent)).toEqual(['Off', 'For an hour', 'On']);
    expect(choices()[0]!.getAttribute('aria-checked')).toBe('true');
    expect(el('.screen-use').textContent).toContain('One that needs the screen asks first');
    expect(el('.screen-use').textContent).toContain('1 task waiting for the screen');

    // With nobody waiting, turning it on marks the pool button as on.
    await act(async () => simulator.pause(QUICK_NOTE));
    await click(choices()[1]!);
    expect(simulator.getState().pool.screen?.mode).toBe('hour');
    expect(choices()[1]!.getAttribute('aria-checked')).toBe('true');
    expect(el('.screen-use').textContent).toMatch(/On until \d{1,2}[:.]\d{2}/);
    expect(poolButton()!.getAttribute('aria-label')).toContain('. Agents may use the screen');
    expect(poolButton()!.querySelector('.screen-mark:not(.in-use)')).not.toBeNull();

    await click(choices()[0]!);
    expect(poolButton()!.querySelector('.screen-mark')).toBeNull();
  });

  it('names the agent on the screen, and keeps the mark after switching off until its step ends', async () => {
    await click(card().querySelector<HTMLButtonElement>('.card-ask button')!);
    expect(poolButton()!.getAttribute('aria-label')).toContain('. An agent is using the screen');
    expect(poolButton()!.querySelector('.screen-mark.in-use')).not.toBeNull();
    await click(poolButton()!);
    expect(el('.screen-use').textContent).toContain('On the screen now: Quick note window opens behind others · Builder');
    // Off never stops the agent on the screen.
    await click(all('.screen-use [role=radio]')[0]!);
    expect(task().screen?.granted).toBe(true);
    expect(poolButton()!.querySelector('.screen-mark.in-use')).not.toBeNull();
  });

  it('moves the switch and the mark to the closed More button in narrow windows', async () => {
    await width(760);
    expect(poolButton()).toBeUndefined();
    const more = () => el('button[aria-label^="More"]');
    expect(more().getAttribute('aria-label')).toBe('More');
    expect(more().querySelector('.screen-mark')).toBeNull();
    await act(async () => simulator.setScreenUse('on'));
    expect(more().getAttribute('aria-label')).toBe('More. An agent is using the screen');
    expect(more().querySelector('.screen-mark')).not.toBeNull();
    await click(more());
    expect(all('.popover .screen-use [role=radio]').map((node) => node.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
  });

  it('allows the screen for one task from its sheet, and says so in the header', async () => {
    await click(card().querySelector<HTMLButtonElement>('.card-open')!);
    expect(el('.sheet .sheet-meta').textContent).toContain('Waiting for the screen');
    expect(el('.sheet .now').textContent).toContain('Needs the screen for:');
    expect(byText('.sheet .now button', 'Allow now')).toBeDefined();
    await click(el('.sheet button[aria-label="More"]'));
    const item = el('.sheet [role=menuitemcheckbox]');
    expect(item.textContent).toContain('Allow the screen for this task');
    expect(item.getAttribute('aria-checked')).toBe('false');
    await click(item);
    expect(task().screenAllowed).toBe(true);
    expect(task().screen?.granted).toBe(true);
    expect(el('.sheet .sheet-meta').textContent).toContain('Screen allowed for this task');
    await click(el('.sheet button[aria-label="More"]'));
    expect(el('.sheet [role=menuitemcheckbox]').getAttribute('aria-checked')).toBe('true');
    await click(el('.sheet [role=menuitemcheckbox]'));
    expect(task().screenAllowed).toBeUndefined();
  });
});
