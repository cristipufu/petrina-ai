import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { Engine } from "../../engine.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


it("refuses a change request for a check that is no longer waiting, so the window keeps the note", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const dir = mkdtempSync(join(owner.root, "petrina-changes-"));
    let engine: Engine | undefined;
    try {
      engine = owner.open(dir, {});
      expect(() => engine!.requestChanges("inbox-gone", "Make it friendlier")).toThrow("isn't waiting any more");
    } finally {
      if (engine) await owner.stop(engine);

    }

  });
});
