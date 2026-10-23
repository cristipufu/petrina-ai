import { BUILT_IN_ROLES, findingCount, type Finding, type JourneyNode, type JourneyStep, type Role } from "@petrina/core";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Display saved reviewer evidence, including reopened reports omitted by older outcome strings. */
export function reviewOutcome(node: JourneyNode, role?: Role): string | undefined {
  const result = role?.result ?? BUILT_IN_ROLES.find(role => role.id === node.roleId)?.result;
  if (node.kind !== "agent" || node.state !== "done" || result !== "findings" || node.endedAt === undefined) return node.outcome;
  const open = node.result?.findings ? [...new Map(node.result.findings.map((finding) => [finding.id, finding])).values()].filter((finding) => finding.status === "open") : undefined;
  return open && (open.length || node.result?.findingsSettled) ? findingCount(open) : node.outcome;
}

export interface ReviewRoundGroups {
  fixed: Finding[];
  reopened: Finding[];
  fresh: Finding[];
  stillOpen: Finding[];
  dismissed: Finding[];
  fixedRecorded: boolean;
  settled: boolean;
}

/** Never read mutable task.findings: a later round must not change an earlier round's result. */
export function reviewRoundGroups(node: JourneyNode, steps: readonly JourneyStep[], resultFor: (id: string) => Role["result"] | undefined = (id) => BUILT_IN_ROLES.find((role) => role.id === id)?.result): ReviewRoundGroups | undefined {
  const index = steps.findIndex((step) => step.id === node.id);
  if (index < 0 || node.state !== "done" || node.endedAt === undefined || !node.result?.findings) return undefined;
  const prior = new Map<string, Finding>();
  let previousReview = -1;
  for (let i = 0; i < index; i++) {
    const step = steps[i]!;
    for (const finding of step.result?.findings ?? []) prior.set(finding.id, finding);
    if (step.kind === "agent" && step.roleId && resultFor(step.roleId) === "findings" && step.result?.findings !== undefined && step.endedAt !== undefined) previousReview = i;
  }
  const claims = new Map<string, { fixed: boolean; text: string; at: number }>();
  let fixedRecorded = true;
  for (const step of steps.slice(previousReview + 1, index)) {
    if (step.kind !== "agent" || !step.roleId || resultFor(step.roleId) !== "build") continue;
    if (step.fixing && !step.agentResults?.length) fixedRecorded = false;
    for (const result of step.agentResults ?? []) {
      const answers = object(result.value)?.answers;
      if (!Array.isArray(answers)) continue;
      for (const value of answers) {
        const answer = object(value);
        if (typeof answer?.id === "string" && typeof answer.fixed === "boolean" && typeof answer.text === "string") claims.set(answer.id, { fixed: answer.fixed, text: answer.text, at: result.at });
      }
    }
    if (step.findingIds?.some((id) => !claims.has(id))) fixedRecorded = false;
  }
  const confirms = new Set<string>();
  for (const result of steps[index]!.agentResults ?? []) {
    const values = object(result.value)?.confirms;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const id = typeof value === "string" ? value : object(value)?.id;
      if (typeof id === "string") confirms.add(id);
    }
  }
  const settled = node.result.findingsSettled === true;
  const groups: ReviewRoundGroups = { fixed: [], reopened: [], fresh: [], stillOpen: [], dismissed: [], fixedRecorded: settled || fixedRecorded, settled };
  const current = new Map(node.result.findings.map((finding) => [finding.id, finding]));
  const changes = node.result.findingChanges;
  const reopened = changes?.reopened ? new Set(changes.reopened.map(finding => finding.id)) : undefined;
  for (const finding of current.values()) {
    if (finding.status === "dismissed") { if (!changes || changes.dismissed.includes(finding.id)) groups.dismissed.push(finding); }
    else if (finding.status === "fixed") { if (!changes || changes.fixed.includes(finding.id)) groups.fixed.push(finding); }
    else if (reopened ? reopened.has(finding.id) : (finding.reopenedAt !== undefined && finding.reopenedAt >= (node.startedAt ?? Infinity) && finding.reopenedAt <= node.endedAt) || prior.get(finding.id)?.status === "fixed") groups.reopened.push(finding);
    else if (changes) (changes.raised.includes(finding.id) ? groups.fresh : groups.stillOpen).push(finding);
    else if (prior.has(finding.id) || confirms.has(finding.id) || finding.reopenedAt !== undefined) groups.stillOpen.push(finding);
    else groups.fresh.push(finding);
  }
  // A completed review keeps a builder's earlier fix closed unless this round reopens/disputes it.
  for (const [id, answer] of settled ? [] : claims) {
    const finding = prior.get(id);
    if (answer.fixed && finding && !current.has(id)) groups.fixed.push({ ...finding, status: "fixed", answer });
  }
  return groups;
}
