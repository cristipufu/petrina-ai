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
import { Simulator, createDemo, createDemoState, type State } from "@petrina/core";
import { useSyncExternalStore } from 'react';
import { App } from '../../../src/App';
import { setSingleKeys } from '../../../src/keyboard';

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

function el<T extends HTMLElement = HTMLElement>(selector: string): T { const found = host.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!; }

async function key(key: string, options: KeyboardEventInit = {}) { await act(async () => { (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })); }); }

async function click(selector: string) { await act(async () => { el(selector).click(); }); }

async function type(selector: string, text: string) { await act(async () => {
  const input = el<HTMLInputElement | HTMLTextAreaElement>(selector);
  input.focus();
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}); }

function sheetId() { return host.querySelector('.sheet-title')?.textContent; }

async function mount(state: State = createDemoState(1_000_000_000), options: ConstructorParameters<typeof Simulator>[1] = {}) {
  simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } }, options);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<App />));
}

beforeEach(async () => { localStorage.clear(); live.link = 'live'; setSingleKeys(true); await mount(); });

afterEach(async () => { try { await act(async () => root.unmount()); } finally { host.remove(); vi.restoreAllMocks(); vi.clearAllTimers(); await widen(1024); } });

async function widen(width: number) { await act(async () => (window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }).happyDOM.setViewport({ width })); }

describe('the app keyboard', () => {
  it('lets usage history inspect, open and leave readings without global Escape taking the key', async () => {
    await act(async () => root.unmount()); host.remove();
    const demo = createDemo(1_000_000_000);
    await mount(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    await click('a[href*="/analytics"]');
    await act(async () => { await Promise.resolve(); });
    const chart = el('.limit-history-plot');
    const id = chart.id;
    await act(async () => chart.focus());
    await key('Home'); await key('End');
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
    await key('Escape');
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    await key('End'); await key('Enter');
    expect(host.querySelector('.limit-history-readings-view')).not.toBeNull();
    await key('k', { ctrlKey: true });
    await key('Escape');
    expect(host.querySelector('.limit-history-readings-view')).not.toBeNull();
    await key('Escape');
    expect(host.querySelector('.limit-history-readings-view')).toBeNull();
    expect(document.activeElement?.id).toBe(id);
  });

  it('keeps readings open when Escape leaves an unrelated answer field, and closes them from their own controls', async () => {
    await act(async () => root.unmount()); host.remove();
    await widen(1440);
    const demo = createDemo(1_000_000_000);
    await mount(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    await click('a[href*="/analytics"]');
    await act(async () => { await Promise.resolve(); });
    await click('.limit-history-readings');
    expect(host.querySelector('.limit-history-readings-view')).not.toBeNull();
    await type('.inbox .reply input', 'Half done');
    const answer = el<HTMLInputElement>('.inbox .reply input');
    await key('Escape');
    expect(document.activeElement).not.toBe(answer);
    expect(el<HTMLInputElement>('.inbox .reply input').value).toBe('Half done');
    expect(host.querySelector('.limit-history-readings-view')).not.toBeNull();
    await act(async () => el('.limit-history-readings-view > button').focus());
    await key('n', { ctrlKey: true });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await key('Escape');
    expect(host.querySelector('.limit-history-readings-view')).not.toBeNull();
    await key('Escape');
    expect(host.querySelector('.limit-history-readings-view')).toBeNull();
    expect(document.activeElement).toBe(el('.limit-history-readings'));
    await type('.inbox .reply input', 'Still here');
    await key('Escape');
    expect(document.activeElement).not.toBe(answer);
    expect(el<HTMLInputElement>('.inbox .reply input').value).toBe('Still here');
  });

  it('keeps app shortcuts available while usage history owns its inspection keys', async () => {
    await act(async () => root.unmount()); host.remove();
    const demo = createDemo(1_000_000_000);
    await mount(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    const chart = async () => {
      await click('a[href*="/analytics"]');
      await act(async () => { await Promise.resolve(); el('.limit-history-plot').focus(); });
    };
    await chart();
    await key('n', { ctrlKey: true });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await key('Escape');
    await act(async () => el('.limit-history-plot').focus());
    await key('?');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Keyboard shortcuts');
    await key('Escape');
    await act(async () => el('.limit-history-plot').focus());
    await key(',', { ctrlKey: true });
    expect(host.querySelector('.limit-history')).toBeNull();
    expect(window.location.pathname).toBe('/settings');
    for (const [letter, path] of [['b', '/'], ['a', '/agents'], ['l', '/library']]) {
      await chart();
      await key(letter!);
      expect(window.location.pathname).toBe(path);
    }
  });

  it('keeps Analytics and its choices open while changing product scope', async () => {
    await click('.rail a[title="Analytics"]');
    await click('[aria-label="Period"] button:first-child');
    await click('label.toggle input');
    await click('.switcher');
    await click('.switcher-row.tone-blue');
    expect(el('h1').textContent).toBe('Analytics');
    expect(el('.page-head p').textContent).toContain('Shop · what the squad used today');
    expect(el('[aria-label="Period"] button[aria-selected="true"]').textContent).toBe('Today');
    expect(el<HTMLInputElement>('label.toggle input').checked).toBe(true);
    await click('.switcher');
    await click('.switcher-row:first-child');
    expect(el('h1').textContent).toBe('Analytics');
    expect(el('.page-head p').textContent).toContain('All products · what the squad used today');
    expect(el<HTMLInputElement>('label.toggle input').checked).toBe(true);
  });

  it('opens a task from the Analytics task split with the keyboard, and leaves tasks no longer on the board as plain rows', async () => {
    // The demo with its history, so Analytics has a removed product's tasks.
    await act(async () => root.unmount()); host.remove();
    const demo = createDemo(1_000_000_000);
    await mount(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    await click('.rail a[title="Analytics"]');
    // Thirty days, so the removed product's tasks are in the split too.
    await click('[aria-label="Period"] button:last-child');
    const byTask = [...host.querySelectorAll<HTMLButtonElement>('.splits-head button')].find((button) => button.textContent === 'By task')!;
    await act(async () => byTask.click());
    const split = () => [...host.querySelectorAll('.split')].find((section) => section.querySelector('h3')?.textContent === 'By task')!;
    const all = split().querySelector<HTMLButtonElement>('.show-earlier');
    if (all) await act(async () => all.click());
    const rows = [...split().querySelectorAll('.split-row:not(.head)')];
    const gone = rows.filter((row) => row.querySelector('.usage-note')?.textContent === 'removed');
    expect(gone.length).toBeGreaterThan(0);
    for (const row of gone) expect(row.querySelector('button')).toBeNull();
    const open = split().querySelector<HTMLButtonElement>('button.split-open')!;
    expect(open.type).toBe('button');
    const title = open.textContent;
    await act(async () => open.focus());
    expect(document.activeElement).toBe(open);
    // A focused button opens with Enter or Space: the browser turns either into this click.
    await act(async () => open.click());
    expect(sheetId()).toBe(title);
  });
});
