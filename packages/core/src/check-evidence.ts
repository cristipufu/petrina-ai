import type { CheckRun, JourneyProductCheck, RepositoryState, Task } from "./model.js";

export function checkResult(run: CheckRun): JourneyProductCheck["result"] {
  return run.interruption || run.interrupted ? "stopped" : run.ok ? "pass" : run.timedOut ? "did-not-finish" : "fail";
}

/** Recorded interruption qualifies the reported result without discarding it. */
export function checkCounts(checks: readonly JourneyProductCheck[]) {
  const results = checks.map((check) => check.run?.interruption || check.run?.interrupted ? "stopped" : check.result);
  return {
    failed: results.filter((result) => result === "fail" || result === "did-not-finish").length,
    unverified: results.filter((result) => result === "stopped" || result === "pending" || result === "running").length,
    passed: results.filter((result) => result === "pass").length,
  };
}

export function checkProblemWords(checks: readonly JourneyProductCheck[]): string {
  const { failed, unverified, passed } = checkCounts(checks);
  return [failed ? `${failed} still failing` : "", unverified ? `${unverified} unverified` : "", !failed && !unverified ? `${passed} passing` : ""].filter(Boolean).join(", ");
}

export function incompleteCheckOutcome(checks: readonly JourneyProductCheck[]): string | undefined {
  const { failed, unverified } = checkCounts(checks);
  if (!unverified) return undefined;
  if (failed) return `Checks: ${checkProblemWords(checks)}`;
  return checks.some((check) => check.run?.interruption) ? "Interrupted — verification incomplete" : "Stopped — verification incomplete";
}

/** Attempts stay separate across products, restarts and reused evidence. */
export function checkAttemptsOf(checks: readonly JourneyProductCheck[]) {
  const attempts = new Map<string, JourneyProductCheck[]>();
  for (const check of checks) {
    const id = `${check.productId ?? ""}:${check.reusedAt !== undefined ? check.run?.source?.stepId ?? "unknown" : ""}:${check.run?.source?.attemptId ?? check.attemptId ?? check.id?.match(/^run-\d+(?=:)/)?.[0] ?? "run-0"}:${check.reusedAt !== undefined ? "reused" : "executed"}`;
    const attempt = attempts.get(id) ?? [];
    attempt.push(check);
    attempts.set(id, attempt);
  }
  return [...attempts.entries()];
}

export function latestCheckResults(checks: readonly JourneyProductCheck[]): JourneyProductCheck[] {
  const products = new Map<string | undefined, { id: string; checks: JourneyProductCheck[] }>();
  for (const check of checks) {
    // Local attempt membership includes both fresh and reused checks. A reused result's source
    // identifies where its evidence came from, not which resumed attempt it belongs to now.
    const id = check.attemptId ?? check.id?.match(/^run-\d+(?=:)/)?.[0] ?? "run-0";
    const latest = products.get(check.productId);
    if (latest?.id === id) latest.checks.push(check);
    else products.set(check.productId, { id, checks: [check] });
  }
  return [...products.values()].flatMap((attempt) => attempt.checks);
}

/** Evidence becoming outdated never settles a recorded failure or interruption. */
export function checkProblem(task: Pick<Task, "repositories" | "checks">): "failing" | "unverified" | undefined {
  const checks = task.repositories ? task.repositories.map((work) => work.checks) : [task.checks];
  if (checks.some((entry) => entry?.results.some((run) => !run.ok && !run.interruption && !run.interrupted))) return "failing";
  if (checks.some((entry) => entry?.results.some((run) => run.interruption || run.interrupted))) return "unverified";
  return undefined;
}

export function checkDecisionLabel(task: Pick<Task, "repositories" | "checks">): string | undefined {
  const problem = checkProblem(task);
  return problem === "failing" ? "Your call: checks still failing" : problem ? "Your call: checks unverified" : undefined;
}

export function builderReturnWords(changed: boolean | undefined, problem: ReturnType<typeof checkProblem>, claimedFixes = 0): string {
  const returned = changed === false ? "No code changes" : changed ? "Changes returned" : "Code changes unavailable";
  const checks = problem === "failing" ? "; checks still failing" : problem ? "; checks unverified" : "";
  return `${returned}${checks}${claimedFixes ? `; ${claimedFixes} ${claimedFixes === 1 ? "fix claimed" : "fixes claimed"}` : ""}`;
}

export function reusedCheckWords(checks: readonly JourneyProductCheck[]): string {
  return `Previous checks reused — ${checkProblemWords(checks)}`;
}

