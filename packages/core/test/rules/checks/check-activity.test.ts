import { describe, expect, it } from "vitest";
import {
  checkActivityDetails,
  checkActivityLine,
  checkHoldLine,
  checkOwnersLine,
  checkReasonWords,
  nextLine,
  pipelineOf,
  stepTip,
  stripOf,
  type CheckActivity,
  type CheckLineOwner,
  type DeepMutable,
  type JourneyStep,
  type ProofRequest,
  type Task,
} from "../../../src/index.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

const state = stateFixture({ now: 1_000_000_000_000 });
const owner = (title: string, changes: Partial<CheckLineOwner> = {}): CheckLineOwner => ({
  taskId: title.toLowerCase().replace(/\W+/g, "-"),
  title,
  kind: "checks",
  ...changes,
});
const running = (id: string, names: string[]) => ({
  id,
  checkActivity: { phase: "running", since: 1, slots: 1, running: names } as CheckActivity,
});

describe("one set of words for a task's check activity", () => {
  it("says each phase on the card's single line, counting whole runs", () => {
    const line = (activity: Partial<CheckActivity>) =>
      checkActivityLine({ phase: "waiting", since: 1, slots: 1, ...activity });
    expect(line({ ahead: 2 })).toBe("Waiting for checks · 2 runs ahead");
    expect(line({ ahead: 1 })).toBe("Waiting for checks · 1 run ahead");
    expect(line({ ahead: 0 })).toBe("Waiting for checks · next in line");
    expect(line({ phase: "held", ahead: 3 })).toBe("Waiting for checks · held for cleanup");
    expect(line({ phase: "paused", ahead: 1 })).toBe("Waiting for the pool to resume");
    expect(line({ phase: "preparing" })).toBe("Preparing automated checks");
    expect(line({ phase: "starting" })).toBe("Starting the checks");
    expect(line({ phase: "running", running: ["Tests"] })).toBe("Running checks: Tests");
    expect(line({ phase: "finishing" })).toBe("Finishing the check run");
  });

  it("names who holds each running place, with an ordinary check's name read from its own task", () => {
    const tasks = [running("fix-login-retry", ["Tests"]), running("lint-pass", ["Lint", "Typecheck"])];
    expect(checkOwnersLine([owner("Fix login retry")], tasks)).toBe("Tests for “Fix login retry” is running");
    expect(checkOwnersLine([owner("Lint pass")], tasks)).toBe("Lint, Typecheck for “Lint pass” are running");
    // Admitted but not started yet: no command to name.
    expect(checkOwnersLine([owner("Starting task")], [])).toBe("Checks for “Starting task” are running");
    expect(checkOwnersLine([owner("Linux", { kind: "extra", name: "Linux suite", productName: "API" })], [])).toBe(
      "Extra validation “Linux suite” for “Linux” (API) is running",
    );
    expect(checkOwnersLine([owner("Fix login retry"), owner("Lint pass")], tasks)).toBe(
      "Running now: Tests for “Fix login retry”; Lint, Typecheck for “Lint pass”",
    );
    expect(checkOwnersLine([], tasks)).toBeUndefined();
  });

  it("keeps held cleanup apart from a healthy run, passing the recorded explanation word for word", () => {
    const extra = owner("Platform work", { kind: "extra", name: "Linux suite" });
    const unrelated =
      "Petrina cannot verify whether programs using the saved client process group belong to this run; they may be unrelated. Do not stop programs based on the saved number.";
    expect(checkHoldLine({ kind: "cleanup", owner: extra, detail: unrelated }, [])).toBe(
      `Checks are held until Petrina confirms extra validation “Linux suite” for “Platform work” has stopped. ${unrelated}`,
    );
    expect(checkHoldLine({ kind: "recovery", owner: extra }, [])).toBe(
      "Checks are held while Petrina confirms an earlier validation stopped: extra validation “Linux suite” for “Platform work”.",
    );
    const held: CheckActivity = {
      phase: "held",
      since: 1,
      slots: 1,
      ahead: 0,
      holds: [{ kind: "cleanup", owner: extra, detail: unrelated }],
    };
    expect(checkActivityDetails(held, [])).toEqual([
      checkHoldLine(held.holds![0]!, []),
      "Checks have their own line, separate from agent slots.",
    ]);
  });

  it("notes the separate line, and how many runs it allows only when more than one", () => {
    const waiting: CheckActivity = {
      phase: "waiting",
      since: 1,
      slots: 2,
      ahead: 1,
      owners: [owner("A"), owner("B")],
    };
    expect(checkActivityDetails(waiting, [running("a", ["Tests"]), running("b", ["Lint"])])).toEqual([
      "Running now: Tests for “A”; Lint for “B”",
      "Checks have their own line, separate from agent slots. Petrina runs up to 2 check runs at once.",
    ]);
    expect(checkActivityDetails({ ...waiting, phase: "paused" }, [])).toContain("Keeps its place · 1 run ahead");
    // Preparing and running say nothing more than the main line.
    expect(checkActivityDetails({ phase: "running", since: 1, slots: 2, running: ["Tests"] }, [])).toEqual([]);
  });

  it("explains a fresh run from the versions recorded then, never from the step before it", () => {
    const earlier = { nodeId: "j28", attemptId: "run-0", sha: "a338ab0", tree: "ca932e6", passed: true, at: 1 };
    expect(checkReasonWords({ purpose: "delivery-check", earlier, changed: ["code", "start"] })).toBe(
      "Before your delivery check: the code changed since the passing run in step 28 (main moved on)",
    );
    expect(checkReasonWords({ purpose: "delivery-check", earlier, changed: ["code"] })).toBe(
      "Before your delivery check: the code changed since the passing run in step 28",
    );
    expect(checkReasonWords({ purpose: "review", changed: [] })).toBe("Before review: no earlier run of these checks");
    expect(checkReasonWords({ purpose: "acceptance", earlier: { ...earlier, passed: false }, changed: ["definitions"] })).toBe(
      "Before acceptance testing: the check commands or hook inputs changed since the failed run in step 28",
    );
    expect(checkReasonWords({ purpose: "publishing", earlier, changed: ["hooks"] })).toBe(
      "Before publishing: the code is unchanged since the passing run in step 28, but the repository's commit hooks must be checked again",
    );
    expect(checkReasonWords({ purpose: "review", earlier: { ...earlier, passed: false }, changed: ["incomplete"] })).toBe(
      "Before review: the earlier run in step 28 did not finish",
    );
    expect(checkReasonWords({ purpose: "delivery-check", earlier: { ...earlier, passed: false }, changed: ["requested"] })).toBe(
      "Before your delivery check: you asked for a fresh run after the failed run in step 28",
    );
    expect(checkReasonWords({ purpose: "review", earlier, changed: ["edits"] })).toContain("working copy has changes");
  });
});

