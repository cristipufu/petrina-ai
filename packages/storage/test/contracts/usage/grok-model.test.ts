import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { modelSplit } from "@petrina/core";
import { WorkLog } from "../../../src/worklog.js";

  it("keeps the resolved model's tokens and agent time on the same Analytics row", () => {
    const db = new Database(":memory:");
    try {
      const log = new WorkLog(db);
      log.startTurn({ id: "resolved", taskId: "task", productId: "product", stageId: "build", stageTitle: "Build", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "grok", profileId: "grok-xhigh", sessionId: "session", reason: "first", startedAt: 1, modelAsked: "grok-4.7", modelRan: "grok-4.7", mainOnly: false, helpers: 0 });
      log.endTurn("resolved", { end: "finished", endedAt: 11, workMs: 10, mainOnly: false, helpers: 0, modelRan: "grok-4.7-build", tokens: { input: 100, cacheRead: 1000, output: 50, total: 1150 } }, [{ model: "grok-4.7-build", input: 100, cacheRead: 1000, output: 50, total: 1150 }]);
      const rows = modelSplit(log.turns({}), log.lines({}));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ label: "Grok 4.7", tokens: { value: 1150 }, time: { value: 10 } });
      expect(log.turns({})[0]?.modelAsked).toBe("grok-4.7");
    } finally { db.close(); }
  });
