import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryWorkLog,
  reviewStats,
  throughputTaskRecord,
  usageView,
  type CheckRun,
  type State,
  type UsageRequest,
} from "@petrina/core";
import { AnalyticsPage } from "../../../src/components/Analytics";
import { lookup } from "../../../src/lib";
import { stateFixture, taskFixture } from "../../fixtures/state";

const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

let currentView: ReturnType<typeof usageView> | undefined;

vi.mock("../../../src/engine", () => ({
  mode: "demo",
  desktop: false,
  sim: {
    usage: (_request: UsageRequest) => currentView,
  },
}));

let root: Root;
let host: HTMLDivElement;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function checkRun(code: number, startedAt: number, endedAt: number, attemptId: string, stepId: string): CheckRun {
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

describe("Analytics throughput and bottlenecks presentation", () => {
  it("renders delivery and cycle-time stats, wall vs parallel agent work, cached-failure reuse, hypothesis badges and task drill-downs in plain language without dashes or code", async () => {
    const state = stateFixture(NOW, {
      pool: { limit: 1, paused: false, toolCaps: {} },
    });

    const runningBusy = taskFixture(state, {
      id: "task-busy",
      productId: "shop",
      title: "Checkout validation",
      state: "running",
      column: "building",
      holdsSlot: true,
      createdAt: NOW - 90 * MIN,
      startedAt: NOW - 60 * MIN,
      agent: { roleId: "builder", profileId: "sol-high", since: NOW - 60 * MIN, step: 1 },
    });

    const queuedSlot = taskFixture(state, {
      id: "task-queued",
      productId: "shop",
      title: "Search indexing",
      state: "queued",
      column: "queue",
      holdsSlot: false,
      createdAt: NOW - 40 * MIN,
      startedAt: undefined,
    });

    const checkWaiting = taskFixture(state, {
      id: "task-check-line",
      productId: "shop",
      title: "Order receipt emails",
      state: "running",
      column: "reviewing",
      holdsSlot: false,
      createdAt: NOW - 2 * HOUR,
      startedAt: NOW - 75 * MIN,
      checkActivity: {
        phase: "waiting",
        since: NOW - 20 * MIN,
        place: 2,
        ahead: 1,
        slots: 1,
        owners: [{ kind: "checks", taskId: "task-busy", title: "Checkout validation" }],
      },
    });

    const archivedLanded = taskFixture(state, {
      id: "task-archived",
      productId: "shop",
      title: "Fix webhook retry loop",
      state: "done",
      column: "done",
      createdAt: NOW - 4 * HOUR,
      startedAt: NOW - 3 * HOUR - 30 * MIN,
      finishedAt: NOW - 2 * HOUR,
      delivery: "local",
      landed: { branch: "main", sha: "deadbeef1234567890" },
      confirmedDelivery: { sha: "deadbeef1234567890", tree: "tree-deadbeef", repo: "acme/shop", branch: "main", at: NOW - 2 * HOUR },
      journey: [
        {
          id: "j1",
          kind: "agent",
          stageId: "build",
          round: 1,
          sub: 0,
          roleId: "builder",
          startedAt: NOW - 210 * MIN,
          endedAt: NOW - 190 * MIN,
          end: "done",
        },
        {
          id: "j2",
          kind: "petrina",
          work: "checks",
          round: 1,
          sub: 1,
          startedAt: NOW - 190 * MIN,
          endedAt: NOW - 175 * MIN,
          end: "failed",
          checkReasons: [{ attemptId: "run-1", productId: "shop", purpose: "review", changed: ["code"] }],
          productChecks: [
            {
              id: "run-1:test",
              attemptId: "run-1",
              productId: "shop",
              name: "Tests",
              result: "fail",
              queuedAt: NOW - 195 * MIN,
              startedAt: NOW - 190 * MIN,
              endedAt: NOW - 175 * MIN,
              run: checkRun(1, NOW - 190 * MIN, NOW - 175 * MIN, "run-1", "j2"),
            },
          ],
          reuses: [
            {
              at: NOW - 170 * MIN,
              originalAt: NOW - 175 * MIN,
              productId: "shop",
              purpose: "review",
              basis: "same-tree",
              passed: false,
            },
          ],
        },
        {
          id: "j3",
          kind: "agent",
          stageId: "build",
          round: 2,
          sub: 0,
          roleId: "builder",
          fixing: true,
          startedAt: NOW - 168 * MIN,
          endedAt: NOW - 150 * MIN,
          end: "done",
          trigger: { after: "j2", reason: "checks failed" },
          checkRepairs: [
            {
              productId: "shop",
              failureNode: "j2",
              checkId: "test",
              attemptId: "run-1",
              findingId: "f-check",
              sha: "deadbeef1234567890",
              tree: "tree-deadbeef",
              definition: "def-1",
              commands: ["bun test"],
              answer: { fixed: true, text: "Fixed" },
            },
          ],
        },
        {
          id: "j4",
          kind: "petrina",
          work: "checks",
          round: 2,
          sub: 1,
          startedAt: NOW - 150 * MIN,
          endedAt: NOW - 135 * MIN,
          end: "done",
          checkReasons: [{ attemptId: "run-2", productId: "shop", purpose: "review", changed: ["code"] }],
          productChecks: [
            {
              id: "run-2:test",
              attemptId: "run-2",
              productId: "shop",
              name: "Tests",
              result: "pass",
              startedAt: NOW - 150 * MIN,
              endedAt: NOW - 135 * MIN,
              run: checkRun(0, NOW - 150 * MIN, NOW - 135 * MIN, "run-2", "j4"),
            },
          ],
        },
      ],
    });

    state.tasks = [runningBusy, queuedSlot, checkWaiting];
    state.history = {
      revision: 1,
      total: 1,
      products: [{ productId: "shop", done: 1, cancelled: 0 }],
      reviews: reviewStats([]),
      reviewsByProduct: {},
      steps: [],
    };

    const log = new MemoryWorkLog(NOW - 5 * 24 * HOUR);
    log.addTurn(
      {
        id: "t1",
        taskId: "task-busy",
        productId: "shop",
        stageId: "build",
        stageTitle: "Build",
        stageKind: "do",
        round: 1,
        fixing: false,
        roleId: "builder",
        toolId: "codex",
        profileId: "sol-high",
        sessionId: "s1",
        reason: "first",
        startedAt: NOW - 60 * MIN,
        endedAt: NOW - 10 * MIN,
        end: "finished",
        mainOnly: false,
        helpers: 0,
        workMs: 50 * MIN,
        tokens: { input: 1000, output: 500, total: 1500 },
      },
      [],
    );
    log.addTurn(
      {
        id: "t2",
        taskId: "task-check-line",
        productId: "shop",
        stageId: "review",
        stageTitle: "Review",
        stageKind: "review-chain",
        round: 1,
        fixing: false,
        roleId: "code-reviewer",
        toolId: "claude-code",
        profileId: "opus-high",
        sessionId: "s2",
        reason: "first",
        startedAt: NOW - 50 * MIN,
        endedAt: NOW - 20 * MIN,
        end: "finished",
        mainOnly: false,
        helpers: 0,
        workMs: 30 * MIN,
        tokens: { input: 800, output: 200, total: 1000 },
      },
      [],
    );

    currentView = usageView(
      log,
      { view: "analytics", period: "7d" },
      {
        now: NOW,
        state: state as State,
        checkSlots: 1,
        archivedThroughputTasks: () => [throughputTaskRecord(archivedLanded)],
      },
    );

    const onOpen = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <AnalyticsPage
          state={state as State}
          find={lookup(state as State)}
          product="all"
          about={false}
          onAboutSeen={() => {}}
          onOpen={onOpen}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const section = host.querySelector<HTMLElement>(".throughput-section")!;
    expect(section).not.toBeNull();
    const text = section.textContent ?? "";

    // Headline stats & cycle-time split
    expect(text).toContain("Throughput and bottlenecks");
    expect(text).toContain("Confirmed landed");
    expect(text).toContain("Wait before start");
    expect(text).toContain("30m");
    expect(text).toContain("Start to delivery");
    expect(text).toContain("1h 30m");
    expect(text).toContain("Shared check line");

    // Wall time (50m) vs parallel summed agent time (1h 20m across 2 tasks)
    expect(text).toContain("Where time and waits went");
    expect(text).toContain("1h 20m across 2 tasks");

    // Repeated work & honest attribution
    expect(text).toContain("2 fresh check runs (1 failed)");
    expect(text).toContain("1 reused cached failure");
    expect(text).toContain("1 return to build (automated checks: 1)");
    expect(text).not.toMatch(/flaky/i);

    // Live bottlenecks & Hypothesis badges
    expect(text).toContain("Holding progress up now");
    expect(text).toContain("Hypothesis");
    expect(text).toContain("Started 1h 15m ago");
    expect(text).toContain("Queued 40m ago");

    // No dashes, raw commands, or git SHAs
    expect([...host.querySelectorAll(".stat, .split-row")].map((el) => el.textContent).join("")).not.toMatch(/[—–]/);
    expect(text).not.toContain("bun test");
    expect(text).not.toContain("deadbeef1234567890");

    // Clicking archived cycling task and live blocked task opens their task sheets
    const archivedBtn = [...section.querySelectorAll<HTMLButtonElement>("button.split-open")].find(
      (btn) => btn.textContent === "Fix webhook retry loop",
    );
    expect(archivedBtn).toBeDefined();
    await act(async () => {
      archivedBtn!.click();
    });
    expect(onOpen).toHaveBeenCalledWith("task-archived");

    const liveBtn = [...section.querySelectorAll<HTMLButtonElement>("button.split-open")].find(
      (btn) => btn.textContent === "Order receipt emails",
    );
    expect(liveBtn).toBeDefined();
    await act(async () => {
      liveBtn!.click();
    });
    expect(onOpen).toHaveBeenCalledWith("task-check-line");
  });
});
