import { expect, it } from "bun:test";
import { join } from "node:path";
import { displayTask, journeyView, nextLine, owedAcceptanceTest } from "@petrina/core";
import { Store } from "../../../src/store.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { legacyRepairState } from "../../fixtures/acceptance-repair.js";

it("restores the actual legacy early-repair record before another acceptance report", () => {
  const root = tempDir("petrina-legacy-acceptance-"), file = join(root, "state.db"), state = legacyRepairState();
  let store: Store | undefined;
  try {
    store = new Store(file); store.save(state, []); store.close(); store = undefined;
    store = new Store(file);
    const loaded = store.loadActive()!, task = loaded.tasks[0]!, shown = displayTask(task);
    expect(task).toEqual(state.tasks[0]!);
    expect(task.retest).toBe(true); expect(task.repairCheck).toBeUndefined();
    expect(task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(task.proofDeliveryGate).toBe("added-check");
    expect(owedAcceptanceTest(task)).toEqual({ stage: 1, final: false });
    expect(nextLine(loaded, shown)).toBe("Next: acceptance testing of the repair (Claude Code · Opus 5.5), then code review (Codex · sol and Claude Code · Opus 5.5)");
    expect(journeyView(shown, { roles: loaded.roles, profiles: loaded.profiles, tasks: loaded.tasks, inbox: loaded.inbox }).nodes.filter(node => ["next", "ahead"].includes(node.state)).map(node => `${node.name}: ${node.state}`))
      .toEqual(["Tester (again): next", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]);
  } finally { try { store?.close(); } finally { removeDir(root); } }
});
