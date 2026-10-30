import {
  decisionEvidence,
  endAgentStep,
  gateStatus,
  JOURNEY_WORDS,
  openStep,
  originalCheck,
  runtimeWaitHolds,
  type CheckRun,
  type Id,
  type ProductCheck,
} from "@petrina/core";
import { acquireCheckPlace, scopesFor, taskView, type RepositoryContext } from "@petrina/orchestrator";
import { powerInterruption, readMachineRecords } from "./check-interruption.js";
import { CHECKS_SEEN, checksFingerprint, commandText, detectChecks } from "./checks.js";
import type { Context } from "./context.js";
import {
  Aborted,
  CHECK_FINDER_PROFILE,
  ScreenWait,
  SourceRefreshRequired,
  type Kernel,
  type RuntimeTask,
} from "./kernel.js";
import { machineRecordsOf } from "./product-check-setup.js";
import { CheckFinderResult } from "./roles.js";
import { beginSideStep } from "./side-step.js";
import type { Turns } from "./turn.js";
import { WaitingForUsage } from "./usage.js";

export async function restoreCheckEvidence(
  k: Kernel,
  settleFindings: (scope: RepositoryContext, results: readonly CheckRun[]) => readonly CheckRun[],
  checkProblem: (task: RuntimeTask) => { title: string; body: string },
): Promise<void> {
  const observations = k.s.tasks
    .filter((task) => !["running", "done", "cancelled", "pr-open"].includes(task.state))
    .flatMap((task) =>
      scopesFor(task).flatMap((scope) =>
        (scope.work.checks?.results ?? [])
          .filter((run) => !run.ok && !run.interruption && !run.interrupted)
          .flatMap((run) => {
            const original = originalCheck(task, run)?.check;
            const start = run.startedAt ?? original?.startedAt;
            const end = run.endedAt ?? original?.endedAt;
            return start !== undefined && end !== undefined ? [{ scope, run, start, end }] : [];
          }),
      ),
    );
  if (!observations.length) return;
  const records = await readMachineRecords(machineRecordsOf(k), k.stopRequested.signal);
  if (k.stopped || k.stopRequested.signal.aborted) return;
  const changed = new Set<RuntimeTask>();
  for (const { scope, run, start, end } of observations) {
    if (scope.task.state === "running" || !scope.work.checks?.results.includes(run)) continue;
    const interruption = powerInterruption(start, end, records);
    if (!interruption) continue;
    run.interruption = interruption;
    for (const step of scope.task.journey ?? []) {
      for (const check of step.productChecks ?? []) {
        if (
          check.run
          && (run.source
            ? check.run.source?.stepId === run.source.stepId
              && check.run.source?.checkId === run.source.checkId
              && check.run.source?.attemptId === run.source.attemptId
            : Boolean(run.logPath && check.run.logPath === run.logPath))
        ) {
          check.run.interruption = interruption;
        }
      }
    }
    settleFindings(scope, scope.work.checks.results);
    changed.add(scope.task);
  }
  for (const task of changed) {
    const decision = openStep(task);
    if (task.state !== "needs-you" || decision?.waitsFor !== "delivery") continue;
    decision.productChecks = decisionEvidence(taskView(task));
    const problem = checkProblem(task);
    for (const item of k.s.inbox) {
      if (item.taskId === task.id && item.kind === "delivery") {
        item.title = problem.title;
        item.body = problem.body;
      }
    }
    task.statusLine = gateStatus(taskView(task), "delivery");
  }
  if (changed.size) k.commitNow();
}

export async function acquireCheckTurnToRun(
  k: Kernel,
  scope: RepositoryContext,
  signal: AbortSignal,
  order = k.checkQueue.reserveOrder(),
): Promise<(() => void) & { waited: boolean }> {
  const { task } = scope;
  if (signal.aborted || k.stopped) throw new Aborted();
  if (runtimeWaitHolds(task)) throw new WaitingForUsage(k.taskAdmissionWait(task));
  let waitingForPool = false;
  const resume = (words: string) => {
    const wasPaused = waitingForPool && task.state === "waiting";
    waitingForPool = false;
    if (!wasPaused && task.statusLine === words) return;
    if (wasPaused) {
      task.state = "running";
      task.column = k.columnFor(task);
    }
    task.statusLine = words;
    k.commit();
  };
  const onWait = (closed?: string) => {
    if (signal.aborted || k.stopped || runtimeWaitHolds(task) || !["running", "waiting"].includes(task.state)) return;
    if (closed) {
      waitingForPool = true;
      if (task.state !== "waiting" || task.statusLine !== closed) k.waitForUsage(task, closed);
    } else {
      resume(k.extraCheckBlocker?.() ?? "Waiting to run the checks: another task's run comes first");
    }
  };
  k.waitingChecks.set(task.id, (k.waitingChecks.get(task.id) ?? 0) + 1);
  try {
    return await acquireCheckPlace(k.checkQueue, signal, order, {
      stopped: () => k.stopped,
      prerequisite: () => runtimeWaitHolds(task),
      closed: () => k.taskAdmissionsClosed(task),
      draining: () => k.draining,
      reason: () => k.taskAdmissionWait(task),
      subscribe: (changed) => k.subscribe(changed),
      onWait,
      admitted: () => {
        if (waitingForPool) resume("Preparing the product's checks");
      },
    });
  } finally {
    const left = k.waitingChecks.get(task.id)! - 1;
    if (left) k.waitingChecks.set(task.id, left);
    else k.waitingChecks.delete(task.id);
    k.syncIdleSleep();
  }
}

