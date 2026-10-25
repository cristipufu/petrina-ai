import { afterAll, expect, it } from "bun:test";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { verifierSelection } from "../../fixtures/verifier-selection.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const utilization of [0, 0.3, 0.95]) it(`keeps allowed Grok usage at ${utilization * 100}% eligible for the independent verifier pair`, async () => {
  const root = tempDir("verifier-selection-"); roots.push(root);
  const f = await verifierSelection(root, utilization);
  try {
    const pending = f.ballots.next(f.task, f.stage)!;
    expect(new Set(pending.seats.map(seat => seat.toolId))).toEqual(new Set(["codex", "grok"]));
    expect(pending.seats).toHaveLength(2);
  } finally { await f.engine.shutdown(); }
}, 30_000 * SLOW);
