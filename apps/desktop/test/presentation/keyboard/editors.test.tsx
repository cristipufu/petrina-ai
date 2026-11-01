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
import { Simulator, createDemoState, type State } from "@petrina/core";
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

async function enter(selector: string) {
  let carried = false;
  await act(async () => { carried = el(selector).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  if (carried) await act(async () => {
    const at = document.activeElement;
    if (at instanceof HTMLButtonElement) at.click();
    else if (at instanceof HTMLTextAreaElement) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(at, `${at.value}\n`); at.dispatchEvent(new Event('input', { bubbles: true })); }
  });
}

async function palette(query: string) { await key('k', { ctrlKey: true }); await type('[role=combobox]', query); }

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

  it('keeps the open task open, untouched, when a new task is created with Enter', async () => {
    await key('j'); await key('m'); const title = sheetId();
    const id = simulator.getState().tasks.find((task) => task.title === title)!.id;
    await type('.composer textarea', 'Keep this message');
    const task = () => { const { state, held } = simulator.getState().tasks.find((entry) => entry.id === id)!; return { state, held }; };
    const before = task();
    // Enter must not carry on to whatever the new-task dialog hands focus back to.
    for (const [index, opener] of ['.composer textarea', '.sheet [aria-label="Pause"]', '.sheet [aria-label="Close"]'].entries()) {
      await act(async () => el(opener).focus());
      await key('n', { ctrlKey: true });
      await click('[role=dialog][aria-label="New task"] [role=radio]');
      await type('[aria-label="What do you want done?"]', `Another thing ${index}`);
      await enter('[aria-label="What do you want done?"]');
      expect(host.querySelector('[aria-label="New task"]')).toBeNull();
      expect(simulator.getState().tasks.some((entry) => entry.title === `Another thing ${index}`)).toBe(true);
      expect(document.activeElement).toBe(el(opener));
      expect(sheetId()).toBe(title);
      expect(task()).toEqual(before);
      expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('Keep this message');
    }
  });

  it('keeps the unsent message mark on finished and cancelled tasks', async () => {
    await palette('Guest checkout'); await key('Enter'); await key('m');
    await type('.composer textarea', 'Still to send');
    await key('Escape'); await key('Escape');
    const id = simulator.getState().tasks.find((task) => task.title === 'Guest checkout')!.id;
    await act(async () => simulator.cancel(id));
    await click('.rail a[title="History"]');
    expect(host.querySelector(`.history-card[data-task-id="${id}"] .draft-mark`)).not.toBeNull();
  });

  it('keeps separate message drafts through task switches, tabs and closing', async () => {
    // Open the Session directly: drafts do not need a Journey to mount before every message.
    // The switch to Pricing still goes through the palette, including its separate return point.
    await key('j'); await key('m');
    expect(sheetId()).toBe('Guest checkout');
    await type('.composer textarea', 'Checkout draft');
    await palette('pricing'); await key('Enter'); await key('m');
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('');
    await type('.composer textarea', 'Pricing draft');
    await click('#tab-plan'); await click('#tab-session');
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('Pricing draft');
    await key('Escape'); await key('Escape');
    await key('m');
    expect(sheetId()).toBe('Guest checkout');
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('Checkout draft');
    expect(host.querySelector('#tab-session .draft-mark')).not.toBeNull();
    await key('Enter');
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('');
    expect(simulator.getState().tasks.find((task) => task.title === 'Guest checkout')!.queued[0]?.text).toBe('Checkout draft');
  });

  it('prefills New task with the planner free to choose a product, and ignores Ctrl K in it', async () => {
    const count = simulator.getState().tasks.length;
    await palette('An entirely new task'); await key('Enter');
    expect(el<HTMLInputElement>('.title-input').value).toBe('An entirely new task');
    expect(el<HTMLButtonElement>('.editor-panel .btn.lead').disabled).toBe(false);
    expect(host.querySelector('[role=radio][aria-checked=true].tone-violet')).toBeNull();
    await key('k', {ctrlKey:true}); expect(host.querySelector('.command-palette')).toBeNull();
    expect(simulator.getState().tasks.length).toBe(count);
  });

  it('blocks Ctrl K and global shortcuts automatically inside nested Board dialogs such as Combine backlog tasks', async () => {
    const productId = simulator.getState().products[0]!.id;
    await act(async () => {
      simulator.addTask({ productId, title: 'Backlog item one', backlog: true });
      simulator.addTask({ productId, title: 'Backlog item two', backlog: true });
    });
    const selectBtn = Array.from(host.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === 'Select tasks');
    expect(selectBtn).toBeDefined();
    await act(async () => selectBtn!.click());
    await click('[aria-label="Include Backlog item one"]');
    await click('[aria-label="Include Backlog item two"]');
    const combineBtn = Array.from(host.querySelectorAll('button')).find((entry) => entry.textContent?.includes('Combine and queue'));
    expect(combineBtn).toBeDefined();
    await act(async () => combineBtn!.click());
    expect(host.querySelector('[aria-label="Combine backlog tasks"]')).not.toBeNull();
    await key('k', { ctrlKey: true });
    expect(host.querySelector('.command-palette')).toBeNull();
    await key('Escape');
    expect(host.querySelector('[aria-label="Combine backlog tasks"]')).toBeNull();
  });

  it.each(['Researcher', 'Bug finder'])('leaves the %s role panel its own keys: Escape asks before unsaved changes go, and app shortcuts wait', async (roleName) => {
    const button = (text: string) => { const found = Array.from(host.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === text); expect(found, text).toBeDefined(); return found!; };
    const roles = simulator.getState().roles;
    await key('l');
    expect(el('.library-views [aria-current="page"]').textContent).toBe('Roles');
    await click('.library-views a[href="/library/roles"]');
    expect(el('.library-views [aria-current="page"]').textContent).toBe('Roles');
    const opener = el(`[aria-label="Edit the ${roleName}"]`);
    await act(async () => opener.focus());
    await click(`[aria-label="Edit the ${roleName}"]`);
    await type('.role-form textarea', 'Finds out what people expect.');
    await key('k', { ctrlKey: true }); expect(host.querySelector('.command-palette')).toBeNull();
    await key('Escape');
    expect(host.querySelector('[role=alertdialog]')?.textContent).toContain('Discard your changes?');
    await act(async () => button('Keep editing').click());
    expect(host.querySelector('[role=alertdialog]')).toBeNull();
    expect(el('.sheet.panel').contains(document.activeElement)).toBe(true);
    for (const name of ['b', 'j', 'i', '?']) await key(name);
    await key('n', { metaKey: true });
    expect(el('.rail a[title="Library (L)"]').getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('.dialog')).toBeNull();
    expect(el<HTMLTextAreaElement>('.role-form textarea').value).toBe('Finds out what people expect.');
    await key('Escape');
    await act(async () => button('Discard changes').click());
    expect(host.querySelector('.sheet.panel')).toBeNull();
    expect(simulator.getState().roles).toBe(roles);
    expect(document.activeElement).toBe(opener);
  });
});
