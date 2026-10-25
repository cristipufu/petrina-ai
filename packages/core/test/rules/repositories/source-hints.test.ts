import { expect, it } from "vitest";
import { hintProducts } from "../../../src/repositories.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

it("limits source hints to retained approved products in their approved order", () => {
  const task = taskFixture(stateFixture(), { repositories: ["billing", "shop", "gone"].map(productId => ({ productId, delivery: "local", completedStages: [], ...(productId === "gone" ? { removed: true } : {}) })) });
  expect(hintProducts(task)).toEqual(["billing", "shop"]);
});

it("keeps an explicitly empty approved map empty", () => {
  expect(hintProducts(taskFixture(stateFixture(), { repositories: [] }))).toEqual([]);
});

it.each(["selectedProducts", "workRows"] as const)("uses the current single product rather than the proposed %s", proposal => {
  const choice = { productId: "billing", delivery: "local", startFrom: { kind: "default" } } as const;
  const task = taskFixture(stateFixture(), proposal === "selectedProducts" ? { selectedProducts: [choice] } : { workRows: [{ choice }] });
  expect(hintProducts(task)).toEqual(["shop"]);
});
