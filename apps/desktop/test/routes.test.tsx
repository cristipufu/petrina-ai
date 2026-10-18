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
    expect(at("/settings/products/shop")).toEqual({ view: "settings", product: "all", productSettings: "shop" });
    expect(routeHref(at("/tasks/task%20%2F%201/design?from=analytics&product=shop"), "?demo")).toBe("/tasks/task%20%2F%201/design?demo=&product=shop&from=analytics");
  });
  it("gives unknown or malformed addresses a recoverable missing page", () => {
    for (const path of ["/other", "/tasks", "/tasks/1/wrong", "/tasks/1/plan/extra", "/settings/products/shop/extra", "/tasks/%E0%A4%A"]) expect(at(path).missing).toBe(path);
  });
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
