// Signed desktop app updates: quiet daily checks, on-demand download with progress, and restart
// only when the coordinator chooses. Browser tabs stay honest that updates belong to the app.

import { useSyncExternalStore } from "react";
import { desktop, mode } from "./engine";
import { shell, type UpdateInfo, type UpdateProgress } from "./notify/channels";

export type { UpdateInfo, UpdateProgress };

const AUTO_KEY = "petrina.updates.auto";
const LAST_KEY = "petrina.updates.lastCheck";
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 8_000;
const TICK_MS = 60 * 60 * 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking"; manual: boolean }
  | { status: "available"; info: UpdateInfo }
  | { status: "downloading"; info: UpdateInfo; progress: number | null }
  | { status: "ready"; info: UpdateInfo }
  | { status: "failed"; info: UpdateInfo; error: string };

export interface UpdateTransport {
  readonly supported: boolean;
  checkUpdate(): Promise<UpdateInfo | null>;
  installUpdate(): Promise<void>;
  onProgress(handler: (progress: UpdateProgress) => void): Promise<() => void>;
  restartApp(): Promise<void>;
}

const DEMO_UPDATE_INFO: UpdateInfo = {
  version: "0.2.0",
  current: "0.1.0",
  notes: "Direct Antigravity CLI sessions, standalone terminal command and signed updates.",
};

function isDemoUpdatePreview(): boolean {
  if (desktop || mode !== "demo" || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("demo-update");
}

function defaultTransport(): UpdateTransport {
  if (desktop) {
    return {
      supported: true,
      checkUpdate: () => shell.checkUpdate(),
      installUpdate: () => shell.installUpdate(),
      onProgress: (handler) => shell.onUpdateProgress(handler),
      restartApp: () => shell.restartApp(),
    };
  }
  if (isDemoUpdatePreview()) {
    let progressHandler: ((progress: UpdateProgress) => void) | undefined;
    return {
      supported: true,
      checkUpdate: async () => DEMO_UPDATE_INFO,
      onProgress: async (handler) => {
        progressHandler = handler;
        return () => {
          if (progressHandler === handler) progressHandler = undefined;
        };
      },
      installUpdate: async () => {
        progressHandler?.({ downloaded: 50, total: 100 });
        await new Promise((resolve) => setTimeout(resolve, 120));
        progressHandler?.({ downloaded: 100, total: 100 });
      },
      restartApp: async () => {
        set({ status: "idle" });
      },
    };
  }
  return {
    supported: false,
    checkUpdate: async () => null,
    installUpdate: async () => undefined,
    onProgress: async () => () => undefined,
    restartApp: async () => undefined,
  };
}

let transport: UpdateTransport = defaultTransport();
let state: UpdateState = isDemoUpdatePreview() ? { status: "available", info: DEMO_UPDATE_INFO } : { status: "idle" };
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function set(next: UpdateState): void {
  state = next;
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUpdateState(): UpdateState {
  return state;
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(subscribe, getUpdateState);
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private browsing or blocked storage leaves the session's default in memory.
  }
}

export function autoCheckEnabled(): boolean {
  return readStorage(AUTO_KEY) !== "off";
}

export function useAutoCheck(): boolean {
  return useSyncExternalStore(subscribe, autoCheckEnabled);
}

export function setAutoCheck(on: boolean): void {
  writeStorage(AUTO_KEY, on ? null : "off");
  notifyListeners();
}

export function updatesSupported(): boolean {
  return transport.supported;
}

export async function checkForUpdates(
  manual: boolean,
  onToast?: (title: string, detail?: string) => void,
): Promise<void> {
  if (!transport.supported) {
    if (manual) onToast?.("Updates apply to the desktop app", "This browser tab loads Petrina from your local engine.");
    return;
  }
  if (state.status === "downloading" || state.status === "ready") {
    if (manual) {
      onToast?.(
        state.status === "ready"
          ? `Restart to finish updating to ${state.info.version}`
          : `Downloading Petrina ${state.info.version}…`,
      );
    }
    return;
  }
  if (state.status === "checking") return;
  const previous = state;
  set({ status: "checking", manual });
  try {
    const info = await transport.checkUpdate();
    if (info) {
      set({ status: "available", info });
      if (manual) onToast?.(`Petrina ${info.version} is available`, "Use Update in the left rail or Settings when ready.");
    } else {
      writeStorage(LAST_KEY, String(Date.now()));
      set({ status: "idle" });
      if (manual) onToast?.("Petrina is up to date");
    }
  } catch (error) {
    set(previous);
    if (manual) onToast?.("Couldn't check for updates", errorText(error));
  }
}

export async function installUpdate(): Promise<void> {
  if (!transport.supported) return;
  if (state.status !== "available" && state.status !== "failed") return;
  const { info } = state;
  set({ status: "downloading", info, progress: null });
  const stopListening = await transport.onProgress((progress) => {
    if (state.status === "downloading") {
      set({
        status: "downloading",
        info,
        progress: progress.total && progress.total > 0 ? Math.min(1, progress.downloaded / progress.total) : null,
      });
    }
  });
  try {
    await transport.installUpdate();
    set({ status: "ready", info });
  } catch (error) {
    set({ status: "failed", info, error: errorText(error) });
  } finally {
    stopListening();
  }
}

export async function restartToUpdate(): Promise<void> {
  if (!transport.supported || state.status !== "ready") return;
  await transport.restartApp();
}

export function startUpdateChecks(): () => void {
  if (!transport.supported || isDemoUpdatePreview()) return () => undefined;
  const due = () => autoCheckEnabled() && Date.now() - Number(readStorage(LAST_KEY) ?? 0) >= DAY_MS;
  const run = () => {
    if (due()) void checkForUpdates(false);
  };
  const first = setTimeout(run, FIRST_CHECK_MS);
  const tick = setInterval(run, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(tick);
  };
}

export function configureUpdatesForTest(nextTransport?: UpdateTransport, nextState: UpdateState = { status: "idle" }): void {
  transport = nextTransport ?? defaultTransport();
  set(nextState);
}
