import { completeAll } from "@petrina/core";
import { beginRepair } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Scenario } from "../../fake-agent.js";
import { coordinator, git, itemOf, taskOf, until } from "../../support.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
import { preparedSharedReview } from "../../fixtures/prepared-shared-review.js";
import { installSharedWorkflowFastPaths, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { privateWorldToolProbe } from "../../fixtures/world-tool-probe.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());

describe.concurrent("one task across products", () => {
  for (const decision of ["pause", "cancel"] as const) it(`cleans every product's saved review copies after restart and ${decision}`, async () => {
    await fixtures.nativeWorld(`screen-copy-${decision}`, async ({ shop, api, engine: withEngine, fakes }) => {

    const { copies, id } = await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipUpToDate: true, skipPrepareChecks: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true, fastCheckpoints: true });
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      fakes.scenario({ planner: "parallel", builder: "plain", screenRoles: ["code reviewer"], screenRoleHold: true, reopen: "resume" });
      const id = await preparedSharedReview(engine, [first, second], "Keep each review copy with its product", true, { checks: "none" });
      await until(engine, (state) => !!taskOf(state, id).screen && !engine.drivers.has(id), coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      const saved = Object.values(engine.task(id)!.hunt!.screenTurns!);
      expect(saved.length).toBeGreaterThan(0);
      const copies = saved.flatMap((entry) => Object.entries(entry.copies!));
      for (const [productId, copy] of copies) {
        expect(dirname(copy)).toBe(join(shop.data, "worktrees", productId, `${id}.copies`));
        expect(existsSync(copy)).toBe(true);
      }

      return { copies, id };

    }, { toolProbe: privateWorldToolProbe(shop) });

    await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { fastCleanup: true, fastCheckpoints: true });
      expect(Object.values(engine.task(id)!.hunt!.screenTurns!).flatMap((entry) => Object.entries(entry.copies!))).toEqual(copies);
      engine[decision](id);
      await completeAll([...engine.copyCleanups.values()]);
      for (const [, copy] of copies) expect(existsSync(copy)).toBe(false);
      for (const world of [shop, api]) expect(await git(world.clone, "worktree", "list", "--porcelain")).not.toContain(`${id}.copies`);
      expect(engine.task(id)!.hunt?.screenTurns).toBeUndefined();

    }, { toolProbe: privateWorldToolProbe(shop) });

    });
  });

  it("gives a third answer its own portable copy in every product and resumes it there after a screen wait and restart", async () => {
    await fixtures.nativeWorld("third-answer-copies", async ({ shop, api, engine: withEngine, fakes }) => {
    const options = { toolProbe: privateWorldToolProbe(shop) };

    const { id, member, copies, kept, resumed, session, scenario, second } = await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipUpToDate: true, skipPrepareChecks: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true, fastCheckpoints: true });
      await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
      await engine.checkTools(); engine.stopRequested.signal.throwIfAborted();
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      // Both initial verifiers say the Important finding does not block, so Antigravity gives the third answer, on the screen.
      const scenario: Scenario = { planner: "parallel", builder: "plain", reviewer: "important", verifier: "not-a-bug", screenRoles: ["verifier"], screenModels: ["gemini-4-argon"], screenRoleHold: true, reopen: "resume", affectedProducts: [first, second] };
      fakes.scenario(scenario);
      const id = await preparedSharedReview(engine, [first, second], "Check the shared greeting three ways", true, { checks: "none" });
      await until(engine, (state) => !!taskOf(state, id).screen && !engine.drivers.has(id), coordinator(["plan", "design"]));
      const member = "vote-third:argon-high";
      const copies = (name: string) => ({ [first]: join(shop.data, "worktrees", first, `${id}.copies`, name), [second]: join(shop.data, "worktrees", second, `${id}.copies`, name) });
      const kept = copies("vote-third_3aargon-high");
      const saved = engine.task(id)!.hunt!.screenTurns![member]!;
      expect(Object.keys(engine.task(id)!.hunt!.screenTurns!)).toEqual([member]);
      expect(saved.copy).toBe(kept[first]!);
      expect(saved.copies).toEqual(kept);
      for (const copy of Object.values(kept)) expect(existsSync(copy)).toBe(true);
      // Every verifier place was given its own copy of each product, the third one's beside the initial pair's.
      const mapOf = (text: string) => Object.fromEntries([...text.matchAll(/Product id: ([^;]+); copy: ([^;]+);/g)].map((match) => [match[1]!, match[2]!]));
      const opened = new Map<string, Record<string, string>>();
      for (const entry of fakes.received("verifier")) if (!opened.has(entry.session)) opened.set(entry.session, mapOf(entry.text));
      const session = saved.conversation.sessionId;
      expect(opened.size).toBe(3);
      expect(opened.get(session)).toEqual(kept);
      expect([...opened.values()]).toEqual(expect.arrayContaining([copies("vote-sol-high"), copies("vote-grok-high"), kept]));
      // A companion copy saved under another folder name, as an earlier version named it, is still the one reopened.
      const earlier = join(shop.data, "worktrees", second, `${id}.copies`, "saved-earlier");
      await git(api.clone, "worktree", "move", kept[second]!, earlier);
      const resumed = { ...kept, [second]: earlier };
      const turn = engine.task(id)!.hunt!.screenTurns![member]!;
      turn.copies = resumed;
      turn.conversation.repositoryCopies = resumed;
      for (const copy of Object.values(resumed)) writeFileSync(join(copy, "held.txt"), "Kept through the restart\n");
      engine.commitNow();

      return { id, member, copies, kept, resumed, session, scenario, second };

    }, options);

    await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipUpToDate: true, skipPrepareChecks: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true, fastCheckpoints: true });
      expect(engine.task(id)!.hunt!.screenTurns![member]!.copies).toEqual(resumed);
      engine.allowScreen(id);
      await until(engine, () => existsSync(join(fakes.dir, `on-screen-${session}`)), coordinator([]));
      // The same place reopens its own conversation in the copies it kept, in both products.
      expect(fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new", "resume"]);
      expect(engine.task(id)!.hunt!.screenTurns![member]!.conversation.repositoryCopies).toEqual(resumed);
      for (const copy of Object.values(resumed)) expect(readFileSync(join(copy, "held.txt"), "utf8")).toBe("Kept through the restart\n");
      expect(existsSync(kept[second]!)).toBe(false);
      fakes.scenario({ ...scenario, screenRoleHold: false });
      writeFileSync(join(fakes.dir, `screen-release-${session}`), "go");
      const state = await until(engine, (state) => !!itemOf(state, id, "delivery") || ["pr-open", "done", "failed"].includes(taskOf(state, id).state), coordinator([]));
      expect(taskOf(state, id).error).toBeUndefined();
      const task = engine.task(id)!;
      const finding = task.findings.find((entry) => entry.text === "The greeting is missing on the welcome page.")!;
      // The third answer counts on its logical place: three answers settle the finding instead of leaving it unresolved.
      expect(finding.votes!.filter((vote) => vote.toolId === "antigravity")).toEqual([expect.objectContaining({ by: "argon-high", plannedProfileId: "argon-high", verdict: "not-a-bug", ballot: expect.objectContaining({ seat: "third:argon-high" }) })]);
      expect(finding.unresolved).toBeUndefined();
      expect(finding.status).toBe("dismissed");
      expect(task.journey!.filter((step) => step.roleId === "verifier").map((step) => step.seats)).toEqual([["verifier:sol-high", "verifier:grok-high"], ["verifier:third:argon-high"]]);
      expect(new Set(fakes.received("verifier").map((entry) => entry.session)).size).toBe(3);
      for (const map of [resumed, kept, copies("vote-sol-high"), copies("vote-grok-high")]) for (const copy of Object.values(map)) expect(existsSync(copy)).toBe(false);
      for (const world of [shop, api]) expect(await git(world.clone, "worktree", "list", "--porcelain")).not.toContain(`${id}.copies`);

    }, options);

    });
  });
});

