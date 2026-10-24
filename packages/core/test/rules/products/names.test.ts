import { describe, expect, it } from "vitest";
import { productName, suggestProductName } from "../../../src/products.js";
import { productState as state } from "../../fixtures/products.js";

describe("product names and settings", () => {
  it("suggests a name from the folder, preserving written capitals and common abbreviations", () => {
    for (const [path, name] of [
      ["/code/petrina-ai/", "Petrina AI"], ["C:\\code\\shop_api", "Shop API"], ["some-ui-ux-cli-sdk", "Some UI UX CLI SDK"],
      ["/code/my-iPhone-aPi", "My iPhone aPi"], [" /code/petrina_ai ", "Petrina AI"], ["", ""],
    ]) expect(suggestProductName(path!)).toBe(name);
  });

  it("trims names, refuses duplicates regardless of case, and enforces one line and 60 characters", () => {
    expect(productName("  New name  ", state().products)).toBe("New name");
    expect(productName("Petrina AI", state().products, "p")).toBe("Petrina AI");
    expect(productName("a".repeat(60), [])).toHaveLength(60);
    for (const name of ["", "  ", "a".repeat(61), "one\ntwo", "one\rtwo", "one\u2028two", "one\u2029two"]) expect(() => productName(name, [])).toThrow();
    expect(() => productName("shop api", state().products)).toThrow("Another product is already called Shop API.");
  });

});
