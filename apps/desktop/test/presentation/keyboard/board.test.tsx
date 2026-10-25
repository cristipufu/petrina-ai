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
import { Simulator, boardOrder, createDemoState, type State } from "@petrina/core";
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

async function palette(query: string) { await key('k', { ctrlKey: true }); await type('[role=combobox]', query); }

function selected() { return host.querySelector('.card.selected')?.getAttribute('data-task-id'); }

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
  it('does not leave a pointer-opened task selected after closing, and keeps its place for J and K', async () => {
    const ids = boardOrder(simulator.getState().tasks, () => true, false);
    await key('j');
    expect(selected()).toBe(ids[0]);
    const index = 2;
    const card = el(`.card[data-task-id="${ids[index]}"]`);
    await act(async () => card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
    await act(async () => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })));
    await click(`.card[data-task-id="${ids[index]}"] .card-open`);
    expect(host.querySelector('.sheet')).not.toBeNull();
    await click('.sheet [aria-label="Close"]');
    expect(host.querySelector('.sheet')).toBeNull();
    expect(selected()).toBeUndefined();
    await key('j');
    expect(selected()).toBe(ids[index + 1]);
    await key('k');
    expect(selected()).toBe(ids[index]);
  });

  it('restores the palette opener and keeps the board in control after a quick inbox round trip', async () => {
    await key('j'); const id = selected();
    const opener = el('[aria-label="Find tasks, products or actions"]');
    await act(async () => opener.focus());
    await key('k', {ctrlKey:true}); await key('k', {ctrlKey:true});
    expect(document.activeElement).toBe(opener);
    await key('i'); await key('b');
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(selected()).toBe(id);
    expect(host.querySelector('.inbox-item.selected')).toBeNull();
  });

  it.each(['board', 'inbox'])('scrolls keyboard moves in the %s after a pointer press with no release', async (area) => {
    if (area === 'inbox') await key('i');
    else await key('j');
    const selector = area === 'board' ? '.card.selected' : '.inbox-item.selected';
    const before = el(selector);
    await act(async () => before.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 })));
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    scroll.mockClear();
    await key('j');
    expect(el(selector)).not.toBe(before);
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.instances.at(-1)).toBe(el(selector));
  });

  it('clears an unfinished pointer press when the window loses focus', async () => {
    await key('j');
    const next = el('.card.selected').nextElementSibling as HTMLElement;
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    await act(async () => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await act(async () => window.dispatchEvent(new Event('blur')));
    scroll.mockClear();
    await act(async () => next.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(scroll).toHaveBeenCalled();
  });

  it('rests board keys on Products, Agents and Library and remembers its card', async () => {
    await key('j'); await key('j'); const id = selected();
    for (const title of ['Products', 'Agents (A)', 'Library (L)']) {
      await click(`.rail a[title="${title}"]`);
      const before = simulator.getState();
      await key('j'); await key('k'); await key('p'); await key('m'); await key('ArrowUp', {altKey:true});
      expect(selected()).toBeUndefined(); expect(host.querySelector('.sheet')).toBeNull();
      expect(simulator.getState()).toBe(before);
      await key('b'); expect(selected()).toBe(id);
    }
  });

  it('walks the board in display order, keeps identity through live updates and uses the old place on removal', async () => {
    const ids = boardOrder(simulator.getState().tasks, () => true, false);
    await key('j'); expect(selected()).toBe(ids[0]);
    await key('j'); expect(selected()).toBe(ids[1]);
    await key('Enter'); const title = sheetId();
    await key('j'); expect(sheetId()).not.toBe(title);
    await key('Escape'); expect(selected()).toBe(ids[2]);
    await act(async () => simulator.cancel(ids[2]!));
    expect(selected()).toBe(ids[3]);
  });

  it('focuses the message box only for M, so the Session tab can keep walking the board', async () => {
    const ids = boardOrder(simulator.getState().tasks, () => true, false);
    const title = (index: number) => simulator.getState().tasks.find((task) => task.id === ids[index])!.title;
    await key('j'); await key('m');
    expect(document.activeElement).toBe(el('.composer textarea'));
    await type('.composer textarea', 'A draft for the first task');
    await key('Escape');
    await key('j'); expect(sheetId()).toBe(title(1));
    expect(document.activeElement).not.toBe(el('.composer textarea'));
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('');
    await key('j'); expect(sheetId()).toBe(title(2));
    await key('k'); expect(sheetId()).toBe(title(1));
    await key('k'); expect(sheetId()).toBe(title(0));
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('A draft for the first task');
    await click('#tab-plan'); await click('#tab-session');
    expect(document.activeElement).not.toBe(el('.composer textarea'));
    await key('Escape'); await key('Enter'); await click('#tab-session');
    expect(document.activeElement).not.toBe(el('.composer textarea'));
    await key('j'); expect(sheetId()).toBe(title(1));
    await key('m'); expect(document.activeElement).toBe(el('.composer textarea'));
  });

  it.each([1, -1] as const)('walks from an open board task that left the list in direction %s', async (direction) => {
    const ids = boardOrder(simulator.getState().tasks, () => true, false);
    await key('j'); await key('j'); await key('j'); await key('Enter');
    await act(async () => simulator.cancel(ids[2]!));
    await key(direction === 1 ? 'j' : 'k');
    expect(sheetId()).toBe(simulator.getState().tasks.find((task) => task.id === ids[2 + direction])!.title);
  });

  it('does not act while typing or repeat the pause key, and can disable single keys', async () => {
    await key('j'); await key('p'); const paused = simulator.getState();
    await key('p', {repeat:true}); expect(simulator.getState()).toBe(paused);
    await key('m'); await type('.composer textarea', 'jkpmi'); const typing = simulator.getState();
    await key('p'); await key('j'); expect(simulator.getState()).toBe(typing);
    await key('Escape'); await key('Escape');
    await palette('Turn single-key shortcuts off'); await key('Enter');
    expect(localStorage.getItem('petrina.single-key-shortcuts')).toBe('off');
    const id = selected(); await key('j'); expect(selected()).toBe(id);
    await key('k', {ctrlKey:true}); expect(host.querySelector('.command-palette')).not.toBeNull();
  });
});