describe.concurrent("shared delivery and hand-back regressions", () => {
  for (const peerOnly of [false, true]) it(`checks and routes deleted tests in ${peerOnly ? "only the other review snapshot" : "every changed review snapshot"} on hand-back`, async () => {
    await fixtures.nativeWorld(`hand-back-${peerOnly}`, async ({ shop, api, engine: withEngine, fakes }) => {
    for (const world of [shop, api]) {
      mkdirSync(join(world.clone, "test"));
      writeFileSync(join(world.clone, "test", "greeting.test.ts"), 'import { test, expect } from "bun:test"; test("greeting", () => expect(true).toBe(true));\n');
      await gitOps.commitChanges(world.clone, "Keep the greeting test");
      await git(world.clone, "push", "-q", world.remote, "main");
    }
    // Copying the launch command never starts a terminal or app.

    await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipUpToDate: true, skipPrepareChecks: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true, fastCheckpoints: true });
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      fakes.scenario({ planner: "short", builder: "plain", screenRoles: ["code reviewer"], screenRoleHold: true, reopen: "resume" });
      const id = await preparedSharedReview(engine, [first, second], "Preserve hand-back ownership", false, { checks: "none" });
      for (const work of engine.task(id)!.repositories!) {
        const saved = readWorktreeCommit(work.worktree!);
        work.checks = { at: Date.now(), sha: saved?.commit, tree: saved?.tree, current: true, definition: "none", results: [] };
      }
      // Screen requests are scripted stand-ins: this exercises saved review conversations without a window.
      await until(engine, (state) => !!taskOf(state, id).screen && !engine.drivers.has(id), coordinator(["plan", "design"]));
      const session = engine.taskDetails(id)!.conversation!.sessionId;
      engine.allowScreen(id);
      await until(engine, () => fakes.marked(`on-screen-${session}`), coordinator([]));
      await engine.takeOver(id, "copy");
      const task = engine.task(id)!;
      const active = task.productId;
      const changed = peerOnly ? [first, second].filter((id) => id !== active) : [first, second];
      const untouched = task.repositories!.find((work) => !changed.includes(work.productId));
      const original = untouched && readWorktreeCommit(untouched.worktree!)?.commit;
      for (const productId of changed) {
        const snapshot = task.driving!.repositoryCopies![productId]!.path;
        rmSync(join(snapshot, "test/greeting.test.ts"));
        await gitOps.commitChanges(snapshot, "Coordinator removes a test");
      }
      engine.setPoolPaused(true);
      // Inspect the saved hand-back before the resumed review can move the active product again.
      engine.startDriver = () => {};
      await engine.handBack(id, "Keep every product's changes", true);
      expect(task.productId).toBe(active);
      const findings = task.findings.filter((finding) => finding.raisedBy === "petrina" && finding.severity === "blocking" && finding.status === "open");
      expect(findings).toHaveLength(changed.length);
      expect(findings.flatMap((finding) => finding.productIds ?? []).sort()).toEqual([...changed].sort());
      for (const work of task.repositories!) {
        if (changed.includes(work.productId)) {
          expect(work.tamper?.problems.length).toBe(1);
          expect(existsSync(join(work.worktree!, "test/greeting.test.ts"))).toBe(false);
          expect(work.checks?.current).toBe(false);
        } else expect(readWorktreeCommit(work.worktree!)?.commit).toBe(original!);
      }
      // Routing selects exactly the affected saved builders, even when the driven product was untouched.
      expect(beginRepair(engine, task, "review", task.stageIndex)).toBe(true);
      expect(task.repair!.products).toEqual(peerOnly ? changed : [first, second]);

    }, { toolPath: () => process.execPath, toolProbe: privateWorldToolProbe(shop) });
    });
  });
});
