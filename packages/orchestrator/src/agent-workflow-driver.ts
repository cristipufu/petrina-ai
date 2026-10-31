import { lastIndexWhere, runtimeWaitHolds, type Id } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { AgentWorkflowDependencies, AgentWorkflowHost } from "./ports/agent-workflow.js";
import { executionFor } from "./repository-context.js";

export interface WorkflowDriverContext {
  readonly host: AgentWorkflowHost;
  readonly ownership: AgentWorkflowDependencies["ownership"];
  readonly catalog: AgentWorkflowDependencies["catalog"];
  readonly errors: AgentWorkflowDependencies["errors"];
  readonly phases: AgentWorkflowDependencies["phases"];
  readonly checks: AgentWorkflowDependencies["checkPreparation"];
  readonly preparedTesters: Map<Id, string>;
  testerCheckKey(task: RuntimeTask): string;
  testerNeedsChecks(task: RuntimeTask): boolean;
  admitNext(task: RuntimeTask, signal: AbortSignal): Promise<boolean | "refresh">;
  waitForUsage(task: RuntimeTask, words: string): void;
}

/** `resume`: the agent already has its seat (a hand back), so its step carries on whatever the pool is doing. */
export function startWorkflowDriver(
  ctx: WorkflowDriverContext,
  taskId: Id,
  resume = false,
  run: (taskId: Id, resume: boolean) => Promise<void> = (id, flag) => driveWorkflowTask(ctx, id, flag),
): void {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completed = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  ctx.ownership.settling.set(taskId, completed);
  // Observe the original result without replacing it, including if finalizer registration fails.
  void completed.then(undefined, () => undefined);
  const finish = (failures: unknown[]): void => {
    // Live drivers stay task-keyed: a quiet paused check is deliberately excluded from a pool drain.
    // Transfer ownership before releasing that reservation or running any finalization callback.
    let tracked = false;
    try {
      ctx.host.trackWork(completed);
      tracked = true;
    } catch (error) {
      failures.push(error);
    }
    const release = () => {
      if (ctx.ownership.settling.get(taskId) === completed) ctx.ownership.settling.delete(taskId);
    };
    if (tracked) release();
    // Without background ownership, keep our own reservation until all callbacks have returned.
    for (const effect of [() => ctx.host.tidy(taskId), () => ctx.host.schedule(), () => ctx.host.idleChanged()]) {
      try {
        effect();
      } catch (error) {
        failures.push(error);
      }
    }
    if (!tracked) release();
    if (!failures.length) {
      resolve();
      return;
    }
    let failure = failures.length === 1 ? failures[0] : new AggregateError(failures, `Could not finish task ${taskId}`);
    try {
      ctx.host.reportDriverError(taskId, failure);
    } catch (error) {
      failure = new AggregateError([...failures, error], `Could not finish task ${taskId}`);
    }
    reject(failure);
  };
  // Both reactions settle without throwing; there is no unowned rejecting finally/then derivative.
  void run(taskId, resume).then(
    () => finish([]),
    (error) => finish([error]),
  );
  ctx.host.idleChanged();
}

