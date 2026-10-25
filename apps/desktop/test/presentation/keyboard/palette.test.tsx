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

async function taken(key: string, options: KeyboardEventInit = {}) { let carried = true; await act(async () => { carried = (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })); }); return !carried; }

describe('the app keyboard', () => {
  it('opens the same palette while typing, restores the field, and closes only the top layer', async () => {
    await key('j'); await key('m');
    await type('.composer textarea', 'Keep this message');
    await key('k', { ctrlKey: true });
    expect(host.querySelector('.command-palette')).not.toBeNull();
    await key('Escape');
    expect(host.querySelector('.sheet')).not.toBeNull();
    expect(document.activeElement).toBe(el('.composer textarea'));
    await key('Escape'); expect(host.querySelector('.sheet')).not.toBeNull();
    expect(document.activeElement).not.toBe(el('.composer textarea'));
    await key('Escape'); expect(host.querySelector('.sheet')).toBeNull();
  });

  it('keeps the palette\'s task rows on the task focused when it opened, and drops them when that task is gone', async () => {
    await key('j'); const id = selected()!;
    const title = simulator.getState().tasks.find((task) => task.id === id)!.title;
    await key('k', { ctrlKey: true });
    expect(el('[role=option][aria-selected=true]').id).toBe(`palette-open-task-${id}`);
    // The card leaves the board, and the board's highlight moves on to its neighbour.
    await act(async () => simulator.cancel(id));
    expect(el('[role=option][aria-selected=true]').id).toBe(`palette-open-task-${id}`);
    await key('Enter'); expect(sheetId()).toBe(title);
    await key('Escape');
    const next = selected()!; expect(next).not.toBe(id);
    const productId = simulator.getState().tasks.find((task) => task.id === next)!.productId;
    await key('k', { ctrlKey: true });
    expect(el('[role=option][aria-selected=true]').id).toBe(`palette-open-task-${next}`);
    await act(async () => {
      for (const task of simulator.getState().tasks) if (task.productId === productId && task.state !== 'done' && task.state !== 'cancelled') simulator.cancel(task.id);
      simulator.removeProduct(productId);
    });
    expect(host.querySelector(`[id^="palette-"][id$="-task-${next}"]`)).toBeNull();
    expect(el('[role=option][aria-selected=true]').id).not.toContain(next);
  });

  it('opens an empty New task from the palette\'s New task action, whatever was typed', async () => {
    await palette('new'); expect(el('[role=option][aria-selected=true]').textContent).toContain('New task');
    await key('Enter');
    expect(el<HTMLInputElement>('.title-input').value).toBe('');
  });

  it('opens the product switcher with Ctrl P over an open task, never the browser\'s Print', async () => {
    expect(await taken('p', { ctrlKey: true })).toBe(true);
    expect(host.querySelector('.switcher-pop')).not.toBeNull();
    await key('Escape'); expect(host.querySelector('.switcher-pop')).toBeNull();
    await key('j'); await key('m'); const title = sheetId();
    const composer = el('.composer textarea');
    expect(await taken('p', { ctrlKey: true })).toBe(true);
    expect(document.activeElement).toBe(el('[aria-label="Search products"]'));
    // Esc closes the switcher only, and focus goes back into the task.
    await key('Escape');
    expect(host.querySelector('.switcher-pop')).toBeNull();
    expect(sheetId()).toBe(title); expect(document.activeElement).toBe(composer);
    await key('p', { ctrlKey: true }); await click('.switcher-row[aria-current=false]');
    expect(host.querySelector('.sheet')).toBeNull();
    await key('n', { ctrlKey: true });
    expect(await taken('p', { ctrlKey: true })).toBe(true);
    expect(host.querySelector('.switcher-pop')).toBeNull();
  });

  it.each(['switcher', 'finished task'])('chooses a product with Enter once, without activating the restored %s', async (opener) => {
    let productName = 'Shop';
    if (opener === 'switcher') {
      await act(async () => el('.switcher').focus());
      await click('.switcher');
    } else {
      await click('.rail a[title="History"]');
      const row = el('.history-card');
      const task = simulator.getState().tasks.find((task) => task.id === row.getAttribute('data-task-id'))!;
      productName = simulator.getState().products.find((product) => product.id === task.productId)!.name;
      await act(async () => row.focus());
      await click('.history-card');
      expect(host.querySelector('.sheet')).not.toBeNull();
      await key('p', { ctrlKey: true });
    }
    await type('[aria-label="Search products"]', productName);
    await enter('[aria-label="Search products"]');
    expect(host.querySelector('.switcher-pop')).toBeNull();
    expect(host.querySelector('.sheet')).toBeNull();
    expect(el('.switcher').textContent).toContain(productName);
    expect(document.activeElement).toBe(el(opener === 'switcher' ? '.switcher' : '.history-card.selected'));
  });

  it('keeps the chosen palette row through live insertions and reordering, and Enter opens it', async () => {
    await palette(''); await key('ArrowDown');
    const chosen = el('[role=option][aria-selected=true]').id;
    await act(async () => {
      simulator.setPoolLimit(12);
      simulator.setPoolPaused(false);
      simulator.addTask({ productId: 'shop', title: 'New work needs approval', approvePlan: true });
      for (let step = 0; step < 60; step++) simulator.tick(1_000_002_200 + step * 2200);
    });
    expect(el('[role=option][aria-selected=true]').id).toBe(chosen);
    await key('Enter');
    expect(sheetId()).toBe(simulator.getState().tasks.find((task) => task.id === chosen.replace('palette-task-', ''))!.title);
  });

  it('highlights the next palette row when its result leaves, and resets only when the query changes', async () => {
    await palette(''); await key('ArrowDown');
    const rows = Array.from(host.querySelectorAll('[role=option]')).map((row) => row.id);
    const removed = el('[role=option][aria-selected=true]').id;
    await act(async () => simulator.cancel(removed.replace('palette-task-', '')));
    expect(el('[role=option][aria-selected=true]').id).toBe(rows[2]);
    await type('[role=combobox]', 'Change the pool limit');
    expect(el('[role=option][aria-selected=true]').id).toBe('palette-limit');
  });

  it('does not walk a list for a task opened from a palette result', async () => {
    await key('j'); const remembered = selected();
    await palette('Guest checkout'); await key('Enter');
    const title = sheetId();
    await key('j'); await key('k');
    expect(sheetId()).toBe(title);
    expect(host.textContent).toContain('J and K walk the board or the inbox');
    await key('Escape'); expect(selected()).toBe(remembered);
    await key('k', {ctrlKey:true}); await key('Enter');
    const focusedTitle = sheetId(); await key('j');
    expect(sheetId()).toBe(focusedTitle);
    expect(host.textContent).toContain('J and K walk the board or the inbox');
  });

  it('runs pool actions and jumps to a typed limit, with the current limit marked', async () => {
    await palette('Change the pool limit'); await key('Enter');
    expect(host.textContent).toContain('Current limit');
    expect(host.textContent).toContain('Lowering the limit never stops anyone');
    await type('[role=combobox]', '12');
    expect(el('[role=option][aria-selected=true]').textContent).toContain('12 agents');
    await key('Enter'); expect(simulator.getState().pool.limit).toBe(12);
    await palette('Resume pool'); await key('Enter'); expect(simulator.getState().pool.paused).toBe(false);
    await palette('Pause pool'); await key('Enter'); expect(simulator.getState().pool.paused).toBe(true);
  });

  it('filters through the palette, clears with one click, and finds tasks outside the product filter', async () => {
    await palette('Notes');
    await click('#palette-product-notes');
    expect(host.querySelector('[data-task-id=guest-checkout]')).toBeNull();
    await palette('Guest checkout');
    expect(host.querySelector('#palette-task-guest-checkout')).not.toBeNull();
    await key('Escape');
    await palette('export'); await click('#palette-filter');
    expect(host.querySelectorAll('.card').length).toBe(1);
    expect(host.querySelector('.active-filter')?.textContent).toContain('export');
    await click('[aria-label="Clear the board filter"]');
    expect(host.querySelectorAll('.card').length).toBeGreaterThan(1);
    await palette('Build this new thing'); await key('Enter');
    await click('[aria-label="Choose products"]');
    expect(el('[role=dialog] input[type=checkbox]:checked').closest('label')?.textContent).toContain('Notes');
  });

  it('offers no task actions on other pages and cannot confirm an action while reconnecting', async () => {
    await key('j'); await key('a'); await key('k', {ctrlKey:true});
    expect(host.querySelector('[id^="palette-pause-task"]')).toBeNull();
    await type('[role=combobox]', 'Resume pool');
    const before = simulator.getState(); live.link = 'reconnecting';
    await key('Enter');
    expect(simulator.getState()).toBe(before);
    expect(host.textContent).toContain('Could not send that action');
    live.link = 'live'; await key('b');
    await key('p');
    expect(host.textContent).toContain('request was withdrawn');
    expect(host.textContent).toContain('P to resume');
  });
});
