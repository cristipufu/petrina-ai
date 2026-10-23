import type { AcceptanceRestoration, JourneyAcceptanceCheck, JourneyStep, Role, Task } from "./model.js";

/** Why every item and proof answer from a run whose changes Petrina undid is unverified. */
export const ACCEPTANCE_RESTORED = "Petrina undid changes during acceptance testing. This run cannot verify the restored product.";
/** Why every item and proof answer is unverified from a run Petrina stopped during before its cleanup was accounted for. */
export const ACCEPTANCE_UNACCOUNTED = "Petrina stopped during acceptance testing and could not confirm what its cleanup undid. This run cannot verify the product.";

/** Why an invalidated run's answers are unverified: what Petrina undid, or that nothing shows what it undid. */
export function restorationReason(restored: AcceptanceRestoration): string {
  return restored.products.length ? ACCEPTANCE_RESTORED : ACCEPTANCE_UNACCOUNTED;
}

/** A completed acceptance run whose results were saved, including a run Petrina invalidated that had nothing to report. */
const savedRun = (step: JourneyStep) => !!step.acceptanceChecks?.length || (step.acceptanceChecks !== undefined && !!step.proofRun?.restored);

/** The undone changes behind the latest saved acceptance run, while that leaves acceptance unverified. */
export function restoredAcceptance(task: Pick<Task, "journey" | "acceptanceUnverified">) {
  return task.acceptanceUnverified ? task.journey?.findLast((step) => step.kind === "agent" && step.endedAt !== undefined && step.acceptanceChecks !== undefined)?.proofRun?.restored : undefined;
}

/** Select one recorded run; later unfinished attempts never replace or supplement it. */
export function recordedAcceptance(task: Task, roleFor: (id?: string) => Role | undefined) {
  const journey = task.journey ?? [];
  const index = journey.findLastIndex((step) => step.kind === "agent" && step.endedAt !== undefined && savedRun(step) && roleFor(step.roleId)?.result === "checks");
  const step = journey[index];
  const reportIndex = step?.agentResults?.findLastIndex((report) => report.roleId === step.roleId) ?? -1;
  const report = step?.agentResults?.[reportIndex];
  const testers = journey.filter((entry) => entry.kind === "agent" && roleFor(entry.roleId)?.result === "checks");
  const edits = journey.slice(index + 1).filter((later) => {
    const role = roleFor(later.roleId);
    return later.kind === "agent" && (!role || role.canEdit || role.result === "build");
  }).reverse();
  return { index, step, reportIndex, report, testers, edits };
}

/** Saved acceptance results and whether their recorded versions still describe the work. */
export function acceptanceSummary(task: Task, roleFor: (id?: string) => Role | undefined) {
  const { step, report, testers, edits } = recordedAcceptance(task, roleFor);
  const tested = report?.versions;
  const work = task.repositories ?? (task.repository ? [task.repository] : [{ productId: task.productId, checks: task.checks }]);
  const running = testers.some((entry) => entry.endedAt === undefined) && !["done", "cancelled", "pr-open"].includes(task.state);
  // Use each product's final recorded edit. A running editor or a missing snapshot
  // leaves freshness unknown, while restoring the tested contents can retain verification.
  const items = (task.brief?.acceptance ?? []).map((item) => {
    const check = step?.acceptanceChecks?.find((check) => check.text === item.text);
    // Item versions are saved by the engine for its assigned products. They can narrow
    // the run's snapshot only when they agree with that recorded acceptance run.
    const versions = item.versions
      ? tested && Object.entries(item.versions).every(([id, tree]) => tested[id] === tree) ? item.versions : undefined
      : tested;
    const current = !!(check?.evidence && check.result !== "blocked" && versions && Object.keys(versions).length > 0 && Object.entries(versions).every(([id, tree]) => {
      if (tree === "unavailable" || !work.some((entry) => entry.productId === id && entry.checks?.current === true && entry.checks.tree === tree)) return false;
      for (const later of edits) {
        const built = later.buildVersions ?? later.agentResults?.findLast((report) => report.roleId === later.roleId)?.versions;
        if (built && Object.keys(built).length > 0 && !(id in built)) continue;
        if (!built && later.buildProductId && later.buildProductId !== id) continue;
        return later.endedAt !== undefined && built?.[id] === tree;
      }
      return true;
    }));
    return { text: item.text, check, current };
  });
  return { items, current: items.length > 0 && items.every((item) => item.current), partlyCurrent: items.some((item) => item.current) && items.some((item) => !item.current), started: testers.length > 0, notStarted: task.journey !== undefined && testers.length === 0, running };
}

export function acceptanceResultWords(check: JourneyAcceptanceCheck | undefined): string {
  return check?.result === "pass" ? "Passed" : check?.result === "fail" ? "Failed" : check?.result === "blocked" ? "Could not verify" : "Unavailable";
}
