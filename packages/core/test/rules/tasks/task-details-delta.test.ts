import { describe, expect, it } from "vitest";
import {
  appendSessionLine,
  applyTaskDetailsUpdate,
  captureTaskDetailsBase,
  diffTaskDetails,
  type SessionLine,
  type Task,
} from "../../../src/index.js";

function sampleTask(): Task {
  return {
    id: "task-1",
    productId: "prod-1",
    delivery: "pull-request",
    title: "Stream task details incrementally",
    description: "Send deltas for open task sheets.",
    area: "tasks",
    kind: "feature",
    createdAt: 100,
    approvePlan: false,
    approveDelivery: false,
    detailsRevision: "boot:1",
    priority: 0,
    held: false,
    state: "running",
    column: "building",
    holdsSlot: true,
    stageIndex: 1,
    rounds: { review: 1 },
    sub: 0,
    fixing: false,
    objections: [],
    findings: [],
    statusLine: "Reviewing",
    queued: [],
    timeline: [
      { id: "tl-1", at: 10, tone: "status", text: "Started build" },
      { id: "tl-2", at: 20, tone: "status", text: "Started review" },
    ],
    session: [
      { id: "s-1", at: 10, from: "agent", roleId: "builder", text: "Built initial version" },
      { id: "s-2", at: 25, from: "agent", roleId: "reviewer", text: "Checking edge cases" },
    ],
    journey: [
      { id: "step-1", kind: "agent", stageId: "build", round: 1, sub: 0, roleId: "builder", profileId: "claude-sonnet", startedAt: 10, endedAt: 20 },
      { id: "step-2", kind: "agent", stageId: "review", round: 1, sub: 0, roleId: "reviewer", profileId: "claude-opus", startedAt: 25 },
    ],
    handedBack: [{ at: 15, stageId: "build", roleId: "builder", title: "Build", summary: "Initial handback", notes: [] }],
    hunt: { stageId: "review", round: 1, reported: { "reviewer:0": true } },
  };
}

describe("taskDetails delta protocol", () => {
  it("emits unchanged when the revision matches", () => {
    const task = sampleTask();
    const base = captureTaskDetailsBase(task);
    const { update } = diffTaskDetails(base, task);
    expect(update).toEqual({ kind: "unchanged", detailsRevision: "boot:1" });
    expect(applyTaskDetailsUpdate(task, update)).toBe(task);
  });

  it("sends only the mutated streaming SessionLine and active JourneyStep without resending untouched history", () => {
    const initial = sampleTask();
    const base = captureTaskDetailsBase(initial);

    // Clone and mutate to verify captureTaskDetailsBase is immune to in-place RuntimeTask mutations.
    const mutated = JSON.parse(JSON.stringify(initial)) as Task;
    const lastLine = mutated.session.at(-1)! as { -readonly [K in keyof SessionLine]: SessionLine[K] };
    lastLine.text = `${lastLine.text} streamed words`;
    mutated.session = [
      ...mutated.session.slice(0, -1),
      lastLine,
      { id: "line-new-1", at: 999, from: "agent", text: "Next paragraph", roleId: "reviewer" },
    ];
    mutated.journey = [
      mutated.journey![0]!,
      { ...mutated.journey![1]!, endedAt: 50 },
    ];
    mutated.detailsRevision = "boot:2";

    const { update } = diffTaskDetails(base, mutated);
    expect(update.kind).toBe("delta");
    if (update.kind !== "delta") throw new Error("Expected delta");
    expect(update.session?.order).toBeUndefined();
    expect(update.session?.upserts.map((line) => line.id)).toEqual([lastLine.id, "line-new-1"]);
    expect(update.timeline).toBeUndefined();
    expect(update.journey).toEqual({
      length: 2,
      steps: [{ index: 1, step: mutated.journey[1]! }],
    });
    expect(update.extras).toBeUndefined();

    const reconstructed = applyTaskDetailsUpdate(initial, update);
    expect(reconstructed).toEqual(mutated);
  });

  it("preserves exact ordering across non-FIFO interior session eviction and timeline head trimming", () => {
    const baseTask = sampleTask();
    const lines: SessionLine[] = [
      { id: "l-pinned-image", at: 1, from: "agent", roleId: "builder", profileId: "p1", text: "Screenshot", images: [{ id: "shot-1", caption: "Shot" }] },
      { id: "l-evictable", at: 2, from: "agent", roleId: "builder", profileId: "p1", text: "Earlier builder note" },
      { id: "l-keep-latest-builder", at: 3, from: "agent", roleId: "builder", profileId: "p1", text: "Latest builder note" },
      { id: "l-reviewer", at: 4, from: "agent", roleId: "reviewer", profileId: "p2", text: "Reviewer note" },
    ];
    const start: Task = { ...baseTask, detailsRevision: "boot:10", session: [...lines] };
    const base = captureTaskDetailsBase(start);

    const nextLines = [...lines];
    appendSessionLine(
      nextLines as never,
      { id: "l-new", at: 5, from: "activity", text: "Running checks" } as never,
      new Set(),
      4,
    );
    expect(nextLines.map((line) => line.id)).toEqual([
      "l-pinned-image",
      "l-keep-latest-builder",
      "l-reviewer",
      "l-new",
    ]);

    const { handedBack: _droppedHandedBack, ...startWithoutHandedBack } = start;
    const nextTask: Task = {
      ...startWithoutHandedBack,
      detailsRevision: "boot:11",
      session: nextLines,
      timeline: [...start.timeline.slice(1), { id: "tl-new", at: 500, tone: "status", text: "Trimmed oldest timeline" }],
      hunt: { ...start.hunt!, reported: { "reviewer:0": true, "reviewer:1": true } },
    };

    const { update } = diffTaskDetails(base, nextTask);
    expect(update.kind).toBe("delta");
    if (update.kind !== "delta") throw new Error("Expected delta");
    expect(update.session?.order).toEqual(["l-pinned-image", "l-keep-latest-builder", "l-reviewer", "l-new"]);
    expect(update.session?.upserts.map((line) => line.id)).toEqual(["l-new"]);
    expect(update.timeline?.order).toBeDefined();

    const reconstructed = applyTaskDetailsUpdate(start, update);
    expect(reconstructed).toEqual(nextTask);
  });
});
