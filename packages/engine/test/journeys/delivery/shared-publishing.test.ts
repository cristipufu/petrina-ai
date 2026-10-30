import { completeAll, commandInputText } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { commitLooseOnRef, installSharedWorkflowFastPaths, prepareSharedDelivery, readRef } from "../../fixtures/shared-preparation.js";
import { fileURLToPath } from "node:url";
import { type RepositoryContext } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../../engine.js";
import { Coordination } from "../../../src/coordination.js";
import { coordinator, finish, git, headNow, itemOf, taskOf, until } from "../../support.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());
const fast = (engine: Engine) => installSharedWorkflowFastPaths(engine, {
  skipDriverPrepare: true,
  skipUpToDate: true,
  skipPrepareChecks: true,
  skipReviewCopies: true,
  skipReviewInputDiffs: true,
  fastCheckCapture: true,
  fastCleanup: true,
  fastCheckpoints: true,
});
async function coordinatorDelivery(engine: ConstructorParameters<typeof Coordination>[0], taskId: string) { const coordination = new Coordination(engine); const { landing, deliveryConfirmed } = (await coordination.call("task.inspect", { taskId })).task as { landing: string; deliveryConfirmed: boolean }; const [delivered, landed] = await completeAll(["delivered", "landed"].map(async (condition): Promise<string> => (await coordination.call("watch.wait", { target: "task", taskId, condition, timeoutMs: 0 })).outcome)); return { landing, deliveryConfirmed, delivered, landed }; }

