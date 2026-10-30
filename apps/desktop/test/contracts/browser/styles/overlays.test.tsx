vi.mock("../../../../src/notify/channels", () => {
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
import { App } from '../../../../src/App';
import { setSingleKeys } from '../../../../src/keyboard';
import { readAppStyles } from '../../../fixtures/styles';

let simulator: Simulator;

const live = { link: 'live', desktop: false };

const empty: never[] = [];

vi.mock('../../../../src/engine', () => ({
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

async function mount(state: State = createDemoState(1_000_000_000), options: ConstructorParameters<typeof Simulator>[1] = {}) {
  simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } }, options);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<App />));
}

beforeEach(async () => { localStorage.clear(); live.link = 'live'; setSingleKeys(true); await mount(); });

afterEach(async () => { try { await act(async () => root.unmount()); } finally { host.remove(); vi.restoreAllMocks(); vi.clearAllTimers(); await widen(1024); } });

async function widen(width: number) { await act(async () => (window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }).happyDOM.setViewport({ width })); }

describe('the app keyboard', () => {
  it('keeps in-app messages under dialogs and the palette, and lets clicks through the gaps between them', async () => {
    const style = document.createElement('style');
    style.textContent = readAppStyles();
    document.head.append(style);
    try {
      await key('j'); await key('p'); await key('j'); await key('p');
      expect(host.querySelectorAll('.toast').length).toBe(2);
      const layer = (selector: string) => Number(getComputedStyle(el(selector)).zIndex);
      await key('n', { ctrlKey: true });
      expect(layer('.toasts')).toBeLessThan(layer('.editor-scrim'));
      expect(layer('.toasts')).toBeLessThan(layer('.editor-panel'));
      await key('Escape'); await key('k', { ctrlKey: true });
      expect(layer('.toasts')).toBeLessThan(layer('.palette-scrim'));
      await key('Escape'); await key('Enter');
      // Still over an open task.
      expect(layer('.toasts')).toBeGreaterThan(layer('.sheet'));
      expect(getComputedStyle(el('.toasts')).pointerEvents).toBe('none');
      expect(getComputedStyle(el('.toast')).pointerEvents).toBe('auto');
    } finally { style.remove(); }
  });
});
