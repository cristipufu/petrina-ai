import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createDemoState, createPortfolioDemo, DEMO_TRIGGERS, Simulator, type Id, type ProductSettings, type State } from "@petrina/core";

// Where the UI finds the real engine:
// - In the desktop app, it asks the shell over the app's internal channel. The shell starts the
//   engine, or the engine it starts finds one already running. The address and key stay in
//   memory only, and the key goes to the engine when the connection opens, never in an address.
// - In a browser opened by `petrina open`, from the URL fragment, kept for this tab only.
// Otherwise, or with ?demo, it runs on the simulated squad.

type Mode = "engine" | "demo";

/** Everything the UI can ask the squad to do. The simulator and the engine both answer it. */
export interface Actions {
  answer(itemId: Id, answer: string): void;
  decideForMe(itemId: Id): void;
  allow(itemId: Id, scope: "once" | "always"): void;
  deny(itemId: Id, note?: string): void;
  approve(itemId: Id): void;
  requestChanges(itemId: Id, note: string): void;
  retry(itemId: Id): void;
  checkShipping(itemId: Id): void;
  shipAgain(itemId: Id): void;
  markDone(itemId: Id): void;
  setPoolLimit(limit: number): void;
  setPoolPaused(paused: boolean): void;
  setToolCap(toolId: Id, cap: number): void;
  moveInQueue(taskId: Id, index: number): void;
  placeInQueue(taskId: Id, anchorId: Id, side: "before" | "after"): number | Promise<number>;
  moveVisibleInQueue(taskId: Id, visibleIds: Id[], direction: -1 | 1): number | Promise<number>;
  moveToTop(taskId: Id): void;
  setHeld(taskId: Id, held: boolean): void;
  setAfter(taskId: Id, after: Id[]): void;
  pause(taskId: Id): void;
  resume(taskId: Id): void;
  cancel(taskId: Id): void;
  sendMessage(taskId: Id, text: string, mode?: "queue" | "interrupt"): void;
  removeQueued(taskId: Id, messageId: Id): void;
  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void;
  addReviewer(taskId: Id, stageId: Id, profileId: Id): void;
  setProductDelivery(productId: Id, delivery: "pull-request" | "release" | "local", approveDelivery: boolean): void;
  updateProduct(productId: Id, settings: ProductSettings): Promise<unknown>;
  removeProduct(productId: Id): Promise<unknown>;
  addTask(input: Parameters<Simulator["addTask"]>[0]): unknown;
  addProduct(path: string, name?: string): Promise<unknown>;
}

/** Something the coordinator said that the engine has not confirmed saving yet. Sent again after reconnecting. */
export interface Unsent {
  clientId: string;
  taskId: Id;
  kind: "message" | "answer" | "no" | "changes";
  text: string;
  /** The inbox item it answers. */
  itemId?: Id;
  /** The engine refused it, in plain words. Kept and shown until the coordinator sends it again or discards it. */
  refused?: string;
}

interface Store extends Actions {
  getState(): State;
  subscribe(listener: () => void): () => void;
  unsent(): readonly Unsent[];
  /** Send something the engine refused once more. */
  resendUnsent(clientId: string): void;
  /** Let go of something the engine refused. */
  discardUnsent(clientId: string): void;
}

/** How the window is connected to its engine. */
export interface EngineStatus {
  link: "starting" | "live" | "reconnecting" | "failed";
  /** Inside the desktop app. */
  desktop: boolean;
  /** Desktop: the app started this engine (quitting stops it), or found one already running. */
  owned?: boolean;
  /** Why the engine could not start or be reached. */
  problem?: string;
  /** Browser: the address answers but refuses this window's old key. */
  restarted?: boolean;
  recovery?: boolean;
  /** The last action the engine refused. */
  error?: string;
}

interface Address {
  url: string;
  token: string;
}

const TICK_MS = 2_200;
const SESSION_KEY = "petrina.engine";
/** The desktop app gives up starting an engine after this many failures in a row, and asks. */
const MAX_FAILURES = 3;

