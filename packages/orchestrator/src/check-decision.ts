import {
  deliveryDecisionProblem,
  reviewDecisionPending,
  checkSetupOutcome,
  checkSetupWords,
  checkOutcome,
  checkOutcomeLabel,
  checkCounts,
  deliveryCheckProblem,
  evidenceFor,
  checkProblemTitle,
  lastIndexWhere,
  repositoryPublished,
  stepsFrom,
  endYouStep,
  JOURNEY_WORDS,
  type CheckRun,
  type Task
} from "@petrina/core";
import { executionFor, scopesFor, taskView } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import type { CheckDecisionHost } from "./ports/check-delivery.js";

/** The check problem's coordinator decision, independent of native execution and storage. */
export class CheckDecision {
  constructor(private readonly host: CheckDecisionHost) {}
  blocked(task: RuntimeTask): "stop" {
    const problem = this.problem(task);
    this.host.log(task, "warn", problem.line);
    this.host.gate(task, problem);
    return "stop";
  }

  /** What the coordinator reads at a check problem: each failing check, the Builder's turns and answers, where the task stopped and what comes after. */
  problem(task: RuntimeTask): { title: string; body: string; line: string } {
    const stages = task.plan?.stages ?? [];
    const shared = !!task.repositories;
    const pending = scopesFor(task).filter(scope => !repositoryPublished(scope.work));
    const failing = pending.flatMap((scope) => {
      const runs = scope.work.checks?.results.filter((run) => checkOutcome(run).kind !== "passed") ?? [];
      return runs.length ? [{ scope, runs, name: this.host.productName(scope) }] : [];
    });
    const names = failing.flatMap(({
      runs,
      name
    }) => runs.filter((run) => checkOutcome(run).kind === "failed").map((run) => shared ? `${name}: ${run.name}` : run.name));
    const unverifiedNames = failing.flatMap(({
      runs,
      name
    }) => runs.filter((run) => checkOutcome(run).kind !== "failed").map((run) => shared ? `${name}: ${run.name}` : run.name));
    const turns = (count: number) => `${count} automatic Builder ${count === 1 ? "turn" : "turns"}`;
    const setups = pending.filter(scope => scope.work.checkSetup || scope.work.checkSetupInvalidated).map(scope => {
      const setup = scope.work.checkSetup;
      return `${shared ? `${this.host.productName(scope)}: ` : ""}${checkSetupWords(checkSetupOutcome(setup, undefined,
        scope.work.checkSetupInvalidated?.id === setup?.input.invalidationId ? undefined : scope.work.checkSetupInvalidated))}. Setup is a local prerequisite, not a code finding. No automatic Builder turn is used for a setup blocker.`;
    });
    const sections = failing.map(({ scope, runs, name }) => {
      const attempts = scope.work.checkReturns ?? 0;
      const lines = runs.map((run) => {
        const finding = task.findings.findLast((entry) => entry.raisedBy === "petrina" && entry.text === `Check failed: ${run.name} (${run.command})` && (!shared || entry.productIds?.includes(scope.work.productId)));
        const answer = (shared ? finding?.answers?.[scope.work.productId] : undefined) ?? finding?.answer;
        return [
          `• ${run.name} ${checkOutcomeLabel(checkOutcome(run))}: ${diagnosticOf(run)}`,
          ...(run.interruption ? [`  ${run.interruption.source}: ${new Date(run.interruption.at).toLocaleString()} — ${run.interruption.event}`] : []),
          ...(answer ? [`  The Builder's last answer${answer.fixed ? ", saying it fixed this" : ""}: “${answer.text.trim()}”`] : []),
          ...(answer && !answer.fixed ? ["  Builder’s explanation — not independently confirmed. Only recorded machine evidence establishes interruption."] : []),
        ].join("\n");
      });
      const evidence = evidenceFor(task, scope.work);
      const reused = evidence.some((check) => check.reusedAt !== undefined);
      const fresh = evidence.some((check) => check.run && check.reusedAt === undefined);
      const { failed, unverified } = checkCounts(evidence);
      return [
        failed ? `${shared ? `${name}: s` : "S"}till failing after ${turns(attempts)}.${unverified ? ` ${unverified} ${unverified === 1 ? "check also unverified" : "checks also unverified"}.` : ""}` : `${shared ? `${name}: ` : ""}Checks unverified. Unavailable or incomplete execution does not use an automatic Builder turn.`,
        ...lines,
        ...(reused ? [fresh ? "Some previous check evidence reused; other checks ran in this attempt." : "Previous check evidence reused; no new execution."] : [])
      ].join("\n");
    });
    const builder = lastIndexWhere(
      stages,
      (
      entry,
      index
    ) => index < task.stageIndex && entry.kind === "do" && this.host.role(
      entry.roleId,
      task
    )?.result === "build"
    );
    const where = this.stoppedAt(task);
    const reviews = new Set(stages.filter((stage) => stage.kind === "review-chain").map((stage) => stage.id));
    const reviewed = Math.max(
      -Infinity,
      ...(task.journey ?? []).filter((step) => step.kind === "agent" && step.stageId && reviews.has(step.stageId) && step.endedAt !== undefined).map((step) => step.endedAt!)
    );
    const unconfirmed = task.findings.filter((finding) => finding.raisedBy !== "petrina" && finding.status !== "dismissed" && !/^(Failed|Could not verify) acceptance check:/.test(finding.text) && finding.answer?.fixed && finding.answer.at > reviewed).length;
    const view = { ...taskView(task), ...(builder >= 0 ? { stageIndex: builder, fixing: false } : {}) } as Task;
    const ahead = stepsFrom(this.host.state(), view, builder >= 0 ? builder + 1 : task.stageIndex);
    const body = [
      ...setups,
      ...sections,
      [
        `Stopped ${where}.`,
        ...(unconfirmed ? [`A reviewer has not yet confirmed ${unconfirmed === 1 ? "1 fix" : `${unconfirmed} fixes`} the Builder made for review findings.`] : []),
        ...(ahead.length ? [`${builder >= 0 ? "After the Builder's next turn, still to come" : "Still to come"}: ${ahead.join(", then ")}.`] : []),
      ].join(" "),
      `${builder >= 0 ? "Send back with a note to give the Builder one more turn. " : ""}Approving does not ship while checks fail or remain unverified. Run checks again explicitly requests fresh verification without approving delivery.`,
    ].join("\n\n");
    const attempts = shared ? "their automatic Builder turns" : turns(executionFor(task).work.checkReturns ?? 0);
    return {
      title: deliveryCheckProblem(taskView(task)) === "unverified" ? `Your call on “${task.title}”: checks unverified` : checkProblemTitle(
        task.title,
        names,
        unverifiedNames
      ),
      body,
      line: deliveryCheckProblem(taskView(task)) === "unverified" ? `Checks unverified (${unverifiedNames.join(", ")}), so Petrina waits for you ${where}` : `Checks still fail after ${attempts} (${names.join(", ")})${unverifiedNames.length ? `; unverified (${unverifiedNames.join(", ")})` : ""}, so Petrina waits for you ${where}`,
    };
  }

