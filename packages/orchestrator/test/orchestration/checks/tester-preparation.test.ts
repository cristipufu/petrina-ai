import { expect, it } from "vitest";
import { testerCheckKey } from "../../../src/tester-preparation.js";
import { repositoryTask } from "../../fixtures/tasks.js";

it("keeps shared check readiness independent of the active repository and invalidates changed evidence", async () => {
  const task = repositoryTask(), productId = task.productId;
  const products = [{ id: productId, name: "Product", repo: "local/product", tone: "blue" as const }];
    task.repositories = [productId, "peer"].map((id, index) => ({ productId: id, delivery: "local", baseSha: `base-${id}`, checks: { at: 10 + index, current: true, results: [] }, completedStages: [] }));
    task.activeProductId = productId;
    const first = testerCheckKey(task, products);
    task.activeProductId = "peer";
    expect(testerCheckKey(task, products)).toBe(first);
    task.repositories[1]!.checks!.at += 1;
    expect(testerCheckKey(task, products)).not.toBe(first);
    const changed = testerCheckKey(task, products);
    task.activeProductId = productId;
    expect(testerCheckKey(task, products)).toBe(changed);
    task.handChanges = true;
    expect(testerCheckKey(task, products)).not.toBe(changed);
});
