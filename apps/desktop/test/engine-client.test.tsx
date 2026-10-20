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
  it('ticks only a synced visible connection, and catches up immediately when shown', async () => {
    await mount();
    const { EngineClient } = await import('../src/engine');
    const client = new EngineClient({ desktop: false, address });
    try {
      const notify = vi.fn(); client.subscribe(notify);
      const unseen = client.getState();
      await advance(15_000); expect(client.getState()).toBe(unseen);
      const socket = current(); socket.connect();
      socket.onmessage?.({ data: JSON.stringify({ type: 'state', state: createDemoState(1000) }) });
      const before = client.getState(); notify.mockClear();
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      await advance(30_000); expect(client.getState()).toBe(before); expect(notify).not.toHaveBeenCalled();
      visibility.mockReturnValue('visible');
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(client.getState().now).toBe(Date.now()); expect(notify).toHaveBeenCalledTimes(1);
      expect(client.getState().tasks).toBe(before.tasks);
      notify.mockClear(); await advance(15_000); expect(notify).toHaveBeenCalledTimes(1);
      socket.close(); notify.mockClear();
      const disconnected = client.getState();
      await advance(15_000); expect(client.getState()).toBe(disconnected);
    } finally { client.dispose(); }
  });
  it('acknowledges after processing state and keeps background inbox updates moving without a paint', async () => {
    await mount();
    const { EngineClient } = await import('../src/engine');
    const client = new EngineClient({ desktop: false, address });
    const socket = current(); socket.connect();
    const send = vi.spyOn(socket, 'send');
    expect(socket.protocols).toEqual(['petrina.v1', `petrina.token.${address.token}`]);
    socket.onmessage?.({ data: JSON.stringify({ type: 'state', stateId: 1, state: createDemoState(1000) }) });
    expect(client.getState().now).toBe(1000);
    expect(send).not.toHaveBeenCalled();
    await advance(0);
    expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'state-ack', stateId: 1 }));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    socket.onmessage?.({ data: JSON.stringify({ type: 'state', stateId: 2, state: createDemoState(2000) }) });
    await advance(0);
    expect(send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'state-ack', stateId: 2 }));
    expect(client.getState().now).toBe(2000);
    // Hiding immediately after receipt must not block later notifications.
    visibility.mockReturnValue('visible');
    socket.onmessage?.({ data: JSON.stringify({ type: 'state', stateId: 3, state: createDemoState(3000) }) });
    visibility.mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(20);
    expect(send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'state-ack', stateId: 3 }));
    expect(send).toHaveBeenCalledTimes(3);
    client.dispose();
  });

  it('keeps command replies independent of the state receipt while the window is hidden', async () => {
    await mount();
    const { EngineClient } = await import('../src/engine');
    const client = new EngineClient({ desktop: false, address });
    const socket = current(); socket.connect();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    socket.onmessage?.({ data: JSON.stringify({ type: 'state', stateId: 1, state: createDemoState(1000) }) });
    const send = vi.spyOn(socket, 'send');
    const result = client.send('setPoolPaused', [true]);
    const request = JSON.parse(send.mock.calls[0]![0]);
    socket.onmessage?.({ data: JSON.stringify({ type: 'result', id: request.id, ok: true, result: 'saved' }) });
    await expect(result).resolves.toBe('saved');
    client.dispose();
  });

  it('cancels old receipts on disconnect and refresh without affecting the replacement connection', async () => {
    await mount();
    const { EngineClient } = await import('../src/engine');
    const client = new EngineClient({ desktop: false, address });
    const first = current(); first.connect();
    const firstSend = vi.spyOn(first, 'send');
    await advance(0);
    first.onmessage?.({ data: JSON.stringify({ type: 'state', stateId: 1, state: createDemoState(1000) }) });
    await act(async () => first.close());
    const next = current(); next.connect();
    expect(next).not.toBe(first);
    const nextSend = vi.spyOn(next, 'send');
    next.onmessage?.({ data: JSON.stringify({ type: 'state', stateId: 2, state: createDemoState(2000) }) });
    await advance(20);
    expect(firstSend).not.toHaveBeenCalled();
    expect(nextSend).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'state-ack', stateId: 2 }));
    expect(client.getState().now).toBe(2000);
    nextSend.mockClear();
    next.onmessage?.({ data: JSON.stringify({ type: 'state', stateId: 3, state: createDemoState(3000) }) });
    client.dispose();
    await advance(20);
    expect(nextSend).not.toHaveBeenCalled();
  });
  it('loads saved report pictures separately with the connection key, and explains a missing picture', async () => {
    const picture = new Blob(['checked page'], { type: 'image/png' });
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => picture });
    vi.stubGlobal('fetch', fetch);
    await mount();
    const { EngineClient } = await import('../src/engine');
    const client = new EngineClient({ desktop: false, address });
    try {
      await expect(client.image('task/1', 'picture 1')).resolves.toBe(picture);
      expect(fetch).toHaveBeenCalledWith(new URL('http://127.0.0.1:43210/api/images/task%2F1/picture%201'), {
        headers: { authorization: `Bearer ${address.token}` },
        signal: expect.any(AbortSignal),
      });
      fetch.mockResolvedValue({ ok: false });
      await expect(client.image('task-1', 'missing')).rejects.toThrow('This picture could not be loaded.');
    } finally { client.dispose(); }
  });

  it('stops unfinished picture downloads on refresh and lets the replacement connection load them', async () => {
    let downloading!: AbortSignal;
    const fetch = vi.fn((_url: URL, { signal }: RequestInit) => {
      downloading = signal!;
      return Promise.resolve({ ok: true, blob: () => new Promise<Blob>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      }) });
    });
    vi.stubGlobal('fetch', fetch);
    await mount();
    const { EngineClient } = await import('../src/engine');
    const client = new EngineClient({ desktop: false, address });
    const pending = client.image('task-1', 'picture-1');
    await Promise.resolve(); // The response arrived; its image contents are still downloading.
    const rejected = expect(pending).rejects.toThrow('connection was refreshed');
    client.dispose();
    await rejected;
    expect(downloading.aborted).toBe(true);
    await expect(client.image('task-1', 'picture-1')).rejects.toThrow('connection was refreshed');
    expect(fetch).toHaveBeenCalledTimes(1);

    const picture = new Blob(['checked page'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => picture }));
    const replacement = new EngineClient({ desktop: false, address });
    try {
      await expect(replacement.image('task-1', 'picture-1')).resolves.toBe(picture);
    } finally { replacement.dispose(); }
  });

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
