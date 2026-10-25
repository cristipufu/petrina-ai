import { afterAll, expect, it } from "bun:test";
import { beginAgentStep } from "@petrina/core";
import { versionsOf } from "../../../src/repositories.js";
import { recordReviewProofs } from "@petrina/orchestrator";
import { ReviewResult } from "../../../src/roles.js";
import { checkpointView } from "../../../src/checkpoint-read.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { signal, fixture, testerReply, passes, close } = proofRequestFixtures();
afterAll(close);
for (const brief of [false, true]) it(`forces exact-version proof after unchanged-patch main advances, with brief ${brief}, then bounds main-only reruns across restart`, async () => {
  const f = await fixture(false, brief);
  const reply = testerReply(f, passes);
  try {
    const request = await f.request(); await f.recordPass(); const oldPatch = f.task.testedPatch;
    await f.advance();
    await f.drive();
    expect(reply).toHaveBeenCalledTimes(1); expect(f.task.proofRefreshes).toBe(1);
    expect(request.status).toBe("proved"); expect(f.task.testedPatch).toBe(oldPatch);
    expect(f.task.testedVersions).toEqual(await versionsOf(f.task));
    const node = f.task.journey!.find(step => step.id === request.proof!.stepId)!;
    expect(node.acceptancePatch).toBe(oldPatch);
    const inspect = async () => {
      const checkpoint = await checkpointView(f.engine, f.engine.taskDetails(f.task.id)!, f.engine.s.inbox.find(item => item.kind === "delivery")!);
      if (!("proofRequests" in checkpoint)) throw new Error("Expected a delivery check with proof requests");
      return checkpoint;
    };
    let checkpoint = await inspect();
    expect(checkpoint.proofRequests).toEqual(f.task.proofRequests!);
    expect(checkpoint.proofRequests![0]!.status).toBe("proved");
    const evidence = checkpoint.acceptance!.evidence;
    if (!("nodeId" in evidence) || !("report" in evidence)) throw new Error("Expected the recorded acceptance report");
    expect(evidence.nodeId).toBe(node.id);
    expect(evidence.report).toMatchObject({ operation: "journey.result", nodeId: node.id });
    expect(checkpoint.acceptance!.evidence.products[0]!.state).toBe("same-contents");
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.task.rounds.review).toBeUndefined(); expect(f.task.stageIndex).toBe(3);
    f.engine.s.inbox = []; await f.advance(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(2); expect(f.task.proofRefreshes).toBe(2);
    expect(f.task.timeline.some(line => line.text === "Final acceptance testing: main moved since the proof was recorded")).toBe(true);
    f.engine.s.inbox = []; await f.advance(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(2); expect(request.status).toBe("stale");
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("earlier version");
    checkpoint = await inspect();
    expect(checkpoint.proofRequests![0]!.status).toBe("stale");
    expect(checkpoint.proofRefreshes).toBe(2);
    expect(checkpoint.acceptance!.evidence.products[0]!.state).toBe("same-change");
    const id = f.task.id; f.engine.setPoolPaused(true); await f.stop(f.engine);
    const restored = f.open(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); restored.schedule = () => {};
    try { expect(restored.task(id)!.proofRefreshes).toBe(2); expect(restored.task(id)!.proofRequests![0]!.status).toBe("stale"); }
    finally { await f.stop(restored); }
  } finally { reply.mockRestore(); await f.close(); }
});

for (const refreshes of [0, 1]) it(`refreshes proof after main moves during final testing, with ${2 - refreshes} main refreshes available`, async () => {
  const f = await fixture(); const request = await f.request(); await f.recordPass(); f.task.proofRefreshes = refreshes;
  let runs = 0;
  const reply = testerReply(f, passes, async () => {
    if (++runs === 1) { await f.advance(); await f.engine["updates"].upToDate(f.scope, signal()); }
  });
  try {
    await f.advance(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(2 - refreshes); expect(f.task.proofRefreshes).toBe(2);
    expect(request.proof!.result).toBe("pass"); expect(f.task.acceptanceUnverified).toBe(false);
    expect(f.task.acceptanceBlocked).toBeUndefined(); expect(f.task.findings).toEqual([]);
    expect(request.status).toBe(refreshes ? "stale" : "proved");
    expect(f.task.proofRefreshBlocked).toBe(!!refreshes);
    expect(f.task.stageIndex).toBe(3);
    f.engine.s.inbox = []; await f.drive(); expect(reply).toHaveBeenCalledTimes(2 - refreshes);
  } finally { reply.mockRestore(); await f.close(); }
});

it("passes proof-only review without votes or Builder work, freezes peer context and tests once after both main advances", async () => {
  const f = await fixture(); const reply = testerReply(f, passes);
  try {
    await f.recordPass([]); await f.advance(); await f.engine["updates"].upToDate(f.scope, signal());
    const snapshot = await f.engine["context"].captureReview(f.scope);
    f.task.hunt = { stageId: "review", round: 1, reported: { "0": true }, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: await versionsOf(f.task) } };
    const value = ReviewResult.parse({ verdict: "pass", proofRequests: [{ text: "Required Ubuntu proof", reason: "Linux must cover the final code", productIds: [f.task.productId] }] });
    recordReviewProofs(f.engine, f.task, f.review, value.proofRequests, "sol-high", "code-reviewer", "0");
    const peer = await f.engine["context"].sectionsFor(f.scope, "security-reviewer", undefined, undefined, undefined, snapshot);
    expect(peer.find(section => section.title === "Proof requests for final acceptance testing")!.body).not.toContain("Required Ubuntu proof");
    f.task.stageIndex = 2;
    beginAgentStep(f.task, "code-reviewer", "sol-high", 1, f.engine.s.roles, undefined, f.scope.work);
    expect(f.engine["reviews"]["pendingVote"](f.task, f.review)).toBeUndefined();
    await f.engine["reviews"]["closeReviewRound"](f.task, f.review, 1, "Nothing to fix", await versionsOf(f.task));
    expect(f.task.stageIndex).toBe(3); expect(f.task.fixing).toBe(false); expect(f.task.findings).toEqual([]);
    expect(f.task.journey!.at(-1)!.reason).toContain("review passed; 1 proof request");
    await f.advance(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(1); expect(f.task.proofRequests![0]!.status).toBe("proved");
    expect(f.task.journey!.filter(step => step.roleId === "builder")).toHaveLength(0);
    expect(f.task.rounds.review).toBeUndefined();
  } finally { reply.mockRestore(); await f.close(); }
});

it("keeps ordinary unchanged-patch reuse and already-current proof without an additional Tester", async () => {
  const f = await fixture(); const reply = testerReply(f, passes);
  try {
    await f.recordPass([]); await f.advance(); await f.drive(); expect(reply).not.toHaveBeenCalled();
    f.engine.s.inbox = []; await f.request(); await f.recordPass(); await f.drive(); expect(reply).not.toHaveBeenCalled();
    expect(f.task.proofRequests![0]!.status).toBe("proved");
  } finally { reply.mockRestore(); await f.close(); }
});
