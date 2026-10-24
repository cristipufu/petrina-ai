import { expect, it } from "vitest";
import { prNumber } from "../../../src/source.js";

it.each(["7", "#7", "https://github.com/acme/shop/pull/7", "https://github.com/ACME/SHOP/pull/7/", "https://github.com/acme/shop/pull/7?tab=files#diff"])("reads an exact reference: %s", value => {
  expect(prNumber(value, "acme/shop")).toBe(7);
});

it.each(["", "0", "-1", "1.5", "7 extra", "9007199254740992", "https://example.com/acme/shop/pull/7", "https://github.com/acme/shop/issues/7"])("rejects an invalid reference: %s", value => {
  expect(() => prNumber(value, "acme/shop")).toThrow("Enter a pull request number");
});

it("rejects another repository's reference before any remote work", () => {
  expect(() => prNumber("https://github.com/someone/other/pull/7", "acme/shop")).toThrow("That pull request belongs to someone/other, not acme/shop");
});
