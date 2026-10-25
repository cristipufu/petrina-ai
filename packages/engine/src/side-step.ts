import type { Id } from "@petrina/core";
import { beginInternalStep, type RepositoryContext } from "@petrina/orchestrator";
import type { Kernel } from "./kernel.js";

/** Native checkpoint composition; snapshot/restore lives with the workflow controller. */
export function beginSideStep(k: Pick<Kernel, "commitNow">, scope: RepositoryContext, roleId: Id): () => void {
  return beginInternalStep({ checkpoint: () => k.commitNow() }, scope, roleId);
}
