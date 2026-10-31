import { describe, expect, it } from "vitest";
import { periodRange, throughputTaskRecord, usageView } from "../../../src/index.js";
import type { CheckRun, Role } from "../../../src/model.js";
import { HOUR, logWith, MIN, NOW, state, task, turn } from "../../fixtures/analytics.js";

function recordedRun(code: number, startedAt: number, endedAt: number, attemptId: string, stepId = "step-check"): CheckRun {
  return {
    name: "Tests",
    command: "bun test",
    ok: code === 0,
    ms: endedAt - startedAt,
    startedAt,
    endedAt,
    output: "",
    source: { stepId, attemptId, checkId: "test" },
    execution: {
      started: true,
      exit: { status: "reported", code },
      stdout: "eof",
      stderr: "eof",
      timedOut: false,
      cancelled: false,
      cleanup: "not-requested",
      outputCleanup: "not-requested",
    },
  };
}

describe("Analytics system throughput and bottlenecks", () => {
  it("separates confirmed landed deliveries from awaiting-merge, unfinished pushes, no-changes, unconfirmed, cancelled and combined tasks, without fabricating missing start times", () => {
    const baseCatalog = state([]);
    const landedFast = task("t-fast", "shop", {
      createdAt: NOW - 3 * HOUR,
      startedAt: NOW - 2 * HOUR - 50 * MIN,
      finishedAt: NOW - 2 * HOUR,
      delivery: "local",
      landed: { branch: "main", sha: "111" },
      confirmedDelivery: { sha: "111", tree: "t111", repo: "acme/shop", branch: "main", at: NOW - 2 * HOUR },
    });
    const landedSlowShared = task("t-shared", "shop", {
      createdAt: NOW - 6 * HOUR,
      startedAt: NOW - 5 * HOUR,
      finishedAt: NOW - HOUR,
      repositories: [
        {
          productId: "shop",
          delivery: "pull-request",
          completedStages: [],
          pr: { number: 10, url: "https://example.test/pr/10", state: "merged", openedAt: NOW - 2 * HOUR },
          confirmedDelivery: { sha: "200", tree: "t200", repo: "acme/shop", branch: "main", at: NOW - HOUR },
        },
        {
          productId: "notes",
          delivery: "local",
          completedStages: [],
          landed: { branch: "main", sha: "222" },
          confirmedDelivery: { sha: "222", tree: "t222", repo: "acme/notes", branch: "main", at: NOW - 90 * MIN },
        },
      ],
    });
    const landedMissingStart = task("t-nostart", "shop", {
      createdAt: NOW - 4 * HOUR,
      startedAt: undefined,
      finishedAt: NOW - 3 * HOUR,
      delivery: "release",
      release: { tag: "v1.2.0", url: "https://example.test/r/1" },
    });
    const companionNoPublish = task("t-companion-noop", "shop", {
      createdAt: NOW - 2 * HOUR,
      startedAt: NOW - 90 * MIN,
      finishedAt: NOW - 30 * MIN,
      repositories: [
        {
          productId: "shop",
          delivery: "local",
          completedStages: [],
          landed: { branch: "main", sha: "444" },
          confirmedDelivery: { sha: "444", tree: "t444", repo: "acme/shop", branch: "main", at: NOW - 30 * MIN },
        },
        {
          productId: "notes",
          delivery: "local",
          completedStages: [],
          nothingToPublish: true,
        },
      ],
    });
    const awaitingMerge = task("t-pr-open", "shop", {
      state: "pr-open",
      column: "ready",
      createdAt: NOW - 2 * HOUR,
      startedAt: NOW - 90 * MIN,
      finishedAt: undefined,
      pr: { number: 11, url: "https://example.test/pr/11", state: "open", openedAt: NOW - 20 * MIN },
    });
    const unfinishedPush = task("t-unpushed", "shop", {
      state: "done",
      column: "done",
      createdAt: NOW - 2 * HOUR,
      startedAt: NOW - 90 * MIN,
      finishedAt: NOW - 15 * MIN,
      delivery: "local",
      landed: { branch: "main", sha: "555" },
      localUpdate: { branch: "main", sha: "555", pushed: false },
    });
    const noChanges = task("t-nochanges", "shop", {
      finishedAt: NOW - 40 * MIN,
      maintenance: {
        routineId: "r-1",
        routineName: "Daily audit",
        scheduledAt: NOW - HOUR,
        queuedAt: NOW - HOUR,
        zone: "UTC",
        focus: "Check logs",
        role: baseCatalog.roles[0]!,
        profile: baseCatalog.profiles[0]!,
        input: "Audit",
        product: baseCatalog.products[0]!,
        noProductChanges: true,
      },
    });
    const markedDone = task("t-marked", "shop", {
      finishedAt: NOW - 35 * MIN,
      pr: undefined,
      landed: undefined,
      release: undefined,
      cleanup: { markedDone: true },
    });
    const closedPr = task("t-closed", "shop", {
      finishedAt: NOW - 25 * MIN,
      pr: { number: 12, url: "https://example.test/pr/12", state: "closed", openedAt: NOW - 50 * MIN },
    });
    const cancelledTask = task("t-cancel", "shop", {
      state: "cancelled",
      finishedAt: NOW - 20 * MIN,
    });
    const combinedTask = task("t-combined", "shop", {
      state: "cancelled",
      combinedInto: "t-fast",
      finishedAt: NOW - 10 * MIN,
    });

    const liveTasks = [awaitingMerge, unfinishedPush];
    const archived = [
      landedFast,
      landedSlowShared,
      landedMissingStart,
      companionNoPublish,
      noChanges,
      markedDone,
      closedPr,
      cancelledTask,
      combinedTask,
    ].map(throughputTaskRecord);

    const log = logWith([]);
    const st = state(liveTasks);
    const allView = usageView(
      log,
      { view: "analytics", period: "today" },
      {
        now: NOW,
        state: st,
        checkSlots: 1,
        archivedThroughputTasks: () => archived,
      },
    ).throughput;

    expect(allView.delivery).toMatchObject({
      landed: 4,
      sharedLanded: 1,
      awaitingMerge: 1,
      prsOpenedInWindow: 3,
      noChanges: 1,
      markedDone: 1,
      closedWithoutMerge: 1,
      unconfirmedOrClosed: 2,
      cancelled: 1,
      combined: 1,
      inProgress: 1,
      unfinishedPushes: 1,
    });
    // Start-split medians use only the 3 landed tasks with a recorded startedAt (10m, 30m, 60m -> median 30m, p90 60m).
    expect(allView.delivery.createdToStart).toEqual({
      count: 3,
      medianMs: 30 * MIN,
      p90Ms: 60 * MIN,
      missingStartCount: 1,
    });
    // Start-to-delivery across the 3 tasks with startedAt: 50m, 60m, 240m -> median 60m, p90 240m.
    expect(allView.delivery.startToDelivery).toEqual({
      count: 3,
      medianMs: 60 * MIN,
      p90Ms: 4 * HOUR,
      missingStartCount: 1,
    });
    // Created-to-delivery includes all 4 landed tasks: 60m, 60m, 90m, 300m -> median 75m, p90 300m.
    expect(allView.delivery.createdToDelivery).toEqual({
      count: 4,
      medianMs: 75 * MIN,
      p90Ms: 5 * HOUR,
    });
    expect(allView.coverage.notes.some((note) => note.includes("1 landed task had no recorded start time"))).toBe(true);

    // Filtering to `notes` treats `companionNoPublish` (where notes had nothingToPublish) as `no-changes`, not `landed`.
    const notesView = usageView(
      log,
      { view: "analytics", period: "today", productId: "notes" },
      {
        now: NOW,
        state: st,
        archivedThroughputTasks: () => archived.filter((entry) => entry.productIds.includes("notes")),
      },
    ).throughput;
    expect(notesView.delivery.landed).toBe(1);
    expect(notesView.delivery.noChanges).toBe(1);
  });

  it("clips cross-boundary intervals to [from, asOf], merges parallel wall time separately from summed task time, and subtracts permission waits once", () => {
    const today = periodRange("today", NOW);
    const midnight = today.from;

    // Task A: open turn started 30m before midnight, still running at NOW, with a 20m permission wait inside Today.
    //Wait: keep numbers crisp around midnight + first hours so everything is easy to verify!
    const asOf = midnight + 2 * HOUR;
    const taskA = task("task-a", "shop", {
      state: "running",
      column: "building",
      holdsSlot: true,
      createdAt: midnight - HOUR,
      startedAt: midnight - 30 * MIN,
      finishedAt: undefined,
      agent: { roleId: "builder", profileId: "sol-high", since: midnight - 30 * MIN, step: 1 },
      journey: [
        {
          id: "step-a-build",
          kind: "agent",
          stageId: "task-a:build",
          round: 1,
          sub: 0,
          roleId: "builder",
          startedAt: midnight - 30 * MIN,
          asks: [
            {
              id: "perm-1",
              kind: "permission",
              title: "Allow test command",
              at: midnight + 20 * MIN,
              endedAt: midnight + 40 * MIN,
            },
          ],
          productChecks: [
            {
              id: "run-1:test",
              attemptId: "run-1",
              productId: "shop",
              name: "Tests",
              result: "pass",
              queuedAt: midnight - 10 * MIN,
              startedAt: midnight + 10 * MIN,
              endedAt: midnight + 50 * MIN,
              run: recordedRun(0, midnight + 10 * MIN, midnight + 50 * MIN, "run-1", "step-a-build"),
            },
          ],
        },
      ],
    });

    // Task B: ran in parallel with Task A from midnight + 30m to midnight + 90m (60m agent turn).
    const taskB = task("task-b", "shop", {
      state: "running",
      column: "reviewing",
      holdsSlot: true,
      createdAt: midnight + 15 * MIN,
      startedAt: midnight + 30 * MIN,
      finishedAt: undefined,
      agent: { roleId: "code-reviewer", profileId: "opus-high", since: midnight + 30 * MIN, step: 1 },
      journey: [],
    });

    const openTurnA = turn({
      id: "turn-a",
      taskId: "task-a",
      productId: "shop",
      roleId: "builder",
      profileId: "sol-high",
      startedAt: midnight - 30 * MIN,
      endedAt: undefined,
      end: undefined,
      workMs: undefined,
    });
    const endedTurnB = turn({
      id: "turn-b",
      taskId: "task-b",
      productId: "shop",
      roleId: "code-reviewer",
      profileId: "opus-high",
      startedAt: midnight + 30 * MIN,
      endedAt: midnight + 90 * MIN,
      end: "finished",
      workMs: 60 * MIN,
    });
    // Same permission wait also recorded as a WorkMoment: must not be double-counted!
    const permMoment = {
      id: "m-perm-1",
      taskId: "task-a",
      productId: "shop",
      stageId: "task-a:build",
      stageTitle: "Build",
      stageKind: "do" as const,
      round: 1,
      at: midnight + 20 * MIN,
      kind: "ask" as const,
      ask: "permission" as const,
      answer: "allowed" as const,
      durationMs: 20 * MIN,
    };

    const st = { ...state([taskA, taskB]), now: asOf };
    const log = logWith([{ turn: openTurnA }, { turn: endedTurnB }], [permMoment], midnight - 5 * 24 * HOUR);
    const tp = usageView(log, { view: "analytics", period: "today" }, { now: asOf, state: st, checkSlots: 1 }).throughput;

    expect(tp.coverage.windowElapsedMs).toBe(2 * HOUR);

    const byKey = new Map(tp.phases.map((phase) => [phase.key, phase]));
    // Task A active segments in [midnight, midnight+120m]: [0, 20m] and [40m, 120m] = 100m.
    // Task B active segment: [30m, 90m] = 60m.
    // Merged wall union: [0, 20m] U [30m, 120m] = 20m + 90m = 110m! Summed across tasks: 100m + 60m = 160m!
    expect(byKey.get("agent-work")).toMatchObject({
      wallMs: 110 * MIN,
      summedMs: 160 * MIN,
      taskCount: 2,
    });
    // Permission wait [20m, 40m] counted once (20m), not doubled by JourneyAsk + WorkMoment.
    expect(byKey.get("coordinator-decisions")).toMatchObject({
      wallMs: 20 * MIN,
      summedMs: 20 * MIN,
      taskCount: 1,
    });
    // Check queue wait [midnight - 10m, midnight + 10m] clipped to Today -> [midnight, midnight + 10m] = 10m.
    expect(byKey.get("waiting-for-checks")).toMatchObject({
      wallMs: 10 * MIN,
      summedMs: 10 * MIN,
      taskCount: 1,
    });
    // Check execution [midnight + 10m, midnight + 50m] = 40m -> 40m / 120m = 1/3 check-slot occupancy.
    expect(byKey.get("check-execution")).toMatchObject({
      wallMs: 40 * MIN,
      summedMs: 40 * MIN,
      taskCount: 1,
    });
    expect(tp.capacity.checkSlot).toMatchObject({
      configuredSlots: 1,
      occupiedWallMs: 40 * MIN,
      completedBatches: 1,
      medianBatchMs: 40 * MIN,
      p90BatchMs: 40 * MIN,
    });
    expect(tp.capacity.checkSlot.occupancyShare).toBeCloseTo(40 / 120, 5);
    expect(tp.capacity.agentPool.meanConcurrencyWhenBusy).toBe(1.5);
  });

  it("distinguishes fresh check runs from reused cached passes and failures, and attributes Builder returns by role.result rather than role name", () => {
    const templateRole = state([]).roles[0]!;
    const customBuildRole: Role = {
      ...templateRole,
      id: "custom-implementer",
      name: "Implementer",
      tone: "blue",
      purpose: "Builds changes",
      instructions: "",
      canEdit: true,
      result: "build",
      column: "building",
      added: true,
    };
    const customCheckRole: Role = {
      ...templateRole,
      id: "custom-verifier-qa",
      name: "QA Runner",
      tone: "teal",
      purpose: "Runs acceptance checks",
      instructions: "",
      canEdit: false,
      result: "checks",
      column: "reviewing",
      added: true,
    };
    const customAuditRole: Role = {
      ...templateRole,
      id: "custom-critic",
      name: "Critic",
      tone: "violet",
      purpose: "Finds issues",
      instructions: "",
      canEdit: false,
      result: "findings",
      column: "reviewing",
      added: true,
    };

    const cyclingTask = task("t-cycle", "shop", {
      title: "Harden webhook retries",
      finishedAt: NOW - 5 * MIN,
      delivery: "local",
      landed: { branch: "main", sha: "abc" },
      journey: [
        {
          id: "s1-build",
          kind: "agent",
          stageId: "t-cycle:build",
          round: 1,
          sub: 0,
          roleId: "custom-implementer",
          startedAt: NOW - 110 * MIN,
          endedAt: NOW - 100 * MIN,
          end: "done",
        },
        {
          id: "s2-checks-fail",
          kind: "petrina",
          work: "checks",
          round: 1,
          sub: 1,
          startedAt: NOW - 100 * MIN,
          endedAt: NOW - 95 * MIN,
          end: "failed",
          checkReasons: [{ attemptId: "run-1", productId: "shop", purpose: "review", changed: ["code"] }],
          productChecks: [
            {
              id: "run-1:test",
              attemptId: "run-1",
              productId: "shop",
              name: "Tests",
              result: "fail",
              startedAt: NOW - 100 * MIN,
              endedAt: NOW - 95 * MIN,
              run: recordedRun(1, NOW - 100 * MIN, NOW - 95 * MIN, "run-1", "s2-checks-fail"),
            },
          ],
          reuses: [
            {
              at: NOW - 92 * MIN,
              originalAt: NOW - 95 * MIN,
              productId: "shop",
              purpose: "review",
              basis: "same-tree",
              passed: false,
            },
          ],
        },
        // Supporting snapshot step for check-reuse: must NOT count as a second fresh check execution!
        {
          id: "s2b-reuse-step",
          kind: "petrina",
          work: "check-reuse",
          round: 1,
          sub: 2,
          startedAt: NOW - 92 * MIN,
          endedAt: NOW - 92 * MIN,
          outcome: "Reused earlier failed check result",
          productChecks: [
            {
              id: "run-1:test",
              attemptId: "run-1",
              productId: "shop",
              name: "Tests",
              result: "fail",
              reusedAt: NOW - 92 * MIN,
            },
          ],
        },
        {
          id: "s3-return-checks",
          kind: "agent",
          stageId: "t-cycle:build",
          round: 1,
          sub: 3,
          roleId: "custom-implementer",
          fixing: true,
          startedAt: NOW - 90 * MIN,
          endedAt: NOW - 85 * MIN,
          end: "done",
          trigger: { after: "s2-checks-fail", reason: "checks failed" },
          builderReturn: { changed: false, productId: "shop", claimedFixes: 0, outcome: "No changes" },
          checkRepairs: [
            {
              productId: "shop",
              failureNode: "s2-checks-fail",
              checkId: "test",
              attemptId: "run-1",
              findingId: "f-check",
              sha: "abc",
              tree: "tree-abc",
              definition: "def-1",
              commands: ["bun test"],
              answer: { fixed: false, text: "Still failing" },
            },
          ],
        },
        {
          id: "s4-rerun-requested",
          kind: "petrina",
          work: "checks",
          round: 1,
          sub: 4,
          startedAt: NOW - 84 * MIN,
          endedAt: NOW - 80 * MIN,
          end: "done",
          checkReasons: [{ attemptId: "run-2", productId: "shop", purpose: "review", changed: ["requested"] }],
          productChecks: [
            {
              id: "run-2:test",
              attemptId: "run-2",
              productId: "shop",
              name: "Tests",
              result: "pass",
              startedAt: NOW - 84 * MIN,
              endedAt: NOW - 80 * MIN,
              run: recordedRun(0, NOW - 84 * MIN, NOW - 80 * MIN, "run-2", "s4-rerun-requested"),
            },
          ],
          reuses: [
            {
              at: NOW - 20 * MIN,
              originalAt: NOW - 80 * MIN,
              productId: "shop",
              purpose: "delivery-check",
              basis: "same-commit",
              passed: true,
            },
          ],
        },
        {
          id: "s5-qa",
          kind: "agent",
          stageId: "t-cycle:qa",
          round: 1,
          sub: 5,
          roleId: "custom-verifier-qa",
          startedAt: NOW - 78 * MIN,
          endedAt: NOW - 74 * MIN,
          end: "done",
          acceptanceChecks: [{ text: "Retry backoff", result: "fail", reason: "Missing jitter" }],
        },
        {
          id: "s6-return-acceptance",
          kind: "agent",
          stageId: "t-cycle:build",
          round: 1,
          sub: 6,
          roleId: "custom-implementer",
          fixing: true,
          startedAt: NOW - 73 * MIN,
          endedAt: NOW - 68 * MIN,
          end: "done",
          trigger: { after: "s5-qa", reason: "acceptance failed" },
          builderReturn: { changed: true, productId: "shop", claimedFixes: 1, outcome: "Added jitter" },
        },
        {
          id: "s7-review",
          kind: "agent",
          stageId: "t-cycle:review",
          round: 1,
          sub: 7,
          roleId: "custom-critic",
          startedAt: NOW - 65 * MIN,
          endedAt: NOW - 60 * MIN,
          end: "done",
          tone: "back",
          result: { findingChanges: { raised: [], fixed: [], dismissed: [], reopened: [{ id: "f-1", evidence: true }] } },
        },
        {
          id: "s8-return-review",
          kind: "agent",
          stageId: "t-cycle:build",
          round: 2,
          sub: 0,
          roleId: "custom-implementer",
          fixing: true,
          findingIds: ["f-1"],
          startedAt: NOW - 58 * MIN,
          endedAt: NOW - 52 * MIN,
          end: "done",
          trigger: { after: "s7-review", reason: "review findings" },
          builderReturn: { changed: true, productId: "shop", claimedFixes: 1, outcome: "Fixed f-1" },
        },
        {
          id: "s9-update",
          kind: "petrina",
          work: "update",
          round: 2,
          sub: 1,
          startedAt: NOW - 50 * MIN,
          endedAt: NOW - 49 * MIN,
          end: "done",
        },
        {
          id: "s10-return-update",
          kind: "agent",
          stageId: "t-cycle:build",
          round: 2,
          sub: 2,
          roleId: "custom-implementer",
          update: true,
          startedAt: NOW - 48 * MIN,
          endedAt: NOW - 44 * MIN,
          end: "done",
          trigger: { after: "s9-update", reason: "branch update" },
        },
        {
          id: "s11-port-review",
          kind: "agent",
          stageId: "t-cycle:review",
          round: 2,
          sub: 3,
          roleId: "custom-critic",
          port: true,
          startedAt: NOW - 43 * MIN,
          endedAt: NOW - 40 * MIN,
          end: "done",
        },
        {
          id: "s12-you-ask",
          kind: "you",
          waitsFor: "delivery",
          round: 2,
          sub: 4,
          startedAt: NOW - 38 * MIN,
          endedAt: NOW - 35 * MIN,
          outcome: "Changes asked",
        },
        {
          id: "s13-return-you",
          kind: "agent",
          stageId: "t-cycle:build",
          round: 2,
          sub: 5,
          roleId: "custom-implementer",
          fixing: true,
          startedAt: NOW - 34 * MIN,
          endedAt: NOW - 30 * MIN,
          end: "done",
          trigger: { after: "s12-you-ask", reason: "changes asked" },
        },
      ],
    });

    const baseState = state([cyclingTask]);
    const st = { ...baseState, roles: [...baseState.roles, customBuildRole, customCheckRole, customAuditRole] };
    const tp = usageView(logWith([]), { view: "analytics", period: "today" }, { now: NOW, state: st }).throughput;

    expect(tp.repeatedWork.checks).toEqual({
      executedBatches: 2,
      failedBatches: 1,
      interruptedOrUnverifiedBatches: 0,
      reusedPassedBatches: 1,
      reusedFailedBatches: 1,
      freshReasons: [
        { key: "code", label: "Code changed", count: 1 },
        { key: "requested", label: "You asked to rerun checks", count: 1 },
      ],
    });
    expect(tp.repeatedWork.builderReturns).toEqual({
      total: 5,
      unchangedSourceReturns: 1,
      byCause: [
        { key: "review", label: "Review findings", count: 1 },
        { key: "checks", label: "Automated checks", count: 1 },
        { key: "acceptance", label: "Acceptance testing", count: 1 },
        { key: "main-update", label: "Branch updates and ports", count: 1 },
        { key: "coordinator", label: "Your change requests", count: 1 },
      ],
    });
    expect(tp.repeatedWork.reviewsAndUpdates).toEqual({
      reviewRounds: 2,
      reviewSendBacks: 1,
      reopenedFindings: 1,
      mainUpdates: 1,
      portReviews: 1,
    });
    expect(tp.repeatedWork.cyclingTasks).toHaveLength(1);
    expect(tp.repeatedWork.cyclingTasks[0]).toMatchObject({
      taskId: "t-cycle",
      checkBatches: 2,
      failedCheckBatches: 1,
      reusedFailedBatches: 1,
      builderReturns: 5,
    });
  });

  it("explains what is holding progress up right now, separating started vs queued age and marking slot contention as a hypothesis", () => {
    const busy1 = task("t-busy-1", "shop", {
      state: "running",
      column: "building",
      holdsSlot: true,
      startedAt: NOW - 20 * MIN,
      finishedAt: undefined,
      agent: { roleId: "builder", profileId: "sol-high", since: NOW - 20 * MIN, step: 1 },
    });
    const checkQueued = task("t-check-wait", "shop", {
      title: "Queued behind check slot",
      state: "running",
      column: "reviewing",
      holdsSlot: false,
      createdAt: NOW - 90 * MIN,
      startedAt: NOW - 45 * MIN,
      finishedAt: undefined,
      checkActivity: {
        phase: "waiting",
        since: NOW - 15 * MIN,
        place: 2,
        ahead: 1,
        slots: 1,
        owners: [{ kind: "checks", taskId: "t-busy-1", title: "Task t-busy-1" }],
      },
    });
    const inboxBlocked = task("t-inbox", "shop", {
      title: "Needs permission",
      state: "waiting",
      column: "building",
      holdsSlot: false,
      createdAt: NOW - 80 * MIN,
      startedAt: NOW - 50 * MIN,
      finishedAt: undefined,
    });
    const slotQueued = task("t-slot-queue", "shop", {
      title: "Waiting for free slot",
      state: "queued",
      column: "queue",
      holdsSlot: false,
      createdAt: NOW - 35 * MIN,
      startedAt: undefined,
      finishedAt: undefined,
    });

    const baseState = state([busy1, checkQueued, inboxBlocked, slotQueued]);
    const st = {
      ...baseState,
      pool: { ...baseState.pool, limit: 1, paused: false },
      inbox: [
        {
          id: "ask-1",
          taskId: "t-inbox",
          kind: "permission" as const,
          title: "Run database seed",
          roleId: "builder",
          profileId: "sol-high",
          at: NOW - 25 * MIN,
          blocking: true,
        },
      ],
    };

    const tp = usageView(logWith([]), { view: "analytics", period: "today" }, { now: NOW, state: st, checkSlots: 1 }).throughput;

    expect(tp.holdingUpNow.pressures.map((p) => ({ key: p.key, hypothesis: Boolean(p.hypothesis) }))).toEqual([
      { key: "check-line-queue", hypothesis: false },
      { key: "coordinator-inbox", hypothesis: false },
      { key: "slot-contention", hypothesis: true },
    ]);

    const byTask = new Map(tp.holdingUpNow.tasks.map((item) => [item.taskId, item]));
    expect(byTask.get("t-check-wait")).toMatchObject({
      kind: "checks-line",
      startedAgeMs: 45 * MIN,
    });
    expect(byTask.get("t-check-wait")!.queuedAgeMs).toBeUndefined();
    expect(byTask.get("t-inbox")).toMatchObject({
      kind: "coordinator",
      startedAgeMs: 50 * MIN,
    });
    expect(byTask.get("t-slot-queue")).toMatchObject({
      kind: "active",
      queuedAgeMs: 35 * MIN,
      hypothesis: true,
    });
    expect(byTask.get("t-slot-queue")!.startedAgeMs).toBeUndefined();
  });
});
