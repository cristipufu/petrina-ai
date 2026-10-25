import { executionFor, type RuntimeTask } from "@petrina/orchestrator";
import type { DeepMutable, Stage } from "@petrina/core";
import type { Engine } from "../engine.js";
import { git } from "@petrina/test-support/commands";

/** A settled fixture fact; native Git still supplies the exact private starting commit. */
export async function localFixtureSource(engine: Engine, task: RuntimeTask): Promise<void> {
  const scope = executionFor(task), product = engine.s.products.find(product => product.id === scope.work.productId);
  if (!product?.path) throw new Error("A prepared runtime fixture needs its registered private product");
  scope.work.delivery = "local";
  scope.work.source = { product: { ...product }, start: { kind: "default", branch: product.defaultBranch ?? "main" },
    destination: { mode: "local", kind: "branch", repo: product.repo, branch: product.defaultBranch ?? "main" },
    confirmed: true, initialSha: await git(product.path, "rev-parse", "HEAD") };
}

export function screenFixturePlan(profiles: string[] = ["opus-high"]): DeepMutable<Stage>[] {
  return [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: profiles, maxRounds: profiles.length > 1 ? 2 : 1 },
    { id: "delivery", kind: "gate", title: "Your delivery check", gate: "delivery", roleId: "coordinator", profileIds: [] },
    { id: "publish", kind: "do", title: "Publish", roleId: "release-manager", profileIds: ["sol-high"] },
  ];
}
