import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, boardOrder, createDemo, createDemoState, inboxOrder, inboxTab, type State } from '@petrina/core';
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
// A browser carries an Enter the page didn't cancel on to whatever has focus once its keydown is over.
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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); await widen(1024); });
// The inbox docks beside the board from 1200px; happy-dom's window starts narrower, so it opens over the board.
async function widen(width: number) { await act(async () => (window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }).happyDOM.setViewport({ width })); }
// Dispatches a key and says whether something on the page took it from the browser.
async function taken(key: string, options: KeyboardEventInit = {}) { let carried = true; await act(async () => { carried = (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })); }); return !carried; }

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
  it('keeps in-app messages under dialogs and the palette, and lets clicks through the gaps between them', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
    document.head.append(style);
    try {
      await key('j'); await key('p'); await key('j'); await key('p');
      expect(host.querySelectorAll('.toast').length).toBe(2);
      const layer = (selector: string) => Number(getComputedStyle(el(selector)).zIndex);
      await key('n', { ctrlKey: true });
      expect(layer('.toasts')).toBeLessThan(layer('.dialog-scrim'));
      expect(layer('.toasts')).toBeLessThan(layer('.dialog'));
      await key('Escape'); await key('k', { ctrlKey: true });
      expect(layer('.toasts')).toBeLessThan(layer('.palette-scrim'));
      await key('Escape'); await key('Enter');
      // Still over an open task.
      expect(layer('.toasts')).toBeGreaterThan(layer('.sheet'));
      expect(getComputedStyle(el('.toasts')).pointerEvents).toBe('none');
      expect(getComputedStyle(el('.toast')).pointerEvents).toBe('auto');
    } finally { style.remove(); }
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
      await click('.fold');
      const row = el('.done-row');
      const task = simulator.getState().tasks.find((task) => task.id === row.getAttribute('data-task-id'))!;
      productName = simulator.getState().products.find((product) => product.id === task.productId)!.name;
      await act(async () => row.focus());
      await click('.done-row');
      expect(host.querySelector('.sheet')).not.toBeNull();
      await key('p', { ctrlKey: true });
    }
    await type('[aria-label="Search products"]', productName);
    await enter('[aria-label="Search products"]');
    expect(host.querySelector('.switcher-pop')).toBeNull();
    expect(host.querySelector('.sheet')).toBeNull();
    expect(el('.switcher').textContent).toContain(productName);
    expect(document.activeElement).toBe(el(opener === 'switcher' ? '.switcher' : '.done-row.selected'));
  });
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
  it('keeps the unsent message mark on finished and cancelled tasks', async () => {
    await palette('Guest checkout'); await key('Enter'); await key('m');
    await type('.composer textarea', 'Still to send');
    await key('Escape'); await key('Escape');
    const id = simulator.getState().tasks.find((task) => task.title === 'Guest checkout')!.id;
    await act(async () => simulator.cancel(id));
    await click('.fold');
    expect(host.querySelector(`.done-row[data-task-id="${id}"] .draft-mark`)).not.toBeNull();
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
  it('leaves the role panel its own keys: Escape asks before unsaved changes go, and app shortcuts wait', async () => {
    const button = (text: string) => { const found = Array.from(host.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === text); expect(found, text).toBeDefined(); return found!; };
    const roles = simulator.getState().roles;
    await key('l');
    await click('[aria-label="Edit the Researcher"]');
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
