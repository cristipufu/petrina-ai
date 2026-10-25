import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";
import { deliveryMissing } from "../../../src/check-evidence.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { git } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";
import { tempDir, removeDir } from "@petrina/test-support/fixtures";
import { sha } from "../../../../core/test/fixtures/related-check-evidence.js";

originalDescribe("related check evidence", () => {
it("uses the actual prepared history after updates, never the original starting commit or short labels", async () => {
    const dir = tempDir("related-delivery-");
    const clone = await makeProduct(dir), initial = await git(clone, "rev-parse", "HEAD");
    try {
      await git(clone, "checkout", "-q", "-b", "delivery");
      writeFileSync(join(clone, "repair.txt"), "replacement progress");
      await git(clone, "add", "."); await git(clone, "commit", "-qm", "Repair progress");
      const delivered = await git(clone, "rev-parse", "HEAD");
      const delivery = { sha: delivered, tree: await git(clone, "rev-parse", "HEAD^{tree}"), repo: "acme/p", branch: "main", at: 10 };
      await git(clone, "checkout", "-q", "main");
      writeFileSync(join(clone, "feature.txt"), "feature"); await git(clone, "add", "."); await git(clone, "commit", "-qm", "Build feature");
      expect(await deliveryMissing(clone, "acme/p", delivery)).toBe(true);
      expect(await deliveryMissing(clone, "acme/p", { ...delivery, sha: delivered.slice(0, 7) })).toBe(false);
      expect(await deliveryMissing(clone, "acme/p", { ...delivery, sha: sha("f") })).toBe(false);
      expect(await deliveryMissing(clone, "other/p", delivery)).toBe(false);
      expect(await deliveryMissing(clone, "acme/p", { ...delivery, tree: sha("f") })).toBe(false);
      await git(clone, "merge", "--no-edit", "delivery");
      expect(await deliveryMissing(clone, "acme/p", delivery)).toBe(false);
      expect(initial).not.toBe(delivered);
    } finally { removeDir(dir); }
  });
});
