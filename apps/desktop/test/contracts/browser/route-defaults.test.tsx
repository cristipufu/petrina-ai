import { describe, expect, it } from "vitest";
import { readRoute, routeHref } from "../../../src/routes";
const at = (path: string) => readRoute(new URL(path, "http://localhost:1430"));

describe("addresses", () => {
  it("restores the exact original check attempt and removes it when leaving the step", () => {
    const route = at("/tasks/pricing-refresh?demo&node=j3&attempt=run-2");
    expect(route.sheet?.attemptId).toBe("run-2");
    expect(at(routeHref(route))).toEqual(route);
    expect(routeHref({ view: "products", product: "all" }, "?demo&node=j3&attempt=run-2")).toBe("/products?demo=");
  });
});
