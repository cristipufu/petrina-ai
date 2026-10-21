import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { type WorkTurn } from "@petrina/core";
import { WorkLog } from "../src/worklog.js";

const turn: WorkTurn = { id: "turn", taskId: "task", productId: "product", stageId: "build", stageTitle: "Build", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "codex", profileId: "sol", sessionId: "continued-session", reason: "first", startedAt: 10, mainOnly: false, helpers: 0 };

it("upgrades old usage safely and retains exact step, run and seat after reopening", () => {
  const db = new Database(":memory:");
  try {
    const first = new WorkLog(db);
    first.startTurn({ ...turn, id: "old" });
    first.close();
    // An old installation has the same existing schema without the three new marks.
    for (const column of ["journey_id", "agent_run_id", "agent_seat"]) db.run(`ALTER TABLE work_turns DROP COLUMN ${column}`);
    const upgraded = new WorkLog(db);
    expect(upgraded.turns({ taskId: "task" })[0]!.journeyId).toBeUndefined();
    const marked = { ...turn, journeyId: "j30", agentRunId: "second-start", agentSeat: "0" };
    upgraded.startTurn(marked);
    for (const total of [100, 200, 200]) upgraded.endTurn(turn.id, { end: "finished", endedAt: 20, helpers: 0, mainOnly: false, tokens: { total } }, [{ model: "new-model", total }]);
    upgraded.close();
    const reopened = new WorkLog(db);
    expect(reopened.turns({ taskId: "task" }).find(row => row.id === turn.id)).toEqual({ ...marked, end: "finished", endedAt: 20, tokens: { total: 200 } });
    expect(reopened.lines({ taskId: "task" })).toEqual([{ turnId: "turn", model: "new-model", total: 200 }]);
    reopened.endTurn(turn.id, { end: "finished", endedAt: 21, helpers: 0, mainOnly: false, tokens: { total: 300 } }, [{ model: "final-model", total: 300 }]);
    expect(reopened.lines({ taskId: "task" })).toEqual([{ turnId: "turn", model: "final-model", total: 300 }]);
  } finally { db.close(); }
});
