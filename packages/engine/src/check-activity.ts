// A task's check fact, read only from the shared check line. Describing the line never admits, reorders or
// releases anything: queue order, limits, holds and cleanup stay with the line and its owners.

import {
  checkActivityDetails,
  checkActivityLine,
  checkHoldLine,
  checkOwnerParts,
  checkOwnerText,
  expectedCheckCommands,
  inCheckLine,
  type CheckActivity,
  type CheckLineHold,
  type CheckLineOwner,
  type CheckRunReason,
  type JourneyCheckReuse,
  type ProductCheck,
  type Task,
} from "@petrina/core";
import type { RepositoryContext } from "@petrina/orchestrator";
import type { CheckOwner } from "./check-queue.js";
import type { Kernel } from "./kernel.js";
import type { CheckState } from "./product-check-setup.js";

/** An owner as the coordinator reads it: the task's title, the product of a task with several, and an extra validation's name. */
export function lineOwner(k: Kernel, owner: CheckOwner): CheckLineOwner {
  // A cleanup hold can outlive its task on the board: its saved task still names it.
  const task = k.task(owner.taskId) ?? (owner.validationId ? k.extraValidationTask(owner.validationId) : undefined);
  const record = owner.validationId
    ? k.s.extraValidations?.find((entry) => entry.id === owner.validationId)
    : undefined;
  const shared = (task?.repositories?.length ?? 0) > 1;
  const productName =
    record?.productName ?? k.s.products.find((product) => product.id === owner.productId)?.name;
  return {
    taskId: owner.taskId,
    title: task?.title ?? owner.taskId,
    kind: owner.kind,
    ...(shared && productName ? { productName } : {}),
    ...(record ? { name: record.name } : {}),
  };
}

/**
 * The fact for a run at arrival `order` in the line: its phase, the whole runs waiting ahead of it, its place,
 * how many runs may run at once, who holds each running place and what holds the line. A cleanup block names
 * its recorded explanation; a recovery hold after a restart says Petrina is confirming an earlier run stopped.
 */
export function lineActivity(k: Kernel, order: number, since: number, productId?: string): CheckActivity {
  const view = k.checkQueue.view();
  const blocked = new Set(view.blocks.flatMap((owner) => (owner?.validationId ? [owner.validationId] : [])));
  const holders = [...view.blocks, ...view.running.filter((place) => place.hold).map((place) => place.owner)];
  const found: { arrival: number; hold: CheckLineHold }[] = [];
  const seen = new Set<string>();
  for (const owner of holders) {
    const key = owner && (owner.validationId ?? `${owner.taskId}:${owner.kind}`);
    if (!owner || !key || seen.has(key)) continue;
    seen.add(key);
    const arrival = owner.validationId
      ? (k.s.extraValidations?.findIndex((entry) => entry.id === owner.validationId) ?? -1)
      : -1;
    const record = arrival >= 0 ? k.s.extraValidations![arrival] : undefined;
    const cleanup = record?.state === "held";
    found.push({
      arrival,
      hold: {
        kind: cleanup ? "cleanup" : "recovery",
        owner: lineOwner(k, owner),
        ...(cleanup && record?.cleanupDetail ? { detail: record.cleanupDetail } : {}),
      },
    });
  }
  // In arrival order, as the coordinator's pool read lists them.
  const holds = found.sort((a, b) => a.arrival - b.arrival).map((entry) => entry.hold);
  const owners = view.running.flatMap((place) =>
    !place.hold && place.owner && !(place.owner.validationId && blocked.has(place.owner.validationId))
      ? [lineOwner(k, place.owner)]
      : [],
  );
  const ahead = view.waiting.filter((entry) => entry.order < order).length;
  // A paused pool keeps every place; a recovery after restart closes the line too, but as a hold.
  const phase = view.closed
    ? k.s.pool.paused || k.draining || k.stopped
      ? "paused"
      : "held"
    : view.blocks.length
      ? "held"
      : "waiting";
  return {
    phase,
    ...(productId ? { productId } : {}),
    since,
    ahead,
    place: view.running.length + ahead + 1,
    slots: view.limit,
    ...(owners.length ? { owners } : {}),
    ...(holds.length ? { holds } : {}),
  };
}

