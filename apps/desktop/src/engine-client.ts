import { invoke } from "@tauri-apps/api/core";
import type { CommandName, Commands, Id, State } from "@petrina/core";
import { Late, Lost } from "./commandFailures";
import {
  browserAddress,
  failureText,
  isSavedUnsentRecord,
  newClientId,
  NOTHING_UNSENT,
  parseServerFrame,
  plainReason,
  validAddress,
  type Address,
  type EngineStatus,
  type FirstTask,
  type Unsent,
} from "./engine-protocol";

export {
  browserAddress,
  failureText,
  newClientId,
  NOTHING_UNSENT,
  plainReason,
  validAddress,
  type Address,
  type EngineStatus,
  type FirstTask,
  type Unsent,
};

/** What was not sent yet when the coordinator opened the demo: sent once the window is back on the engine. */
const UNSENT_KEY = "petrina.unsent";
/** How long first run's Start waits for the engine to confirm the task is saved. */
const START_TIMEOUT_MS = 10_000;
/** The desktop app gives up starting an engine after this many failures in a row, and asks. */
const MAX_FAILURES = 3;

const EMPTY: State = {
  now: Date.now(),
  seq: 0,
  products: [],
  roles: [],
  tools: [],
  profiles: [],
  tasks: [],
  inbox: [],
  pool: {
    limit: 3,
    paused: false,
    toolCaps: {},
  },
};

