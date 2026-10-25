import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { WorkTurn } from "@petrina/core";
import { WorkLog } from "@petrina/storage/worklog";
import { authorFor } from "../../../src/tracking.js";

it("attributes design answers to the last finished author in that stage and round", () => {
  const db = new Database(":memory:");
  try {
    const log = new WorkLog(db);
    const base: WorkTurn = { id: "original", taskId: "task-a", productId: "p", stageId: "design", stageTitle: "Design", stageKind: "converge", round: 2, fixing: false, roleId: "architect", toolId: "codex", profileId: "sol-high", sessionId: "session", reason: "first", startedAt: 1, mainOnly: false, helpers: 0 };
    for (const [index, extra] of [
      {}, { id: "replacement", profileId: "opus-high" }, { id: "later-round", round: 3 },
      { id: "other-stage", stageId: "other" }, { id: "other-role", roleId: "design-reviewer" },
      { id: "interrupted", profileId: "grok-high" }, { id: "other-task", taskId: "task-b" },
    ].entries()) {
      const turn = { ...base, ...extra, startedAt: index + 1 };
      log.startTurn(turn);
      if (turn.id !== "interrupted") log.endTurn(turn.id, { end: "finished", endedAt: index + 2, mainOnly: false, helpers: 0 }, []);
    }
    expect(authorFor(log, { id: "task-a" }, { id: "design", roleId: "architect" }, 2)).toEqual({ roleId: "architect", profileId: "opus-high" });
  } finally { db.close(); }
});
