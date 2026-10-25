vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, Simulator } from "@petrina/core";
import { App } from "../../../src/App";

let simulator: Simulator;

const live = { link: "live", desktop: false };

const empty: never[] = [];

vi.mock("../../../src/engine", () => ({
  mode: "demo", desktop: false, startClock: () => () => {},
  useEngineStatus: () => live, useUnsent: () => empty,
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => simulator.getState()),
  sim: new Proxy({}, { get: (_, name) => name === "synced" ? () => true : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));

let root: Root | undefined;

let host: HTMLDivElement | undefined;

afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; });

it("gives the routine editor the keyboard ahead of page shortcuts and returns focus", async () => {
  await mount("/routines?demo");
  const add = [...host!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Add a routine"))!;
  add.focus();
  await act(async () => add.click());
  expect(host!.querySelector(".routine-panel")).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(host!.querySelector(".routine-panel")).toBeNull();
  expect(document.activeElement).toBe(add);
});

async function mount(path: string) {
  history.replaceState(null, "", path);
  const state = createDemoState(1_000_000_000_000);
  simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<App />));
}

async function click(selector: string) { await act(async () => host!.querySelector<HTMLElement>(selector)!.click()); }

describe("navigation in the app", () => {
  it("opens a linked node, records selection and deselection, and restores it through history", async () => {
    const state = createDemoState(1_000_000_000_000);
    const steps = state.tasks.find((task) => task.id === "guest-checkout")!.journey!;
    const step = steps.find((item) => item.roleId === "architect")!;
    const path = `/tasks/guest-checkout?demo&node=${encodeURIComponent(step.id)}`;
    await mount(path);
    expect(host!.querySelector("#journey-details-title")?.textContent).toContain("Architect");
    await click(".step-panel-bar button");
    expect(new URL(location.href).searchParams.has("node")).toBe(false);
    expect(host!.querySelector("#journey-details-title")).toBeNull();
    const other = steps.findIndex((item) => item.roleId === "design-reviewer");
    await act(async () => host!.querySelectorAll<HTMLElement>(".journey-list li")[other]!.click());
    expect(new URL(location.href).searchParams.get("node")).toBe(steps[other]!.id);
    await act(async () => { history.replaceState(null, "", path); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(host!.querySelector("#journey-details-title")?.textContent).toContain("Architect");
    await click(".step-panel-bar button");
    await click("#tab-plan");
    expect(location.pathname).toBe("/tasks/guest-checkout/plan");
    expect(new URL(location.href).searchParams.has("node")).toBe(false);
  });

  it("edits a product in the shared side panel and keeps app settings separate", async () => {
    await mount("/products?demo");
    const products = simulator.getState().products.length;
    expect(host!.querySelectorAll(".product-pick")).toHaveLength(products);
    expect(host!.querySelector(".setting-list")).toBeNull();
    await click('[data-product-settings="shop"]');
    expect(location.pathname).toBe("/products/shop/settings");
    const editor = host!.querySelector("#product-editor-shop")!;
    expect(editor.closest("table")).toBeNull();
    expect(editor.matches(".editor-panel[role=dialog]")).toBe(true);
    expect(host!.querySelectorAll(".product-pick")).toHaveLength(products);
    const input = editor.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Shop updated");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!;
    await act(async () => save.click());
    expect(simulator.getState().products.find((product) => product.id === "shop")!.name).toBe("Shop updated");
    expect(location.pathname).toBe("/products");
    expect(document.activeElement).toBe(host!.querySelector('[data-product-settings="shop"]'));
    await click('[data-product-settings="shop"]');
    await act(async () => host!.querySelector<HTMLInputElement>('#product-editor-shop input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(host!.querySelector('#product-editor-shop')).toBeNull();
    expect(location.pathname).toBe("/products");
    await click('.rail a[href^="/settings"]');
    expect(host!.querySelector(".settings-page")).not.toBeNull();
    expect(host!.querySelector(".product-editor, #settings-products")).toBeNull();
  });

  it("opens product settings by address and reserves shortcuts for the modal", async () => {
    await mount("/products/shop/settings?demo");
    expect(host!.querySelector(".editor-panel")?.getAttribute("id")).toBe("product-editor-shop");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true })));
    expect(host!.querySelector(".command-palette")).toBeNull();
    expect(location.pathname).toBe("/products/shop/settings");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host!.querySelector(".editor-panel")).toBeNull();
    expect(location.pathname).toBe("/products");
    expect(document.activeElement).toBe(host!.querySelector('[data-product-settings="shop"]'));
  });

  it("keeps navigation shortcuts available when a product settings address is missing", async () => {
    await mount("/products/missing/settings?demo");
    expect(host!.querySelector(".editor-panel")).toBeNull();
    expect(host!.textContent).toContain("This link is unavailable.");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true })));
    expect(host!.querySelector(".command-palette")).not.toBeNull();
  });

  it("keeps review outcomes and usage in Analytics, leaving Agents focused on the pool", async () => {
    await mount("/agents?demo");
    expect(host!.textContent).not.toContain("How reviews are going");
    expect(host!.querySelector(".usage-list, .limit-card, .kpis")).toBeNull();
    expect(host!.textContent).toContain("Tools on this machine");
    await click('.rail a[title="Library (L)"]');
    expect(host!.textContent).not.toContain("Tools on this machine");
    await click('.rail a[title="Analytics"]');
    expect(host!.querySelector("#analytics-reviews")?.textContent).toBe("How reviews are going");
    expect(host!.querySelector(".limit-card")).not.toBeNull();
  });

  it("opens a bookmarked task tab and follows task and tab navigation in the address", async () => {
    await mount("/tasks/guest-checkout/design?demo");
    expect(host!.querySelector(".sheet-title")?.textContent).toBe("Guest checkout");
    expect(host!.querySelector("#tab-design")?.getAttribute("aria-selected")).toBe("true");
    await click("#tab-plan");
    expect(location.pathname).toBe("/tasks/guest-checkout/plan");
    await click('.task-list-item:not([aria-current="true"])');
    expect(location.pathname).toMatch(/^\/tasks\//);
    expect(location.pathname).not.toContain("guest-checkout");
    expect(location.search).toContain("demo");
  });

  it("follows browser history without turning it into a new navigation", async () => {
    await mount("/analytics?demo&product=shop");
    expect(host!.querySelector(".analytics")).not.toBeNull();
    await click('.rail a[title="Products"]');
    expect(location.pathname).toBe("/products");
    const entries = history.length;
    await act(async () => { history.replaceState(null, "", "/analytics?demo&product=shop"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(host!.querySelector(".analytics")).not.toBeNull();
    expect(host!.querySelector('.rail a[aria-current="page"]')?.textContent).toBe("Analytics");
    expect(history.length).toBe(entries);
  });

  it("recovers missing tasks and unknown pages through the navigation", async () => {
    for (const path of ["/tasks/removed", "/not-a-page"]) {
      if (root) { await act(async () => root!.unmount()); host!.remove(); }
      await mount(path);
      expect(host!.querySelector(".route-missing")?.textContent).toContain("This link is unavailable");
      await click('.rail a[title="Products"]');
      expect(location.pathname).toBe("/products");
      expect(host!.querySelector(".route-missing")).toBeNull();
      expect(host!.querySelector(".portfolio")).not.toBeNull();
    }
  });
});

it("opens Routines as a first-party page and keeps Library focused on roles and profiles", async () => {
  await mount("/routines?demo=portfolio&product=shop");
  expect(host!.querySelector('.rail a[aria-current="page"]')?.textContent).toBe("Routines");
  expect([...host!.querySelectorAll(".rail a")].map(node => node.getAttribute("title"))).toEqual(["Board (B)", "History", "Agents (A)", "Analytics", "Products", "Routines", "Library (L)", expect.stringContaining("Settings")]);
  expect(host!.querySelector(".library-views")).toBeNull();
  await click('.rail a[title="Library (L)"]');
  expect([...host!.querySelectorAll(".library-views a")].map(node => node.textContent)).toEqual(["Roles", "Profiles"]);
  expect(window.location.search).toContain("product=shop");
  await click('.rail a[title="Routines"]');
  expect(window.location.pathname).toBe("/routines");
  await click(".switcher"); await click(".switcher-list > .switcher-row");
  expect(window.location.pathname).toBe("/routines");
  expect(new URL(window.location.href).searchParams.has("product")).toBe(false);
});
