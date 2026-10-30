import { findingKind } from "./findings.js";
import type { AcceptanceGap, AcceptanceRestoration, Finding, FindingKind, Id, JourneyAcceptanceCheck, JourneyStep, Role, Task } from "./model.js";

/** Why every item and proof answer from a run whose changes Petrina undid is unverified. */
export const ACCEPTANCE_RESTORED = "Petrina undid changes during acceptance testing. This run cannot verify the restored product.";
/** Why every item and proof answer is unverified from a run Petrina stopped during before its cleanup was accounted for. */
export const ACCEPTANCE_UNACCOUNTED = "Petrina stopped during acceptance testing and could not confirm what its cleanup undid. This run cannot verify the product.";

/** Why an invalidated run's answers are unverified: what Petrina undid, or that nothing shows what it undid. */
export function restorationReason(restored: AcceptanceRestoration): string {
  return restored.products.length ? ACCEPTANCE_RESTORED : ACCEPTANCE_UNACCOUNTED;
}

/**
 * A shared task's acceptance failure whose automatic repairs are used up: it waits for the coordinator's delivery
 * decision after the remaining planned steps. No automatic repair hands it to a Builder, it neither starts nor counts
 * toward review rounds, votes or decisions, and only a passing acceptance run closes it. Asking for changes at the
 * delivery check reopens it for another bounded attempt.
 */
export function exhaustedAcceptanceFailure(
  task: Pick<Task, "repositories" | "acceptanceBlocked">,
  finding: Pick<Finding, "status" | "text"> & { kind?: FindingKind; raisedBy?: string },
): boolean {
  return !!task.repositories && task.acceptanceBlocked === true && finding.status === "open" && findingKind(finding) === "acceptance-failed";
}

/**
 * What a Builder fixing a product answers by id: the open findings for that product, except pre-existing ones and
 * acceptance failures held for the delivery decision. Fresh and continued conversations and their saved context all use
 * this one list.
 */
export function builderFindings<F extends Finding>(task: Pick<Task, "repositories" | "acceptanceBlocked"> & { findings: readonly F[] }, productId: Id): F[] {
  return task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing" && (!task.repositories || !!finding.productIds?.includes(productId)) && !exhaustedAcceptanceFailure(
    task,
    finding
  ));
}

/**
 * The acceptance testing a tester stage still owes before the plan moves on: checking an acceptance repair, under way or
 * finished, or final testing the delivery check started. It stays owed until the Tester's run is recorded, also while
 * Petrina runs or repairs product checks first. Final testing, and a repair of what it found, return straight to the
 * delivery check. A delivery check Petrina added never skips planned steps that have not run yet, such as the reviews a
 * task saved before repairs recorded their route still owes: that testing goes on through the rest of the plan.
 */
export function owedAcceptanceTest(task: Pick<Task, "repair" | "retest" | "repairCheck" | "stageIndex" | "plan" | "journey" | "proofDeliveryGate">): {
  stage: number;
  final: boolean
} | undefined {
  if (task.repair?.kind === "acceptance") return { stage: task.repair.returnStage, final: task.repair.final === true };
  if (!task.retest && !task.repairCheck) return undefined;
  const stage = task.repair?.returnStage ?? task.stageIndex;
  if (!task.retest) return { stage, final: false };
  const stages = task.plan?.stages ?? [];
  const gate = stages.findIndex((entry) => entry.kind === "gate" && entry.gate === "delivery");
  const skips = gate >= 0 && stages[gate]!.id === task.proofDeliveryGate && stages.slice(
    stage + 1,
    gate
  ).some((entry) => !task.journey?.some((step) => step.stageId === entry.id && step.endedAt !== undefined));
  return { stage, final: !skips };
}

/** A completed acceptance run whose results were saved, including a run Petrina invalidated that had nothing to report. */
const savedRun = (step: JourneyStep) => !!step.acceptanceChecks?.length || (step.acceptanceChecks !== undefined && !!step.proofRun?.restored);

