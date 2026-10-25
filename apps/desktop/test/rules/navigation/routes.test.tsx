// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PAGE_NAMES, readRoute, routeHref, type AppRoute } from "../../../src/route-codec";

const at = (path: string) => readRoute(new URL(path, "http://localhost:1430"));

describe("addresses", () => {
  it("addresses all Library views while preserving product scope and demos", () => {
    for (const libraryView of ["roles", "profiles"] as const) {
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

it("round-trips routine runs and their task links with independent History navigation", () => {
  const route: AppRoute = { view: "routines", product: "shop", routineRuns: { id: "routine / daily", history: { status: "cancelled", cursor: "older", query: "check" } } };
  expect(at(routeHref(route, "?demo=portfolio"))).toEqual(route);
  const task: AppRoute = { ...route, sheet: { taskId: "run", tab: "overview", list: "history", stepId: "j2" } };
  expect(at(routeHref(task, "?demo=portfolio"))).toEqual(task);
  expect(routeHref({ view: "history", product: "all" }, "?routine=old&historyCursor=old&demo")).toBe("/history?demo=");
  expect(at("/routines/one/runs/extra").missing).toBeDefined();
});

it("round-trips a final History status and ignores invalid filter bookmarks", () => {
  const route: AppRoute = { view: "history", product: "shop", history: { status: "committed", query: "fix" }, sheet: { taskId: "finished", tab: "overview", list: "history" } };
  expect(at(routeHref(route, '?demo'))).toEqual(route);
  expect(at('/history?historyStatus=unknown')).toEqual({ view: "history", product: "all" });
  expect(routeHref({ view: "board", product: "all" }, '?demo&historyStatus=cancelled')).toBe('/?demo=');
});
