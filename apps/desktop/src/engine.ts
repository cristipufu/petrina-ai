import { useSyncExternalStore } from "react";
import { createDemoState, createPortfolioDemo, DEMO_TRIGGERS, Simulator, type Id, type State } from "@petrina/core";

// The UI talks to the real engine when it is running (the page carries its address in a
// meta tag). Without it, or with ?demo, it runs on the simulated squad.

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
  setPoolLimit(limit: number): void;
  setPoolPaused(paused: boolean): void;
  moveInQueue(taskId: Id, index: number): void;
  moveToTop(taskId: Id): void;
  setHeld(taskId: Id, held: boolean): void;
  pause(taskId: Id): void;
  resume(taskId: Id): void;
  cancel(taskId: Id): void;
  sendMessage(taskId: Id, text: string, mode?: "queue" | "interrupt"): void;
  removeQueued(taskId: Id, messageId: Id): void;
  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void;
  addReviewer(taskId: Id, stageId: Id, profileId: Id): void;
  setProductDelivery(productId: Id, delivery: "pull-request" | "release" | "local", approveDelivery: boolean): void;
  addTask(input: Parameters<Simulator["addTask"]>[0]): unknown;
  addProduct(path: string): Promise<unknown>;
}

interface Store extends Actions {
  getState(): State;
  subscribe(listener: () => void): () => void;
}

const TICK_MS = 2_200;

function engineAddress(): { url: string; token: string } | undefined {
  if (new URLSearchParams(window.location.search).has("demo")) return undefined;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="petrina-engine"]');
  if (!meta?.content) return undefined;
  try {
    const parsed = JSON.parse(meta.content) as { url?: unknown; token?: unknown };
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return undefined;
    const url = new URL(parsed.url);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") return undefined;
    return { url: parsed.url, token: parsed.token };
  } catch {
    return undefined;
  }
}

const EMPTY: State = { now: Date.now(), seq: 0, products: [], roles: [], tools: [], profiles: [], tasks: [], inbox: [], pool: { limit: 3, paused: false, toolCaps: {} } };

class EngineClient implements Store {
  private state: State = EMPTY;
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | undefined;
  private next = 0;
  private readonly calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  connected = false;
  lastError: string | undefined;

  constructor(private readonly address: { url: string; token: string }) {
    this.connect();
    // The engine only sends state when something changes; keep "3m ago" honest in between.
    setInterval(() => {
      this.state = { ...this.state, now: Date.now() };
      this.emit();
    }, 15_000);
  }