function validAddress(raw: unknown): Address | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { url, token } = raw as { url?: unknown; token?: unknown };
  if (typeof url !== "string" || typeof token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ws" || parsed.search) return undefined;
  } catch {
    return undefined;
  }
  return { url, token };
}

/**
 * `petrina open` passes the engine's address in the URL fragment (never sent to a server).
 * It is kept for this tab only and removed from the address bar right away.
 */
function browserAddress(): Address | undefined {
  const hash = new URLSearchParams(window.location.hash.slice(1)).get("engine");
  if (hash) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      const decoded = validAddress(JSON.parse(atob(hash.replace(/-/g, "+").replace(/_/g, "/"))));
      if (decoded) {
        try {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(decoded));
        } catch {
          // Without storage the tab still works; a reload just needs `petrina open` again.
        }
        return decoded;
      }
    } catch {
      return undefined;
    }
  }
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    return saved ? validAddress(JSON.parse(saved)) : undefined;
  } catch {
    return undefined;
  }
}

const EMPTY: State = { now: Date.now(), seq: 0, products: [], roles: [], tools: [], profiles: [], tasks: [], inbox: [], pool: { limit: 3, paused: false, toolCaps: {} } };
const NOTHING_UNSENT: readonly Unsent[] = [];

/** The connection closed before the engine answered: worth sending again. */
class Lost extends Error {}

