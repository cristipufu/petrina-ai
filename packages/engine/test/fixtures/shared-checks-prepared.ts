import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopesFor } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { Engine } from "../engine.js";
import { sourcePrepared } from "./source-prepared.js";
import { sharedBrief } from "./shared-agents.js";
import { materializePreparedWorktree, readRef } from "./shared-preparation.js";

/** A declared built change enters the real Tester/review/check workflow, with no prior check or review evidence. */
export async function sharedChecksPrepared(engine: Engine, input: Parameters<Engine["addTask"]>[0], recipe: unknown, available: () => void): Promise<string> {
  const active = () => { available(); engine.stopRequested.signal.throwIfAborted(); };
  active();
  const schedule = engine.schedule, paused = engine.s.pool.paused;
  let ready = false;
  engine.schedule = () => {};
  try {
    const id = await sourcePrepared(engine, input, recipe, { kind: "builder", brief: sharedBrief() }, active);
    active();
    engine.setPoolPaused(true);
    const task = engine.task(id)!;
    if (engine.drivers.has(id)) throw new Error("A prepared check fixture cannot replace an active driver");
    const build = task.plan!.stages[task.stageIndex]!;
    if (build.kind !== "do" || engine.role(build.roleId, task)?.result !== "build") throw new Error("The prepared shared checks require the initial Builder boundary");
    const next = task.plan!.stages[task.stageIndex + 1];
    if (!next || next.kind !== "do" || engine.role(next.roleId, task)?.result !== "checks") throw new Error("The prepared shared checks must enter actual acceptance testing");
    task.state = "running";
    for (const scope of scopesFor(task)) {
      active();
      const product = engine.productOf(scope)!;
      if (!product.checks) engine.setProductChecks(product.id, [{ name: "Version", command: "git --version" }]);
      const defaultBranch = product.defaultBranch ?? "main";
      const baseSha = product.path ? readRef(join(product.path, ".git"), `refs/heads/${defaultBranch}`) : undefined;
      if (product.path && baseSha) {
        await materializePreparedWorktree(engine, scope, product.path, `origin/${defaultBranch}`, baseSha, "greeting.txt", "Hello\n", "Added a greeting.");
        active();
        scope.work.preparation = "ready";
      } else {
        await engine["driver"]["prepare"](scope, engine.stopRequested.signal);
        active();
        scope.work.preparation = "ready";
        writeFileSync(join(scope.work.worktree!, "greeting.txt"), "Hello\n");
        await git.commitChanges(scope.work.worktree!, "Added a greeting.");
        active();
      }
      scope.work.report = { summary: "Added a greeting.", changes: ["People see a greeting"], tests: "Petrina runs the configured checks." };
      scope.work.completedStages = [...new Set([...(scope.work.completedStages ?? []), build.id])];
      if (scope.work.checks || scope.work.checkSetup || scope.work.reviewedSha || scope.work.reviewedTree || scope.work.conversation)
        throw new Error("Prepared shared checks cannot contain completed check, review or conversation evidence");
    }
    if (task.acceptancePassed || task.findings.length) throw new Error("Prepared shared checks must precede acceptance and review observations");
    task.stageIndex++; task.sub = 0; task.state = "waiting"; task.holdsSlot = false;
    task.column = engine.columnFor(task);
    active(); engine.commitNow(task);
    ready = true;
    return id;
  } finally {
    engine.schedule = schedule;
    // A rejected setup stays paused until its canonical generation owner stops it.
    if (ready) engine.setPoolPaused(paused);
  }
}