export async function driveWorkflowTask(ctx: WorkflowDriverContext, taskId: Id, resume = false): Promise<void> {
  const controller = new AbortController();
  ctx.ownership.drivers.set(taskId, controller);
  const { signal } = controller;
  const task = () => {
    const found = ctx.host.task(taskId);
    if (!found) throw ctx.errors.aborted();
    return found;
  };
  try {
    // A delivery from before the update: nothing happens, not even an update from GitHub, until the coordinator chooses.
    if (executionFor(task()).work.shipping?.carriedOver) {
      ctx.phases.carriedOver(task());
      return;
    }

    for (;;) {
      if (signal.aborted) throw ctx.errors.aborted();
      const current = task();
      let scope = executionFor(current);
      if (runtimeWaitHolds(current)) {
        ctx.waitForUsage(current, ctx.host.admissionWait(current));
        return;
      }
      if (current.reviewDecision?.accepted === false) {
        ctx.host.gate(current, "delivery");
        return;
      }
      const stage = current.stageIndex < 0 ? undefined : current.plan?.stages[current.stageIndex];
      if (!stage || ctx.catalog.role(stage.roleId, current)?.result !== "checks") {
        ctx.preparedTesters.delete(taskId);
      }
      const prepared = await ctx.phases.prepareWorkspace(current, stage, signal);
      if (prepared.kind === "repeat") continue;
      if (prepared.kind === "stop") return;
      scope = prepared.scope;
      // Nothing ships while changes made by hand wait for review: the last review chain looks at them first.
      if (
        stage
        && current.handChanges
        && (stage.gate === "delivery" || ctx.catalog.role(stage.roleId, current)?.result === "delivery")
      ) {
        const chain = lastIndexWhere(current.plan!.stages, (entry) => entry.kind === "review-chain");
        if (chain >= 0) {
          current.stageIndex = chain;
          current.sub = 0;
          current.fixing = false;
          delete current.hunt;
          ctx.host.note(
            current,
            "milestone",
            "Reviewing your changes before anything ships: the review starts again from the first reviewer",
          );
          ctx.host.changed();
          continue;
        }
        delete current.handChanges;
      }
      // Acceptance was tried on this change already. Fixes are reviewed, and the final code is tried once more
      // right before the delivery check, so a tester pass per fix round is spared.
      if (
        stage?.kind === "do"
        && ctx.catalog.role(stage.roleId, current)?.result === "checks"
        && !current.retest
        && current.testedPatch !== undefined
        && (!current.repositories || current.acceptancePassed)
      ) {
        ctx.host.note(
          current,
          "milestone",
          "Acceptance will be tried once more on the final code, right before your delivery check",
        );
        current.stageIndex += 1;
        current.sub = 0;
        ctx.host.changed();
        continue;
      }
      // Plan and design checkpoints need no work; delivery preparation can update files and run checks.
      if (stage?.kind === "gate") {
        // On the way back to the check where changes were asked, earlier design checks are not asked again.
        if (stage.gate === "design" && current.returnToCheck !== undefined && current.stageIndex < current.returnToCheck) {
          ctx.host.note(
            current,
            "milestone",
            "Went past the earlier design check you already approved, back to the one where you asked for changes",
          );
          current.stageIndex += 1;
          current.sub = 0;
          ctx.host.changed();
          continue;
        }
        delete current.returnToCheck;
        if (stage.gate === "delivery") {
          const checkpoint = await ctx.phases.deliveryCheckpoint(scope, signal);
          if (checkpoint.kind === "repeat") continue;
          return;
        }
        ctx.host.gate(current, stage.gate ?? "delivery");
        return;
      }
      // Petrina is stopping: the step waits for the restart instead of starting an agent it would cut short.
      if (ctx.host.admissionsClosed(current)) {
        current.state = "waiting";
        current.holdsSlot = false;
        delete current.agent;
        current.column = ctx.host.column(current);
        current.statusLine = ctx.host.admissionWait(current);
        ctx.host.changed();
        return;
      }
      // Running agents finish; every following agent must qualify again, even on the same tool.
      if (resume) resume = false;
      else {
        const admission = await ctx.admitNext(current, signal);
        if (admission === "refresh" || ctx.host.sourceRefreshDue(current)) continue;
        if (!admission) {
          ctx.host.changed();
          return;
        }
      }
      ctx.host.changed();
      // The stage (or planning) is under way from here: a slot is held for it, or it needs none.
      ctx.host.beginStage(scope);
      // Give acceptance testing verified automated evidence first, so it can focus on the user cases.
      // Read-only review reuses this same run; changing code still requires fresh evidence.
      if (ctx.testerNeedsChecks(current)) {
        const acceptance = await ctx.phases.prepareAcceptance(scope, signal);
        if (acceptance.kind === "stop") return;
        if (acceptance.kind === "repeat") continue;
        ctx.preparedTesters.set(taskId, ctx.testerCheckKey(current));
        ctx.checks.release(taskId);
        continue;
      }
      if (current.stageIndex < 0) {
        // Pausing while the copy is made already has a plan. Planning again would start a second one.
        if (!current.plan) await ctx.phases.planner(current, signal);
        scope = executionFor(current);
        if (current.confirmWork || current.workError || !scope.work.source?.confirmed) {
          ctx.host.gate(current, "plan");
          return;
        }
        // Show me the plan first stays editable until it is approved. Skipping that check prepares on the next pass.
        if (current.approvePlan) {
          ctx.host.gate(current, "plan");
          return;
        }
        current.stageIndex = 0;
        current.sub = 0;
        ctx.host.changed();
        continue;
      }
      if (!stage) throw new Error("The plan ended without a delivery");
      const next =
        stage.kind === "do"
          ? ctx.catalog.role(stage.roleId, current)?.result === "delivery"
            ? await ctx.phases.delivery(current, stage, signal)
            : await ctx.phases.doStage(scope, stage, signal)
          : stage.kind === "converge"
            ? await ctx.phases.converge(scope, stage, signal)
            : await ctx.phases.review(current, stage, signal);
      if (next === "stop") return;
    }
  } catch (error) {
    const problem = ctx.errors.classify(error);
    if (signal.aborted || problem.kind === "abort" || problem.kind === "screen") return;
    if (problem.kind === "source-refresh") {
      ctx.waitForUsage(task(), "Waiting to bring the work onto the required source");
      return;
    }
    if (ctx.host.task(taskId)?.maintenance?.settingsDecision && !ctx.host.task(taskId)?.maintenance?.settingsDecision?.choice) {
      return;
    }
    if (problem.kind === "usage") {
      // Admission may close during an awaited preparation step. Every such exit must
      // release its reservation and remain schedulable, even if the callee only threw.
      const current = ctx.host.task(taskId);
      if (current && ["running", "waiting"].includes(current.state)) {
        ctx.waitForUsage(current, ctx.host.draining() ? ctx.host.drainLine() : problem.words);
      }
      return;
    }
    const current = task();
    let failure = error;
    try {
      await ctx.phases.clearUnpublishedOnFailure(current);
    } catch (cleanup) {
      if (!Object.is(error, cleanup)) {
        failure = new AggregateError([error, cleanup], "The task failed and its working copy could not be restored");
      }
    }
    ctx.host.failed(taskId, failure);
  } finally {
    ctx.checks.release(taskId);
    // A check run lives inside this driver: none outlives it.
    const ended = ctx.host.task(taskId);
    if (ended) ctx.checks.clear?.(ended);
    if (ctx.host.task(taskId)?.state !== "waiting") ctx.preparedTesters.delete(taskId);
    if (ctx.ownership.drivers.get(taskId) === controller) ctx.ownership.drivers.delete(taskId);
    await ctx.phases.finish(taskId, signal);
  }
}
