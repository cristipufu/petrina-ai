import { afterAll, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandInputText, proofDecision, proofGap } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { versionsOf } from "../../../src/repositories.js";
import { recordReviewProofs } from "@petrina/orchestrator";
import * as gitSteps from "@petrina/repositories/git";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";
import { readRef, readWorktreeCommit } from "../../fixtures/shared-preparation.js";

const { signal, fixture, close } = proofRequestFixtures();
afterAll(close);
it("checks a saved prepared delivery again after main moves and retains the publishing return reason", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    const versions = await versionsOf(f.task); f.task.approvedProofDecision = proofDecision(f.task, versions);
    const head = readWorktreeCommit(f.scope.work.worktree!)!.commit;
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: head, prepared: { tested: head, summary: "Prepared" } };
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(true);
    await f.advance();
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(false);
    await f.engine["shipping"]["prepareAgain"](f.scope, "Main moved during publishing");
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
    expect(f.task.timeline.at(-1)!.text).toContain("Nothing more was published");
  } finally { await f.close(); }
});

it("refreshes a released prerequisite before publishing and retains exact-version proof approval", async () => {
  const f = await fixture(); const request = await f.request(); await f.recordPass();
  try {
    f.task.startedAt = 1; f.task.stageIndex = 4; f.task.proofRefreshes = 2;
    f.task.approvedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    const approved = structuredClone(f.task.approvedProofDecision);
    expect(await f.engine["shipping"]["prepare"](f.scope, f.ship, signal())).toBe("ready");
    const prerequisite = f.engine.addTask({ productId: f.products[0]!.id, title: "Land the required fix", backlog: true });
    f.engine.setRuntimeWait(f.task.id, [prerequisite], "Publishing needs this fix", "proof-wait");
    await f.advance();
    const destination = readRef(join(f.products[0]!.path!, ".git"), "refs/heads/main");
    f.engine.setRuntimeWait(f.task.id, [], "The required source is ready", "proof-clear");
    expect(await f.engine["shipping"].deliver(f.task, f.ship, signal())).toBe("continue");
    expect(f.task.runtimeWait?.refreshPending).toBe(true);
    expect(await f.engine["driver"]["refreshAfterWait"](f.task, signal())).toBe(false);
    expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
    expect(f.task.approvedProofDecision).toEqual(approved);
    expect(await f.engine["shipping"].deliver(f.task, f.ship, signal())).toBe("continue");
    expect(f.task.stageIndex).toBe(3);
    expect(f.task.approvedProofDecision).toBeUndefined();
    expect(request.status).toBe("stale");
    expect(f.task.proofRefreshes).toBe(2);
    expect(f.task.findings).toEqual([]);
    expect(readRef(join(f.products[0]!.path!, ".git"), "refs/heads/main")).toBe(destination);
    await f.drive();
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("earlier version");
    expect(f.task.checkedProofDecision).not.toEqual(approved);
    expect(f.task.proofRefreshes).toBe(2);
  } finally { await f.close(); }
});

it("requires explicit release-gap approval and permits only Petrina's verified version commit, including the pushed restart and shared continuation", async () => {
  const f = await fixture(true); await f.request(); await f.recordPass();
  try {
    const release = f.task.repositories![0]!; release.delivery = "release";
    writeFileSync(join(release.worktree!, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
    await gitSteps.commitChanges(release.worktree!, "Declare the fixture version");
    await f.recordPass();
    f.task.checkedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    expect(proofGap(f.task)).toContain("release version"); expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    f.engine.gate(f.task, "delivery"); f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    const start = readWorktreeCommit(release.worktree!)!.commit;
    release.shipping = { moves: 0, failures: 0, base: release.baseSha, start, version: "0.2.0", tag: "v0.2.0" };
    const releaseScope = executionFor(f.task, release.productId);
    const versions = await f.engine["shipping"].releases["declaredVersions"](release.worktree!, start);
    const tested = await f.engine["shipping"].releases.setVersion(releaseScope, versions);
    expect(tested).not.toBe(start);
    release.shipping.prepared = { tested, summary: "Version only" };
    release.proofRelease = { start, tested };
    // The exact atomic push has completed; resuming release metadata must retain this preparation.
    release.shipping.pushed = true;
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(true);
    release.release = { tag: "v0.2.0", url: "https://example.test/release" };
    const preparedRelease = release.shipping; delete release.shipping;
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(true);
    delete release.release; release.shipping = preparedRelease; delete release.shipping.pushed;
    writeFileSync(join(release.worktree!, "unexpected.txt"), "unreviewed edit");
    await gitSteps.commitChanges(release.worktree!, "Unexpected change");
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(false);
  } finally { await f.close(); }
});

it("adds final preparation to a plan that omitted delivery approval, while current proof keeps its authorized automatic route", async () => {
  const f = await fixture(false, false, undefined, {
    runCheckCommand: (req) => req.argv[0] === process.execPath && req.argv[1] === "-e" && req.argv[2] === "process.exit(0)" ? { code: 0 } : undefined,
  });
  try {
    f.engine.setProductChecks(f.task.productId, [{ name: "Test", command: commandInputText([process.execPath, "-e", "process.exit(0)"]) }]);
    f.task.approveDelivery = false; f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.id !== "gate"); f.task.stageIndex = 2;
    f.task.hunt = { stageId: "review", round: 1, reported: { "0": true }, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: await versionsOf(f.task) } };
    recordReviewProofs(f.engine, f.task, f.review, [{ text: "Required Linux proof", reason: "Exact final version required", productIds: [f.task.productId] }], "sol-high", "code-reviewer", "0");
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(["do", "do", "review-chain", "gate", "do"]);
    expect(f.task.proofDeliveryGate).toBeDefined(); expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    await f.recordPass();
    // Tester answers do not invent product-check authority; execute this fixture's declared command.
    expect((await f.run(f.engine, () => f.engine["checks"].failing(f.scope, signal()))).kind).toBe("passed");
    f.task.risk = { level: "medium", why: "Existing task opted out of approval" };
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(true);
    f.scope.work.delivery = "release";
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    expect(proofGap(f.task)).toContain("release version");
  } finally { await f.close(); }
});