/** A running task between a Builder and a Security review, a Tester, the delivery check and publishing. */
function planned(changes: Partial<Task> = {}): DeepMutable<Task> {
  const task = taskFixture(state, { id: "t1", title: "Planned task", state: "running", startedAt: 1 });
  task.state = "running";
  task.sub = 0;
  task.findings = [];
  task.rounds = {};
  task.fixing = false;
  delete task.agent;
  delete task.helpers;
  delete task.todo;
  delete task.retest;
  delete task.testedPatch;
  delete task.hunt;
  delete task.portReview;
  task.plan = {
    rationale: "Checks",
    plannerProfileId: "sol-high",
    stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["opus-high"] },
      { id: "test", title: "Acceptance", kind: "do", roleId: "tester", profileIds: ["sol-high"] },
      { id: "gate", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
      { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["sonnet-medium"] },
    ],
  };
  delete task.repositories;
  task.repository = { productId: task.productId, delivery: "pull-request" };
  task.delivery = "pull-request";
  return Object.assign(task, changes) as DeepMutable<Task>;
}

const waiting: CheckActivity = { phase: "waiting", since: 1, slots: 1, ahead: 2, owners: [owner("Other task")] };
const strip = (task: Task) =>
  stripOf(pipelineOf(task, state.roles)).map((step) =>
    step.state === "current" ? `${step.label}:${stepTip(step)}` : step.label,
  );
