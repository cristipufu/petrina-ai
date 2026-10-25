import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkLog } from "@petrina/storage/worklog";
describe("An agent session", () => {
it("keeps unfamiliar model names exactly as reported, including long names with different endings", () => {
    const prefix = `unfamiliar-${"model-".repeat(40)}`;
    const names = [`${prefix}[fast]`, `${prefix}[careful]`];
    const db = new Database(":memory:");
    try {
      const log = new WorkLog(db);
      log.startTurn({ id: "long-names", taskId: "names", productId: "product", stageId: "build", stageTitle: "Build", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "claude-code", profileId: "opus-high", sessionId: "session", reason: "first", startedAt: 1, mainOnly: false, helpers: 0 });
      log.endTurn("long-names", { end: "finished", endedAt: 2, workMs: 1, mainOnly: false, helpers: 0, tokens: { total: 30 } }, names.map((model) => ({ model, total: 15 })));
      expect(log.lines({ taskId: "names" }).map((line) => line.model).sort()).toEqual([...names].sort());
    } finally {
      db.close();
    }
  });
});
