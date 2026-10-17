// The notification switch and the inbox's one-time offer, remembered on this device: the desktop
// app and each browser keep their own. Notifications are on by default in the desktop app and off
// in a browser until the coordinator turns them on (the browser asks for permission then).

import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";

const SWITCH_KEY = "petrina.notifications";
const OFFER_KEY = "petrina.notifications.offer";

export interface NotifySettings {
  /** The coordinator's choice. In a browser it only counts while the browser allows notifications. */
  on: boolean;
  /** The inbox's offer to turn on browser notifications was answered or dismissed. */
  offerDone: boolean;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the choice lasts until the window closes.
  }
}

const listeners = new Set<() => void>();
let current: NotifySettings | undefined;

export function getSettings(): NotifySettings {
  if (!current) {
    const saved = read(SWITCH_KEY);
    current = { on: saved === null ? isTauri() : saved === "on", offerDone: read(OFFER_KEY) === "done" };
  }
  return current;
}

function change(next: Partial<NotifySettings>): void {
  current = { ...getSettings(), ...next };
  for (const listener of listeners) listener();
}

export function setNotificationsOn(on: boolean): void {
  write(SWITCH_KEY, on ? "on" : "off");
  // Turning them on, from anywhere, answers the inbox's offer too.
  if (on) write(OFFER_KEY, "done");
  change(on ? { on, offerDone: true } : { on });
}

export function finishOffer(): void {
  write(OFFER_KEY, "done");
  change({ offerDone: true });
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNotifySettings(): NotifySettings {
  return useSyncExternalStore(subscribeSettings, getSettings);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The test from Settings, after `delay` (on a Mac, which shows no banner for the app in front).
 * If notifications are switched off meanwhile, here or after leaving Settings and coming back,
 * nothing goes out.
 */
export async function sendTest(send: () => Promise<unknown>, delay: number, wait: (ms: number) => Promise<void> = sleep): Promise<"sent" | "off"> {
  if (delay > 0) await wait(delay);
  if (!getSettings().on) return "off";
  await send();
  return "sent";
}