  /** The step the failing checks guard, in the coordinator's words. */
  private stoppedAt(task: RuntimeTask): string {
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return "before delivery";
    if (stage.kind === "gate") return stage.gate === "delivery" ? "before your delivery check" : `before ${stage.title.toLowerCase()}`;
    if (stage.kind === "review-chain") {
      const round = task.rounds[stage.id] ?? 1;
      return `before the ${stage.title.toLowerCase()}${round > 1 ? ` (round ${round})` : ""}`;
    }
    const result = this.host.role(stage.roleId, task)?.result;
    return result === "checks" ? "before acceptance testing" : result === "delivery" ? "before shipping" : `before ${stage.title.toLowerCase()}`;
  }
  /** Explicit verification withdraws approval without replenishing the failure episode. */
  rerun(task: RuntimeTask): void {
    for (const { work } of scopesFor(task)) {
      if (repositoryPublished(work)) continue;
      work.checkSetupInvalidated = { id: this.host.id(task), kind: "explicit-rerun", at: this.host.now() };
      if (work.checks) {
        delete work.checks.sha;
        delete work.checks.tree;
        work.checks.current = false;
      }
      delete work.approvedSha;
      delete work.approvedPatch;
      delete work.approvedFor;
    }
    this.host.log(task, "you", "You asked to run checks again on unchanged work; delivery is not approved");
    endYouStep(task, { outcome: "Run checks again", reason: JOURNEY_WORDS.checkAgain }, this.host.now());
  }
}

export function checkDiagnostic(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.replace(/^@[^|]+\|\s*/, "").trim());
  const failures = lines.filter((line) => /^\(fail\)\s/i.test(line));
  const causes = lines.filter((line) => /^(?:error|assertionerror):/i.test(line) || /^timed out waiting for\b/i.test(line));
  const detail = [...failures, ...causes].filter((line, index, all) => all.indexOf(line) === index).slice(0, 6).join("\n").slice(0, 1000);
  return detail || undefined;
}

function diagnosticOf(run: CheckRun): string {
  const detail = checkDiagnostic(run.output) ?? run.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join("\n");
  return (detail || "no output").slice(0, 600);
}

/** Validation precedes removing a coordinator decision; no check result can authorize its own approval. */
export function assertCheckApproval(task: RuntimeTask): void {
  if (!reviewDecisionPending(task) && deliveryDecisionProblem({ repositories: task.repositories, journey: task.journey, ...executionFor(task).work }))
    throw new Error("The product's checks are failing or unverified. Run the checks again or ask for changes; delivery has not been approved.");
}