const requestedProof = (): DeepMutable<ProofRequest> => ({
  id: "proof",
  source: "review:1:0:0",
  text: "Ubuntu recovery",
  reason: "Final version proof",
  productIds: [],
  ownerStageId: "test",
  reviewedVersions: {},
  status: "pending",
  requestedBy: {
    stageId: "security",
    round: 1,
    seat: "0",
    roleId: "security-reviewer",
    profileId: "opus-high",
  },
});

describe("the Board strip names the real current activity", () => {
  for (const [stage, before] of [
    [1, "Review"],
    [2, "Test"],
    [3, "Ship"],
    [4, "Ship"],
  ] as const) {
    it(`calls checks before ${before} (stage ${stage}) Checks, without moving the plan's step`, () => {
      for (const phase of ["preparing", "waiting", "held", "starting", "running", "finishing"] as const) {
        const task = planned({ stageIndex: stage, checkActivity: { ...waiting, phase } });
        const current = pipelineOf(task, state.roles).find((step) => step.state === "current")!;
        expect(current).toEqual({ label: "Checks", state: "current", before });
        expect(stepTip(current)).toBe(`Automated checks before ${before}, now`);
        expect(task.stageIndex).toBe(stage);
      }
    });
  }

  it("keeps Checks through a pool pause that keeps the run's place", () => {
    expect(strip(planned({ stageIndex: 1, state: "waiting", checkActivity: { ...waiting, phase: "paused" } }))).toContain(
      "Checks:Automated checks before Review, now",
    );
  });

  it("returns to the plan's step once its agent starts, and leaves non-check moments as they were", () => {
    const reviewing = planned({
      stageIndex: 1,
      agent: { roleId: "security-reviewer", profileId: "opus-high", since: 2, step: 0 },
    });
    expect(strip(reviewing)).toEqual(["Plan", "Build", "Review:Review, now", "Test", "Ship"]);
    // A stale fact never shows checks while a reviewer works.
    expect(strip({ ...reviewing, checkActivity: waiting })).toEqual(["Plan", "Build", "Review:Review, now", "Test", "Ship"]);
    // The Check finder only works out the checks: they stay the current work.
    expect(
      strip({
        ...reviewing,
        agent: { ...reviewing.agent!, roleId: "check-finder" },
        checkActivity: { ...waiting, phase: "preparing" },
      }),
    ).toContain("Checks:Automated checks before Review, now");
    // Without roles the Check finder counts as an agent at work.
    expect(
      stripOf(
        pipelineOf({
          ...reviewing,
          agent: { ...reviewing.agent!, roleId: "check-finder" },
          checkActivity: waiting,
        } as Task),
      ).map((step) => step.label),
    ).toContain("Review");
    expect(strip(planned({ stageIndex: 1 }))).toEqual(["Plan", "Build", "Review:Review, now", "Test", "Ship"]);
    expect(strip(planned({ stageIndex: 1, state: "paused" }))).toEqual(["Plan", "Build", "Review:Review, now", "Test", "Ship"]);
    expect(strip(planned({ stageIndex: 1, state: "cancelled", checkActivity: waiting }))).toEqual([
      "Plan",
      "Build",
      "Review",
      "Test",
      "Ship",
    ]);
  });
});

