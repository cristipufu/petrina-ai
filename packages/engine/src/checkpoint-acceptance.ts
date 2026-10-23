// Compact recorded evidence only. This projection never supplies an acceptance verdict to the engine.
import { acceptanceSummary, recordedAcceptance, resultSeatOf, roleForTask, seatOf, type Role, type Task } from "@petrina/core";

const CHECK_LIMIT = 8, ATTEMPT_LIMIT = 4;
const clip = (text: string, limit: number) => {
  const chars = Array.from(text);
  return { text: chars.slice(0, limit).join(""), shortened: chars.length > limit };
};

export function checkpointAcceptance(task: Task, roles: readonly Role[]) {
  const roleFor = (id?: string) => id ? roleForTask(roles, id, task) : undefined;
  const run = recordedAcceptance(task, roleFor);
  const { step, report, reportIndex, testers, edits } = run;
  const tested = report?.versions;
  const checks = step?.acceptanceChecks ?? [];
  const nodeRead = (nodeId: string) => ({ operation: "journey.node", taskId: task.id, nodeId });
  const planned = task.plan?.stages.some((stage) => roleFor(stage.roleId)?.result === "checks");
  const missing = testers.length ? "Testing ran but recorded no completed check results." : planned ? "Testing has not run yet." : "No testing step is planned or recorded.";
  const works = task.repositories ?? (task.repository ? [task.repository] : [task]);
  const products = works.map((work) => {
    const tree = tested?.[work.productId];
    const latest = work.checks;
    const base = { productId: work.productId, testedTree: tree ?? null, checkedTree: latest?.tree ?? null };
    const answer = (state: "same-contents" | "same-change" | "changed" | "unknown", reason: string) => ({ ...base, state, reason });
    if (!step || !tree || tree === "unavailable") return answer("unknown", "This testing run has no available saved contents for this product.");
    // Match the shared summary's per-product final-edit rule, including restored contents.
    const edit = edits.find((later) => {
      const versions = later.buildVersions ?? later.agentResults?.findLast((entry) => entry.roleId === later.roleId)?.versions;
      return versions && Object.keys(versions).length ? work.productId in versions : !later.buildProductId || later.buildProductId === work.productId;
    });
    const built = edit?.buildVersions ?? edit?.agentResults?.findLast((entry) => entry.roleId === edit.roleId)?.versions;
    if (edit && (edit.endedAt === undefined || !built?.[work.productId] || built[work.productId] === "unavailable")) return answer("unknown", "A later editing step has no finished contents snapshot for this product.");
    if (edit && built?.[work.productId] !== tree && (!latest?.tree || latest.tree === "unavailable" || latest.current !== true)) return answer("changed", "A later completed edit records different contents for this product.");
    if (!latest?.tree || latest.tree === "unavailable") return answer("unknown", "No checked contents were saved for this product.");
    // A non-current run can reflect changed commands or incomplete proof, not changed contents.
    if (latest.current !== true) return answer("unknown", "The saved checks do not establish the current contents of this product.");
    if (latest.tree === tree && (!edit || built?.[work.productId] === tree)) return answer("same-contents", "The testing run and current saved checks record the same contents; any later edit also records those contents.");
    // The task-wide patch belongs to this run only when its complete version map agrees.
    // The checked patch must likewise be bound to the latest checks, never an older approval.
    const boundTest = step.acceptancePatch && step.acceptancePatch === task.testedPatch && testers.findLast((entry) => entry.endedAt !== undefined) === step && tested && Object.keys(tested).length > 0 && task.testedVersions &&
      Object.keys(tested).length === Object.keys(task.testedVersions).length &&
      Object.entries(tested).every(([id, version]) => task.testedVersions![id] === version);
    const boundCheck = work.checkedSha && work.checkedSha === latest.sha;
    if (!task.repositories && latest.tree !== tree && boundTest && boundCheck && task.testedPatch && work.checkedPatch &&
      (!edit || built?.[work.productId] === latest.tree)) {
      if (task.testedPatch === work.checkedPatch) return { ...answer("same-change", "Same change, the main code underneath moved: the tested change matches the checked change, bound to this run and the latest checks."), testedPatch: task.testedPatch, checkedPatch: work.checkedPatch };
      return answer("changed", "The saved tested change differs from the change bound to the latest checks.");
    }
    if (edit && built?.[work.productId] !== tree) return answer("changed", "A later completed edit records different contents for this product.");
    if (task.repositories) return answer("changed", "This product's current checked contents differ from its contents in the testing run.");
    return answer("unknown", "Checked contents differ; no matching tested and checked change records establish whether only the underlying main code moved.");
  });
  const sorted = checks.map((check, index) => ({ check, index })).sort((a, b) => Number(a.check.result === "pass") - Number(b.check.result === "pass"));
  const listed = sorted.slice(0, CHECK_LIMIT).map(({ check, index }) => {
    const text = clip(check.text, 240), reason = check.reason === undefined ? undefined : clip(check.reason, 400);
    const evidence = !reason && check.result !== "pass" && check.evidence ? clip(check.evidence, 400) : undefined;
    return { index, text: text.text, result: check.result, kind: task.brief?.acceptance.some((item) => item.text === check.text) ? "requirement" : "additional", ...(reason ? { reason: reason.text } : {}), ...(evidence ? { evidence: evidence.text } : {}), evidenceRecorded: !!check.evidence, shortened: text.shortened || reason?.shortened === true || evidence?.shortened === true };
  });
  const otherRuns = testers.filter((entry) => entry !== step).reverse();
  const seat = step && report && resultSeatOf(step, report, roles, task);
  const inputIndex = report ? report.inputIndex ?? step?.agentInputs?.findLastIndex((input) => input.roleId === report.roleId && input.profileId === report.profileId && (input.at ?? 0) <= report.at) : undefined;
  const input = inputIndex !== undefined ? step?.agentInputs?.[inputIndex] : undefined;
  // journey.input indexes attempts within a seat, whereas saved results index all node inputs.
  const inputAttempt = input && seat && seatOf(input, roles, task) === seat && input.roleId === report?.roleId && input.profileId === report.profileId
    ? step!.agentInputs!.slice(0, inputIndex).filter((entry) => seatOf(entry, roles, task) === seat).length : undefined;
  const summary = acceptanceSummary(task, roleFor);
  return {
    passed: task.acceptancePassed ?? null, blocked: task.acceptanceBlocked ?? false, unverified: task.acceptanceUnverified ?? false,
    testedPatch: task.testedPatch ?? null, testedVersions: task.testedVersions ?? null,
    // Preserve the original design requirements independently of this run's report.
    items: task.brief?.acceptance ?? [],
    requirements: {
      state: task.brief ? "recorded" : "no-brief",
      ...(!task.brief ? { message: "No design brief recorded; no design requirement list is available. See testing evidence below." } : {}),
      results: summary.items.map((item, index) => ({ index, result: item.check?.result ?? "not-reported", current: item.current })),
    },
    evidence: {
      state: checks.length ? "recorded" : "unavailable",
      ...(!checks.length ? { reason: missing } : {}),
      counts: { passed: checks.filter((check) => check.result === "pass").length, failed: checks.filter((check) => check.result === "fail").length, couldNotVerify: checks.filter((check) => check.result === "blocked").length },
      checks: listed, omittedChecks: checks.length - listed.length,
      shortened: checks.length > listed.length || listed.some((entry) => entry.shortened),
      ...(step ? {
        nodeId: step.id, read: nodeRead(step.id),
        ...(report ? { report: { operation: "journey.result", taskId: task.id, nodeId: step.id, index: reportIndex, ...(seat ? { seat } : {}) } } : { reportUnavailable: "No original participant report was retained on this step." }),
        ...(inputAttempt !== undefined ? { inputs: { operation: "journey.input", taskId: task.id, nodeId: step.id, seat, index: inputAttempt } } : { inputsUnavailable: "No exact input reference for this participant report was retained. Any saved instructions remain on the step." }),
      } : {}),
      products,
      otherRuns: otherRuns.slice(0, ATTEMPT_LIMIT).map((entry) => {
        const name = clip(task.plan?.stages.find((stage) => stage.id === entry.stageId)?.title ?? roleFor(entry.roleId)?.name ?? "Acceptance testing", 120);
        return { nodeId: entry.id, name: name.text, shortened: name.shortened, round: entry.round, ...(step ? { position: task.journey!.indexOf(entry) > run.index ? "later" : "earlier" } : {}), state: entry.endedAt === undefined ? "unfinished" : entry.acceptanceChecks?.length ? "recorded" : "no-results", read: nodeRead(entry.id) };
      }),
      omittedRuns: Math.max(0, otherRuns.length - ATTEMPT_LIMIT),
      otherRunsShortened: otherRuns.length > ATTEMPT_LIMIT,
      ...(otherRuns.length > ATTEMPT_LIMIT ? { runsRead: { operation: "journey.list", taskId: task.id } } : {}),
    },
  };
}
