import { executionFor, scopesFor, type RuntimeTask } from "@petrina/orchestrator";
import type { DeepMutable, Stage } from "@petrina/core";
import type { Engine } from "../engine.js";
import { git } from "@petrina/test-support/commands";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import type { ProductRepository } from "@petrina/test-support/repositories";
import { readWorktreeCommit } from "./shared-preparation.js";

type SourceInput = { check(): void } & ({ deferInitialSha: true } | { initial: ProductRepository });

/** A captured immutable input or native Git supplies the start; Driver still pins its actual private copy. */
export async function localFixtureSource(engine: Engine, task: RuntimeTask, options?: SourceInput): Promise<void> {
  const scope = executionFor(task), product = engine.s.products.find(product => product.id === scope.work.productId);
  if (!product?.path) throw new Error("A prepared runtime fixture needs its registered private product");
  if (options) {
    options.check(); engine.stopRequested.signal.throwIfAborted();
    if (engine.task(task.id) !== task || executionFor(task).work !== scope.work || engine.productOf(scope) !== product)
      throw new Error("The prepared runtime source lost its captured owner");
  }
  if (options && "initial" in options) {
    const { path, initialSha } = options.initial;
    if ("deferInitialSha" in options || (initialSha.length !== 40 && initialSha.length !== 64) || /[^0-9a-f]/.test(initialSha)
      || product.path !== fixtureFiles.canonical(path) || (product.defaultBranch ?? "main") !== "main"
      || task.state !== "backlog" || task.plan || task.journey?.length || task.agent
      || scope.work.source || scope.work.worktree || scope.work.baseSha || scope.work.savedVersion
      || engine.s.tasks.some(current => (engine.drivers.has(current.id) || engine.runs.has(current.id) || engine.helperRuns.get(current.id)?.size)
        && scopesFor(current).some(scope => scope.work.productId === product.id)))
      throw new Error("The initial fixture source requires its unchanged private main before any writer starts");
  }
  scope.work.delivery = "local";
  scope.work.source = { product: { ...product }, start: { kind: "default", branch: product.defaultBranch ?? "main" },
    destination: { mode: "local", kind: "branch", repo: product.repo, branch: product.defaultBranch ?? "main" },
    confirmed: true, ...(options && "deferInitialSha" in options && options.deferInitialSha ? {} : { initialSha: options && "initial" in options ? options.initial.initialSha : (readWorktreeCommit(product.path)?.commit ?? await git(product.path, "rev-parse", "HEAD")) }) };
}

export function screenFixturePlan(profiles: string[] = ["opus-high"]): DeepMutable<Stage>[] {
  return [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: profiles, maxRounds: profiles.length > 1 ? 2 : 1 },
    { id: "delivery", kind: "gate", title: "Your delivery check", gate: "delivery", roleId: "coordinator", profileIds: [] },
    { id: "publish", kind: "do", title: "Publish", roleId: "release-manager", profileIds: ["sol-high"] },
  ];
}