it("discards an unpublished release identity before proving and preparing a newly approved version", async () => {
  const f = await fixture(); await f.request(); f.scope.work.delivery = "release";
  const release = f.engine["shipping"].releases;
  const notes = spyOn(f.engine["turns"], "turn").mockImplementation(async (_scope, roleId, _profileId, _given, schema) => {
    expect(roleId).toBe("release-manager"); return schema.parse({ summary: "Release ready", notes: "The recovery change is ready." });
  });
  const choose = spyOn(release, "chooseVersion").mockImplementation(async scope => {
    scope.work.shipping!.version = "0.3.0"; scope.work.shipping!.tag = "v0.3.0";
    return release["declaredVersions"](scope.work.worktree!, readWorktreeCommit(scope.work.worktree!)!.commit);
  });
  try {
    writeFileSync(join(f.scope.work.worktree!, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
    await gitSteps.commitChanges(f.scope.work.worktree!, "Declare fixture version");
    await f.recordPass();
    const start = readWorktreeCommit(f.scope.work.worktree!)!.commit;
    f.scope.work.shipping = { moves: 0, failures: 0, start, base: f.scope.work.baseSha, version: "0.2.0", tag: "v0.2.0" };
    const tested = await release.setVersion(f.scope, await release["declaredVersions"](f.scope.work.worktree!, start));
    f.scope.work.proofRelease = { start, tested }; f.scope.work.shipping.prepared = { tested, summary: "Earlier release preparation" };
    await f.advance();
    await f.engine["shipping"]["prepareAgain"](f.scope, "Main moved before publishing");
    expect(f.scope.work.proofRelease).toBeUndefined(); expect(f.scope.work.shipping).toBeUndefined();
    await f.engine["updates"].upToDate(f.scope, signal()); await f.recordPass();
    f.task.checkedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    f.engine.gate(f.task, "delivery"); f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    expect(await f.engine["shipping"]["readyToShip"](f.scope, signal())).toBe("ready");
    expect(await f.engine["shipping"]["prepare"](f.scope, f.ship, signal())).toBe("ready");
    expect(f.scope.work.proofRelease!.start).not.toBe(start); expect(f.scope.work.shipping!.prepared!.tested).not.toBe(tested);
  } finally { choose.mockRestore(); notes.mockRestore(); await f.close(); }
});

it("retains an exact local update awaiting its push while rejecting a newer destination version", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    f.task.approvedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    const tested = readWorktreeCommit(f.scope.work.worktree!)!.commit;
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: tested, localUpdated: tested, prepared: { tested, summary: "Local update awaits its push" } };
    await gitSteps.resetTo(f.products[0]!.path!, tested);
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(true);
    await f.advance();
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(false);
    expect(f.scope.work.shipping.localUpdated).toBe(tested);
  } finally { await f.close(); }
});

it("guards a pending local push through interrupted delivery recovery while preserving an already published result", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  const connections = f.engine["connections"], verifier = f.engine["shipping"].verifier;
  const product = f.products[0]!; product.repo = "acme/proof"; product.remote = "https://github.com/acme/proof.git";
  const remote = { url: product.remote };
  const connection = spyOn(connections, "connection").mockResolvedValue({ ok: true, remote });
  const contains = spyOn(verifier, "remoteContains").mockResolvedValue(false);
  const refs = spyOn(gitSteps, "remoteRefs").mockResolvedValue({ ok: true, value: new Map() });
  const push = spyOn(gitSteps, "push").mockResolvedValue({ ok: true, value: undefined });
  try {
    const tested = readWorktreeCommit(f.scope.work.worktree!)!.commit;
    f.task.stageIndex = 4; f.task.approvedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: tested, localUpdated: tested, prepared: { tested, summary: "Local placement is complete" }, step: "push", boot: "earlier-boot" };
    await gitSteps.resetTo(product.path!, tested);
    f.scope.work.localUpdate = { branch: "main", sha: tested, pushed: false };
    // A changed proof status is part of the bound decision even when the placed code is identical.
    delete f.task.proofRequests![0]!.proof;
    expect(await f.engine["shipping"].deliver(f.task, f.ship, signal())).toBe("continue");
    expect(push).not.toHaveBeenCalled(); expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
    expect(f.scope.work.localUpdate).toEqual({ branch: "main", sha: tested, pushed: false });
    // The same historical delivery can be recorded after a later remote observation, without pushing again.
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: tested, localUpdated: tested, prepared: { tested, summary: "Already published" }, step: "push" };
    contains.mockResolvedValue(true);
    expect(await f.engine["shipping"].deliver(f.task, f.ship, signal())).toBe("stop");
    expect(push).not.toHaveBeenCalled(); expect(f.scope.work.landed?.sha).toBe(tested.slice(0, 7));
    expect(f.scope.work.confirmedDelivery?.sha).toBe(tested);
  } finally { push.mockRestore(); refs.mockRestore(); contains.mockRestore(); connection.mockRestore(); await f.close(); }
});
