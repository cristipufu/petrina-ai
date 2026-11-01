// Journey node check, reuse, ask and settlement event emitters and check-basis helpers.
import { checkOutcomeLabel } from "./check-outcome.js";
import { outstandingReportsFirst } from "./finding-reports.js";
import { INBOX_CATALOG, INBOX_KINDS } from "./inbox-catalog.js";
import { JOURNEY_WORDS } from "./journey-words.js";
import type { Id, InboxKind, Role } from "./model.js";
import {
  claimsUnderTest,
  reviewEnd,
  type CheckFacts,
  type InboxFacts,
  type NodeFacts,
  type WorkflowContext,
  type WorkflowEventDraft,
  type WorkflowFacts,
} from "./workflow-facts.js";
import { reconcile, resultRefs, type FindingBaseline } from "./workflow-reconcile.js";
export type { FindingBaseline };

export const LEGACY_KINDS: Partial<Record<InboxKind, string>> = Object.fromEntries(
  INBOX_KINDS.flatMap((kind) => {
    const legacy = INBOX_CATALOG[kind].legacyWait;
    return legacy ? ([[kind, legacy]] as const) : [];
  }),
);

/**
 * The attempts recorded on a checks step, oldest first, each with its product. An attempt's entries are added
 * when it is queued and its versions when it runs, so one with nothing to run has versions only. Attempt
 * numbers never decrease within a step, which orders attempts whose records interleave.
 */