/** The engine's reason when it is plain words; its checks of what was sent are not, so they get a plain line. */
function plainReason(error: string): string {
  return error.length <= 160 && !/[{}[\]<>"`]/.test(error) ? error : "Petrina's engine could not take it.";
}

function clientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

class EngineClient implements Store {
  private state: State = EMPTY;
  private status: EngineStatus;
  private outbox: readonly Unsent[] = NOTHING_UNSENT;
  /** How to send each unsent entry, by its client id. */
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
  /** Asking the shell, so a second attempt waits for this one. */
  private connecting = false;
  private next = 0;
  private readonly calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly source: { desktop: true } | { desktop: false; address: Address }) {
    this.status = { link: "starting", desktop: source.desktop };
    if (!source.desktop) this.browserDisconnected();
    if (!source.desktop) this.address = source.address;
    void this.attempt(false);
    // Hidden windows get slow timers: the moment the window shows again, retry instead of waiting.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.status.link !== "live" && this.status.link !== "failed" && !this.socket) void this.attempt(this.failures > 0);
    });
    // The engine only sends state when something changes; keep "3m ago" honest in between.
    setInterval(() => {
      this.state = { ...this.state, now: Date.now() };
      this.emit();
    }, 15_000);
  }

  /** Get the engine's address (from the shell, in the desktop app) and connect. */
  private async attempt(restart: boolean): Promise<void> {
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
    const socket = new WebSocket(address.url, ["petrina.v1", `petrina.token.${address.token}`]);
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      clearTimeout(this.hintTimer);
      this.disconnectedAt = undefined;
      opened = true;
      this.failures = 0;
      this.wasLive = true;
      this.setStatus({ link: "live", desktop: this.source.desktop, ...(this.owned === undefined ? {} : { owned: this.owned }) });
      for (const entry of this.outbox) if (!entry.refused) this.deliver(entry);
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; state?: State; id?: number; ok?: boolean; result?: unknown; error?: string };
      if (message.type === "state" && message.state) {
        this.state = message.state;
        this.emit();
      } else if (message.type === "result" && typeof message.id === "number") {
        const call = this.calls.get(message.id);
        this.calls.delete(message.id);
        if (message.ok) call?.resolve(message.result);
        else {
          this.setStatus({ ...this.status, error: message.error ?? "The engine refused that" });
          call?.reject(new Error(message.error ?? "The engine refused that"));
        }
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const call of this.calls.values()) call.reject(new Lost("Petrina lost its connection to the engine"));
      this.calls.clear();
      if (!this.source.desktop) this.browserDisconnected();
      if (!opened) return this.failed("Petrina could not connect to its engine.");
      // The engine stopped: in the desktop app, the shell starts a new one if needed. Right away,
      // not on a timer, which a hidden window would slow down.
      this.setStatus({ ...this.status, link: "reconnecting", desktop: this.source.desktop });
      void this.attempt(false);
    };
  }

  private failed(problem: string): void {
    this.failures += 1;
    if (this.source.desktop && this.failures >= MAX_FAILURES) {
      // Never switch to the demo on its own: the coordinator chooses.
      this.setStatus({ link: "failed", desktop: true, problem });
      return;
    }
    const browserWaiting = !this.source.desktop && this.disconnectedAt !== undefined && Date.now() - this.disconnectedAt >= 3000;
    this.setStatus({ ...this.status, link: this.wasLive || browserWaiting ? "reconnecting" : "starting", desktop: this.source.desktop, problem });
    if (browserWaiting) void this.checkBrowserEngine();
    // After a failure the desktop app asks for a fresh engine: the old one may be stuck.
    this.retryTimer = setTimeout(() => void this.attempt(this.source.desktop), this.source.desktop ? 1000 : 1500);
  }

  /** Browser recovery stays quiet on short blips; the desktop shell owns its own recovery. */
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
    if (!address || this.source.desktop) return;
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
    if (this.status.link !== "live" && this.disconnectedAt === disconnectedAt) this.setStatus({ ...this.status, restarted });
  }

  /** "Try again" on the couldn't-start message. */
  retryEngine = (): void => {
    this.failures = 0;
    this.setStatus({ link: this.wasLive ? "reconnecting" : "starting", desktop: this.source.desktop });
    void this.attempt(true);
  };

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private call(name: string, ...args: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Lost("Petrina is not connected to its engine"));
    const id = (this.next += 1);
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, action: { name, args } }));
    });
  }

  private fire(name: string, ...args: unknown[]): Promise<void> {
    const sent = this.call(name, ...args).then(() => undefined);
    // Existing pointer controls report failures through the connection pill. Keyboard controls
    // also await this promise, so their success notes follow the engine's acknowledgement.
    void sent.catch(() => undefined);
    return sent;
  }

  /** Kept, and shown as unsent, until the engine confirms it saved it. */
  private durable(entry: Omit<Unsent, "clientId">, name: string, args: (id: string) => unknown[]): void {
    const unsent: Unsent = { ...entry, clientId: clientId() };
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
        // Lost on the way: it goes again after reconnecting. Refused: it stays, marked, until the coordinator decides.
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
    this.durable({ taskId: item.taskId, kind: "answer", text: answer, itemId }, "answer", (id) => [itemId, answer, { taskId: item.taskId, about: item.title, clientId: id }]);
  };
  decideForMe = (itemId: Id) => {
    const item = this.item(itemId);
    if (item) this.answer(itemId, item.options?.[0] ?? "Use your best judgment.");
  };
  allow = (itemId: Id, scope: "once" | "always") => this.fire("allow", itemId, scope);
  deny = (itemId: Id, note?: string) => {
    const item = this.item(itemId);
    if (!item) return;
    this.durable({ taskId: item.taskId, kind: "no", text: note ?? "", itemId }, "deny", (id) => [itemId, note ?? "", { taskId: item.taskId, about: item.title, clientId: id }]);
  };
  approve = (itemId: Id) => this.fire("approve", itemId);
  requestChanges = (itemId: Id, note: string) => {
    const item = this.item(itemId);
    if (!item) return;
    this.durable({ taskId: item.taskId, kind: "changes", text: note, itemId }, "requestChanges", () => [itemId, note]);
  };
  retry = (itemId: Id) => this.fire("retry", itemId);
  checkShipping = (itemId: Id) => this.fire("checkShipping", itemId);
  shipAgain = (itemId: Id) => this.fire("shipAgain", itemId);
  markDone = (itemId: Id) => this.fire("markDone", itemId);
  setPoolLimit = (limit: number) => this.fire("setPoolLimit", limit);
  setPoolPaused = (paused: boolean) => this.fire("setPoolPaused", paused);
  setToolCap = (toolId: Id, cap: number) => this.fire("setToolCap", toolId, cap);
  moveInQueue = (taskId: Id, index: number) => this.fire("moveInQueue", taskId, index);
  placeInQueue = (taskId: Id, anchorId: Id, side: "before" | "after") => this.call("placeInQueue", taskId, anchorId, side) as Promise<number>;
  moveVisibleInQueue = (taskId: Id, visibleIds: Id[], direction: -1 | 1) => this.call("moveVisibleInQueue", taskId, visibleIds, direction) as Promise<number>;
  moveToTop = (taskId: Id) => this.fire("moveToTop", taskId);
  setHeld = (taskId: Id, held: boolean) => this.fire("setHeld", taskId, held);
  setAfter = (taskId: Id, after: Id[]) => this.fire("setAfter", taskId, after);
  pause = (taskId: Id) => this.fire("pause", taskId);
  resume = (taskId: Id) => this.fire("resume", taskId);
  cancel = (taskId: Id) => this.fire("cancel", taskId);
  sendMessage = (taskId: Id, text: string, mode: "queue" | "interrupt" = "queue") => {
    const trimmed = text.trim();
    if (trimmed) this.durable({ taskId, kind: "message", text: trimmed }, "sendMessage", (id) => [taskId, trimmed, mode, id]);
  };
  removeQueued = (taskId: Id, messageId: Id) => this.fire("removeQueued", taskId, messageId);
  setStageProfile = (taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id) => this.fire("setStageProfile", taskId, stageId, list, index, profileId);
  addReviewer = (taskId: Id, stageId: Id, profileId: Id) => this.fire("addReviewer", taskId, stageId, profileId);
  setProductDelivery = (productId: Id, delivery: "pull-request" | "release" | "local", approveDelivery: boolean) => this.fire("setProductDelivery", productId, delivery, approveDelivery);
  updateProduct = (productId: Id, settings: ProductSettings) => this.call("updateProduct", productId, settings);
  removeProduct = (productId: Id) => this.call("removeProduct", productId);
  addTask = (input: Parameters<Simulator["addTask"]>[0]) => this.call("addTask", input);
  addProduct = (path: string, name?: string) => this.call("addProduct", path, name);
}

