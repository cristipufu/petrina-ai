import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, boardOrder, createDemoState, inboxOrder, inboxTab, type State } from '@petrina/core';
import { useSyncExternalStore } from 'react';
import { App } from '../src/App';
import { setSingleKeys } from '../src/keyboard';

let simulator: Simulator;
const live = { link: 'live', desktop: false };
const empty: never[] = [];
vi.mock('../src/engine', () => ({
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
async function mount(state: State = createDemoState(1_000_000_000)) {
  simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<App />));
}
beforeEach(async () => { localStorage.clear(); live.link = 'live'; setSingleKeys(true); await mount(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); });

describe('the app keyboard', () => {
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
  it('rests board keys on Products, Agents and Library and remembers its card', async () => {
    await key('j'); await key('j'); const id = selected();
    for (const title of ['Products', 'Agents (A)', 'Library (L)']) {
      await click(`.rail button[title="${title}"]`);
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
  it('keeps separate message drafts through task switches, tabs and closing', async () => {
    await palette('Guest checkout'); await key('Enter'); await key('m');
    await type('.composer textarea', 'Checkout draft');
    await palette('pricing'); await key('Enter'); await key('m');
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('');
    await type('.composer textarea', 'Pricing draft');
    await click('#tab-plan'); await click('#tab-session');
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('Pricing draft');
    await key('Escape'); await key('Escape');
    await palette('Guest checkout'); await key('Enter'); await key('m');
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('Checkout draft');
    expect(host.querySelector('#tab-session .draft-mark')).not.toBeNull();
    await key('Enter');
    expect(el<HTMLTextAreaElement>('.composer textarea').value).toBe('');
    expect(simulator.getState().tasks.find((task) => task.title === 'Guest checkout')!.queued[0]?.text).toBe('Checkout draft');
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
  it('prefills New task without picking a product or creating anything, and ignores Ctrl K in it', async () => {
    const count = simulator.getState().tasks.length;
    await palette('An entirely new task'); await key('Enter');
    expect(el<HTMLInputElement>('.title-input').value).toBe('An entirely new task');
    expect(el<HTMLButtonElement>('.dialog .btn.lead').disabled).toBe(true);
    expect(host.querySelector('[role=radio][aria-checked=true].tone-violet')).toBeNull();
    await key('k', {ctrlKey:true}); expect(host.querySelector('.command-palette')).toBeNull();
    expect(simulator.getState().tasks.length).toBe(count);
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
    expect(el('[role=radio][aria-checked=true]').textContent).toContain('Notes');
  });
  it('offers no task actions on other pages and cannot confirm an action while reconnecting', async () => {
    await key('j'); await key('a'); await key('k', {ctrlKey:true});
    expect(host.querySelector('#palette-pause-task')).toBeNull();
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
      for (let step = 0; step < 60; step++) simulator.tick(1_000_002_200 + step * 2200);
    });
    expect(simulator.getState().inbox.length).toBeGreaterThan(before);
    expect(document.activeElement).toBe(field);
    expect(el('.inbox-item.selected').getAttribute('data-inbox-id')).toBe(id);
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
