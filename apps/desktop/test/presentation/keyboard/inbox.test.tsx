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
import { Simulator, boardOrder, createDemoState, inboxOrder, inboxTab, type State } from "@petrina/core";
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
  it('leaves nothing taking keys after Esc in the docked inbox on Products, Agents and Library, even after the palette', async () => {
    await widen(1400);
    for (const title of ['Products', 'Agents (A)', 'Library (L)']) {
      await click(`.rail a[title="${title}"]`);
      await key('i'); expect(host.querySelector('.inbox-item.selected')).not.toBeNull();
      await key('Escape');
      const before = simulator.getState();
      const quiet = () => {
        expect(host.querySelector('.inbox-item.selected')).toBeNull();
        expect(el('.inbox').contains(document.activeElement)).toBe(false);
        expect(host.querySelector('.sheet')).toBeNull();
        expect(simulator.getState()).toBe(before);
      };
      await key('Enter'); await key('j'); await key('p'); await key('m'); quiet();
      await key('k', { ctrlKey: true }); await key('k', { ctrlKey: true });
      await key('Enter'); await key('j'); await key('p'); await key('m'); quiet();
    }
  });

  it('hides the inbox over the board on Esc and gives focus to the Inbox button, and hands the docked one to the board', async () => {
    await key('i'); expect(host.querySelector('.inbox-item.selected')).not.toBeNull();
    await key('Escape');
    expect(host.querySelector('.inbox')).toBeNull();
    expect(document.activeElement).toBe(el('[aria-label^="Inbox,"]'));
    await widen(1400);
    await key('i'); await key('Escape');
    expect(host.querySelector('.inbox')).not.toBeNull();
    await key('j'); expect(selected()).toBe(boardOrder(simulator.getState().tasks, () => true, false)[0]);
  });

  it.each(['i', 'b'])('hands focus to the highlighted board card with %s from the docked inbox', async (shortcut) => {
    await widen(1400);
    await key('j'); const id = selected()!;
    const title = simulator.getState().tasks.find((task) => task.id === id)!.title;
    await key('i');
    if (shortcut === 'b') await act(async () => el('[aria-label^="Inbox,"]').focus());
    await key(shortcut);
    expect(selected()).toBe(id);
    expect(document.activeElement).toBe(el(`.card[data-task-id="${id}"]`));
    if (shortcut === 'i') expect(host.querySelector('.inbox')).toBeNull();
    await enter(`.card[data-task-id="${id}"]`);
    expect(sheetId()).toBe(title);
  });

  it('keeps focus on the Inbox button when the button closes the inbox', async () => {
    await widen(1400);
    await key('j'); await key('i');
    await act(async () => el('[aria-label^="Inbox,"]').focus());
    await click('[aria-label^="Inbox,"]');
    expect(host.querySelector('.inbox')).toBeNull();
    expect(document.activeElement).toBe(el('[aria-label^="Inbox,"]'));
  });

  it.each([
    [1400, 'click'], [1400, 'Enter'], [1024, 'click'], [1024, 'Enter'],
  ])('returns to the highlighted card when Hide the inbox is used at %spx with %s', async (width, activation) => {
    await widen(Number(width));
    await key('j'); const id = selected()!;
    const title = simulator.getState().tasks.find((task) => task.id === id)!.title;
    await key('i');
    const hide = '[aria-label="Hide the inbox"]';
    await act(async () => el(hide).focus());
    if (activation === 'click') await click(hide);
    else await enter(hide);
    expect(host.querySelector('.inbox')).toBeNull();
    expect(selected()).toBe(id);
    expect(document.activeElement).toBe(el(`.card[data-task-id="${id}"]`));
    await enter(`.card[data-task-id="${id}"]`);
    expect(sheetId()).toBe(title);
  });

  it('returns to the highlighted card when I hides the narrow inbox', async () => {
    await key('j'); const id = selected()!;
    const title = simulator.getState().tasks.find((task) => task.id === id)!.title;
    await key('i'); await key('i');
    expect(host.querySelector('.inbox')).toBeNull();
    expect(selected()).toBe(id);
    expect(document.activeElement).toBe(el(`.card[data-task-id="${id}"]`));
    await enter(`.card[data-task-id="${id}"]`);
    expect(sheetId()).toBe(title);
  });

  it.each([
    [1024, 'Board (B)'], [1400, 'Board (B)'],
    [1024, 'Agents (A)'], [1400, 'Agents (A)'],
  ])('keeps the inbox return point after creating a task at %spx on %s', async (width, page) => {
    await widen(Number(width));
    await click(`.rail a[title="${page}"]`);
    await key('i'); await key('j');
    const item = el('.inbox-item.selected').getAttribute('data-inbox-id')!;
    const ids = inboxOrder(simulator.getState()).map((entry) => entry.id);
    await key('Enter'); const title = sheetId();
    await key('n', { ctrlKey: true });
    await click('[role=dialog][aria-label="New task"] [role=radio]');
    await type('[aria-label="What do you want done?"]', 'Another task from the inbox');
    await enter('[aria-label="What do you want done?"]');
    expect(simulator.getState().tasks.some((task) => task.title === 'Another task from the inbox')).toBe(true);
    expect(sheetId()).toBe(title);
    expect(el(`.rail a[title="${page}"]`).getAttribute('aria-current')).toBe('page');
    await key('Escape');
    expect(host.querySelector('.sheet')).toBeNull();
    expect(el('.inbox-item.selected').getAttribute('data-inbox-id')).toBe(item);
    expect(document.activeElement).toBe(el(`.inbox-item[data-inbox-id="${item}"]`));
    expect(selected()).toBeUndefined();
    await key('j');
    expect(el('.inbox-item.selected').getAttribute('data-inbox-id')).toBe(ids[2]);
    expect(selected()).toBeUndefined();
  });

  it.each([1, -1] as const)('walks from an answered inbox item in direction %s without taking the cursor', async (direction) => {
    const items = inboxOrder(simulator.getState());
    await key('i'); await key('j'); await key('m');
    await type('.composer textarea', 'Keep this inbox draft'); await key('Escape');
    await act(async () => simulator.answer(items[1]!.id, 'Both, starting from the system setting'));
    expect(inboxOrder(simulator.getState()).map((item) => item.id)).not.toContain(items[1]!.id);
    await key(direction === 1 ? 'j' : 'k');
    const target = items[1 + direction]!;
    expect(sheetId()).toBe(simulator.getState().tasks.find((task) => task.id === target.taskId)!.title);
    expect(el('[role=tab][aria-selected=true]').id).toBe(`tab-${inboxTab(target.kind)}`);
    if (inboxTab(target.kind) === 'session') expect(document.activeElement).not.toBe(el('.composer textarea'));
    await key(direction === 1 ? 'k' : 'j');
    const next = direction === 1 ? items[0]! : items[2]!;
    expect(sheetId()).toBe(simulator.getState().tasks.find((task) => task.id === next.taskId)!.title);
  });

  it('gives only the inbox the keys, opens the relevant tab and moves after an answer', async () => {
    await key('j'); await key('i');
    expect(selected()).toBeUndefined();
    const first = el('.inbox-item.selected').getAttribute('data-inbox-id');
    await key('j'); expect(el('.inbox-item.selected').getAttribute('data-inbox-id')).not.toBe(first);
    await key('Enter'); expect(host.querySelector('.sheet')).not.toBeNull();
    expect(el('[role=tab][aria-selected=true]').textContent).toContain('Session');
    await key('b'); expect(host.querySelector('.sheet')).toBeNull(); expect(host.querySelector('.inbox')).not.toBeNull();
    expect(selected()).not.toBeUndefined();
    await key('i'); expect(host.querySelector('.inbox-item.selected')).not.toBeNull();
    const id = el('.inbox-item.selected').getAttribute('data-inbox-id')!;
    await act(async () => simulator.allow(id, 'once'));
    expect(el('.inbox-item.selected').getAttribute('data-inbox-id')).not.toBe(id);
    await key('i'); expect(host.querySelector('.inbox')).toBeNull();
  });

  it('keeps the inbox keys and cursor steady when new requests arrive, and preserves answer-button focus', async () => {
    await key('i');
    await act(async () => { el<HTMLButtonElement>('.inbox-item.selected button').focus(); });
    expect(document.activeElement?.tagName).toBe('BUTTON');
    await type('.inbox .reply input', 'An answer in progress');
    const id = el('.inbox-item.selected').getAttribute('data-inbox-id');
    const field = document.activeElement;
    const before = simulator.getState().inbox.length;
    await act(async () => {
      simulator.setPoolLimit(12);
      simulator.setPoolPaused(false);
      simulator.addTask({ productId: 'shop', title: 'Another plan to approve', approvePlan: true });
      // Long enough for new requests: scripted agents take several actions under each item of their to-do lists.
      for (let step = 0; step < 120; step++) simulator.tick(1_000_002_200 + step * 2200);
    });
    expect(simulator.getState().inbox.length).toBeGreaterThan(before);
    expect(document.activeElement).toBe(field);
    expect(el('.inbox-item.selected').getAttribute('data-inbox-id')).toBe(id);
  });
});