/** The undone changes behind the latest saved acceptance run, while that leaves acceptance unverified. */
export function restoredAcceptance(task: Pick<Task, "journey" | "acceptanceUnverified">) {
  return task.acceptanceUnverified ? task.journey?.findLast((step) => step.kind === "agent" && step.endedAt !== undefined && step.acceptanceChecks !== undefined)?.proofRun?.restored : undefined;
}

/** Saved checklist items the latest acceptance run could not verify. The Tester's own extra probes are observations, never requirements. */
export function unverifiedRequirements(task: Pick<Task, "brief">) {
  return task.brief?.acceptance.filter((item) => item.verification === "blocked") ?? [];
}

/**
 * Required acceptance the latest run could not verify: a saved checklist item, requested proof, or the whole run when
 * Petrina invalidated it. It is never tried again unchanged; asking for changes at the delivery check clears it.
 */
export function requiredUnverified(task: Pick<Task, "brief" | "journey" | "acceptanceUnverified" | "proofRequests">): boolean {
  return task.acceptanceUnverified === true && (unverifiedRequirements(task).length > 0 || !!restoredAcceptance(task) || !!task.proofRequests?.some((request) => request.status === "unverified"));
}

/**
 * The required acceptance gap a delivery decision must cover: the latest saved run and each checklist item it could not
 * verify, or that Petrina invalidated that run. Undefined when every saved requirement has a result. Requested proof keeps its own decision.
 */
export function acceptanceGap(task: Pick<Task, "brief" | "journey" | "acceptanceUnverified">): AcceptanceGap | undefined {
  const items = unverifiedRequirements(task);
  const restored = restoredAcceptance(task);
  if (!items.length && !restored) return undefined;
  const run = task.journey?.findLast((step) => step.kind === "agent" && step.endedAt !== undefined && step.acceptanceChecks !== undefined);
  const reportIndex = run?.agentResults?.findLastIndex((report) => report.roleId === run.roleId) ?? -1;
  return {
    ...(run ? { stepId: run.id } : {}),
    ...(reportIndex >= 0 ? { reportIndex } : {}),
    items: items.map((item) => {
      const evidence = run?.acceptanceChecks?.find((check) => check.text === item.text)?.evidence;
      return {
        text: item.text,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(evidence ? { evidence } : {}),
        ...(item.productIds ? { productIds: [...item.productIds] } : {})
      };
    }),
    ...(restored ? { restored: true as const } : {}),
  };
}

/** A decision covers a gap only when it was about that same run and the same unverified items. */
export function sameAcceptanceGap(decided: AcceptanceGap | undefined, gap: AcceptanceGap): boolean {
  return !!decided && decided.stepId === gap.stepId && !!decided.restored === !!gap.restored && decided.items.length === gap.items.length && decided.items.every((
    item,
    index
  ) => item.text === gap.items[index]!.text);
}

/** A required acceptance gap without the coordinator's explicit decision about it: nothing is published while it lasts. */
export function undecidedAcceptanceGap(task: Pick<Task, "brief" | "journey" | "acceptanceUnverified" | "approvedAcceptanceGap">): AcceptanceGap | undefined {
  const gap = acceptanceGap(task);
  return gap && !sameAcceptanceGap(task.approvedAcceptanceGap, gap) ? gap : undefined;
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
  return {
    items,
    current: items.length > 0 && items.every((item) => item.current),
    partlyCurrent: items.some((item) => item.current) && items.some((item) => !item.current),
    started: testers.length > 0,
    notStarted: task.journey !== undefined && testers.length === 0,
    running
  };
}

export function acceptanceResultWords(check: JourneyAcceptanceCheck | undefined): string {
  return check?.result === "pass" ? "Passed" : check?.result === "fail" ? "Failed" : check?.result === "blocked" ? "Could not verify" : "Unavailable";
}
