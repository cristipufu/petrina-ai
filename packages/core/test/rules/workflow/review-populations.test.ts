import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";
import { workflowEvents, workflowFacts, type Finding, type InboxItem, type JourneyStep, type TaskRepository, type TaskState, type WorkflowContext } from "../../../src/index.js";

const state = stateFixture({ now: 1_000_000, products: [{ id: "shop", name: "Shop", repo: "local/shop", tone: "blue" }, { id: "notes", name: "Notes", repo: "local/notes", tone: "green" }, { id: "billing", name: "Billing", repo: "local/billing", tone: "blue" }] });

const ctx = (inbox: InboxItem[] = [], now = 5_000): WorkflowContext => ({ roles: state.roles, profiles: state.profiles, inbox, products: state.products.map(({ id, name }) => ({ id, name })), now });

function task(changes: Partial<TaskState> = {}, work: Partial<TaskRepository> = {}): TaskState {
  const base = taskFixture(state, { id: "h1", title: "Workflow event fixture", kind: "bug", state: "running", delivery: "pull-request", stageIndex: 0, selectedProducts: undefined });
  const { pr: _pr, release: _release, landed: _landed, localUpdate: _local, shipping: _shipping, cleanup: _cleanup, ...rest } = base;
  const repository = { productId: base.productId, delivery: base.delivery, ...work };
  return { ...rest, repository, journey: [], findings: [], state: "running", statusLine: "Working", ...changes } as unknown as TaskState;
}

const seated = (step: JourneyStep, seats: readonly (readonly [key: string, profileId: string])[] = [["0", step.profileId!]]): JourneyStep => ({ ...step, agentInputs: [...(step.agentInputs ?? []), ...seats.map(([reviewerKey, profileId]) => ({ at: step.startedAt, roleId: step.roleId!, profileId, reviewerKey, requestedProfileId: profileId, taskTitle: "T", sections: [], mode: "fresh" as const }))] });

const handedBack = (step: JourneyStep, at = (step.endedAt ?? step.startedAt) - 1): JourneyStep => ({ ...step, agentResults: (step.agentInputs ?? []).map((input, inputIndex) => ({ roleId: input.roleId, profileId: input.profileId, at, value: { findings: [], verdict: "pass" }, inputIndex, findings: [] })) });