function stepAttempts(node: NodeFacts): { attemptId?: string; productId?: Id }[] {
  const seen = new Map<string, { attemptId?: string; productId?: Id }>();
  for (const record of [...node.checks, ...node.checked]) {
    const key = `${record.attemptId ?? ""}|${record.productId ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, {
        ...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
        ...(record.productId ? { productId: record.productId } : {}),
      });
    }
  }
  const number = (id: string | undefined): number => {
    const match = /(\d+)$/.exec(id ?? "");
    return match ? Number(match[1]) : -1;
  };
  return [...seen.values()].sort((a, b) => number(a.attemptId) - number(b.attemptId));
}

/**
 * One attempt on a checks step: the named one, a product's latest, or the step's latest, with how many attempts
 * that product made on the step. A run interrupted and resumed on the same step keeps the stopped attempt as
 * history. Records without a product (an older single-product step) stand in when the product named has none.
 */
function checkAttempt(
  node: NodeFacts,
  select: {
    attemptId?: string;
    productId?: Id;
  } = {},
): {
  attemptId?: string;
  productId?: Id;
  checks: CheckFacts[];
  attempts: number;
} {
  const all = stepAttempts(node);
  const chosen =
    select.attemptId !== undefined
      ? all.findLast(
          (attempt) =>
            attempt.attemptId === select.attemptId
            && (select.productId === undefined || attempt.productId === select.productId),
        )
      : (all.findLast((attempt) => select.productId === undefined || attempt.productId === select.productId)
        ?? all.findLast((attempt) => attempt.productId === undefined));
  if (!chosen) return { checks: [], attempts: 0 };
  return {
    ...(chosen.attemptId !== undefined ? { attemptId: chosen.attemptId } : {}),
    ...(chosen.productId ? { productId: chosen.productId } : {}),
    checks: node.checks.filter((check) => check.attemptId === chosen.attemptId && check.productId === chosen.productId),
    attempts: all.filter((attempt) => attempt.productId === chosen.productId).length,
  };
}

/** Each entry counts once: completed with a verdict, stopped or still waiting, or skipped. */
function checkTally(checks: readonly CheckFacts[]): {
  configured: number;
  ran: number;
  passed: number;
  failed: number;
  unfinished: number;
  skipped: number;
} {
  const count = (test: (check: CheckFacts) => boolean) => checks.filter(test).length;
  return {
    configured: checks.length,
    ran: count((check) => check.result === "pass" || check.result === "fail"),
    passed: count((check) => check.result === "pass"),
    failed: count((check) => check.result === "fail"),
    unfinished: count((check) => ["stopped", "did-not-finish", "pending", "running"].includes(check.result)),
    skipped: count((check) => check.result === "skipped"),
  };
}

/** The recorded versions of exactly this attempt; an older record without attempt identities keeps its latest, and nothing borrows another attempt's. */
function attemptVersions(
  node: NodeFacts,
  attemptId: string | undefined,
  productId?: Id,
): NodeFacts["checked"][number] | null {
  return (
    (attemptId === undefined
      ? node.checked.at(-1)
      : node.checked.findLast(
          (entry) => entry.attemptId === attemptId && (productId === undefined || entry.productId === productId),
        )) ?? null
  );
}

type CheckBasis = Record<string, unknown> & { productId?: Id; basis: string; passed?: boolean | null };

/**
 * On what basis a tester, reviewer or voter could start: for each of the task's products, the latest run or
 * reuse before this node, or none. `none-configured` is recorded evidence that there was nothing to run (an
 * attempt with versions but no entries, or a reuse of one); `passed` is then `null`, because nothing passed.
 * A reconstructed older step says nothing. Review and acceptance check every product in turn, so a single
 * product reads flat, and several are listed in task order and combined.
 */
export function checkBasisFor(facts: WorkflowFacts, node: NodeFacts): Record<string, unknown> {
  const products = facts.works.map((work) => work.productId);
  // Older records without a product belong to a single product's task; on a shared task they stay unattributed.
  const key = (productId: Id | undefined): Id | undefined =>
    productId ?? (products.length === 1 ? products[0] : undefined);
  const latest = new Map<Id | undefined, { at: number; value: CheckBasis }>();
  const consider = (productId: Id | undefined, at: number, value: CheckBasis) => {
    const have = latest.get(productId);
    if (!have || at >= have.at) latest.set(productId, { at, value: { ...(productId ? { productId } : {}), ...value } });
  };
  for (const entry of facts.nodes) {
    if (entry.index >= node.index) break;
    const checksStep = entry.kind === "petrina" && entry.work === "checks";
    const refs = { node: { taskId: facts.id, nodeId: entry.id } };
    if (checksStep && entry.endedAt !== undefined) {
      const attempted = [...new Set(stepAttempts(entry).map((attempt) => attempt.productId))];
      for (const productId of attempted.length ? attempted : [undefined]) {
        const attempt = checkAttempt(entry, { productId });
        const tally = checkTally(attempt.checks);
        const none = tally.configured === 0;
        consider(
          key(productId),
          entry.endedAt,
          entry.legacy && none
            ? { basis: "unavailable", nodeId: entry.id, refs }
            : {
                basis: none ? "none-configured" : tally.unfinished && !tally.ran ? "unfinished" : "ran",
                nodeId: entry.id,
                ...(attempt.attemptId ? { attemptId: attempt.attemptId } : {}),
                attempts: attempt.attempts,
                passed: none ? null : tally.ran > 0 && !tally.failed && !tally.unfinished,
                ran: tally.ran,
                failed: tally.failed,
                unfinished: tally.unfinished,
                configured: tally.configured,
                versions: attemptVersions(entry, attempt.attemptId, attempt.productId),
                refs,
              },
        );
      }
    }
    for (const reuse of entry.reuses) {
      if (reuse.at > node.startedAt) continue;
      // A reused attempt that recorded its versions but no entries had nothing to run.
      const none =
        checksStep
        && reuse.attemptId !== undefined
        && entry.checked.some(
          (version) =>
            version.attemptId === reuse.attemptId && (!reuse.productId || version.productId === reuse.productId),
        )
        && checkAttempt(entry, {
          attemptId: reuse.attemptId,
          ...(reuse.productId ? { productId: reuse.productId } : {}),
        }).checks.length === 0;
      consider(key(reuse.productId), reuse.at, {
        basis: none ? "none-configured" : "reused",
        reused: true,
        nodeId: entry.id,
        ...(reuse.attemptId ? { attemptId: reuse.attemptId } : {}),
        passed: none ? null : reuse.passed,
        ...(none ? { configured: 0 } : {}),
        purpose: reuse.purpose,
        reuseBasis: reuse.basis,
        originalAt: reuse.originalAt,
        versions: {
          ...(reuse.sha ? { sha: reuse.sha } : {}),
          ...(reuse.tree ? { tree: reuse.tree } : {}),
          ...(reuse.definition ? { definition: reuse.definition } : {}),
        },
        refs,
      });
    }
  }
  const listed: CheckBasis[] = [
    ...products.map((productId) => latest.get(productId)?.value ?? { productId, basis: "unavailable" }),
    ...[...latest]
      .filter(([productId]) => productId === undefined || !products.includes(productId))
      .map(([, entry]) => entry.value),
  ];
  if (listed.length <= 1) return listed[0] ?? { basis: "unavailable" };
  const name = (productId: Id | undefined) =>
    facts.works.find((work) => work.productId === productId)?.productName ?? productId ?? "unattributed product";
  const bases = new Set(listed.map((entry) => entry.basis));
  const passes = listed.map((entry) => entry.passed);
  // Combined: any failure or unfinished run fails; a missing record leaves it unknown; nothing configured anywhere is null.
  const passed = passes.includes(false)
    ? false
    : passes.includes(undefined)
      ? undefined
      : passes.every((value) => value === null)
        ? null
        : true;
  return {
    basis: bases.size === 1 ? [...bases][0] : "mixed",
    ...(passed !== undefined ? { passed } : {}),
    summary: listed.map((entry) => `${name(entry.productId)}: ${checkBasisWords(entry)}`).join("; "),
    products: listed,
    refs: {
      nodes: listed.flatMap((entry) =>
        typeof entry.nodeId === "string"
          ? [
              {
                taskId: facts.id,
                nodeId: entry.nodeId,
              },
            ]
          : [],
      ),
    },
  };
}

/** Plain words for one product's basis. */
function checkBasisWords(entry: CheckBasis): string {
  switch (entry.basis) {
    case "ran":
      return entry.passed
        ? "checks ran and passed"
        : entry.failed
          ? `checks ran, ${entry.failed} failed`
          : "checks ran and did not all pass";
    case "reused":
      return `checks reused (${entry.passed ? "passing" : "failing"} run)`;
    case "none-configured":
      return `${JOURNEY_WORDS.noChecks}${entry.reused ? " (reused)" : ""}`;
    case "unfinished":
      return "checks did not finish";
    default:
      return "no check evidence recorded";
  }
}

export function emitNodeChecksAndEnd({
  node,
  fresh,
  old,
  role,
  at,
  before,
  next,
  ctx,
  baselines,
  carried,
  settledItems,
  push,
}: {
  node: NodeFacts;
  fresh: boolean;
  old: NodeFacts | undefined;
  role: Pick<Role, "id" | "name" | "result"> | undefined;
  at: { nodeId: Id; stageId?: Id };
  before: WorkflowFacts;
  next: WorkflowFacts;
  ctx: WorkflowContext;
  baselines: Map<Id, FindingBaseline>;
  carried: readonly InboxFacts[];
  settledItems: Set<Id>;
  push: (draft: Omit<WorkflowEventDraft, "taskId" | "productIds">) => void;
}): void {
  for (const check of node.checks) {
    const earlier = fresh ? undefined : old!.checks.find((entry) => entry.index === check.index);
    const ref = { check: { taskId: next.id, nodeId: node.id, index: check.index } };
    const terminal = !["pending", "running"].includes(check.result);
    if (!earlier) {
      push({
        at: check.queuedAt ?? node.startedAt,
        kind: "check.queued",
        ...at,
        summary: `${check.name} queued`,
        name: check.name,
        ...(check.attemptId ? { attemptId: check.attemptId } : {}),
        ...(check.productId ? { productId: check.productId } : {}),
        refs: ref,
      });
    }
    if ((!earlier || earlier.result === "pending") && (check.result === "running" || (terminal && check.startedAt !== undefined))) {
      push({
        at: check.startedAt ?? node.startedAt,
        kind: "check.started",
        ...at,
        summary: `${check.name} started`,
        name: check.name,
        ...(check.attemptId ? { attemptId: check.attemptId } : {}),
        ...(check.productId ? { productId: check.productId } : {}),
        refs: ref,
      });
    }
    if (terminal && (!earlier || earlier.result !== check.result)) {
      push({
        at: check.endedAt ?? ctx.now,
        kind: "check.finished",
        ...at,
        summary: `${check.name}: ${
          check.commandOutcome && (check.commandOutcome.kind === "incomplete" || check.commandOutcome.kind === "unavailable")
            ? checkOutcomeLabel(check.commandOutcome)
            : check.result === "pass"
              ? "passed"
              : check.result === "fail"
                ? "failed"
                : check.result === "did-not-finish"
                  ? "did not finish"
                  : check.result
        }${check.ms !== undefined ? ` in ${Math.max(1, Math.round(check.ms / 1000))}s` : ""}${
          check.detail ? `: ${check.detail.split("\n")[0]}` : ""
        }`,
        name: check.name,
        result: check.result,
        ...(check.commandOutcome ? { commandOutcome: check.commandOutcome } : {}),
        ...(check.previousRunOutcome ? { previousRunOutcome: check.previousRunOutcome } : {}),
        ...(check.reportedResult ? { reportedResult: check.reportedResult } : {}),
        ...(check.ok !== undefined ? { ok: check.ok } : {}),
        ...(check.attemptId ? { attemptId: check.attemptId } : {}),
        ...(check.productId ? { productId: check.productId } : {}),
        ...(check.logRecorded !== undefined
          ? {
              log: check.logRecorded
                ? check.logComplete === false
                  ? "incomplete"
                  : check.logComplete
                    ? "complete"
                    : "unverified"
                : "excerpt-only",
            }
          : {}),
        ...(check.detail ? { detail: check.detail } : {}),
        versions: check.attemptId
          ? (node.checked.find((entry) => entry.attemptId === check.attemptId && entry.productId === check.productId) ?? null)
          : null,
        refs: ref,
      });
    }
  }
  for (const [position, reuse] of node.reuses.entries()) {
    if (!fresh && old!.reuses[position]) continue;
    push({
      at: reuse.at,
      kind: "check.reused",
      ...at,
      summary: `Checks reused for ${reuse.purpose}: the ${reuse.passed ? "passing" : "non-passing"} evidence from ${node.name} still covers the same ${reuse.basis === "same-tree" ? "code" : "commit"} and check definitions`,
      purpose: reuse.purpose,
      ...(reuse.attemptId ? { attemptId: reuse.attemptId } : {}),
      basis: reuse.basis,
      passed: reuse.passed,
      originalAt: reuse.originalAt,
      ...(reuse.productId ? { productId: reuse.productId } : {}),
      ...(reuse.sha ? { sha: reuse.sha } : {}),
      ...(reuse.tree ? { tree: reuse.tree } : {}),
      ...(reuse.definition ? { definition: reuse.definition } : {}),
      refs: {
        node: {
          taskId: next.id,
          nodeId: node.id,
        },
        checks: node.checks
          .filter((check) => check.ok !== undefined && (!reuse.attemptId || check.attemptId === reuse.attemptId))
          .map((check) => ({
            taskId: next.id,
            nodeId: node.id,
            index: check.index,
          })),
      },
    });
  }
  for (const ask of node.asks) {
    const earlier = fresh ? undefined : old!.asks.find((entry) => entry.id === ask.id);
    if (earlier && earlier.endedAt === undefined && ask.endedAt !== undefined) {
      settledItems.add(ask.id);
      push({
        at: ask.endedAt,
        kind: "coordinator.decision",
        ...at,
        summary: `${ask.kind === "question" ? "Question" : "Permission"} ${ask.how ?? "settled"}${ask.answer ? `: ${ask.answer}` : ""}: ${ask.title}`,
        requestKind: ask.kind,
        itemId: ask.id,
        how: ask.how ?? "unknown",
        ...(ask.answer ? { answer: ask.answer } : {}),
        title: ask.title,
        refs: {
          conversation: {
            taskId: next.id,
            nodeId: node.id,
          },
        },
      });
    }
  }
  if (node.endedAt !== undefined && (fresh || old!.endedAt === undefined)) {
    // Settlement proves the whole group reported, including work kept through Try again on earlier steps.
    // Without that proof, only a step holding every required hand-back gets a completed review summary.
    const review =
      node.kind === "agent" && (role?.result === "findings" || role?.result === "votes") ? reviewEnd(node) : undefined;
    const reviewNodes =
      review?.examined && node.reviewSteps
        ? next.nodes.filter((entry) => node.reviewSteps!.includes(entry.id))
        : [node];
    const reconciliation = review?.examined
      ? reconcile(
          baselines.get(node.id) ?? {
            findings: before.findings,
            since: "engine-start",
            claims: claimsUnderTest(
              {
                nodes: next.nodes,
                findings: before.findings,
              },
              node,
              ctx.roles,
            ),
          },
          next.findings,
        )
      : undefined;
    // A restart can observe this node after settlement. Keep the saved round's decisions,
    // rather than attributing them to the engine-start population baseline.
    if (reconciliation && node.findingChanges) Object.assign(reconciliation, node.findingChanges);
    // A run resumed on the same step keeps its stopped attempt as history; the step's result is its latest attempt.
    const attempt = node.kind === "petrina" && node.work === "checks" ? checkAttempt(node) : undefined;
    const checkSummary = attempt
      ? {
          ...(attempt.attemptId ? { attemptId: attempt.attemptId } : {}),
          ...(attempt.productId ? { productId: attempt.productId } : {}),
          attempts: attempt.attempts,
          ...checkTally(attempt.checks),
        }
      : undefined;
    push({
      at: node.endedAt,
      kind: "node.finished",
      ...at,
      summary: `${node.name}: ${node.outcome ?? node.end ?? "ended"}${node.reason ? ` (${node.reason})` : ""}${
        review && !review.examined
          ? `; no completed review (${review.acceptedResults} of ${review.seats} accepted result${review.seats === 1 ? "" : "s"})`
          : ""
      }`,
      nodeKind: node.kind,
      ...(node.roleId ? { roleId: node.roleId } : {}),
      ...(node.profileId ? { profileId: node.profileId } : {}),
      ...(node.work ? { work: node.work } : {}),
      ...(node.waitsFor ? { waitsFor: node.waitsFor } : {}),
      ...(node.outcome ? { outcome: node.outcome } : {}),
      ...(node.reason ? { reason: node.reason } : {}),
      end: node.end ?? "done",
      ...(node.tone ? { tone: node.tone } : {}),
      elapsedMs: Math.max(0, node.endedAt - node.startedAt),
      ...(node.localSetup ? { localSetup: node.localSetup } : {}),
      ...(node.acceptance ? { acceptance: node.acceptance } : {}),
      ...(attempt && checkSummary
        ? {
            checks: checkSummary,
            versions: attemptVersions(node, attempt.attemptId, attempt.productId),
          }
        : {}),
      ...(role?.result === "build" ? { checks: "separate-step" } : {}),
      ...(review ? { review } : {}),
      refs: {
        node: {
          taskId: next.id,
          nodeId: node.id,
        },
        ...(attempt
          ? {
              checks: attempt.checks
                .filter((check) => check.ok !== undefined)
                .map((check) => ({
                  taskId: next.id,
                  nodeId: node.id,
                  index: check.index,
                })),
            }
          : {}),
        ...(review && !review.examined && node.results.length ? { results: resultRefs(next.id, node) } : {}),
      },
    });
    if (reconciliation) {
      const counts = reconciliation.reportCounts.closing;
      const reports = outstandingReportsFirst(next.findings).map((finding) => {
        const result = node.results.find((entry) => entry.findingIds?.includes(finding.id));
        const read = { taskId: next.id, nodeId: node.id, findingId: finding.id };
        return {
          id: finding.id,
          text: finding.text,
          severity: finding.severity,
          status: finding.status,
          productIds: finding.productIds ?? [],
          ...(finding.held ? { heldForDecision: true } : {}),
          ...(finding.tracking ? { tracking: finding.tracking } : {}),
          evidence: node.resultFindings.some((copy) => copy.id === finding.id)
            ? { read }
            : result
              ? {
                  read: {
                    ...read,
                    result: result.index,
                  },
                }
              : { unavailable: "This review saved no copy of this report. Current status may differ." },
        };
      });
      push({
        at: node.endedAt,
        kind: "review.finished",
        ...at,
        summary: `${node.name} finished: ${reconciliation.opening} ${reconciliation.opening === 1 ? "report" : "reports"} before, ${reconciliation.closing} after; ${counts.open.total} open ${counts.open.total === 1 ? "report" : "reports"} (${counts.open.important} Important, ${counts.open.nits} ${counts.open.nits === 1 ? "nit" : "nits"}, ${counts.open.preExisting} pre-existing ${counts.open.preExisting === 1 ? "follow-up" : "follow-ups"})${
          reconciliation.heldForDecision
            ? `; ${reconciliation.heldForDecision.length === 1 ? "1 of the Important is an acceptance failure" : `${reconciliation.heldForDecision.length} of the Important are acceptance failures`} held for your delivery decision, not review work`
            : ""
        }; raised ${reconciliation.raised.length}, fixed ${reconciliation.fixed.length}, reopened ${reconciliation.reopened.length}, dismissed ${reconciliation.dismissed.length}, unverified ${reconciliation.unverified.length}`,
        ...reconciliation,
        reports,
        omitted: {
          reportBodies: "Use each report’s evidence.read for full text, answers and verification, or its unavailable reason.",
        },
        ...(role ? { roleId: node.roleId } : {}),
        ...(node.team ? { team: node.team } : {}),
        refs: {
          node: {
            taskId: next.id,
            nodeId: node.id,
          },
          ...(node.reviewInput
            ? {
                reviewInput: {
                  taskId: next.id,
                  nodeId: node.id,
                },
              }
            : {}),
          findings: {
            taskId: next.id,
            nodeId: node.id,
          },
          results: reviewNodes.flatMap((entry) => resultRefs(next.id, entry)),
          inputs: reviewNodes.flatMap((entry) =>
            entry.inputs.map((input) => ({
              taskId: next.id,
              nodeId: entry.id,
              seat: input.seat,
              index: input.attempt - 1,
            })),
          ),
          currentRequests: { taskId: next.id },
        },
      });
    }
    if (node.kind === "you") {
      const item = [...carried, ...before.inbox].find(
        (entry) => LEGACY_KINDS[entry.kind] === node.waitsFor && !next.inbox.some((current) => current.id === entry.id),
      );
      if (item) settledItems.add(item.id);
      push({
        at: node.endedAt,
        kind: "coordinator.decision",
        ...at,
        summary: `${node.name}: ${node.outcome ?? "decided"}${node.reason ? ` (${node.reason})` : ""}`,
        requestKind: item?.kind ?? node.waitsFor,
        ...(item
          ? {
              itemId: item.id,
              title: item.title,
            }
          : {}),
        how: node.outcome ?? "decided",
        ...(node.reason ? { reason: node.reason } : {}),
      });
    }
  }
}