describe.concurrent("one task across products", () => {
  it("retires shared local deliveries into paged history and removes them only with their last product", async () => {
    await fixtures.world("shared-history", async ({ shop, api, engine: withEngine, fakes }) => {

    const { first, second, id } = await withEngine(async engine => {
      fast(engine);
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "local" })), title: "A shared local delivery", clientId: "shared-history-request", backlog: true });
      engine.schedule();
      expect(engine.task(id)?.state).toBe("backlog");
      expect(fakes.openings("planner")).toHaveLength(0);

      return { first, second, id };

    });

    await withEngine(async engine => {
      fast(engine);
      expect(engine.task(id)?.selectedProducts?.map((choice) => choice.productId)).toEqual([first, second]);
      expect(engine.task(id)?.startedAt).toBeUndefined();
      // History observes completed delivery and cleanup; the Builder result is an explicit prerequisite.
      await prepareSharedDelivery(engine, id, { checks: "none" });
      engine.schedule();
      await finish(engine, id);
      await until(engine, () => !engine.activeState().tasks.some((task) => task.id === id), coordinator([]));
      expect(engine.windowState().tasks).toEqual([]);
      expect(engine.windowState().history?.total).toBe(1);
      for (const productId of [first, second]) expect(engine.historyPage({ productId }).items.map((item) => item.id)).toEqual([id]);
      expect(engine.taskDetails(id)?.repositories?.every((work) => work.cleanup?.removedAt && work.cleanup.reviewCopiesRemovedAt)).toBe(true);

    });

    await withEngine(async engine => {
      fast(engine);
      expect(engine.activeState().tasks).toEqual([]);
      const before = engine.taskDetails(id)!;
      const deliveries = before.repositories!.map((work) => work.landed);
      expect(engine.addTask({ productId: first, title: "Lost reply", clientId: "shared-history-request" })).toBe(id);
      engine.removeProduct(first);
      engine.save();
      expect(engine.historyPage({ productId: second }).items.map((item) => item.id)).toEqual([id]);
      expect(engine.taskDetails(id)?.repositories?.map((work) => work.landed)).toEqual(deliveries);
      expect(engine.taskDetails(id)?.repositories?.[0]?.removed).toBe(true);
      expect(engine.taskDetails(id)?.session).toEqual(before.session);
      engine.removeProduct(second);
      engine.save();
      expect(engine.historyPage({}).total).toBe(0);
      expect(engine.taskDetails(id)).toBeUndefined();

    });

    });
  });

  it("prepares two separate copies only after approval, builds both and opens mutually linked PRs", async () => {
    await fixtures.world("two", async ({ shop, api, engine: withEngine, fakes }) => {

    await withEngine(async engine => {
      fast(engine);
      const first = shop.preparedProduct(engine), second = api.preparedProduct(engine);
      for (const productId of [first, second]) {
        const product = engine.s.products.find(p => p.id === productId)!;
        product.checks = [];
        product.checksBy = "coordinator";
      }
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request", reason: "Both sides need the greeting." })) });
      const id = engine.addTask({ productId: first, title: "A shared greeting", approvePlan: false });
      const state = await until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
      expect(taskOf(state, id).error).toBeUndefined();
      expect(taskOf(state, id).workRows).toHaveLength(2);
      expect(taskOf(state, id).worktree).toBeUndefined();
      engine.approve(itemOf(state, id, "plan")!.id);
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["design"]));
      expect(taskOf(ready, id).error).toBeUndefined();
      const approval = itemOf(ready, id, "delivery")!;
      expect(approval.body).toContain("acme/demo; link pending");
      expect(approval.body).toContain("acme/api; link pending");
      expect(approval.body).toContain("visible to anyone who can read it");
      expect(ready.inbox.filter((item) => item.taskId === id && item.kind === "delivery")).toHaveLength(1);
      engine.approve(approval.id);
      // Completing generated links uses this decision, with no second delivery approval.
      const task = taskOf(await finish(engine, id, coordinator([])), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("pr-open");
      expect(task.repositories).toHaveLength(2);
      expect(task.repositories!.every((work) => work.report && work.checks?.results.every((result) => result.ok) && work.pr?.state === "open")).toBe(true);
      expect(task.plan!.stages.filter((stage) => stage.roleId === "builder")).toHaveLength(1);
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
      expect(shop.github().prs[0]!.body).toContain(api.github().prs[0]!.url);
      expect(api.github().prs[0]!.body).toContain(shop.github().prs[0]!.url);
      expect(shop.github().prs[0]!.body).toContain("Part of a change across:");
      expect(task.repositories!.every((work) => work.companion?.state === "done")).toBe(true);
      expect(task.timeline.filter((entry) => entry.text === "You approved the delivery")).toHaveLength(1);
      expect(readFileSync(join(shop.clone, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/main");
      expect(readFileSync(join(api.clone, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/main");

    });
    });
  });

  it("keeps a confirmed PR when another repository fails, then resumes after restart without publishing twice", async () => {
    await fixtures.world("partial", async ({ shop, api, engine: withEngine }) => {

    const { id } = await withEngine(async engine => {
      fast(engine);
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      api.setGitHub((state) => { state.fail = { "pr create": 1 }; });
      const worksOn = [first, second].map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "pull-request" as const }));
      const id = engine.addTask({ backlog: true, productId: first, worksOn, title: "A partial delivery" });
      await prepareSharedDelivery(engine, id, { checks: "none" });
      engine.schedule();
      const partial = await until(engine, (state) => !!taskOf(state, id).error || !!itemOf(state, id, "shipping"));
      expect({ state: taskOf(partial, id).state, error: taskOf(partial, id).error, deliveries: taskOf(partial, id).repositories?.map((work) => ({ product: work.productId, pr: work.pr, shipping: work.shipping })) }).toMatchObject({ state: "needs-you" });
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(0);
      expect(taskOf(partial, id).repositories![0]!.pr?.number).toBe(1);
      // The open pull request cannot stand in for the interrupted companion, whichever product is shown.
      const interrupted = engine.task(id)!.activeProductId;
      for (const shown of [first, second]) {
        engine.task(id)!.activeProductId = shown;
        expect(await coordinatorDelivery(engine, id)).toEqual({ landing: "open", deliveryConfirmed: false, delivered: "timed-out", landed: "timed-out" });
      }
      engine.task(id)!.activeProductId = interrupted;

      return { id };

    });

    await withEngine(async engine => {
      fast(engine);
      const retry = engine.getState().inbox.find((item) => item.taskId === id && ["shipping", "stuck"].includes(item.kind))!;
      if (retry.kind === "shipping") engine.checkShipping(retry.id); else engine.retry(retry.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined(); expect(done.state).toBe("pr-open");
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
      expect(shop.github().calls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1);
      expect(done.repositories!.every((work) => work.companion?.state === "done")).toBe(true);
      expect(await coordinatorDelivery(engine, id)).toEqual({ landing: "awaiting-merge", deliveryConfirmed: true, delivered: "completed", landed: "timed-out" });

    });

    });
  });

  it("previews a release without a version commit and waits for the companion open PR after publishing", async () => {
    await fixtures.world("mixed-release", async ({ shop, api, engine: withEngine }) => {
    const pkgText = JSON.stringify({ name: "api", version: "1.0.0" });
    writeFileSync(join(api.clone, "package.json"), pkgText);
    const sha = commitLooseOnRef(join(api.clone, ".git"), {
      ref: "refs/heads/main",
      file: { name: "package.json", content: pkgText },
      message: "Record the version",
    });
    if (sha) {
      cpSync(join(api.clone, ".git", "objects"), join(api.remote, "objects"), { recursive: true });
      writeFileSync(join(api.remote, "refs", "heads", "main"), `${sha}\n`);
      mkdirSync(join(api.clone, ".git", "refs", "remotes", "origin"), { recursive: true });
      writeFileSync(join(api.clone, ".git", "refs", "remotes", "origin", "main"), `${sha}\n`);
    } else {
      await git(api.clone, "add", "."); await git(api.clone, "commit", "-qm", "Record the version"); await git(api.clone, "push", "-q", api.remote, "main");
    }

    await withEngine(async engine => {
      fast(engine);
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const id = engine.addTask({ backlog: true, productId: first, worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: second, startFrom: { kind: "default" }, delivery: "release" }], title: "Release the shared greeting" });
      await prepareSharedDelivery(engine, id, { checks: "none" });
      engine.schedule();
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      const preview = taskOf(ready, id);
      expect(preview.error).toBeUndefined();
      expect(preview.repositories![1]!.releasePreview?.notes).toBeTruthy();
      expect(JSON.parse(readFileSync(join(preview.repositories![1]!.worktree!, "package.json"), "utf8")).version).toBe("1.0.0");
      expect(shop.github().prs).toHaveLength(0); expect(api.github().releases).toHaveLength(0);
      engine.approve(itemOf(ready, id, "delivery")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined(); expect(done.state).toBe("pr-open");
      expect(done.repositories![0]!.pr?.state).toBe("open"); expect(done.repositories![1]!.release).toBeDefined();
      expect(api.github().releases).toHaveLength(1);
      expect(shop.github().prs[0]!.body).toContain(api.github().releases[0]!.url);

    });
    });
  });

  it("keeps a PR fork within its original product and retries its companion comment without duplicates", async () => {
    await fixtures.world("fork-links", async ({ shop, api, engine: withEngine, sourceRemotes }) => {
    const fork = join(shop.dir, "fork.git");
    cpSync(shop.remote, fork, { recursive: true });
    sourceRemotes["contributor/demo"] = fork;
    const baseSha = readRef(fork, "refs/heads/main")!;
    const initial = commitLooseOnRef(fork, {
      parentSha: baseSha,
      ref: "refs/heads/review-work",
      file: { name: "existing.txt", content: "Existing PR work" },
      message: "Existing PR work",
    })!;
    cpSync(join(fork, "objects"), join(shop.remote, "objects"), { recursive: true });
    mkdirSync(join(shop.remote, "refs", "pull", "7"), { recursive: true });
    writeFileSync(join(shop.remote, "refs", "pull", "7", "head"), `${initial}\n`);
    cpSync(join(fork, "objects"), join(shop.clone, ".git", "objects"), { recursive: true });
    writeFileSync(join(shop.clone, ".git", "refs", "heads", "review-work"), `${initial}\n`);
    shop.setGitHub((state) => { state.forks = { "contributor/demo": fork }; state.lose = { "pr comment": 1 }; state.prs.push({ number: 7, url: "https://github.com/acme/demo/pull/7", state: "OPEN", title: "Original title", body: "Original description", headRefName: "review-work", baseRefName: "main", headRefOid: initial, headRepository: { nameWithOwner: "contributor/demo" }, isCrossRepository: true }); });

    await withEngine(async engine => {
      fast(engine);
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const id = engine.addTask({ backlog: true, productId: first, worksOn: [{ productId: first, startFrom: { kind: "pull-request", value: "7" }, delivery: "pull-request" }, { productId: second, startFrom: { kind: "default" }, delivery: "pull-request" }], title: "Update the shared PR" });
      await prepareSharedDelivery(engine, id, { checks: "none" });
      const plan = engine.getState();
      expect(taskOf(plan, id).workRows).toHaveLength(2);
      expect(taskOf(plan, id).workRows!.every((row) => !row.addition)).toBe(true);
      expect(taskOf(plan, id).workRows![0]!.source!.destination.repo).toBe("contributor/demo");
      engine.schedule();
      const links = await until(engine, (state) => taskOf(state, id).statusLine === "Deliveries saved. Finish links" || !!taskOf(state, id).error);
      expect(taskOf(links, id).error).toBeUndefined();
      engine.retry(itemOf(links, id, "stuck")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined(); expect(done.repositories![0]!.pr!.number).toBe(7);
      expect(shop.github().prs).toHaveLength(1);
      expect(shop.github().prs[0]!.title).toBe("Original title"); expect(shop.github().prs[0]!.body).toBe("Original description");
      expect(shop.github().calls.filter((args) => args[0] === "pr" && args[1] === "comment")).toHaveLength(1);
      expect(shop.github().pages!["issues/7/comments?per_page=100"]!.flat()).toHaveLength(1);
      expect(api.github().prs).toHaveLength(1);

    });
    });
  });
});

describe.concurrent("shared delivery and hand-back regressions", () => {
  for (const decision of ["send-back"] as const) it(`cleans earlier unpublished release versions before shared ${decision} after a later preview mismatch`, async () => {
    await fixtures.world(`release-preview-mismatch-${decision}`, async ({ shop, api, engine: withEngine, fakes }) => {
    for (const world of [shop, api]) {
      writeFileSync(join(world.clone, "package.json"), JSON.stringify({ name: world === shop ? "shop" : "api", version: "1.0.0" }));
      if (world === shop) {
        const peerState = join(api.dir, "github.json");
        writeFileSync(join(shop.clone, "mutate-peer-release.cjs"), `
          const fs = require('node:fs');
          const { writeFixtureJson } = require(${JSON.stringify(fileURLToPath(import.meta.resolve("@petrina/test-support/fixture-json")))});
          if (JSON.parse(fs.readFileSync('package.json', 'utf8')).version === '1.0.1') {
            const path = ${JSON.stringify(peerState)};
            const state = JSON.parse(fs.readFileSync(path, 'utf8'));
            state.releases[0].tagName = '1.0.0';
            state.releases[0].url = 'https://github.com/acme/api/releases/tag/1.0.0';
            writeFixtureJson(path, state);
          }
        `);
      }
      await gitOps.commitChanges(world.clone, "Record the release version");
      await gitOps.push(world.clone, { url: world.remote, local: true }, [{ sha: headNow(world.clone), ref: "refs/heads/main" }]);
      mkdirSync(join(world.remote, "refs", "tags"), { recursive: true });
      writeFileSync(join(world.remote, "refs", "tags", "v1.0.0"), `${readRef(join(world.clone, ".git"), "refs/heads/main")}\n`);
      world.setGitHub((state) => state.releases.push({ tagName: "v1.0.0", url: `https://github.com/${state.repo}/releases/tag/v1.0.0`, publishedAt: "2025-01-01T00:00:00Z", isDraft: false, name: "v1.0.0", body: "Previous release" }));
    }

    const peerStatePath = join(api.dir, "github.json");
    const runMismatchCheck = (req: { readonly argv: readonly string[]; readonly cwd: string }) => {
      if (req.argv[0] !== process.execPath || req.argv[1] !== "mutate-peer-release.cjs") return undefined;
      if (JSON.parse(readFileSync(join(req.cwd, "package.json"), "utf8")).version === "1.0.1") {
        const state = JSON.parse(readFileSync(peerStatePath, "utf8"));
        state.releases[0].tagName = "1.0.0";
        state.releases[0].url = "https://github.com/acme/api/releases/tag/1.0.0";
        writeFixtureJson(peerStatePath, state);
      }
      return { code: 0 };
    };

    const { id, approved } = await withEngine(async engine => {
      fast(engine);
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      engine.setProductChecks(first, [{ name: "Update peer release record", command: commandInputText([process.execPath, "mutate-peer-release.cjs"]) }]);
      const secondProduct = engine.s.products.find(p => p.id === second)!;
      secondProduct.checks = [];
      secondProduct.checksBy = "coordinator";
      const id = engine.addTask({ backlog: true, productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "release" })), title: "Prepare two releases" });
      await prepareSharedDelivery(engine, id, { build: "run" });
      engine.schedule();
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      expect(taskOf(ready, id).error).toBeUndefined();
      expect(taskOf(ready, id).repositories!.every((work) => work.releasePreview?.version === "1.0.1")).toBe(true);
      const approved = taskOf(ready, id).repositories!.map((work) => work.checkedSha!);
      const shipping = (engine as unknown as { shipping: { prepare: (...args: unknown[]) => Promise<unknown> } }).shipping;
      const prepare = shipping.prepare.bind(shipping);
      shipping.prepare = async (...args: unknown[]) => {
        const result = await prepare(...args);
        if ((args[0] as RepositoryContext).work.productId === second && result === "continue") engine.setPoolPaused(true);
        return result;
      };
      engine.approve(itemOf(ready, id, "delivery")!.id);
      const paused = await until(engine, (state) => (state.pool.paused && taskOf(state, id).state === "waiting") || !!taskOf(state, id).error, coordinator([]));
      const waiting = taskOf(paused, id);
      expect(waiting.error).toBeUndefined();
      expect(waiting.repositories!.map((work) => work.checkedSha)).toEqual(approved);
      expect(waiting.plan!.stages[waiting.stageIndex]!.gate).toBe("delivery");
      expect(api.github().releases[0]!.tagName).toBe("1.0.0");
      // B's preview changes after A's version check; pausing at the gate must not preserve A's version commit.
      for (const work of waiting.repositories!) {
        expect(work.shipping?.prepared).toBeUndefined();
        expect(headNow(work.worktree!)).toBe(work.checkedSha!);
        expect(JSON.parse(readFileSync(join(work.worktree!, "package.json"), "utf8")).version).toBe("1.0.0");
      }
      expect(shop.github().releases).toHaveLength(1);
      expect(api.github().releases).toHaveLength(1);
      engine.setPoolPaused(false);
      const mismatch = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator([]));
      expect(taskOf(mismatch, id).error).toBeUndefined();

      return { id, approved };

    }, { runCheckCommand: runMismatchCheck });

    await withEngine(async engine => {
      fast(engine);
      const restored = engine.task(id)!;
      expect(restored.repositories!.map((work) => headNow(work.worktree!))).toEqual(approved);
      const decisionItem = itemOf(engine.getState(), id, "delivery")!;
      if (decision === "send-back") {
        engine.requestChanges(decisionItem.id, "Revisit the shared release before trying again");
        const revised = await until(engine, (state) => fakes.received("builder").length >= 4 || !!taskOf(state, id).error, coordinator([]));
        expect(taskOf(revised, id).error).toBeUndefined();
        expect(fakes.received("builder").slice(-2)).toHaveLength(2);
        for (const prompt of fakes.received("builder").slice(-2)) {
          expect(prompt.text).toContain("Revisit the shared release before trying again");
          expect(prompt.text).not.toContain("1.0.1");
        }
        expect(shop.github().releases).toHaveLength(1);
        expect(api.github().releases).toHaveLength(1);
      } else {
        engine.approve(decisionItem.id);
        const again = await until(engine, (state) => taskOf(state, id).state === "done" || !!taskOf(state, id).error || !!itemOf(state, id, "delivery"), coordinator([]));
        expect(taskOf(again, id).error).toBeUndefined();
        expect(taskOf(again, id).state).toBe("done");
        expect(shop.github().releases).toHaveLength(2);
        expect(api.github().releases).toHaveLength(2);
      }

    }, { runCheckCommand: runMismatchCheck });

    });
  });

  for (const decision of ["send-back"] as const) it(`keeps shared approval and offers ${decision} when release-version checks fail`, async () => {
    await fixtures.world(`release-version-failure-${decision}`, async ({ shop, api, engine: withEngine, fakes }) => {
    const allow = join(api.dir, "allow-release");
    const runVersionCheck = (req: { readonly argv: readonly string[]; readonly cwd: string }) => {
      if (req.argv[0] !== process.execPath || req.argv[1] !== "version-check.cjs") return undefined;
      const version = JSON.parse(readFileSync(join(req.cwd, "package.json"), "utf8")).version;
      return { code: version !== "1.0.0" && !existsSync(allow) ? 1 : 0 };
    };
    writeFileSync(join(api.clone, "package.json"), JSON.stringify({ name: "api", version: "1.0.0" }));
    writeFileSync(join(api.clone, "version-check.cjs"), `if (require('./package.json').version !== '1.0.0' && !require('node:fs').existsSync(${JSON.stringify(allow)})) process.exit(1);`);
    await gitOps.commitChanges(api.clone, "Record the version");
    await gitOps.push(api.clone, { url: api.remote, local: true }, [{ sha: headNow(api.clone), ref: "refs/heads/main" }]);
    mkdirSync(join(api.remote, "refs", "tags"), { recursive: true });
    writeFileSync(join(api.remote, "refs", "tags", "v1.0.0"), `${readRef(join(api.clone, ".git"), "refs/heads/main")}\n`);
    api.setGitHub((state) => state.releases.push({ tagName: "v1.0.0", url: "https://github.com/acme/api/releases/tag/v1.0.0", publishedAt: "2025-01-01T00:00:00Z", isDraft: false, name: "v1.0.0", body: "Previous release" }));

    const { id, approval } = await withEngine(async engine => {
      fast(engine);
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const firstProduct = engine.s.products.find(p => p.id === first)!;
      firstProduct.checks = [];
      firstProduct.checksBy = "coordinator";
      engine.setProductChecks(second, [{ name: "Release version", command: commandInputText([process.execPath, "version-check.cjs"]) }]);
      const id = engine.addTask({ backlog: true, productId: first, worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: second, startFrom: { kind: "default" }, delivery: "release" }], title: "Check release preparation" });
      await prepareSharedDelivery(engine, id, { build: "run" });
      engine.schedule();
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator(["plan", "design"]));
      engine.approve(itemOf(ready, id, "delivery")!.id);
      const approval = engine.task(id)!.repositories!.map((work) => ({ sha: work.approvedSha, patch: work.approvedPatch, destination: { ...work.approvedFor! } }));
      const waiting = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error || taskOf(state, id).state === "pr-open", coordinator([]));
      const failed = taskOf(waiting, id);
      expect(failed.error).toBeUndefined();
      expect(failed.state).toBe("needs-you");
      expect(itemOf(waiting, id, "stuck")).toBeUndefined();
      expect(itemOf(waiting, id, "delivery")!.body).toContain("API: getting the release ready failed");
      expect(itemOf(waiting, id, "delivery")!.body).toContain("send it back with a note");
      expect(failed.repositories!.map((work) => ({ sha: work.approvedSha, patch: work.approvedPatch, destination: { ...work.approvedFor! } }))).toEqual(approval);
      expect(failed.plan!.stages[failed.stageIndex]!.gate).toBe("delivery");
      for (const work of failed.repositories!) {
        expect(work.shipping?.prepared).toBeUndefined();
        expect(headNow(work.worktree!)).toBe(work.approvedSha!);
      }
      expect(JSON.parse(readFileSync(join(failed.repositories![1]!.worktree!, "package.json"), "utf8")).version).toBe("1.0.0");
      expect(failed.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking")).toEqual([]);
      expect(failed.repositories![1]!.checks!.results.every((run) => run.ok)).toBe(true);
      expect(fakes.received("builder")).toHaveLength(2);
      expect(shop.github().prs).toHaveLength(0); expect(api.github().releases).toHaveLength(1);

      return { id, approval };

    }, { runCheckCommand: runVersionCheck });

    await withEngine(async engine => {
      fast(engine);
      expect(engine.task(id)!.repositories!.map((work) => work.approvedSha)).toEqual(approval.map((work) => work.sha));
      const decisionItem = itemOf(engine.getState(), id, "delivery")!;
      expect(decisionItem.body).toContain("API: getting the release ready failed");
      writeFileSync(allow, "Release preparation is ready");
      if (decision === "send-back") {
        engine.requestChanges(decisionItem.id, "Reconsider the shared greeting before release");
        const revised = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator([]));
        expect(taskOf(revised, id).error).toBeUndefined();
        expect(fakes.received("builder")).toHaveLength(4);
        const repairs = fakes.received("builder").slice(2);
        for (const repair of repairs) {
          expect(repair.text).toContain("Reconsider the shared greeting before release");
          expect(repair.text).not.toContain("Check failed: Release version");
        }
        for (const work of taskOf(revised, id).repositories!) expect(work.checks!.results.every((run) => run.ok)).toBe(true);
        expect(shop.github().prs).toHaveLength(0); expect(api.github().releases).toHaveLength(1);
        engine.approve(itemOf(revised, id, "delivery")!.id);
      } else engine.approve(decisionItem.id);
      const done = taskOf(await until(engine, (state) => taskOf(state, id).state === "pr-open" || !!taskOf(state, id).error || !!itemOf(state, id, "delivery"), coordinator([])), id);
      expect(done.error).toBeUndefined();
      expect(done.state).toBe("pr-open");
      expect(shop.github().prs).toHaveLength(1); expect(api.github().releases).toHaveLength(2);
      expect(fakes.received("builder")).toHaveLength(decision === "send-back" ? 4 : 2);

    }, { runCheckCommand: runVersionCheck });

    });
  });
});