/** A unique stored diagnostic identity can recover older provenance; names and commit ids cannot. */
export function originalCheck(task: Pick<Task, "journey">, run: CheckRun): { stepId: string; check: JourneyProductCheck } | undefined {
  const matches = task.journey?.flatMap((step) => step.productChecks?.flatMap((check) =>
    step.kind !== "you" && step.work !== "check-reuse" && check.reusedAt === undefined && (run.source ? step.id === run.source.stepId && check.id === run.source.checkId && check.attemptId === run.source.attemptId : !!run.logPath && check.run?.logPath === run.logPath)
      ? [{ stepId: step.id, check }] : []) ?? []) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** Snapshot only recorded evidence. Older records with no provenance keep that limitation. */
export function evidenceFor(task: Pick<Task, "journey">, work: Pick<RepositoryState, "productId" | "checks">): JourneyProductCheck[] {
  const saved = work.checks;
  if (!saved) return [];
  const latestReuse = task.journey?.findLast((step) => step.work === "check-reuse" && step.productChecks?.some((check) => check.productId === work.productId));
  const reusedAtFor = (source: CheckRun["source"], logPath?: string) => latestReuse?.productChecks?.find((check) => {
    const recorded = check.run?.source ?? check.source;
    return check.productId === work.productId && (source ? recorded?.stepId === source.stepId && recorded?.attemptId === source.attemptId && recorded?.checkId === source.checkId : !!logPath && check.run?.logPath === logPath);
  })?.reusedAt;
  const entries = saved.results.map((run, index): JourneyProductCheck => {
    const found = originalCheck(task, run);
    const original = found?.check;
    const source = run.source ?? (found && original?.id && original.attemptId ? { stepId: found.stepId, checkId: original.id, attemptId: original.attemptId } : undefined);
    const reusedAt = reusedAtFor(source, run.logPath);
    const recordedRun = { ...run, ...(source ? { source } : {}), ...(run.startedAt === undefined && original?.startedAt !== undefined ? { startedAt: original.startedAt } : {}), ...(run.endedAt === undefined && original?.endedAt !== undefined ? { endedAt: original.endedAt } : {}) };
    return { ...original, id: source?.checkId ?? `saved-${index}`, name: run.name, productId: work.productId, result: checkResult(run), run: recordedRun, ...(reusedAt !== undefined ? { reusedAt } : {}) };
  });
  const sources = new Set(entries.flatMap(({ run }) => run?.source ? [`${run.source.stepId}:${run.source.attemptId}`] : []));
  for (const step of task.journey ?? []) for (const check of step.productChecks ?? []) {
    if (check.result === "skipped" && sources.has(`${step.id}:${check.attemptId}`) && check.productId === work.productId) {
      const source = check.id && check.attemptId ? { stepId: step.id, attemptId: check.attemptId, checkId: check.id } : undefined;
      const reusedAt = reusedAtFor(source);
      entries.push({ ...check, ...(source ? { source } : {}), ...(reusedAt !== undefined ? { reusedAt } : {}) });
    }
  }
  return entries;
}

export function decisionEvidence(task: Pick<Task, "journey" | "repositories" | "productId" | "checks">): JourneyProductCheck[] {
  return (task.repositories ?? [task]).flatMap((work) => evidenceFor(task, work));
}

/** Latest return describes its turn; the task can still contain earlier changes. */
export function builderCheckSummary(task: Pick<Task, "journey" | "repositories" | "checks" | "state">): string | undefined {
  const returns = task.journey?.flatMap((step, index) => step.builderReturn ? [{ entry: step.builderReturn, index }] : []) ?? [];
  if (!returns.length) return undefined;
  const latest = new Map(returns.map((returned) => [returned.entry.productId, returned]));
  const works = task.repositories ?? [{ productId: latest.keys().next().value!, checks: task.checks }];
  return works.map((work) => {
    const returned = latest.get(work.productId);
    const entry = returned?.entry;
    const evidence = evidenceFor(task, work);
    const { failed, unverified } = checkCounts(evidence);
    const problem = failed ? "Checks still failing. " : unverified ? "Checks unverified. " : "";
    const outdated = !["done", "cancelled", "pr-open"].includes(task.state) && work.checks?.current === false;
    const earlier = failed ? ` Earlier checks failed.${unverified ? ` ${unverified} ${unverified === 1 ? "check was also unverified" : "checks were also unverified"}.` : ""}` : unverified ? " Earlier checks were unverified." : "";
    const status = outdated ? `Checks need updating.${earlier} ` : problem ? `${problem}${failed && unverified ? `${unverified} ${unverified === 1 ? "check also unverified" : "checks also unverified"}. ` : ""}` : work.checks?.results.length ? "Current checks passed. " : "Checks not recorded. ";
    // Reuse before this product's latest return describes earlier work, not this handoff.
    const following = task.journey?.slice((returned?.index ?? -1) + 1) ?? [];
    const reused = evidence.some((check) => check.reusedAt !== undefined && following.some((step) => step.work === "check-reuse" && step.productChecks?.some((recorded) => recorded.productId === work.productId && recorded.reusedAt === check.reusedAt)));
    const name = task.repositories ? `${task.repositories.find((repository) => repository.productId === work.productId)?.source?.product.name ?? work.productId}: ` : "";
    return `${name}${entry ? `${builderReturnWords(entry.changed, undefined, entry.claimedFixes)}. ` : ""}${status}${reused && !outdated ? "Previous check evidence reused." : ""}`.trim();
  }).join(" ");
}

export function matchesCheckLogIdentity(expected: { device: string; inode: string }, actual: { dev: bigint; ino: bigint }): boolean {
  return expected.device === actual.dev.toString() && expected.inode === actual.ino.toString();
}
