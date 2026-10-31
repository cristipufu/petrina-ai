vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => {
    throw new Error("This presentation test did not request a native notification.");
  };
  return {
    platform: () => "linux",
    browserPermission: () => "unsupported",
    useBrowserPermission: () => "unsupported",
    askBrowser: async () => "unsupported",
    BrowserNotices: class {
      show = unexpected;
      test = unexpected;
      waiting() {}
    },
    shell: {
      show: unexpected,
      test: unexpected,
      badge: unexpected,
      onClick: unexpected,
      onRelaunch: unexpected,
      checkUpdate: unexpected,
      installUpdate: unexpected,
      onUpdateProgress: unexpected,
      restartApp: unexpected,
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: () => {
    throw new Error("This presentation test did not request a native desktop operation.");
  },
}));
import { createDemoState, Simulator } from "@petrina/core";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../src/App";
import {
  autoCheckEnabled,
  configureUpdatesForTest,
  type UpdateInfo,
  type UpdateProgress,
  type UpdateTransport,
} from "../../../src/updates";

let simulator: Simulator;
const live = { link: "live", desktop: false };
const empty: never[] = [];

vi.mock("../../../src/engine", () => ({
  mode: "demo",
  desktop: false,
  startClock: () => () => {},
  useEngineStatus: () => live,
  useUnsent: () => empty,
  useSim: () =>
    useSyncExternalStore(
      (fn) => simulator.subscribe(fn),
      () => simulator.getState(),
    ),
  sim: new Proxy(
    {},
    {
      get: (_, name) =>
        name === "synced"
          ? () => true
          : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args),
    },
  ),
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const RELEASE: UpdateInfo = {
  version: "0.2.0",
  current: "0.1.0",
  notes: "Direct Antigravity CLI sessions and signed desktop updates.",
};

async function mount(path = "/?demo") {
  history.replaceState(null, "", path);
  const state = createDemoState(1_000_000_000_000);
  simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<App />));
}

beforeEach(() => {
  localStorage.clear();
  configureUpdatesForTest();
});

afterEach(async () => {
  configureUpdatesForTest();
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("signed desktop app updates", () => {
  it("stays quiet when up to date, shows rail progress on install, retries failures, and restarts only on click", async () => {
    let progressListener: ((progress: UpdateProgress) => void) | undefined;
    let finishInstall: (() => void) | undefined;
    let failInstall: ((reason: Error) => void) | undefined;
    let restarted = 0;

    const transport: UpdateTransport = {
      supported: true,
      checkUpdate: async () => RELEASE,
      onProgress: async (handler) => {
        progressListener = handler;
        return () => {
          if (progressListener === handler) progressListener = undefined;
        };
      },
      installUpdate: () =>
        new Promise<void>((resolve, reject) => {
          finishInstall = resolve;
          failInstall = reject;
        }),
      restartApp: async () => {
        restarted += 1;
      },
    };
    configureUpdatesForTest(transport);
    await mount("/settings?demo");

    expect(host!.querySelector(".rail-update")).toBeNull();
    const checkBtn = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((btn) =>
      btn.textContent?.includes("Check for updates"),
    )!;
    await act(async () => checkBtn.click());

    const railUpdate = host!.querySelector<HTMLButtonElement>(".rail-update")!;
    expect(railUpdate).not.toBeNull();
    expect(railUpdate.textContent).toBe("Update");
    expect(railUpdate.getAttribute("aria-label")).toContain("Download and install Petrina 0.2.0");
    expect(host!.textContent).toContain("Direct Antigravity CLI sessions and signed desktop updates.");

    // First install attempt reports progress, then fails cleanly with a Retry button.
    await act(async () => {
      railUpdate.click();
    });
    expect(host!.querySelector(".rail-update.busy")?.textContent).toBe("Updating");

    await act(async () => {
      progressListener?.({ downloaded: 35, total: 100 });
    });
    expect(host!.querySelector(".rail-update.busy")?.textContent).toBe("35%");

    await act(async () => {
      failInstall?.(new Error("Connection interrupted"));
    });
    const retryBtn = host!.querySelector<HTMLButtonElement>(".rail-update.failed")!;
    expect(retryBtn.textContent).toBe("Retry");
    expect(host!.textContent).toContain("Connection interrupted");

    // Retry succeeds and waits for an explicit restart click.
    await act(async () => {
      retryBtn.click();
    });
    await act(async () => {
      progressListener?.({ downloaded: 100, total: 100 });
      finishInstall?.();
    });

    expect(restarted).toBe(0);
    const restartBtn = host!.querySelector<HTMLButtonElement>(".rail-update.ready")!;
    expect(restartBtn.textContent).toBe("Restart");
    await act(async () => restartBtn.click());
    expect(restarted).toBe(1);
  });

  it("exposes update actions and daily-check controls in Settings and the command palette", async () => {
    let checked = 0;
    configureUpdatesForTest({
      supported: true,
      checkUpdate: async () => {
        checked += 1;
        return null;
      },
      installUpdate: async () => undefined,
      onProgress: async () => () => undefined,
      restartApp: async () => undefined,
    });
    await mount("/settings?demo");

    const toggle = host!.querySelector<HTMLButtonElement>('[aria-labelledby="updates-auto-name"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(autoCheckEnabled()).toBe(true);

    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(autoCheckEnabled()).toBe(false);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(host!.querySelector("#palette-update-check")?.textContent).toContain("Check for updates");
    expect(host!.querySelector("#palette-update-auto")?.textContent).toContain("Turn daily update checks on");

    await act(async () => host!.querySelector<HTMLElement>("#palette-update-check")!.click());
    expect(checked).toBe(1);
    expect(host!.textContent).toContain("Petrina is up to date");
  });

  it("stays honest in browser tabs where signed desktop updates do not run", async () => {
    configureUpdatesForTest();
    await mount("/settings?demo");
    expect(host!.textContent).toContain("Signed app updates run inside the Petrina desktop app.");
    expect(host!.querySelector('[aria-labelledby="updates-auto-name"]')).toBeNull();
  });
});
