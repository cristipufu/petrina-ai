import { expect, it } from "vitest";
import { commandInputText } from "../../../src/check-commands.js";
import { configureProductChecks, type ProductCheckSettingWork } from "../../../src/products.js";
import type { DeepMutable } from "../../../src/flow.js";
import type { Product, RepositoryState } from "../../../src/model.js";

it("saves literal check arguments and changes only matching executions' current marker", () => {
  const product: DeepMutable<Product> = { id: "p", name: "Product", repo: "local/product", tone: "blue", checksBy: "finder", checksFingerprint: "prior-definition", checksSeen: [{ fingerprint: "seen-definition", checks: [] }] };
  const work: ProductCheckSettingWork & Pick<RepositoryState, "checkReturns" | "approvedSha"> = { productId: "p", checkReturns: 2, approvedSha: "coordinator-choice", checks: { at: 1, current: true, results: [{ name: "Earlier", command: "prior", ok: false, ms: 1, output: "saved failure" }] } };
  const other: ProductCheckSettingWork = { productId: "q", checks: { at: 2, current: true, results: [] } };
  const before: typeof work = JSON.parse(JSON.stringify(work)), untouched: typeof other = JSON.parse(JSON.stringify(other));
  const argv = [String.raw`C:\Users\O'Neil\Program Files\tool.exe`, "", `both 'single' and "double"`, "line one\nline two", String.raw`literal\n`];
  configureProductChecks(product, [{ name: "  Owner's: checks\nsecond line  ", command: commandInputText(argv) }], [work, other]);
  expect(product.checks).toEqual([{ name: "Owner's: checks\nsecond line", argv }]);
  expect(product.checksBy).toBe("coordinator");
  expect(product.checksFingerprint).toBeUndefined();
  expect(product.checksSeen).toEqual([{ fingerprint: "seen-definition", checks: [] }]);
  expect(work).toEqual({ ...before, checks: { ...before.checks!, current: false } });
  expect(other).toEqual(untouched);
});

it("clears declared checks for discovery without discarding recorded outcomes", () => {
  const product: DeepMutable<Product> = { id: "p", name: "Product", repo: "local/product", tone: "blue", checks: [{ name: "Tests", argv: ["program"] }], checksBy: "coordinator", checksFingerprint: "definition", checksSeen: [{ fingerprint: "seen", checks: [] }] };
  const work: ProductCheckSettingWork & Pick<RepositoryState, "checkReturns" | "approvedSha"> = { productId: "p", checks: { at: 1, current: true, results: [] }, checkReturns: 2 };
  const before: typeof work = JSON.parse(JSON.stringify(work));
  configureProductChecks(product, null, [work]);
  expect(product).toEqual({ id: "p", name: "Product", repo: "local/product", tone: "blue" });
  expect(work).toEqual({ ...before, checks: { ...before.checks!, current: false } });
});

it("keeps the existing missing-product and empty-definition errors", () => {
  const executions = { *[Symbol.iterator](): IterableIterator<never> { throw new Error("No missing product may visit executions"); } };
  expect(() => configureProductChecks(undefined, [], executions)).toThrow("This product is no longer in Petrina");
  const product: DeepMutable<Product> = { id: "p", name: "Product", repo: "local/product", tone: "blue" };
  expect(() => configureProductChecks(product, [{ name: "", command: "" }], [])).toThrow("Give at least one check");
  expect(product).toEqual({ id: "p", name: "Product", repo: "local/product", tone: "blue" });
});

it("rejects empty declarations before touching any product or execution", () => {
  const product: DeepMutable<Product> = { id: "p", name: "Product", repo: "local/product", tone: "blue", checks: [{ name: "Earlier", argv: ["program"] }], checksBy: "finder", checksFingerprint: "definition", checksSeen: [{ fingerprint: "seen", checks: [] }] };
  const matching: ProductCheckSettingWork = { productId: "p", checks: { at: 1, current: true, results: [] } };
  const other: ProductCheckSettingWork = { productId: "q", checks: { at: 2, current: true, results: [] } };
  const before = JSON.stringify({ product, matching, other });
  let visited = 0;
  const works = { *[Symbol.iterator]() { visited++; yield matching; yield other; } };
  for (const rejected of [[], [{ name: "", command: "program" }], [{ name: "Empty", command: "" }]]) {
    expect(() => configureProductChecks(product, rejected, works)).toThrow("Give at least one check");
    expect(JSON.stringify({ product, matching, other })).toBe(before);
    expect(visited).toBe(0);
  }
});
