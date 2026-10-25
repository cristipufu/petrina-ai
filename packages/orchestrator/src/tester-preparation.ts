import { stepKey, type DeepMutable, type Product, type TaskState } from "@petrina/core";
import { scopesFor } from "./repository-context.js";
type MutableTask = DeepMutable<TaskState>;

export function testerCheckKey(task: MutableTask, products: readonly Product[]): string {
  const scopes = scopesFor(task);
  // Evidence belongs to every approved owner, independent of the visible active product.
  const evidence = scopes.map(({ work }) => [work.productId, work.baseSha, work.checks?.at, work.checks?.current]);
  const productIds = new Set(scopes.map(({ work }) => work.productId));
  return JSON.stringify([stepKey(task), task.handChanges, evidence,
    products.filter((product) => productIds.has(product.id)).map((product) => [product.id, product.checks])]);
}