describe("Next names the agent work that actually starts after the checks", () => {
  it("names the Security review while checks queue before it, then what follows once it starts", () => {
    const queued = planned({ stageIndex: 1, checkActivity: waiting });
    expect(nextLine(state, queued)).toBe("Next: security review (Claude Code · Opus 5.5), then testing (Codex · sol)");
    expect(nextLine(state, { ...queued, checkActivity: { ...waiting, phase: "running", running: ["Tests"] } })).toBe(
      nextLine(state, queued),
    );
    const reviewing = planned({
      stageIndex: 1,
      agent: { roleId: "security-reviewer", profileId: "opus-high", since: 2, step: 0 },
    });
    expect(nextLine(state, reviewing)).toBe(
      "Next: testing (Codex · sol), or fixes by the builder if blocking issues are found",
    );
  });

  it("names the Tester, the delivery decision and publishing while checks come before each", () => {
    expect(nextLine(state, planned({ stageIndex: 2, checkActivity: waiting }))).toBe(
      "Next: testing (Codex · sol), then your OK to ship",
    );
    expect(nextLine(state, planned({ stageIndex: 3, checkActivity: waiting }))).toBe(
      "Next: your OK to ship, then Petrina opens the pull request",
    );
    expect(nextLine(state, planned({ stageIndex: 4, checkActivity: { ...waiting, phase: "finishing" } }))).toBe(
      "Next: Petrina opens the pull request",
    );
    expect(nextLine(state, planned({ stageIndex: 4, delivery: "release", checkActivity: waiting }))).toBe(
      "Next: release notes (Claude Code · Sonnet 5.5), then Petrina publishes the release",
    );
  });

  it("previews the forced Tester run for a new proof request even after an earlier unverified result", () => {
    const request = requestedProof();
    const task = planned({
      stageIndex: 3,
      testedPatch: "tested",
      acceptancePassed: false,
      acceptanceUnverified: true,
      proofRequests: [request],
      brief: { summary: "", areas: [], forUsers: [], risks: [], acceptance: [{ text: "Works on Ubuntu", verification: "blocked" }] },
    });
    request.productIds = [task.productId];
    task.journey = [
      {
        id: "j36",
        kind: "agent",
        roleId: "tester",
        stageId: "test",
        round: 1,
        sub: 0,
        startedAt: 1,
        endedAt: 2,
        acceptanceChecks: [{ text: "Works on Ubuntu", result: "blocked", reason: "No Ubuntu host" }],
      } as DeepMutable<JourneyStep>,
    ];
    expect(nextLine(state, task)).toBe("Next: final acceptance testing for requested proof, then your OK to ship");
    expect(nextLine(state, { ...task, proofRequests: [] })).toBe("Next: your OK to ship, then Petrina opens the pull request");
    expect(nextLine(state, { ...task, proofRequests: [{ ...request, status: "unverified" }] })).toBe(
      "Next: your OK to ship, then Petrina opens the pull request",
    );
    expect(
      nextLine(state, {
        ...task,
        proofRefreshes: 2,
        proofRefreshBlocked: true,
        checks: { at: 1, current: true, tree: "current", results: [] },
        checkedProofDecision: { refreshBlocked: true, versions: { [task.productId]: "current" }, statuses: { proof: "pending" } },
      }),
    ).toBe("Next: your OK to ship, then Petrina opens the pull request");
    expect(nextLine(state, { ...task, acceptanceBlocked: true })).toBe(
      "Next: your OK to ship, then Petrina opens the pull request",
    );
    expect(
      nextLine(state, {
        ...task,
        stageIndex: 2,
        plan: { ...task.plan!, stages: task.plan!.stages.filter((stage) => stage.id !== "test") },
      }),
    ).toBe("Next: your OK to ship, then Petrina opens the pull request");
  });

  it("keeps an owed repair test ahead of requested final proof and preserves its review route through check preparation", () => {
    const task = planned({ testedPatch: "earlier", proofRequests: [requestedProof()] });
    const [build, security, test, gate, ship] = task.plan!.stages;
    task.plan!.stages = [build!, test!, security!, gate!, ship!];
    task.stageIndex = 1;
    task.repairCheck = true;
    for (const phase of ["preparing", "waiting", "held", "paused", "starting", "running", "finishing"] as const) {
      task.checkActivity = { phase, since: 1, slots: 1, ahead: 2 };
      task.state = phase === "paused" ? "waiting" : "running";
      expect(nextLine(state, task)).toBe(
        "Next: acceptance testing of the repair (Codex · sol), then security review (Claude Code · Opus 5.5)",
      );
      expect(nextLine(state, { ...task, repairCheck: undefined, retest: true })).toBe(
        "Next: final acceptance testing (Codex · sol), then your OK to ship",
      );
    }
    const tester = { roleId: "tester", profileId: "sol-high", since: 2, step: 0 };
    expect(nextLine(state, { ...task, state: "running", agent: tester })).toBe(
      "Next: security review (Claude Code · Opus 5.5), then your OK to ship",
    );
    expect(nextLine(state, { ...task, state: "running", agent: tester, repairCheck: undefined, retest: true })).toBe(
      "Next: your OK to ship, or fixes by the builder if acceptance checks fail",
    );
  });

  it("previews new requested proof after two main-only refreshes when the task code changed, retaining a current limit", () => {
    const task = planned({
      stageIndex: 3,
      testedPatch: "earlier",
      acceptancePassed: false,
      acceptanceUnverified: true,
      proofRefreshes: 2,
      proofRequests: [requestedProof()],
      brief: { summary: "", areas: [], forUsers: [], risks: [], acceptance: [{ text: "Works on Ubuntu", verification: "blocked" }] },
    });
    task.proofRefreshBlocked = true;
    task.checkedProofDecision = {
      refreshBlocked: true,
      versions: { [task.productId]: "main-only-version" },
      statuses: { proof: "pending" },
    };
    task.checks = { current: true, at: 1, tree: "changed-task-version", results: [] };
    const testing = "Next: final acceptance testing for requested proof, then your OK to ship";
    const preparing = "Next: final acceptance testing for requested proof if the task's code changed, then your OK to ship";
    const decision = "Next: your OK to ship, then Petrina opens the pull request";
    for (const status of ["pending", "stale"] as const) {
      task.proofRequests![0]!.status = status;
      task.checkedProofDecision!.statuses.proof = status;
      expect(nextLine(state, task)).toBe(preparing);
      expect(nextLine(state, { ...task, checks: { ...task.checks!, tree: "main-only-version" } })).toBe(decision);
      expect(nextLine(state, { ...task, proofRefreshes: 1 })).toBe(testing);
      expect(nextLine(state, { ...task, proofRefreshBlocked: false })).toBe(preparing);
      expect(nextLine(state, { ...task, checks: { ...task.checks!, current: false, tree: "main-only-version" } })).toBe(
        preparing,
      );
      expect(
        nextLine(state, {
          ...task,
          checks: { ...task.checks!, tree: "main-only-version" },
          proofRequests: [{ ...requestedProof(), id: "new-proof" }],
        }),
      ).toBe(preparing);
    }
    expect(nextLine(state, { ...task, proofRequests: [] })).toBe(decision);
    expect(nextLine(state, { ...task, proofRequests: [{ ...requestedProof(), status: "unverified" }] })).toBe(decision);
    expect(nextLine(state, { ...task, acceptanceBlocked: true })).toBe(decision);
    const captured: Task = {
      ...task,
      proofRefreshBlocked: false,
      testedChanges: { [task.productId]: "task-patch" },
      testedVersions: { [task.productId]: "tested-tree" },
      checkedSha: "checked",
      checkedPatch: "task-patch",
      checks: { current: true, sha: "checked", tree: "new-tree", at: 1, results: [] },
    };
    expect(nextLine(state, captured)).toBe(decision);
    expect(nextLine(state, { ...captured, acceptancePassed: true, acceptanceUnverified: false, brief: undefined })).toBe(
      decision,
    );
    expect(nextLine(state, { ...captured, checkedPatch: "changed-task-patch" })).toBe(testing);
    expect(nextLine(state, { ...captured, checkedSha: "older-check" })).toBe(preparing);
    const shared: Task = {
      ...captured,
      testedChanges: { api: "api-patch", web: "web-patch" },
      testedVersions: { api: "api-tested", web: "web-tested" },
      repositories: ["api", "web"].map((productId) => ({
        productId,
        delivery: "local",
        completedStages: [],
        checkedSha: "checked",
        checkedPatch: `${productId}-patch`,
        checks: { current: true, sha: "checked", tree: `${productId}-now`, at: 1, results: [] },
      })),
    };
    expect(nextLine(state, shared)).toBe(decision);
    expect(
      nextLine(state, {
        ...shared,
        repositories: shared.repositories!.map((work) =>
          work.productId === "web" ? { ...work, checkedPatch: "changed-web-patch" } : work,
        ),
      }),
    ).toBe(testing);
  });
});