export async function ensureProductChecks(
  k: Kernel,
  turns: Turns,
  context: Context,
  scope: RepositoryContext,
  signal: AbortSignal,
): Promise<readonly ProductCheck[]> {
  const { task, work: repository } = scope;
  const product = k.productOf(scope);
  if (!product || !repository.worktree) return [];
  const continuing = k.role(repository.conversation?.roleId ?? "")?.result === "check-discovery";
  if (product.checksBy === "coordinator" && !continuing) return product.checks ?? [];
  const fingerprint = checksFingerprint(repository.worktree);
  if (!continuing && product.checks && product.checksFingerprint === fingerprint) return product.checks;
  const seen = product.checksSeen?.find((entry) => entry.fingerprint === fingerprint);
  if (!continuing && seen) return seen.checks;
  const declared = detectChecks(repository.worktree);
  const restore = beginSideStep(k, scope, "check-finder");
  const why = !product.checks ? "first time" : "the CI, build or hook files changed";
  const finder = k.onUsable(CHECK_FINDER_PROFILE);
  let ran: Id = finder;
  try {
    const result = await turns.turn(
      scope,
      "check-finder",
      finder,
      async () => [
        ...(await context.sectionsFor(scope, "check-finder")),
        ...(product.checks
          ? [
              {
                title: "The checks used until now",
                body: product.checks.map((c) => `- ${c.name}: ${commandText(c.argv)}`).join("\n"),
              },
            ]
          : []),
        ...(declared.length
          ? [
              {
                title: "Commands the repository declares (a starting point, not the answer)",
                body: declared.map((c) => `- ${c.name}: ${commandText(c.argv)}`).join("\n"),
              },
            ]
          : []),
      ],
      CheckFinderResult,
      signal,
      { status: "Working out how to check this product", used: (id) => (ran = id) },
    );
    k.releaseScreen(task);
    restore();
    if (product.checksBy === "coordinator") return product.checks ?? [];
    product.checks = result.checks.map((c) => ({ name: c.name, argv: c.argv, why: c.why }));
    endAgentStep(
      task,
      { outcome: JOURNEY_WORDS.foundChecks(product.checks.length), reason: JOURNEY_WORDS.checksFound },
      Date.now(),
    );
    k.log(
      scope,
      "done",
      `Found how to check ${product.name} (${why}): ${product.checks.map((c) => c.name).join(", ")}`,
      "check-finder",
      ran,
    );
  } catch (error) {
    if (signal.aborted || error instanceof Aborted || error instanceof ScreenWait) throw error;
    k.releaseScreen(task);
    restore();
    if (error instanceof WaitingForUsage || error instanceof SourceRefreshRequired) throw error;
    k.tracking.failed(scope, error, { roleId: "check-finder", profileId: ran });
    endAgentStep(task, { outcome: JOURNEY_WORDS.couldNotFinish, reason: JOURNEY_WORDS.checksAsBefore }, Date.now());
    if (product.checksBy === "coordinator") return product.checks ?? [];
    const fallback: ProductCheck[] = product.checks ? [...product.checks] : declared;
    product.checks = fallback.map((c) => ({
      name: c.name,
      argv: [...c.argv],
      ...(c.why ? { why: c.why } : {}),
    }));
    k.log(
      scope,
      "warn",
      `The Check finder could not finish, so Petrina uses ${fallback.length ? "the checks it had" : "no checks"} for now`,
    );
  }
  product.checksBy = "finder";
  product.checksFingerprint = fingerprint;
  product.checksSeen = [
    ...(product.checksSeen ?? []).filter((e) => e.fingerprint !== fingerprint),
    { fingerprint, checks: product.checks ?? [] },
  ].slice(-CHECKS_SEEN);
  k.commit();
  return product.checks ?? [];
}

export function cachedProductChecks(k: Kernel, scope: RepositoryContext): readonly ProductCheck[] | undefined {
  const product = k.productOf(scope);
  const repository = scope.work;
  if (!product || !repository.worktree) return [];
  if (product.checksBy === "coordinator") return product.checks ?? [];
  const fingerprint = checksFingerprint(repository.worktree);
  if (product.checks && product.checksFingerprint === fingerprint) return product.checks;
  return product.checksSeen?.find((entry) => entry.fingerprint === fingerprint)?.checks;
}

export async function refreshCheckInterruptions(
  k: Kernel,
  scope: RepositoryContext,
  signal: AbortSignal,
): Promise<void> {
  const saved = scope.work.checks!;
  let records: string | undefined;
  for (const run of saved.results) {
    if (!run.ok && !run.interruption && !run.interrupted) {
      const original = originalCheck(scope.task, run)?.check;
      const start = run.startedAt ?? original?.startedAt;
      const end = run.endedAt ?? original?.endedAt;
      if (start === undefined || end === undefined) continue;
      records ??= await readMachineRecords(machineRecordsOf(k), signal);
      if (signal.aborted || k.stopped) throw new Aborted();
      const interruption = powerInterruption(start, end, records);
      if (interruption) {
        run.interruption = interruption;
        if (original?.run) original.run.interruption = interruption;
      }
    }
  }
}