class DemoStore implements Store {
  constructor(private readonly simulator: Simulator) {}
  getState = () => this.simulator.getState();
  subscribe = (listener: () => void) => this.simulator.subscribe(listener);
  unsent = () => NOTHING_UNSENT;
  resendUnsent = () => undefined;
  discardUnsent = () => undefined;
  answer = (itemId: Id, answer: string) => this.simulator.answer(itemId, answer);
  decideForMe = (itemId: Id) => this.simulator.decideForMe(itemId);
  allow = (itemId: Id, scope: "once" | "always") => this.simulator.allow(itemId, scope);
  deny = (itemId: Id, note?: string) => this.simulator.deny(itemId, note);
  approve = (itemId: Id) => this.simulator.approve(itemId);
  requestChanges = (itemId: Id, note: string) => this.simulator.requestChanges(itemId, note);
  retry = (itemId: Id) => this.simulator.approve(itemId);
  checkShipping = () => undefined;
  shipAgain = () => undefined;
  markDone = () => undefined;
  setPoolLimit = (limit: number) => this.simulator.setPoolLimit(limit);
  setPoolPaused = (paused: boolean) => this.simulator.setPoolPaused(paused);
  setToolCap = (toolId: Id, cap: number) => this.simulator.setToolCap(toolId, cap);
  moveInQueue = (taskId: Id, index: number) => this.simulator.moveInQueue(taskId, index);
  placeInQueue = (taskId: Id, anchorId: Id, side: "before" | "after") => this.simulator.placeInQueue(taskId, anchorId, side);
  moveVisibleInQueue = (taskId: Id, visibleIds: Id[], direction: -1 | 1) => this.simulator.moveVisibleInQueue(taskId, visibleIds, direction);
  moveToTop = (taskId: Id) => this.simulator.moveToTop(taskId);
  setHeld = (taskId: Id, held: boolean) => this.simulator.setHeld(taskId, held);
  setAfter = () => undefined;
  pause = (taskId: Id) => this.simulator.pause(taskId);
  resume = (taskId: Id) => this.simulator.resume(taskId);
  cancel = (taskId: Id) => this.simulator.cancel(taskId);
  sendMessage = (taskId: Id, text: string, mode: "queue" | "interrupt" = "queue") => this.simulator.sendMessage(taskId, text, mode);
  removeQueued = (taskId: Id, messageId: Id) => this.simulator.removeQueued(taskId, messageId);
  setStageProfile = (taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id) => this.simulator.setStageProfile(taskId, stageId, list, index, profileId);
  addReviewer = (taskId: Id, stageId: Id, profileId: Id) => this.simulator.addReviewer(taskId, stageId, profileId);
  setProductDelivery = (productId: Id, delivery: "pull-request" | "release" | "local", approveDelivery: boolean) => this.simulator.setProductDelivery(productId, delivery, approveDelivery);
  updateProduct = async (productId: Id, settings: ProductSettings) => this.simulator.updateProduct(productId, settings);
  removeProduct = async (productId: Id) => this.simulator.removeProduct(productId);
  addTask = (input: Parameters<Simulator["addTask"]>[0]) => this.simulator.addTask(input);
  addProduct = async () => {
    throw new Error("The demo has fixed products");
  };
}

