// Runs the notifier for the window: system notifications in the desktop app, browser ones in a
// tab, in-app messages otherwise. Also keeps the icon's count (desktop) or the tab's title
// (browser) equal to the Inbox button's. The demo never sends notifications or sets the icon.

import { useEffect, useRef } from "react";
import { countableInboxItems } from "@petrina/core";
import { desktop, mode, sim } from "../engine";
import { askBrowser, BrowserNotices, browserPermission, platform, shell, type BrowserPermission } from "./channels";
import { Notifier } from "./notifier";
import { getSettings, setNotificationsOn, subscribeSettings } from "./settings";
import type { Notice, Target } from "./words";

/** System or browser notifications for the real squad. The demo's simulated squad never sends them. */
export const realSquad = mode === "engine";

/** Petrina is in front: its window or tab is visible and focused. */
export function inFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** The switch is on, and in a browser the browser allows them. */
export function notificationsOn(): boolean {
  return getSettings().on && (desktop || browserPermission() === "granted");
}

/** Turn notifications on in a browser: the browser asks first. They stay off unless it allows them. */
export async function turnOnInBrowser(): Promise<BrowserPermission> {
  const permission = await askBrowser();
  if (permission === "granted") setNotificationsOn(true);
  return permission;
}

interface Handlers {
  /** A click on a notification (or on View in an in-app message) for this target. */
  onJump: (target: Target) => void;
  /** Show the in-app message. */
  onToast: (notice: Notice) => void;
}

export function useNotices({ onJump, onToast }: Handlers): void {
  const jump = useRef(onJump);
  jump.current = onJump;
  const toast = useRef(onToast);
  toast.current = onToast;

  useEffect(() => {
    const browser = desktop ? undefined : new BrowserNotices((target) => jump.current(target));
    const notifier = new Notifier({
      inFront,
      canNotify: () => realSquad && notificationsOn(),
      show: (notice) => (browser ? browser.show(notice) : shell.show(notice)),
      toast: (notice) => toast.current(notice),
      waiting: (ids) => browser?.waiting(ids),
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    });

    let count = -1;
    const update = () => {
      const state = sim.getState();
      notifier.update(state, sim.synced());
      const visible = countableInboxItems(state.inbox).length;
      if (visible === count) return;
      count = visible;
      // The same number as the Inbox button, with notifications on or off.
      if (desktop) shell.badge(realSquad ? count : 0);
      else document.title = count > 0 ? `(${count}) Petrina` : "Petrina";
    };
    update();
    const unsubscribe = sim.subscribe(update);

    const onFront = () => {
      if (inFront()) notifier.cameToFront();
    };
    window.addEventListener("focus", onFront);
    document.addEventListener("visibilitychange", onFront);
    const unsubscribeSettings = subscribeSettings(() => {
      if (!getSettings().on) notifier.switchedOff();
    });

    const listening: Promise<() => void>[] = [];
    if (desktop && realSquad) {
      listening.push(shell.onClick((target) => jump.current(target)));
      // Windows reports no click from its notification list: it opens Petrina again instead,
      // without saying which notification. Once Petrina has sent one, the inbox opens with
      // nothing selected. Anywhere else, opening Petrina again only brings it forward.
      listening.push(
        shell.onRelaunch(() => {
          if (platform() === "windows" && notifier.sent > 0) jump.current({ kind: "inbox" });
        }),
      );
    }

    return () => {
      unsubscribe();
      unsubscribeSettings();
      window.removeEventListener("focus", onFront);
      document.removeEventListener("visibilitychange", onFront);
      for (const stop of listening) void stop.then((unlisten) => unlisten()).catch(() => undefined);
      notifier.dispose();
    };
  }, []);
}
