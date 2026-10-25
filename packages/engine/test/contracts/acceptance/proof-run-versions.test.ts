import { afterAll, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameVersions } from "@petrina/core";
import { git } from "../../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { changesOf, versionsOf } from "../../../src/repositories.js";
import { stepKey } from "../../../src/kernel.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { signal, fixture, testerReply, passes, close } = proofRequestFixtures();
afterAll(close);
for (const proof of [false, true]) it(`takes a new prepared snapshot after a failed Tester attempt, with requested proof ${proof}`, async () => {
  const f = await fixture(); if (proof) await f.request(); f.task.stageIndex = 1;
  const broken = spyOn(f.engine["turns"], "turn").mockRejectedValue(new Error("Controlled tool failure"));
  const review = spyOn(f.engine["reviews"], "runReview").mockResolvedValue("stop");
  try {
    await expectRejection(f.drive(), "Controlled tool failure");
    const old = structuredClone(f.task.acceptanceRun!.versions);
    expect(f.scope.work.conversation).toBeUndefined();
    broken.mockRestore(); await f.advance();
    await f.engine.retry(f.engine.s.inbox.find(item => item.kind === "stuck")!.id);
    const reply = testerReply(f, passes);
    try {
      await f.drive();
      expect(reply).toHaveBeenCalledTimes(1); expect(review).toHaveBeenCalledTimes(1);
      expect(f.task.testedVersions).toEqual(await versionsOf(f.task)); expect(f.task.testedVersions).not.toEqual(old);
      expect(f.task.acceptancePassed).toBe(true); expect(f.task.acceptanceRun).toBeUndefined();
      if (proof) expect(f.task.proofRequests![0]!.status).toBe("proved");
      expect(f.task.proofRefreshes).toBeUndefined();
    } finally { reply.mockRestore(); }
  } finally { broken.mockRestore(); review.mockRestore(); await f.close(); }
});

for (const savedConversation of [false, true]) it(`binds a restarted Tester to its ${savedConversation ? "saved conversation" : "newly prepared copy"}`, async () => {
  const f = await fixture(); await f.request(); f.task.stageIndex = 1;
  const versions = await versionsOf(f.task);
  f.task.acceptanceRun = { versions, changes: await changesOf(f.task), requestIds: [f.task.proofRequests![0]!.id] };
  if (savedConversation) f.scope.work.conversation = { step: stepKey(f.task), roleId: "tester", profileId: "opus-high", toolId: "claude", model: "opus", sessionId: "saved-tester", startedAt: 1 };
  f.engine.setPoolPaused(true); await f.stop(f.engine);
  f.engine = f.open(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); f.engine.schedule = () => {};
  await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task); f.engine.setPoolPaused(false);
  const reply = testerReply(f, passes); const review = spyOn(f.engine["reviews"], "runReview").mockResolvedValue("stop");
  try {
    await f.advance(); f.task.state = "running";
    const admit = spyOn(f.engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(true);
    try { await f.run(f.engine, () => f.engine["driver"].workflow["drive"](f.task.id)); } finally { admit.mockRestore(); }
    expect(reply).toHaveBeenCalledTimes(1); expect(f.task.acceptancePassed).toBe(true);
    expect(f.task.testedVersions).toEqual(await versionsOf(f.task));
    expect(sameVersions(f.task.testedVersions, versions)).toBe(savedConversation);
    expect(f.task.proofRequests![0]!.status).toBe("proved"); expect(f.task.proofRefreshes).toBeUndefined();
  } finally { reply.mockRestore(); review.mockRestore(); await f.close(); }
});

for (const shared of [false, true]) for (const unrelated of shared ? [false, true] : [false]) for (const result of ["pass", "fail"] as const) it(`preserves ${result} for ${shared ? "shared" : "single"} proof when ${unrelated ? "another" : "an affected"} product changes during testing`, async () => {
  const f = await fixture(shared); const request = await f.request("Prove the first product", [f.products[0]!.id]);
  f.task.retest = true; f.task.stageIndex = 1;
  const before = await versionsOf(f.task);
  const reply = testerReply(f, ids => ids.map(id => ({ id, result, evidence: "The scoped scenario and its nearby control were tried" })), async () => {
    const work = f.owners[unrelated ? 1 : 0]!.worktree;
    writeFileSync(join(work, "during.txt"), "A new task change\n"); await git(work, "add", "."); await git(work, "commit", "-q", "-m", "Change during acceptance");
  });
  try {
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(request.proof!.versions).toEqual(before); expect(request.proof!.result).toBe(result);
    expect(request.status).toBe(unrelated ? result === "pass" ? "proved" : "failed" : "stale");
    expect(f.task.acceptanceUnverified).toBe(false); expect(f.task.acceptanceBlocked).toBeUndefined();
    if (result === "fail") {
      expect(f.task.stageIndex).toBe(0); expect(f.task.findings).toHaveLength(1);
      expect(f.task.findings[0]!.proofRequestId).toBe(request.id); expect(f.task.findings[0]!.status).toBe("open");
      expect(f.scope.work.acceptanceReturns).toBe(1);
      if (shared) expect(f.task.repair!.products).toEqual([f.products[0]!.id]);
    } else {
      expect(f.task.stageIndex).toBe(3); expect(f.task.acceptancePassed).toBe(false);
      reply.mockRestore(); const refresh = testerReply(f, passes);
      try { await f.drive(); expect(refresh).toHaveBeenCalledTimes(1); expect(request.status).toBe("proved"); expect(f.task.acceptancePassed).toBe(true); }
      finally { refresh.mockRestore(); }
    }
    expect(f.task.proofRefreshes).toBeUndefined();
  } finally { reply.mockRestore(); await f.close(); }
});
