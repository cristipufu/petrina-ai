import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { SLOW } from "@petrina/test-support/slow";
import { verifierSelection } from "../../fixtures/verifier-selection.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


for (const utilization of [0, 0.3, 0.95]) it(`keeps allowed Grok usage at ${utilization * 100}% eligible for the independent verifier pair`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const root = mkdtempSync(join(owner.root, "verifier-selection-"));
    const f = await verifierSelection(owner, root, utilization);
    try {
      const pending = f.ballots.next(f.task, f.stage)!;
      expect(new Set(pending.seats.map(seat => seat.toolId))).toEqual(new Set(["codex", "grok"]));
      expect(pending.seats).toHaveLength(2);
    } finally { await owner.stop(f.engine); }

  });
}, 30_000 * SLOW);
