vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));

import { stateFixture } from "../../fixtures/state";
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/App';
import type { EngineStatus } from '../../../src/engine';

const gate: { status: EngineStatus } = {
  status: { link: 'starting', desktop: false, synced: false },
};

vi.mock('../../../src/engine', () => {
  class Lost extends Error {}
  class Late extends Error {}
  return {
    mode: 'engine',
    desktop: false,
    Lost,
    Late,
    failureText: (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
    plainReason: (text: string) => text,
    newClientId: () => 'client-1',
    startClock: () => () => {},
    useEngineStatus: () => gate.status,
    useUnsent: () => [],
    useSim: () => stateFixture(1_000_000_000),
    sim: new Proxy({}, { get: () => () => undefined }),
    openDemo: () => undefined,
    retryEngine: () => undefined,
    leaveDemo: () => undefined,
  };
});

let root: Root;

let host: HTMLDivElement;

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a browser tab whose saved connection key is refused', () => {
  it('says how to open a fresh window, and does not keep saying it is starting', async () => {
    gate.status = {
      link: 'reconnecting',
      desktop: false,
      synced: false,
      restarted: true,
      recovery: true,
      problem: 'Petrina could not connect to its engine.',
    };
    await mount();
    const screen = host.querySelector('.engine-screen')?.textContent ?? '';
    expect(screen).toContain('bun run open');
    expect(screen).toContain('fresh window');
    expect(screen).not.toContain('Starting Petrina');
    expect(screen).not.toContain('bun run engine');
  });

  it('still says Starting Petrina while the key has not been refused', async () => {
    gate.status = { link: 'starting', desktop: false, synced: false, problem: 'Petrina could not connect to its engine.' };
    await mount();
    const screen = host.querySelector('.engine-screen')?.textContent ?? '';
    expect(screen).toContain('Starting Petrina…');
    expect(screen).toContain('bun run engine');
    expect(screen).not.toContain('fresh window');
  });
});
