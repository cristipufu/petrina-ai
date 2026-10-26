import type { Product } from "@petrina/core";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import type { Engine } from "../engine.js";

/** A declared fixture precondition, never a repository discovery or check observation. */
export type PreparedProduct = Pick<Product, "id" | "name" | "repo" | "tone"> & {
  path: string;
  remote: string;
  defaultBranch: string;
  delivery: NonNullable<Product["delivery"]>;
  approveDelivery: boolean;
};

/** Known private repository recipes skip discovery; identity choices stay explicit at each fixture owner. */
export function installPreparedProduct(engine: Engine, input: PreparedProduct): string {
  const path = fixtureFiles.canonical(input.path);
  if (engine.tracking.productIdTaken(input.id) || engine.s.products.some(product => product.path === path))
    throw new Error("The prepared product's fixture identity is already in use");
  const product = { id: input.id, name: input.name, repo: input.repo, tone: input.tone, path,
    remote: input.remote, defaultBranch: input.defaultBranch, delivery: input.delivery, approveDelivery: input.approveDelivery };
  engine.tracking.product(product, { addedAt: Date.now() });
  engine.s.products.push(product);
  engine.commitNow();
  return product.id;
}