export const sameActivity = (a: CheckActivity | undefined, b: CheckActivity | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * A task's check activity as the card and task details say it: its phase, product, the whole runs ahead, its place, how
 * many runs Petrina allows at once, who holds each running place and what holds the line, with the recorded explanation.
 */
export function checkActivityRead(engine: Pick<Kernel, "activeState">, task: Pick<Task, "checkActivity">) {
  const activity = task.checkActivity;
  if (!activity) return null;
  const tasks = engine.activeState().tasks;
  return {
    phase: activity.phase,
    productId: activity.productId ?? null,
    since: activity.since,
    ahead: activity.ahead ?? null,
    place: activity.place ?? null,
    slots: activity.slots,
    running: activity.running ?? [],
    line: checkActivityLine(activity),
    owners: (activity.owners ?? []).map((owner) => ({
      taskId: owner.taskId,
      title: owner.title,
      kind: owner.kind,
      productName: owner.productName ?? null,
      check: owner.kind === "checks" ? checkOwnerParts(owner, tasks).what : null,
      validation: owner.kind === "extra" ? (owner.name ?? null) : null,
      text: checkOwnerText(owner, tasks),
    })),
    holds: (activity.holds ?? []).map((hold) => ({
      kind: hold.kind,
      taskId: hold.owner.taskId,
      title: hold.owner.title,
      validation: hold.owner.name ?? null,
      detail: hold.detail ?? null,
      text: checkHoldLine(hold, tasks),
    })),
    details: checkActivityDetails(activity, tasks),
  };
}

/** What a task waits for: its check line wait in the card's words, or its status line while it waits on anything else. */
export function waitingReason(task: Task, states: readonly Task["state"][]): string | null {
  if (inCheckLine(task.checkActivity)) return checkActivityLine(task.checkActivity!);
  return states.includes(task.state) ? task.statusLine : null;
}

/**
 * Why the saved run does not cover the current code, from the versions both runs recorded: the code, the starting
 * point (only when both recorded it), the check definitions, or hooks that must run again on unchanged code.
 */
export function checkRunReasonFor(
  scope: RepositoryContext,
  checks: readonly ProductCheck[],
  state: CheckState,
  purpose: JourneyCheckReuse["purpose"],
): CheckRunReason {
  const { task, work: repository } = scope;
  const saved = repository.checks;
  const product = task.repositories ? { productId: repository.productId } : {};
  if (!saved?.results.length) return { purpose, ...product, changed: [] };
  const incomplete = saved.results.some(
    (run) => run.interruption || run.interrupted || run.cleanupIncomplete || run.timedOut,
  );
  const passed = !incomplete && saved.results.every((run) => run.ok);
  const earlier = {
    ...(saved.provenance ? { nodeId: saved.provenance.nodeId, attemptId: saved.provenance.attemptId } : {}),
    ...(saved.sha ? { sha: saved.sha } : {}),
    ...(saved.tree ? { tree: saved.tree } : {}),
    passed,
    at: saved.at,
  };
  const changed: CheckRunReason["changed"][number][] = [];
  // Try again and Run checks again clear a finished run's versions; a stopped run never recorded its definition.
  if (!saved.sha && !saved.tree) changed.push(incomplete || !saved.definition ? "incomplete" : "requested");
  else if (state.trackedChanged) changed.push("edits");
  else {
    const sameCode =
      (Boolean(state.tree) && saved.tree === state.tree) || (Boolean(state.sha) && saved.sha === state.sha);
    const expected = expectedCheckCommands(checks, saved.results);
    const commands =
      JSON.stringify(expected) !== JSON.stringify(saved.results.slice(0, expected.length).map((run) => run.command));
    if (!sameCode) changed.push("code");
    if (saved.base && repository.baseSha && saved.base !== repository.baseSha) changed.push("start");
    if (sameCode && (commands || (Boolean(saved.definition) && saved.definition !== state.definition))) {
      changed.push("definitions");
    }
    if (sameCode && !changed.includes("definitions")) changed.push("hooks");
  }
  return { purpose, ...product, earlier, changed };
}
