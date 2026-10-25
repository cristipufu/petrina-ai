import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkLog } from "@petrina/storage/worklog";
import { removeDir } from "@petrina/test-support/fixtures";
describe("A step a usage limit stopped", () => {
  it("keeps the retry it owes across a restart, and drops a saved list it cannot read", () => {
    const file = join(mkdtempSync(join(tmpdir(), "petrina-owed-")), "petrina.db");
    try {
      const first = new Database(file);
      new WorkLog(first).setOwedRetries(["task-3|builder|opus-high"]);
      first.close();
      const again = new Database(file);
      const log = new WorkLog(again);
      expect(log.owedRetries()).toEqual(["task-3|builder|opus-high"]);
      again.query("UPDATE work_meta SET value = 'not a list' WHERE key = 'owed-retries'").run();
      expect(log.owedRetries()).toEqual(["task-3|builder|opus-high"]);
      expect(new WorkLog(again).owedRetries()).toEqual([]);
      log.close();
      // Petrina is stopping: nothing more is written.
      log.setOwedRetries(["task-4|builder|opus-high"]);
      expect(log.owedRetries()).toEqual([]);
      again.close();
    } finally {
      removeDir(join(file, ".."));
    }
  });
});