describe("review reports name the populations they count", () => {
  const report = (id: string, severity: Finding["severity"], status: Finding["status"] = "open"): Finding => ({ id, text: "Two blind reports may describe the same bug", severity, status, raisedBy: "opus-high", confirmedBy: [], productIds: ["shop", "api"] });

  function reviewEvent(opening: Finding[], closing: Finding[], shared = true) {
    const scope = shared ? { productId: "shop", repositories: [{ productId: "shop", delivery: "local" as const, completedStages: [] }, { productId: "api", delivery: "local" as const, completedStages: [] }] } : { productId: "shop" };
    const review = seated({ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", startedAt: 10, round: 1, sub: 0 });
    const done = handedBack({ ...review, endedAt: 20 });
    done.result = { findings: closing };
    const context = ctx();
    const baselines = new Map();
    const started = workflowFacts(task({ ...scope, findings: opening, journey: [review] }), context);
    workflowEvents(workflowFacts(task({ ...scope, findings: opening }), context), started, context, baselines);
    return workflowEvents(started, workflowFacts(task({ ...scope, findings: closing, journey: [done] }), context), context, baselines).find((event) => event.kind === "review.finished")!;
  }

  it("reports the two-open-report example as zero Important, one nit and one pre-existing follow-up", () => {
    const closing = [report("old", "pre-existing"), report("nit", "suggestion")];
    closing[0]!.tracking = { taskId: "follow-up" };
    const event = reviewEvent([], closing);
    expect(event).toMatchObject({ opening: 0, closing: 2, raised: ["old", "nit"], stillOpen: [], stillOpenPopulation: "open-important", openImportant: [], openNits: ["nit"], openPreExisting: ["old"], reportCounts: { opening: { total: 0 }, closing: { total: 2, open: { total: 2, important: 0, nits: 1, preExisting: 1 }, fixed: 0, dismissed: 0, unverified: 0 } } });
    expect(event.summary).toContain("2 open reports (0 Important, 1 nit, 1 pre-existing follow-up)");
    expect(event.reports).toEqual([closing[1]!, closing[0]!].map((finding) => expect.objectContaining({ id: finding.id, severity: finding.severity, status: "open", productIds: ["shop", "api"], evidence: { read: { taskId: event.taskId, nodeId: "review", findingId: finding.id } } })));
    expect((event.reports as { tracking?: { taskId: string } }[])[1]!.tracking).toEqual({ taskId: "follow-up" });
  });

  for (const severity of ["suggestion", "pre-existing"] as const) it(`keeps all ${severity} reports open without implying Important work remains`, () => {
    const reports = [report("one", severity), report("two", severity), report("three", severity)];
    const event = reviewEvent([], reports);
    expect(event.reportCounts).toMatchObject({ closing: { total: 3, open: { total: 3, important: 0, nits: severity === "suggestion" ? 3 : 0, preExisting: severity === "pre-existing" ? 3 : 0 } } });
    expect(event.stillOpen).toEqual([]);
    expect(event.raised).toEqual(["one", "two", "three"]);
    expect(event.summary).toContain("3 open reports (0 Important");
  });

  it("includes settled reports in the total and separates status totals from overlapping review changes", () => {
    const opening = [report("important", "blocking"), report("nit", "suggestion"), report("fixed", "blocking", "fixed")];
    const closing = [...opening, report("old", "pre-existing"), report("dismissed", "blocking", "dismissed"), report("uncertain", "blocking", "unverified")];
    const event = reviewEvent(opening, closing);
    expect(event).toMatchObject({ opening: 3, closing: 6, raised: ["old", "dismissed", "uncertain"], openImportant: ["important"], openNits: ["nit"], openPreExisting: ["old"], reportCounts: { opening: { total: 3, fixed: 1 }, closing: { total: 6, open: { total: 3, important: 1, nits: 1, preExisting: 1 }, fixed: 1, dismissed: 1, unverified: 1 } } });
    expect(event.fixed).toEqual([]); // Already fixed before the review, with no new claim.
    expect(event.dismissed).toEqual(["dismissed"]); // Also raised: these are not an equation.
    expect(event.unverified).toEqual(["uncertain"]);
    expect(event.summary).toContain("1 Important");
  });

  it("uses singular report wording and keeps reproduced nits outside the Important-only list", () => {
    const before = { ...report("nit", "suggestion", "fixed"), answer: { fixed: true, text: "Fixed", at: 5 } };
    const after = { ...before, status: "open" as const, reopenedAt: 15, evidence: "Still happens" };
    const event = reviewEvent([before], [after]);
    expect(event.summary).toContain("1 report before, 1 after; 1 open report (0 Important, 1 nit");
    expect(event).toMatchObject({ claimedFixed: ["nit"], reopened: [{ id: "nit", evidence: true }], stillOpen: [], openImportant: [], openNits: ["nit"] });
  });

  for (const shared of [false, true]) it(`uses the existing product assignment rule in ${shared ? "shared" : "single-product"} report entries`, () => {
    const reports = [
      { ...report("missing", "blocking"), productIds: undefined },
      { ...report("empty", "blocking"), productIds: [] },
      { ...report("named", "blocking"), productIds: ["shop"] },
      { ...report("invalid", "blocking"), productIds: ["shop", "unknown"] },
    ];
    const event = reviewEvent([], reports, shared);
    expect((event.reports as { productIds: string[] }[]).map((entry) => entry.productIds)).toEqual(shared ? [[], [], ["shop"], []] : [["shop"], ["shop"], ["shop"], ["shop"]]);
    expect(reports[0]!.productIds).toBeUndefined();
  });
});