  private connect(): void {
    const socket = new WebSocket(`${this.address.url}?token=${encodeURIComponent(this.address.token)}`);
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.emit();
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
          this.lastError = message.error;
          call?.reject(new Error(message.error ?? "The engine refused that"));
          this.emit();
        }
      }
    };
    socket.onclose = () => {
      this.connected = false;
      this.emit();
      setTimeout(() => this.connect(), 1500);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private call(name: string, ...args: unknown[]): Promise<unknown> {
    const id = (this.next += 1);
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.socket?.send(JSON.stringify({ id, action: { name, args } }));
    });
  }

  private fire(name: string, ...args: unknown[]): void {
    this.call(name, ...args).catch(() => undefined);
  }

  getState = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  answer = (itemId: Id, answer: string) => this.fire("answer", itemId, answer);
  decideForMe = (itemId: Id) => this.fire("decideForMe", itemId);
  allow = (itemId: Id, scope: "once" | "always") => this.fire("allow", itemId, scope);
  deny = (itemId: Id, note?: string) => this.fire("deny", itemId, ...(note ? [note] : []));
  approve = (itemId: Id) => this.fire("approve", itemId);
  requestChanges = (itemId: Id, note: string) => this.fire("requestChanges", itemId, note);
  retry = (itemId: Id) => this.fire("retry", itemId);
  setPoolLimit = (limit: number) => this.fire("setPoolLimit", limit);
  setPoolPaused = (paused: boolean) => this.fire("setPoolPaused", paused);
  moveInQueue = (taskId: Id, index: number) => this.fire("moveInQueue", taskId, index);
  moveToTop = (taskId: Id) => this.fire("moveToTop", taskId);
  setHeld = (taskId: Id, held: boolean) => this.fire("setHeld", taskId, held);
  pause = (taskId: Id) => this.fire("pause", taskId);
  resume = (taskId: Id) => this.fire("resume", taskId);
  cancel = (taskId: Id) => this.fire("cancel", taskId);
  sendMessage = (taskId: Id, text: string, mode: "queue" | "interrupt" = "queue") => this.fire("sendMessage", taskId, text, mode);
  removeQueued = (taskId: Id, messageId: Id) => this.fire("removeQueued", taskId, messageId);
  setStageProfile = (taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id) => this.fire("setStageProfile", taskId, stageId, list, index, profileId);
  addReviewer = (taskId: Id, stageId: Id, profileId: Id) => this.fire("addReviewer", taskId, stageId, profileId);
  setProductDelivery = (productId: Id, delivery: "pull-request" | "release" | "local", approveDelivery: boolean) => this.fire("setProductDelivery", productId, delivery, approveDelivery);
  addTask = (input: Parameters<Simulator["addTask"]>[0]) => this.call("addTask", input);
  addProduct = (path: string) => this.call("addProduct", path);
}

class DemoStore implements Store {
  constructor(private readonly simulator: Simulator) {}
  getState = () => this.simulator.getState();
  subscribe = (listener: () => void) => this.simulator.subscribe(listener);
  answer = (itemId: Id, answer: string) => this.simulator.answer(itemId, answer);
  decideForMe = (itemId: Id) => this.simulator.decideForMe(itemId);
  allow = (itemId: Id, scope: "once" | "always") => this.simulator.allow(itemId, scope);
  deny = (itemId: Id, note?: string) => this.simulator.deny(itemId, note);
  approve = (itemId: Id) => this.simulator.approve(itemId);
  requestChanges = (itemId: Id, note: string) => this.simulator.requestChanges(itemId, note);
  retry = (itemId: Id) => this.simulator.approve(itemId);
  setPoolLimit = (limit: number) => this.simulator.setPoolLimit(limit);
  setPoolPaused = (paused: boolean) => this.simulator.setPoolPaused(paused);
  moveInQueue = (taskId: Id, index: number) => this.simulator.moveInQueue(taskId, index);
  moveToTop = (taskId: Id) => this.simulator.moveToTop(taskId);
  setHeld = (taskId: Id, held: boolean) => this.simulator.setHeld(taskId, held);
  pause = (taskId: Id) => this.simulator.pause(taskId);
  resume = (taskId: Id) => this.simulator.resume(taskId);
  cancel = (taskId: Id) => this.simulator.cancel(taskId);
  sendMessage = (taskId: Id, text: string, mode: "queue" | "interrupt" = "queue") => this.simulator.sendMessage(taskId, text, mode);
  removeQueued = (taskId: Id, messageId: Id) => this.simulator.removeQueued(taskId, messageId);
  setStageProfile = (taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id) => this.simulator.setStageProfile(taskId, stageId, list, index, profileId);
  addReviewer = (taskId: Id, stageId: Id, profileId: Id) => this.simulator.addReviewer(taskId, stageId, profileId);
  setProductDelivery = (productId: Id, delivery: "pull-request" | "release" | "local", approveDelivery: boolean) => this.simulator.setProductDelivery(productId, delivery, approveDelivery);
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

const address = engineAddress();
export const mode: Mode = address ? "engine" : "demo";
const client = address ? new EngineClient(address) : undefined;
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

export function engineStatus(): { connected: boolean; error?: string } {
  if (!client) return { connected: true };
  return { connected: client.connected, ...(client.lastError ? { error: client.lastError } : {}) };
}
