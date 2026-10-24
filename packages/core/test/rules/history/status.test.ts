import { describe, expect, it } from "vitest";
import { historyStatus, type HistoryItem, type HistoryStatus } from "../../../src/history.js";

const base: HistoryItem = { id: "task", productId: "shop", title: "Maintenance", kind: "chore", state: "done", createdAt: 1, delivery: "local", statusLine: "Finished" };
const landed = { branch: "main", sha: "abc" };
const pr = { number: 1, url: "https://github.com/acme/shop/pull/1", state: "merged" as const, openedAt: 1 };
const release = { tag: "v1.0.0", url: "https://github.com/acme/shop/releases/tag/v1.0.0", sha: "abc", publishedAt: 1 };

describe("final task outcomes", () => {
  const cases: [HistoryStatus, Partial<HistoryItem>][] = [
    ["marked-done", {}], ["committed", { landed }], ["released", { landed, release }],
    ["merged", { pr }], ["closed", { pr: { ...pr, state: "closed" } }],
    ["cancelled", { state: "cancelled", landed }], ["combined", { state: "cancelled", combinedInto: "combined-task" }],
    ["no-changes", { maintenance: { noProductChanges: true } }],
    ["committed", { deliveries: [{ productId: "shop", delivery: "local", landed }, { productId: "billing", delivery: "local", nothingToPublish: true }] }],
    ["mixed", { landed, deliveries: [{ productId: "shop", delivery: "local", landed }, { productId: "billing", delivery: "pull-request", pr }] }],
    ["no-changes", { deliveries: [{ productId: "shop", delivery: "local", nothingToPublish: true }] }],
  ];
  for (const [expected, changes] of cases) it(`classifies ${expected}: ${JSON.stringify(changes)}`, () => { expect(historyStatus({ ...base, ...changes })).toBe(expected); expect(historyStatus(JSON.parse(JSON.stringify({ ...base, ...changes })))).toBe(expected); });
});
