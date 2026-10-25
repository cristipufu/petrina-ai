import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { TaskHistory } from "../../../src/history-store.js";
import { join } from "node:path";
import { tempDir, removeDir } from "@petrina/test-support/fixtures";
import { sha, peer, matches, archived } from "../../../../core/test/fixtures/related-check-evidence.js";

originalDescribe("related check evidence", () => {
it("reads bounded, product-scoped evidence after restart without loading private task material", () => {
    const folder = tempDir("related-history-"); const file = join(folder, "history.db");
    let db = new Database(file);
    try {
      const history = new TaskHistory(db);
      history.put(Array.from({ length: 30 }, (_, i) => {
        const p = peer(`peer-${i}`); p.delivery = { sha: sha("e"), tree: sha("f"), repo: "acme/p", branch: "main", at: 10 };
        return archived(p);
      }));
      db.close(); db = new Database(file);
      const loaded = new TaskHistory(db);
      const records = loaded.checkEvidence("p");
      expect(records).toHaveLength(24);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
      expect(loaded.checkEvidence("other")).toEqual([]);
      expect(records[0]!.journey[0]!.id).toBe("j5");
      expect(records[0]!.journey[1]!.checkRepairs![0]!.tree).toBe(sha("d"));
      expect(records[0]!.delivery!.sha).toBe(sha("e"));
      expect(matches({ ...records[0]!, state: "running" })[0]!.status).toBe("claimed");
    } finally { db.close(); removeDir(folder); }
  });
});
