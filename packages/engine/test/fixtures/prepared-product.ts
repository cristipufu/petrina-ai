import { dirname, join } from "node:path";
import type { Product } from "@petrina/core";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import type { Engine } from "../engine.js";

/** A declared fixture precondition, never a repository discovery or check observation. */
export type PreparedProduct = Pick<Product, "id" | "name" | "repo" | "tone"> & {
  path: string;
  remote?: string;
  defaultBranch: string;
  delivery: NonNullable<Product["delivery"]>;
  approveDelivery: boolean;
};

/** The declared acme/demo NativeWorld catalog recipe; data only, never discovery or registration. */
export function acmeDemoProduct(path: string): PreparedProduct {
  return { id: "demo", name: "Clone", repo: "acme/demo", tone: "blue", path,
    remote: "https://github.com/acme/demo.git", defaultBranch: "main", delivery: "pull-request", approveDelivery: true };
}

/** The makeProduct default: a private bare origin and its clone, with local delivery. */
export function privateCloneProduct(path: string): PreparedProduct {
  return { id: "clone", name: "Clone", repo: "local/clone", tone: "blue", path,
    remote: join(dirname(path), "origin.git"), defaultBranch: "main", delivery: "local", approveDelivery: true };
}

/** Known private repository recipes skip discovery; identity choices stay explicit at each fixture owner. */
export function installPreparedProduct(engine: Engine, input: PreparedProduct): string {
  const path = fixtureFiles.canonical(input.path);
  if (engine.tracking.productIdTaken(input.id) || engine.s.products.some(product => product.path === path))
    throw new Error("The prepared product's fixture identity is already in use");
  const product = { id: input.id, name: input.name, repo: input.repo, tone: input.tone, path,
    ...(input.remote !== undefined ? { remote: input.remote } : {}), defaultBranch: input.defaultBranch, delivery: input.delivery, approveDelivery: input.approveDelivery };
  engine.tracking.product(product, { addedAt: Date.now() });
  engine.s.products.push(product);
  engine.commitNow();
  return product.id;
}
