import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, Simulator } from "@petrina/core";
import { App } from "../src/App";
import { PAGE_NAMES, readRoute, routeHref, type AppRoute } from "../src/routes";

let simulator: Simulator;
const live = { link: "live", desktop: false };
const empty: never[] = [];
vi.mock("../src/engine", () => ({
  mode: "demo", desktop: false, startClock: () => () => {},
  useEngineStatus: () => live, useUnsent: () => empty,
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => simulator.getState()),
  sim: new Proxy({}, { get: (_, name) => name === "synced" ? () => true : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; });
const at = (path: string) => readRoute(new URL(path, "http://localhost:1430"));

describe("addresses", () => {
  it("addresses all Library views while preserving product scope and demos", () => {
    for (const libraryView of ["routines", "roles", "profiles"] as const) {
      const route: AppRoute = { view: "library", product: "shop", libraryView };
      const href = routeHref(route, "?demo=portfolio");
      expect(at(href)).toEqual(route);
      expect(href).toContain("demo=portfolio");
    }
  });
  it("round-trips every main page and preserves demo and product scope", () => {
    for (const view of Object.keys(PAGE_NAMES) as AppRoute["view"][]) {
      const route: AppRoute = { view, product: "shop" };
      const href = routeHref(route, "?demo=portfolio");
      expect(at(href)).toEqual(route);
      expect(new URL(href, "http://localhost").searchParams.get("demo")).toBe("portfolio");
    }
  });
  it("restores task tabs, the background page, and product settings from a direct link", () => {
    expect(at("/tasks/task%20%2F%201/design?from=analytics&product=shop")).toEqual({ view: "analytics", product: "shop", sheet: { taskId: "task / 1", tab: "design", list: undefined } });
    expect(at("/tasks/guest-checkout").sheet).toEqual({ taskId: "guest-checkout", tab: "overview", list: "board" });
    expect(at("/products/shop/settings")).toEqual({ view: "products", product: "all", productSettings: "shop" });
    expect(at("/settings/products/shop")).toEqual(at("/products/shop/settings"));
    expect(routeHref(at("/settings/products/shop"), "?demo")).toBe("/products/shop/settings?demo=");
    expect(routeHref(at("/tasks/task%20%2F%201/design?from=analytics&product=shop"), "?demo")).toBe("/tasks/task%20%2F%201/design?demo=&product=shop&from=analytics");
  });
  it("round-trips a selected node without carrying it to other pages", () => {
    const route = at("/tasks/guest-checkout?node=step%20%2F%202&demo=portfolio&from=agents");
    expect(route.sheet?.stepId).toBe("step / 2");
    const href = routeHref(route, "?demo=portfolio&node=old");
    expect(at(href)).toEqual(route);
    expect(routeHref({ view: "products", product: "all" }, "?demo&node=old")).toBe("/products?demo=");
  });
  it("keeps History's current page and search in task and node links without an expanding cursor trail", () => {
    const route: AppRoute = { view: "history", product: "shop", history: { cursor: "older page", query: "account export", previous: ["", "previous page"] }, sheet: { taskId: "finished", tab: "overview", list: "history", stepId: "build-2" } };
    const href = routeHref(route, "?demo=portfolio");
    expect(at(href)).toEqual({ ...route, history: { cursor: "older page", query: "account export" } });
    expect(href).not.toContain("previous");
    expect(routeHref({ view: "board", product: "all" }, href.slice(href.indexOf("?")))).toBe("/?demo=portfolio");
  });
  it("gives unknown or malformed addresses a recoverable missing page", () => {
    for (const path of ["/other", "/tasks", "/tasks/1/wrong", "/tasks/1/plan/extra", "/settings/products/shop/extra", "/tasks/%E0%A4%A"]) expect(at(path).missing).toBe(path);
  });
});

it("gives the routine editor the keyboard ahead of page shortcuts and returns focus", async () => {
  await mount("/library/routines?demo");
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
  it("edits a product in the existing portfolio row and keeps app settings separate", async () => {
    await mount("/products?demo");
    const products = simulator.getState().products.length;
    expect(host!.querySelectorAll(".product-pick")).toHaveLength(products);
    expect(host!.querySelector(".setting-list")).toBeNull();
    await click('[data-product-settings="shop"]');
    expect(location.pathname).toBe("/products/shop/settings");
    const editor = host!.querySelector("#product-editor-shop")!;
    expect(editor.closest("tr")?.previousElementSibling?.querySelector(".product-pick")?.textContent).toBe("Shop");
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
