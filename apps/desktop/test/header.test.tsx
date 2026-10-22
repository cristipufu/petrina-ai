import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Simulator, createDemoState, createPortfolioDemo } from '@petrina/core';
import { App } from '../src/App';

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

// happy-dom does not lay out rem units. Deliver the browser's size notification explicitly;
// the hook still reads the real root style, without a window resize.
const observations = new Map<Element, () => void>();
let root: Root;
let host: HTMLDivElement;
let originalWidth: number;
let originalFont: string;
const NOW = 1_000_000_000;
function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = host.querySelector<T>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
}
async function textSize(size: number) {
  await act(async () => {
    document.documentElement.style.fontSize = `${size}px`;
    for (const notify of observations.values()) notify();
  });
}
async function width(size: number) {
  await act(async () => {
    Object.defineProperty(window, 'innerWidth', { value: size, configurable: true });
    window.dispatchEvent(new Event('resize'));
  });
}
async function mount(portfolio = false) {
  const state = portfolio ? createPortfolioDemo(NOW).state : createDemoState(NOW);
  simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
  await act(async () => root.render(<App />));
}
beforeEach(() => {
  originalWidth = window.innerWidth;
  originalFont = document.documentElement.style.fontSize;
  document.documentElement.style.fontSize = '16px';
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    private targets = new Set<Element>();
    constructor(private callback: () => void) {}
    observe(target: Element) { this.targets.add(target); observations.set(target, this.callback); }
    disconnect() { for (const target of this.targets) observations.delete(target); }
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  const probes = [...observations.keys()];
  await act(async () => root.unmount());
  expect(observations.size).toBe(0);
  for (const probe of probes) expect(probe.isConnected).toBe(false);
  host.remove();
  document.documentElement.style.fontSize = originalFont;
  Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
  vi.unstubAllGlobals();
});

describe('the header follows available room as text changes', () => {
  it.each([false, true])('compacts and restores without resizing the window (portfolio: %s)', async (portfolio) => {
    await mount(portfolio);
    expect(el('.brand').textContent).toBe('Petrina');
    expect(el('.palette-trigger').textContent).toContain('Find tasks or actions');
    expect(el('.switcher').textContent).toContain(portfolio ? '20' : '3');

    await textSize(20);
    expect(el('.brand').textContent).toBe('');
    expect(host.querySelector('.palette-trigger')).toBeNull();
    expect(el('button[aria-label^="Agents at work"]')).toBeDefined();
    expect(el('button[aria-label^="Theme,"]')).toBeDefined();

    await textSize(32);
    expect(window.innerWidth).toBe(1440);
    expect(host.querySelector('button[aria-label^="Agents at work"]')).toBeNull();
    expect(el('button[aria-label^="Inbox,"]').textContent).toContain('Inbox');
    expect(el('.topbar .primary').textContent).toContain('New task');
    const more = el<HTMLButtonElement>('.topbar button[aria-label="More"]');
    await act(async () => { more.focus(); more.click(); });
    expect(el('[aria-label="Agents at once"]')).toBeDefined();
    const theme = el<HTMLButtonElement>('[aria-label="Theme"] [role="radio"]');
    await act(async () => {
      theme.focus();
      theme.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('.more-section')).toBeNull();
    expect(document.activeElement).toBe(more);

    await textSize(16);
    expect(el('.brand').textContent).toBe('Petrina');
    expect(el('.palette-trigger').textContent).toContain('Find tasks or actions');
    expect(el('button[aria-label^="Agents at work"]')).toBeDefined();
    expect(el('button[aria-label^="Theme,"]')).toBeDefined();
    expect(host.querySelector('.topbar button[aria-label="More"]')).toBeNull();
  });

  it('uses enlarged text on first render and keeps responding to window changes', async () => {
    await textSize(32);
    await mount(true);
    expect(el('button[aria-label="More"]')).toBeDefined();
    await width(1024);
    expect(el('button[aria-label^="Inbox,"]').textContent).not.toContain('Inbox');
    expect(el('.switcher').textContent).toContain('All products');
    await width(2640);
    expect(el('.brand').textContent).toBe('Petrina');
    expect(el('.palette-trigger').textContent).toContain('Find tasks or actions');
    expect(el('button[aria-label^="Theme,"]')).toBeDefined();
  });
});
