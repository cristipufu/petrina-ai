import type { Id, NewTaskInput, State, WindowStateDelta } from "@petrina/core";
import { Late, Lost } from "./commandFailures";

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

/** How the window is connected to its engine. */
export interface EngineStatus {
  link: "starting" | "live" | "reconnecting" | "failed";
  /** The engine's real state has arrived at least once: until then the window knows nothing about products or tasks. */
  synced: boolean;
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

export interface Address {
  url: string;
  token: string;
}

/** First run's Start, as the window sends it: its id makes a resend after a lost reply find the same task. */
export type FirstTask = NewTaskInput & { clientId: string };

export type ServerFrame =
  | { type: "state"; state: State; stateId?: number }
  | { type: "state-delta"; stateId: number; baseStateId: number; delta: WindowStateDelta }
  | { type: "result"; id: number; ok: boolean; result?: unknown; error?: string };

const SESSION_KEY = "petrina.engine";
const UNSENT_KINDS = new Set<Unsent["kind"]>(["message", "answer", "no", "changes"]);
export const NOTHING_UNSENT: readonly Unsent[] = [];

function isStateSnapshot(value: unknown): value is State {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["now"] === "number" &&
    Array.isArray(candidate["products"]) &&
    Array.isArray(candidate["roles"]) &&
    Array.isArray(candidate["tools"]) &&
    Array.isArray(candidate["profiles"]) &&
    Array.isArray(candidate["tasks"]) &&
    Array.isArray(candidate["inbox"]) &&
    Boolean(candidate["pool"]) &&
    typeof candidate["pool"] === "object"
  );
}

function isWindowStateDelta(value: unknown): value is WindowStateDelta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["now"] === "number" && typeof candidate["seq"] === "number";
}

export function parseServerFrame(raw: string): ServerFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const frame = parsed as Record<string, unknown>;
  if (frame["type"] === "state" && isStateSnapshot(frame["state"])) {
    const stateId = frame["stateId"];
    return {
      type: "state",
      state: frame["state"],
      ...(typeof stateId === "number" ? { stateId } : {}),
    };
  }
  if (
    frame["type"] === "state-delta" &&
    typeof frame["stateId"] === "number" &&
    typeof frame["baseStateId"] === "number" &&
    isWindowStateDelta(frame["delta"])
  ) {
    return {
      type: "state-delta",
      stateId: frame["stateId"],
      baseStateId: frame["baseStateId"],
      delta: frame["delta"],
    };
  }
  if (frame["type"] === "result" && typeof frame["id"] === "number" && typeof frame["ok"] === "boolean") {
    const error = frame["error"];
    return {
      type: "result",
      id: frame["id"],
      ok: frame["ok"],
      result: frame["result"],
      ...(typeof error === "string" ? { error } : {}),
    };
  }
  return undefined;
}

function isUnsentEntry(value: unknown): value is Unsent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["clientId"] === "string" &&
    candidate["clientId"].length > 0 &&
    typeof candidate["taskId"] === "string" &&
    typeof candidate["kind"] === "string" &&
    UNSENT_KINDS.has(candidate["kind"] as Unsent["kind"]) &&
    typeof candidate["text"] === "string" &&
    (candidate["itemId"] === undefined || typeof candidate["itemId"] === "string") &&
    (candidate["refused"] === undefined || typeof candidate["refused"] === "string")
  );
}

export function isSavedUnsentRecord(value: unknown): value is { entry: Unsent; send: { name: string; args: unknown[] } } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const send = record["send"];
  if (!isUnsentEntry(record["entry"]) || !send || typeof send !== "object") return false;
  const call = send as Record<string, unknown>;
  return typeof call["name"] === "string" && call["name"].length > 0 && Array.isArray(call["args"]);
}

export function validAddress(raw: unknown): Address | undefined {
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
export function browserAddress(): Address | undefined {
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

/** The engine's reason when it is plain words; its checks of what was sent are not, so they get a plain line. */
export function plainReason(error: string): string {
  return error.length <= 160 && !/[{}[\]<>"`]/.test(error) ? error : "Petrina's engine could not take it.";
}

/** Why something sent to the engine failed, in one plain sentence. */
export function failureText(failure: unknown): string {
  if (failure instanceof Lost) return "Petrina isn't connected to its engine right now, so try again once it's back.";
  if (failure instanceof Late) return "Petrina's engine didn't answer in time, so try again.";
  return plainReason(failure instanceof Error ? failure.message : String(failure));
}

/** An id for something the window sends, so a resend after a lost reply counts once. */
export function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