/** The connection to the real engine, and the outbox for what the coordinator says until the engine saves it. */
export class EngineClient {
  image = async (taskId: Id, imageId: Id): Promise<Blob> => {
    if (this.disposed) throw new Lost("Petrina's connection was refreshed");
    if (!this.address) throw new Error("Waiting for Petrina to reconnect.");
    const url = new URL(this.address.url);
    url.protocol = "http:";
    url.pathname = `/api/images/${encodeURIComponent(taskId)}/${encodeURIComponent(imageId)}`;
    const request = new AbortController();
    this.images.add(request);
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.address.token}` }, signal: request.signal });
      if (!response.ok) throw new Error("This picture could not be loaded.");
      return await response.blob();
    } finally {
      this.images.delete(request);
    }
  };
  private state: State = EMPTY;
  private status: EngineStatus;
  private outbox: readonly Unsent[] = NOTHING_UNSENT;
  private readonly sends = new Map<string, { name: string; args: unknown[] }>();
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | undefined;
  private address: Address | undefined;
  private owned: boolean | undefined;
  private failures = 0;
  private wasLive = false;
  private disconnectedAt: number | undefined;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private next = 0;
  private readonly calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly images = new Set<AbortController>();
  private pendingStateAck: { socket: WebSocket; stateId: number } | undefined;
  private disposed = false;
  private readonly clock: ReturnType<typeof setInterval>;
  private readonly onVisibility = () => {
    this.tick();
    if (document.visibilityState === "visible" && this.status.link !== "live" && this.status.link !== "failed" && !this.status.restarted && !this.socket) void this.attempt(this.failures > 0);
  };

  constructor(private readonly source: { desktop: true } | { desktop: false; address: Address }) {
    this.status = { link: "starting", desktop: source.desktop, synced: false };
    if (!source.desktop) this.browserDisconnected();
    if (!source.desktop) this.address = source.address;
    this.restoreUnsent();
    void this.attempt(false);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.clock = setInterval(() => this.tick(), 15_000);
  }

  private tick(): void {
    if (this.disposed || !this.status.synced || this.status.link !== "live" || document.visibilityState === "hidden") return;
    this.state = { ...this.state, now: Date.now() };
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearStateAck();
    clearInterval(this.clock);
    clearTimeout(this.hintTimer);
    clearTimeout(this.retryTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
    for (const call of this.calls.values()) call.reject(new Lost("Petrina's connection was refreshed"));
    this.calls.clear();
    for (const request of this.images) request.abort(new Lost("Petrina's connection was refreshed"));
    this.images.clear();
    this.listeners.clear();
    this.state = EMPTY;
    this.outbox = NOTHING_UNSENT;
    this.sends.clear();
  }

  private async attempt(restart: boolean): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.retryTimer);
    if (this.connecting) return;
    this.connecting = true;
    try {
      await this.reach(restart);
    } finally {
      this.connecting = false;
    }
  }

  private async reach(restart: boolean): Promise<void> {
    if (this.source.desktop) {
      try {
        const hello = JSON.parse(await invoke<string>("engine_details", { restart })) as { type?: string; owned?: unknown; message?: unknown };
        if (this.disposed) return;
        if (hello.type === "error") return this.failed(typeof hello.message === "string" ? hello.message : "Petrina's engine could not start.");
        this.address = validAddress(hello);
        this.owned = hello.owned === true;
        if (!this.address) return this.failed("Petrina's engine gave an address the app does not recognise.");
      } catch (error) {
        return this.failed(typeof error === "string" ? error : "Petrina could not start its engine.");
      }
    }
    this.open(this.address!);
  }

  private open(address: Address): void {
    if (this.disposed) return;
    this.clearStateAck();
    const socket = new WebSocket(address.url, ["petrina.v1", `petrina.token.${address.token}`]);
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      if (this.disposed || this.socket !== socket) return;
      clearTimeout(this.hintTimer);
      this.disconnectedAt = undefined;
      opened = true;
      this.failures = 0;
      this.wasLive = true;
      this.setStatus({ link: "live", desktop: this.source.desktop, synced: this.status.synced, ...(this.owned === undefined ? {} : { owned: this.owned }) });
      for (const entry of this.outbox) if (!entry.refused) this.deliver(entry);
    };
    socket.onmessage = (event) => {
      if (this.disposed || this.socket !== socket) return;
      const message = parseServerFrame(String(event.data));
      if (!message) return;
      if (message.type === "state") {
        this.state = message.state;
        if (!this.status.synced) this.status = { ...this.status, synced: true };
        this.emit();
        if (typeof message.stateId === "number" && Number.isSafeInteger(message.stateId) && message.stateId > 0) {
          this.acknowledgeState(socket, message.stateId);
        }
      } else {
        const call = this.calls.get(message.id);
        this.calls.delete(message.id);
        if (message.ok) call?.resolve(message.result);
        else {
          const reason = message.error ?? "The engine refused that";
          this.setStatus({ ...this.status, error: reason });
          call?.reject(new Error(reason));
        }
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.clearStateAck();
      this.socket = undefined;
      for (const call of this.calls.values()) call.reject(new Lost("Petrina lost its connection to the engine"));
      this.calls.clear();
      if (!this.source.desktop) this.browserDisconnected();
      if (!opened) return this.failed("Petrina could not connect to its engine.");
      this.setStatus({ ...this.status, link: "reconnecting", desktop: this.source.desktop });
      void this.attempt(false);
    };
  }

  private acknowledgeState(socket: WebSocket, stateId: number): void {
    const receipt = { socket, stateId };
    this.pendingStateAck = receipt;
    queueMicrotask(() => {
      if (this.pendingStateAck !== receipt) return;
      this.pendingStateAck = undefined;
      if (!this.disposed && receipt.socket === this.socket && receipt.socket.readyState === WebSocket.OPEN) {
        receipt.socket.send(JSON.stringify({ type: "state-ack", stateId: receipt.stateId }));
      }
    });
  }

  private clearStateAck(): void {
    this.pendingStateAck = undefined;
  }

  private failed(problem: string): void {
    if (this.disposed) return;
    if (!this.source.desktop && this.status.restarted) return;
    this.failures += 1;
    if (this.source.desktop && this.failures >= MAX_FAILURES) {
      this.setStatus({ link: "failed", desktop: true, synced: this.status.synced, problem });
      return;
    }
    const browserWaiting = !this.source.desktop && this.disconnectedAt !== undefined && Date.now() - this.disconnectedAt >= 3000;
    this.setStatus({ ...this.status, link: this.wasLive || browserWaiting ? "reconnecting" : "starting", desktop: this.source.desktop, problem });
    if (browserWaiting) void this.checkBrowserEngine();
    this.retryTimer = setTimeout(() => void this.attempt(this.source.desktop), this.source.desktop ? 1000 : 1500);
  }

  private browserDisconnected(): void {
    if (this.disconnectedAt !== undefined) return;
    this.disconnectedAt = Date.now();
    this.hintTimer = setTimeout(() => {
      if (this.status.link === "live") return;
      this.setStatus({ ...this.status, link: "reconnecting", recovery: true });
      void this.checkBrowserEngine();
    }, 3000);
  }

  private async checkBrowserEngine(): Promise<void> {
    const address = this.address;
    if (this.disposed || !address || this.source.desktop) return;
    const disconnectedAt = this.disconnectedAt;
    let restarted = false;
    try {
      const url = new URL(address.url);
      url.protocol = "http:";
      url.pathname = "/api/health";
      const response = await fetch(url, { headers: { authorization: `Bearer ${address.token}` }, signal: AbortSignal.timeout(1500) });
      restarted = response.status === 401;
    } catch {
      // Nothing answers, or the window cannot tell: the general hint covers both.
    }
    if (this.disposed || this.status.link === "live" || this.disconnectedAt !== disconnectedAt) return;
    if (restarted || this.status.restarted) {
      clearTimeout(this.retryTimer);
      this.setStatus({ ...this.status, restarted: true, recovery: true, link: "reconnecting", problem: undefined });
      return;
    }
    this.setStatus({ ...this.status, restarted: false });
  }

  retryEngine = (): void => {
    this.failures = 0;
    this.setStatus({ link: this.wasLive ? "reconnecting" : "starting", desktop: this.source.desktop, synced: this.status.synced });
    void this.attempt(true);
  };

  keepUnsent = (): void => {
    if (!this.outbox.length) return;
    try {
      localStorage.setItem(UNSENT_KEY, JSON.stringify(this.outbox.map((entry) => ({ entry, send: this.sends.get(entry.clientId) }))));
    } catch {
      // Without storage it cannot be kept; the couldn't-start screen says what is waiting.
    }
  };

  private restoreUnsent(): void {
    try {
      const saved = localStorage.getItem(UNSENT_KEY);
      localStorage.removeItem(UNSENT_KEY);
      if (!saved) return;
      const parsed: unknown = JSON.parse(saved);
      if (!Array.isArray(parsed)) return;
      for (const record of parsed) {
        if (!isSavedUnsentRecord(record) || this.sends.has(record.entry.clientId)) continue;
        this.sends.set(record.entry.clientId, record.send);
        this.outbox = [...this.outbox, record.entry];
      }
    } catch {
      // Nothing kept, or nothing readable.
    }
  }

  private setStatus(status: EngineStatus): void {
    if (this.disposed) return;
    this.status = status;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private call(name: string, ...args: unknown[]): Promise<unknown> {
    return this.callWithin(undefined, name, ...args);
  }

  private callWithin(timeoutMs: number | undefined, name: string, ...args: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Lost("Petrina is not connected to its engine"));
    const id = (this.next += 1);
    while (args.length && args.at(-1) === undefined) args.pop();
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.calls.delete(id);
              reject(new Late("Petrina's engine did not answer in time"));
            }, timeoutMs);
      const settle = (done: () => void) => {
        clearTimeout(timer);
        done();
      };
      this.calls.set(id, { resolve: (value) => settle(() => resolve(value)), reject: (error) => settle(() => reject(error)) });
      socket.send(JSON.stringify({ id, action: { name, args } }));
    });
  }

  private durable(entry: Omit<Unsent, "clientId">, name: string, args: (id: string) => unknown[]): void {
    const unsent: Unsent = { ...entry, clientId: newClientId() };
    this.sends.set(unsent.clientId, { name, args: args(unsent.clientId) });
    this.outbox = [...this.outbox, unsent];
    this.emit();
    this.deliver(unsent);
  }

  private deliver(unsent: Unsent): void {
    const send = this.sends.get(unsent.clientId);
    if (!send || this.socket?.readyState !== WebSocket.OPEN) return;
    this.call(send.name, ...send.args).then(
      () => this.settle(unsent),
      (error: Error) => {
        if (!(error instanceof Lost)) this.mark(unsent.clientId, plainReason(error.message));
      },
    );
  }

  private mark(clientId: string, refused: string | undefined): void {
    this.outbox = this.outbox.map((entry) => {
      if (entry.clientId !== clientId) return entry;
      const { refused: _old, ...rest } = entry;
      return refused ? { ...rest, refused } : rest;
    });
    this.emit();
  }

  resendUnsent = (clientId: string): void => {
    const entry = this.outbox.find((candidate) => candidate.clientId === clientId);
    if (!entry?.refused) return;
    this.mark(clientId, undefined);
    this.deliver(entry);
  };

  discardUnsent = (clientId: string): void => {
    const entry = this.outbox.find((candidate) => candidate.clientId === clientId);
    if (entry?.refused) this.settle(entry);
  };

  private settle(unsent: Unsent): void {
    this.sends.delete(unsent.clientId);
    this.outbox = this.outbox.filter((entry) => entry.clientId !== unsent.clientId);
    this.emit();
  }

  private item(itemId: Id) {
    return this.state.inbox.find((entry) => entry.id === itemId);
  }

  getState = (): State => this.state;
  synced = (): boolean => this.status.synced;
  getStatus = (): EngineStatus => this.status;
  unsent = (): readonly Unsent[] => this.outbox;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  answer = (itemId: Id, answer: string) => {
    const item = this.item(itemId);
    if (!item) return;
    this.durable(
      {
      taskId: item.taskId,
      kind: "answer",
      text: answer,
      itemId
    },
      "answer",
      (id) => [
      itemId,
      answer,
      {
      taskId: item.taskId,
      about: item.title,
      clientId: id
    }
    ]
    );
  };
  decideForMe = (itemId: Id) => {
    const item = this.item(itemId);
    if (!item) return;
    const answer = item.options?.[0] ?? "Use your best judgment.";
    this.durable(
      {
      taskId: item.taskId,
      kind: "answer",
      text: answer,
      itemId
    },
      "answer",
      (id) => [
      itemId,
      answer,
      {
      taskId: item.taskId,
      about: item.title,
      clientId: id,
      decided: true
    }
    ]
    );
  };
  deny = (itemId: Id, note?: string) => {
    const item = this.item(itemId);
    if (!item) return;
    this.durable(
      {
      taskId: item.taskId,
      kind: "no",
      text: note ?? "",
      itemId
    },
      "deny",
      (id) => [
      itemId,
      note ?? "",
      {
      taskId: item.taskId,
      about: item.title,
      clientId: id
    }
    ]
    );
  };
  requestChanges = (itemId: Id, note: string) => {
    const item = this.item(itemId);
    if (!item) return;
    this.durable({ taskId: item.taskId, kind: "changes", text: note, itemId }, "requestChanges", () => [itemId, note]);
  };
  sendMessage = (taskId: Id, text: string, mode: "now" | "queue" | "interrupt" = "now") => {
    const trimmed = text.trim();
    if (trimmed) this.durable({ taskId, kind: "message", text: trimmed }, "sendMessage", (id) => [taskId, trimmed, mode, id]);
  };

  send = <K extends CommandName>(name: K, args: readonly [...Parameters<Commands[K]>]): Promise<Awaited<ReturnType<Commands[K]>>> => {
    const sent = this.call(name, ...args) as Promise<Awaited<ReturnType<Commands[K]>>>;
    void sent.catch(() => undefined);
    return sent;
  };

  startFirstTask = (input: FirstTask): Promise<Id> => this.callWithin(START_TIMEOUT_MS, "startFirstTask", input) as Promise<Id>;
}
