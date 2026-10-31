// Where notifications go. In the desktop app the shell shows them as system notifications, sets
// the icon's count and reports clicks. In a browser tab they are the browser's own, once allowed.

import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TEST_NOTICE, type Notice, type Target } from "./words";

export type Platform = "mac" | "windows" | "linux";

export interface UpdateInfo {
  readonly version: string;
  readonly current: string;
  readonly notes: string | null;
}

export interface UpdateProgress {
  readonly downloaded: number;
  readonly total: number | null;
}

export function platform(): Platform {
  const agent = navigator.userAgent;
  if (/Windows/i.test(agent)) return "windows";
  if (/Mac/i.test(agent)) return "mac";
  return "linux";
}

/** A click the shell reports, read carefully: anything but a known item opens the inbox only. */
function readTarget(raw: unknown): Target {
  const value = raw as { kind?: unknown; id?: unknown } | null;
  return value?.kind === "item" && typeof value.id === "string" && value.id ? { kind: "item", id: value.id } : { kind: "inbox" };
}

/** The desktop app's shell. */
export const shell = {
  /** False when Petrina is in front and the window should show its own message instead. */
  show(notice: Notice): Promise<boolean> {
    return invoke<boolean>("notify", { title: notice.title, body: notice.lines.join("\n"), target: notice.target, test: false });
  },
  test(): Promise<boolean> {
    return invoke<boolean>("notify", { title: TEST_NOTICE.title, body: TEST_NOTICE.lines.join("\n"), target: { kind: "app" }, test: true });
  },
  /** The count on the Dock or taskbar icon. Zero removes it. */
  badge(count: number): void {
    void invoke("set_badge", { count }).catch(() => undefined);
  },
  onClick(handler: (target: Target) => void): Promise<() => void> {
    return listen("notification-clicked", (event) => handler(readTarget(event.payload)));
  },
  /** Petrina was opened again (by hand, or by the system for a notification) and came forward. */
  onRelaunch(handler: () => void): Promise<() => void> {
    return listen("relaunched", () => handler());
  },
  checkUpdate(): Promise<UpdateInfo | null> {
    return invoke<UpdateInfo | null>("check_update");
  },
  installUpdate(): Promise<void> {
    return invoke<void>("install_update");
  },
  onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<() => void> {
    return listen<UpdateProgress>("update-progress", (event) => handler(event.payload));
  },
  restartApp(): Promise<void> {
    return invoke<void>("restart_app");
  },
};

export type BrowserPermission = NotificationPermission | "unsupported";

export function browserPermission(): BrowserPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Browsers only ask right after a click, so this runs from one. */
export async function askBrowser(): Promise<BrowserPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    await Notification.requestPermission();
  } catch {
    // Older browsers take a callback instead; what they decided shows in the permission below.
  }
  permissionChanged();
  return browserPermission();
}

const permissionListeners = new Set<() => void>();
let watching = false;

function permissionChanged(): void {
  for (const listener of permissionListeners) listener();
}

/** The browser's permission, kept current when it changes in the browser's own settings. */
function subscribePermission(listener: () => void): () => void {
  permissionListeners.add(listener);
  if (!watching && !isTauri()) {
    watching = true;
    window.addEventListener("focus", permissionChanged);
    document.addEventListener("visibilitychange", permissionChanged);
    void navigator.permissions
      ?.query({ name: "notifications" })
      .then((status) => status.addEventListener("change", permissionChanged))
      .catch(() => undefined);
  }
  return () => {
    permissionListeners.delete(listener);
  };
}

export function useBrowserPermission(): BrowserPermission {
  return useSyncExternalStore(subscribePermission, browserPermission);
}

/** The browser's notifications. One goes away once its items are handled; a test stays. */
export class BrowserNotices {
  private readonly open = new Map<Notification, readonly string[]>();

  constructor(private readonly onClick: (target: Target) => void) {}

  show(notice: Notice): boolean {
    const shown = this.make(notice);
    if (!shown) return false;
    this.open.set(shown, notice.itemIds);
    shown.onclick = () => {
      window.focus();
      shown.close();
      this.open.delete(shown);
      this.onClick(notice.target);
    };
    shown.onclose = () => this.open.delete(shown);
    return true;
  }

  /** Close what was handled: an item's own notification, or a summary once all of its items are. */
  waiting(ids: ReadonlySet<string>): void {
    for (const [shown, items] of this.open) {
      if (items.every((id) => !ids.has(id))) {
        shown.close();
        this.open.delete(shown);
      }
    }
  }

  private make(notice: Pick<Notice, "title" | "lines">): Notification | undefined {
    if (browserPermission() !== "granted") return undefined;
    try {
      return new Notification(notice.title, { body: notice.lines.join("\n"), icon: "/icon.svg" });
    } catch {
      // Some browsers only show notifications from a service worker.
      return undefined;
    }
  }

  test(): boolean {
    const shown = this.make(TEST_NOTICE);
    if (shown) shown.onclick = () => window.focus();
    return shown !== undefined;
  }
}
