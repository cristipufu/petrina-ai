import { describe, expect, it } from "vitest";
import { workflowFixture } from "../../fixtures/workflow.js";
import { afterChangesAsked, columnOf, coveredByDecision, designRoundEnd, gateStatus, gateTitle, noteReproduction, noteRoundEnd, passedOpenWords, reviewDecisionFor, reviewRoundEnd, type DeepMutable } from "../../../src/flow.js";
import { BUILT_IN_ROLES } from "../../../src/library.js";
import type { Finding, Stage, Task } from "../../../src/model.js";

const { task: planned } = workflowFixture();
const stages = planned.plan!.stages;
const at = (match: (stage: Stage) => boolean) => stages.findIndex(match);
const copy = (extra: Partial<Task> = {}): DeepMutable<Task> => JSON.parse(JSON.stringify({ ...planned, ...extra })) as DeepMutable<Task>;
const important = (status: Finding["status"] = "open"): Finding => ({ id: "f1", text: "It breaks", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status });

describe("the rules a task's run follows, in the engine and the demo alike", () => {
  it("puts a task in the column of the stage it is on", () => {
    expect(columnOf({ ...planned, state: "queued" }, BUILT_IN_ROLES)).toBe("queue");
    expect(columnOf({ ...planned, state: "running", stageIndex: -1 }, BUILT_IN_ROLES)).toBe("planning");
    expect(columnOf({ ...planned, state: "running", stageIndex: at((stage) => stage.roleId === "builder") }, BUILT_IN_ROLES)).toBe("building");
    expect(columnOf({ ...planned, state: "running", stageIndex: at((stage) => stage.kind === "review-chain") }, BUILT_IN_ROLES)).toBe("reviewing");
    expect(columnOf({ ...planned, state: "pr-open" }, BUILT_IN_ROLES)).toBe("ready");
    expect(columnOf({ ...planned, state: "cancelled" }, BUILT_IN_ROLES)).toBe("done");
  });

  it("says what each checkpoint waits for", () => {
    expect(gateStatus(planned, "plan")).toBe("Plan ready. Waiting for your OK");
    expect(gateStatus(planned, "delivery")).toBe("Reviews done. Waiting for your OK to ship");
  });

  it("keeps an unverified acceptance item at the delivery decision", () => {
    const task = copy({ brief: { ...planned.brief!, acceptance: [{ text: "A real session can write safely", verification: "blocked", reason: "The account limit prevented a session." }] } });
    expect(gateTitle(task, "delivery")).toContain("1 acceptance check could not be verified");
    expect(gateStatus(task, "delivery")).toBe("1 acceptance check could not be verified. Your call");
  });

  it("names the failing checks at a check problem instead of counting the findings they raise", () => {
    const run = (name: string, ok: boolean) => ({ name, command: `bun run ${name.toLowerCase()}`, ok, output: ok ? "ok" : "failed", ms: 1 });
    const task = copy({ findings: [important()], checks: { at: 1, results: [run("Tests", false), run("Typecheck", true)] } });
    expect(gateTitle(task, "delivery")).toBe(`Your call on “${planned.title}”: a check still fails (Tests)`);
    expect(gateStatus(task, "delivery")).toBe("Checks still fail. Your call");
    const both = copy({ checks: { at: 1, results: [run("Tests", false), run("Build", false)] } });
    expect(gateTitle(both, "delivery")).toBe(`Your call on “${planned.title}”: checks still fail (Tests, Build)`);
    // Once the checks pass, open Important findings are counted as before.
    expect(gateTitle(copy({ findings: [important()], checks: { at: 1, results: [run("Tests", true)] } }), "delivery")).toBe(`Your call on “${planned.title}”: 1 blocking finding still open`);
  });

  it("sends a delivery back to the builder, and a plan back to the planner", () => {
    const delivery = copy({ stageIndex: stages.length - 1, sub: 2 });
    afterChangesAsked(delivery, "delivery", "The greeting is gone", 0, BUILT_IN_ROLES);
    expect([delivery.stageIndex, delivery.fixing, delivery.sentBack, delivery.sub]).toEqual([at((stage) => stage.roleId === "builder"), true, 1, 0]);

    const plan = copy({ stageIndex: 0 });
    afterChangesAsked(plan, "plan", "Smaller, please", 0, BUILT_IN_ROLES);
    expect([plan.stageIndex, plan.plan]).toEqual([-1, undefined]);
  });

  it("routes review and coordinator returns by the role's build result, regardless of its name", () => {
    const builder = { ...BUILT_IN_ROLES.find(role => role.result === "build")!, id: "implementer", name: "Implementer" };
    const misleading = { ...BUILT_IN_ROLES.find(role => role.result === "notes")!, id: "builder" };
    const roles = [builder, misleading];
    const review: Stage = { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: [], maxRounds: 2 };
    const task = copy({ stageIndex: 2, findings: [important()], plan: { rationale: "Custom roles", plannerProfileId: "sol-high", stages: [
      { id: "build", title: "Implement", kind: "do", roleId: "implementer", profileIds: [] },
      { id: "notes", title: "Write notes", kind: "do", roleId: "builder", profileIds: [] }, review,
    ] } });
    expect(reviewRoundEnd(task, review, 1, roles)).toEqual({ kind: "send back", builder: 0, open: 1 });
    afterChangesAsked(task, "delivery", "Fix this", 1, roles);
    expect(task.stageIndex).toBe(0);
    expect(task.fixing).toBe(true);
  });

  it("ends a design round settled, in another round, or with the architects disagreeing", () => {
    const converge = { ...stages[0]!, kind: "converge" as const, maxRounds: 3 };
    expect(designRoundEnd(0, 1, converge)).toBe("settled");
    expect(designRoundEnd(2, 1, converge)).toBe("next round");
    expect(designRoundEnd(1, 3, converge)).toBe("disagreement");
  });

  it("ends a review round back at the builder, passed, or with rounds used up", () => {
    const chain = at((stage) => stage.kind === "review-chain");
    const review = { ...stages[chain]!, maxRounds: 2 };
    expect(reviewRoundEnd({ ...planned, stageIndex: chain, findings: [important("fixed")] }, review, 1, BUILT_IN_ROLES)).toEqual({ kind: "passed" });
    expect(reviewRoundEnd({ ...planned, stageIndex: chain, findings: [important()] }, review, 1, BUILT_IN_ROLES)).toEqual({ kind: "send back", builder: at((stage) => stage.roleId === "builder"), open: 1 });
    expect(reviewRoundEnd({ ...planned, stageIndex: chain, findings: [important()] }, review, 2, BUILT_IN_ROLES)).toEqual({ kind: "used up", open: 1 });
  });

  it("leaves findings a decision to continue covers out of a later round's end, until new evidence or a changed own change", () => {
    const chain = at((stage) => stage.kind === "review-chain");
    const review = { ...stages[chain]!, maxRounds: 2 };
    const builder = at((stage) => stage.roleId === "builder");
    const product = planned.productId;
    const nit: Finding = { ...important(), id: "nit", severity: "suggestion" };
    const asked = reviewDecisionFor({ findings: [important(), nit, { ...important("fixed"), id: "fixed" }] }, "earlier", 3, 100, { [product]: "v1" });
    // Only the open Important findings, with when and on which version of the task's own change.
    expect(asked).toEqual({ stageId: "earlier", round: 3, accepted: false, covers: ["f1"], at: 100, versions: { [product]: "v1" } });
    const continued = (extra: Partial<Task> = {}, decision: Partial<NonNullable<Task["reviewDecision"]>> = {}): Task => ({ ...planned, stageIndex: chain, findings: [important()], reviewDecision: { ...asked, accepted: true, ...decision }, ...extra });
    const end = (task: Task, changes: Record<string, string> = { [product]: "v1" }, round = 1) => reviewRoundEnd(task, review, round, BUILT_IN_ROLES, coveredByDecision(task, changes));
    const back = { kind: "send back", builder, open: 1 };
    expect(end(continued())).toEqual({ kind: "passed", covered: 1 });
    expect(end(continued(), { [product]: "v1" }, 2)).toEqual({ kind: "passed", covered: 1 });
    // Ordinary flows: no decision, one still waiting, or one saved before covered findings were recorded.
    expect(end({ ...planned, stageIndex: chain, findings: [important()] })).toEqual(back);
    expect(end(continued({}, { accepted: false }))).toEqual(back);
    expect(end({ ...planned, stageIndex: chain, findings: [important()], reviewDecision: { stageId: "earlier", round: 3, accepted: true } })).toEqual(back);
    // A changed or unreadable own change, on either side.
    expect(end(continued(), { [product]: "v2" })).toEqual(back);
    expect(end(continued(), {})).toEqual(back);
    expect(end(continued({}, { versions: { [product]: "unavailable" } }), { [product]: "unavailable" })).toEqual(back);
    // New evidence after the decision ends its cover; the deciding round's own evidence does not.
    expect(end(continued({ findings: [{ ...important(), reproducedAt: 101 }] }))).toEqual(back);
    expect(end(continued({ findings: [{ ...important(), reopenedAt: 101 }] }))).toEqual(back);
    expect(end(continued({ findings: [{ ...important(), reproducedAt: 100, reopenedAt: 90 }] }))).toEqual({ kind: "passed", covered: 1 });
    // A new Important finding is never covered: the round sends back, then uses its rounds up, counting everything open.
    const fresh = continued({ findings: [important(), { ...important(), id: "new" }] });
    expect(coveredByDecision(fresh, { [product]: "v1" })).toEqual(new Set(["f1"]));
    expect(end(fresh)).toEqual({ ...back, open: 2 });
    expect(end(fresh, { [product]: "v1" }, 2)).toEqual({ kind: "used up", open: 2 });
    expect(reviewDecisionFor(fresh, review.id, 2, 200, { [product]: "v1" }).covers).toEqual(["f1", "new"]);
    // Only a finding the decision lists records a reproduction.
    const task = copy({ findings: [important(), { ...important(), id: "other" }], reviewDecision: { ...asked, accepted: true } });
    for (const finding of task.findings) noteReproduction(task, finding, 150);
    expect(task.findings.map((finding) => finding.reproducedAt)).toEqual([150, undefined]);
    // A passed round's log line names covered findings apart, never as nothing to fix.
    expect(passedOpenWords([important(), nit], new Set(["f1"]))).toBe("1 nit; 1 earlier important still open under your decision to continue");
    expect(passedOpenWords([important()], new Set(["f1"]))).toBe("1 earlier important still open under your decision to continue");
    expect(passedOpenWords([nit, important("fixed")], new Set())).toBe("1 nit");
    expect(passedOpenWords([], new Set())).toBe("Nothing to fix");
  });

  it("judges a shared finding's cover by its own products' change", () => {
    const chain = at((stage) => stage.kind === "review-chain");
    const review = { ...stages[chain]!, maxRounds: 2 };
    const repositories = ["shop", "api"].map((productId) => ({ productId, delivery: "pull-request" as const, completedStages: [] }));
    const shop: Finding = { ...important(), id: "shop", productIds: ["shop"] };
    const unassigned: Finding = { ...important(), id: "together", productIds: [] };
    const task: Task = { ...planned, stageIndex: chain, repositories, findings: [shop, unassigned], reviewDecision: { stageId: "earlier", round: 3, accepted: true, covers: ["shop", "together"], at: 100, versions: { shop: "s1", api: "a1" } } };
    expect(coveredByDecision(task, { shop: "s1", api: "a1" })).toEqual(new Set(["shop", "together"]));
    // The API's own change moved: the shop's finding stays covered; one without valid owners depends on every product.
    expect(coveredByDecision(task, { shop: "s1", api: "a2" })).toEqual(new Set(["shop"]));
    expect(coveredByDecision(task, { shop: "s2", api: "a1" })).toEqual(new Set());
    expect(reviewRoundEnd(task, review, 1, BUILT_IN_ROLES, coveredByDecision(task, { shop: "s1", api: "a2" })).kind).toBe("send back");
  });

  it("holds a shared acceptance failure whose repairs are used up for the delivery decision, outside every review round", () => {
    const chain = at((stage) => stage.kind === "review-chain");
    const review = { ...stages[chain]!, maxRounds: 2 };
    const failure: Finding = { ...important(), id: "f2", text: "Failed acceptance check: People see the greeting", productIds: ["a"] };
    const shared = { ...planned, stageIndex: chain, repositories: [], acceptanceBlocked: true };
    // Alone it neither sends the work back nor asks for a review decision; beside a review finding only that one counts.
    expect(reviewRoundEnd({ ...shared, findings: [failure] }, review, 1, BUILT_IN_ROLES)).toEqual({ kind: "passed" });
    expect(reviewRoundEnd({ ...shared, findings: [failure] }, review, 2, BUILT_IN_ROLES)).toEqual({ kind: "passed" });
    expect(reviewRoundEnd({ ...shared, findings: [failure, important()] }, review, 1, BUILT_IN_ROLES)).toEqual({ kind: "send back", builder: at((stage) => stage.roleId === "builder"), open: 1 });
    const round = copy({ ...shared, findings: [failure, important()] });
    noteRoundEnd(round, review.id, 1);
    expect(round.blockingFindingsAfter![review.id]!.at(-1)).toEqual(["f1"]);
    // A review decision is about the review's findings only.
    expect(reviewDecisionFor({ ...shared, findings: [failure, important()] }, review.id, 2, 200, {}).covers).toEqual(["f1"]);
    // At the decision it stays open and named, without claiming review rounds ran out.
    expect(gateTitle({ ...shared, findings: [failure] }, "delivery")).toBe(`Your call on “${planned.title}”: 1 blocking finding still open`);
    expect(gateStatus({ ...shared, findings: [failure] }, "delivery")).toBe("Acceptance still fails after the builder's returns. Your call");
    expect(gateStatus({ ...shared, findings: [failure, important()] }, "delivery")).toBe("Review rounds ran out with 1 blocking finding open. Your call");
    // Asking for changes clears the hold: it is an ordinary open finding again, as it is in a single-product task.
    expect(reviewRoundEnd({ ...shared, acceptanceBlocked: false, findings: [failure] }, review, 1, BUILT_IN_ROLES).kind).toBe("send back");
    expect(reviewRoundEnd({ ...planned, stageIndex: chain, acceptanceBlocked: true, findings: [failure] }, review, 1, BUILT_IN_ROLES).kind).toBe("send back");
  });
});
