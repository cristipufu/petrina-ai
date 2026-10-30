import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { executionFor } from "@petrina/orchestrator";
import { versionsOf } from "../../../src/repositories.js";
import { ReviewResult } from "../../../src/roles.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { signal, fixture, testerReply, passes, close } = proofRequestFixtures();
afterAll(close);
it("retains an earlier pass and refreshes it when an affected product changes during acceptance", async () => {
  const f = await fixture(true); const request = await f.request();
  const before = await versionsOf(f.task);
  f.task.retest = true; f.task.stageIndex = 1;
  const reply = testerReply(f, passes, async () => {
    const companion = f.owners[1]!.worktree;
    writeFileSync(join(companion, "changed-during-acceptance.txt"), "A different companion version\n");
    await gitOps.commitChanges(companion, "Change the companion during acceptance");
  });
  try {
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.testedVersions).toEqual(before);
    expect(request.proof!.versions).toEqual(before);
    expect(request.proof!.result).toBe("pass");
    expect(request.status).toBe("stale");
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(false);
    expect(f.task.findings).toEqual([]); expect(f.task.repair).toBeUndefined();
    expect(f.task.acceptanceBlocked).toBeUndefined();
    reply.mockRestore();
    const refresh = testerReply(f, passes);
    try {
      await f.drive();
      expect(refresh).toHaveBeenCalledTimes(1); expect(request.status).toBe("proved");
      expect(f.task.testedVersions).toEqual(await versionsOf(f.task));
      expect(f.task.proofRefreshes).toBeUndefined();
      expect(f.task.timeline.some(line => line.text === "Final acceptance testing: the task's code changed since acceptance testing")).toBe(true);
    } finally { refresh.mockRestore(); }
  } finally { reply.mockRestore(); await f.close(); }
});

it("keeps new requests from a reopened passing review, while replay and restart keep each request once", async () => {
  const f = await fixture();
  try {
    const apply = async (text: string) => f.engine["reviews"]["applyReview"](f.scope, f.review, ReviewResult.parse({ verdict: "pass", proofRequests: [{ text, reason: "Required on the final version", productIds: [f.task.productId] }] }), "sol-high", "code-reviewer", "0");
    const start = async () => {
      f.task.stageIndex = 2;
      f.task.hunt = { stageId: "review", round: 1, reported: {}, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: await versionsOf(f.task) } };
      beginAgentStep(f.task, "code-reviewer", "sol-high", 1, f.engine.s.roles, undefined, f.scope.work);
    };
    await start(); await apply("Run Linux capacity");
    await f.engine["reviews"]["closeReviewRound"](f.task, f.review, 1, "Nothing to fix"); delete f.task.hunt;
    f.engine.gate(f.task, "delivery");
    f.engine.requestChanges(f.engine.s.inbox.find(item => item.kind === "delivery")!.id, "Also cover the Windows case");
    expect(f.task.rounds.review).toBeUndefined();
    await start(); await apply("Run Windows paths");
    const sources = f.task.proofRequests!.map(request => request.source);
    expect(new Set(sources).size).toBe(2);
    f.engine.setPoolPaused(true); await f.stop(f.engine);
    f.engine = f.open(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    await apply("Run Windows paths");
    expect(f.task.proofRequests!.map(request => request.text)).toEqual(["Run Linux capacity", "Run Windows paths"]);
    expect(f.task.proofRequests!.map(request => request.source)).toEqual(sources);
    expect(f.task.proofRequests!.every(request => request.status === "pending")).toBe(true);
    expect(f.task.findings).toEqual([]); expect(f.task.rounds.review).toBeUndefined();
  } finally { await f.close(); }
});
