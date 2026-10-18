import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '@petrina/core';
import type { EngineStatus } from '../src/engine';

/** Only the network is a stand-in: these tests run the real connection and recovery timers. */
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string, readonly protocols: string[]) { Socket.instances.push(this); }
  send(_message: string) {}
  close() { this.readyState = 3; this.onclose?.(); }
  connect() { this.readyState = Socket.OPEN; this.onopen?.(); }
}

let root: Root | undefined;
let host: HTMLDivElement;
let latest: EngineStatus;
let added: ReturnType<typeof vi.spyOn>;
const address = { url: 'ws://127.0.0.1:43210/ws', token: 'refused-browser-test-key' };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  sessionStorage.clear();
  sessionStorage.setItem('petrina.engine', JSON.stringify(address));
  localStorage.clear();
  added = vi.spyOn(document, 'addEventListener');
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  // The app's singleton listens for the lifetime of a window; each test is a new window.
  for (const [name, listener, options] of added.mock.calls) document.removeEventListener(name, listener, options);
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

async function mount() {
  const engine = await import('../src/engine');
  const { StartingScreen } = await import('../src/components/EngineState');
  function Screen() {
    latest = engine.useEngineStatus();
    return <StartingScreen status={latest} />;
  }
  root = createRoot(host);
  await act(async () => root!.render(<Screen />));
  expect(engine.mode).toBe('engine');
}

async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
const current = () => Socket.instances.at(-1)!;

describe('the real browser connection', () => {
  it('releases a refreshed client, rejects pending calls and never reconnects or emits again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    await mount();
    const { EngineClient } = await import('../src/engine');
    const timers = vi.getTimerCount();
    const client = new EngineClient({ desktop: false, address });
    const socket = current();
    const heard = vi.fn();
    client.subscribe(heard);
    socket.connect();
    socket.onmessage?.({ data: JSON.stringify({ type: 'state', state: createDemoState(1000) }) });
    const pending = client.send('setPoolPaused', [true]);
    expect(client.getState().tasks.length).toBeGreaterThan(0);
    client.dispose();
    await expect(pending).rejects.toThrow('connection was refreshed');
    expect(socket.readyState).toBe(3);
    expect(client.getState().tasks).toEqual([]);
    expect(vi.getTimerCount()).toBe(timers);
    heard.mockClear();
    const sockets = Socket.instances.length;
    await advance(60_000);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(Socket.instances).toHaveLength(sockets);
    expect(heard).not.toHaveBeenCalled();
    client.dispose();
  });

  it('hands unconfirmed messages to the replacement client with their original retry identity', async () => {
    await mount();
    const { EngineClient } = await import('../src/engine');
    const client = new EngineClient({ desktop: false, address });
    const first = current();
    first.connect();
    const sent = vi.spyOn(first, 'send');
    client.sendMessage('task-1', 'Check the guest view');
    const instruction = JSON.parse(sent.mock.calls[0]![0] as string);
    const clientId = client.unsent()[0]!.clientId;
    client.keepUnsent();
    client.dispose();
    const replacement = new EngineClient({ desktop: false, address });
    const second = current();
    const resent = vi.spyOn(second, 'send');
    expect(replacement.unsent()[0]!.clientId).toBe(clientId);
    second.connect();
    const retry = JSON.parse(resent.mock.calls[0]![0] as string);
    expect(retry.action).toEqual(instruction.action);
    second.onmessage?.({ data: JSON.stringify({ type: 'result', id: retry.id, ok: true }) });
    await Promise.resolve();
    expect(replacement.unsent()).toEqual([]);
    replacement.dispose();
  });

  it('recognises a refused saved key, gives the fresh-window fix, and stops retries even on returning to the tab', async () => {
    const health = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal('fetch', health);
    await mount();
    expect(host.textContent).toContain('Starting Petrina…');
    await act(async () => current().close());
    await advance(1500);
    expect(Socket.instances).toHaveLength(2);
    await act(async () => current().close());
    await advance(1500);
    expect(health).toHaveBeenCalledWith(new URL('http://127.0.0.1:43210/api/health'), expect.objectContaining({
      headers: { authorization: `Bearer ${address.token}` },
      signal: expect.any(AbortSignal),
    }));
    expect(latest).toMatchObject({ link: 'reconnecting', restarted: true, recovery: true, synced: false });
    expect(host.textContent).toContain('Petrina needs a fresh window');
    expect(host.textContent).toContain('bun run open');
    expect(host.textContent).not.toContain('Starting Petrina…');
    const attempts = Socket.instances.length;
    await advance(60_000);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(5000);
    expect(Socket.instances).toHaveLength(attempts);
  });

  it('keeps retrying an unreachable engine and accepts its real state when it comes back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network unavailable')));
    await mount();
    await act(async () => current().close());
    await advance(3000);
    expect(latest.restarted).toBe(false);
    expect(host.textContent).toContain('Starting Petrina…');
    await act(async () => current().close());
    await advance(1500);
    expect(Socket.instances.length).toBeGreaterThan(2);
    await act(async () => {
      current().connect();
      current().onmessage?.({ data: JSON.stringify({ type: 'state', state: createDemoState(1000) }) });
    });
    expect(latest).toMatchObject({ link: 'live', synced: true });
    expect(latest.restarted).toBeUndefined();
  });

  it('ignores an old refusal if the socket has already reconnected', async () => {
    let answer!: (response: { status: number }) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answer = resolve; })));
    await mount();
    await act(async () => current().close());
    await advance(3000);
    await act(async () => current().connect());
    await act(async () => answer({ status: 401 }));
    expect(latest.link).toBe('live');
    expect(latest.restarted).toBeUndefined();
  });
});