function demo() {
  const now = Date.now();
  if (new URLSearchParams(window.location.search).get("demo") === "portfolio") return createPortfolioDemo(now);
  return { state: createDemoState(now), triggers: DEMO_TRIGGERS };
}

/** Inside the desktop app (not a browser). */
export const desktop = isTauri();
const wantsDemo = new URLSearchParams(window.location.search).has("demo");
const address = desktop || wantsDemo ? undefined : browserAddress();
const client = wantsDemo ? undefined : desktop ? new EngineClient({ desktop: true }) : address ? new EngineClient({ desktop: false, address }) : undefined;
export const mode: Mode = client ? "engine" : "demo";
let simulator: Simulator | undefined;
if (!client) {
  const initial = demo();
  simulator = new Simulator(initial.state, { triggers: initial.triggers, prMergeAfter: 45, tickMs: TICK_MS });
}

/** The squad: the real engine, or the simulated one in demo mode. */
export const sim: Store = client ?? new DemoStore(simulator!);

let timer: ReturnType<typeof setInterval> | undefined;

export function startClock(): () => void {
  if (simulator && !timer) timer = setInterval(() => simulator!.tick(Date.now()), TICK_MS);
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}

export function useSim(): State {
  return useSyncExternalStore(sim.subscribe, sim.getState);
}

const DEMO_STATUS: EngineStatus = { link: "live", desktop };
const getStatus = () => client?.getStatus() ?? DEMO_STATUS;

export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(sim.subscribe, getStatus);
}

/** What the coordinator said that the engine has not confirmed yet. */
export function useUnsent(): readonly Unsent[] {
  return useSyncExternalStore(sim.subscribe, sim.unsent);
}

/** "Try again" after the engine could not start. */
export function retryEngine(): void {
  client?.retryEngine();
}

/** "Open the demo": only ever the coordinator's choice. */
export function openDemo(): void {
  window.location.replace(`${window.location.pathname}?demo`);
}

/** Back from the demo to the real engine, in the desktop app. */
export function leaveDemo(): void {
  window.location.replace(window.location.pathname);
}
