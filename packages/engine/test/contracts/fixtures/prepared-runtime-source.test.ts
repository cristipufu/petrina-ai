import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { createProductRepository, git } from "../../fixtures.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { localFixtureSource } from "../../fixtures/prepared-runtime.js";
import { scriptedToolProbe } from "../../scripted-probes.js";
import { expectRejection } from "@petrina/test-support/rejections";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

it("calibrates a declared initial source against Git, keeps the default fresh, and refuses unrelated inputs", async () => {
  return cases.use("petrina-initial-source-", async owner => {
    const repository = await createProductRepository(owner.root);
    owner.check();
    let providerStarts = 0;
    const engine = owner.open(join(owner.root, "data"), { admissionsClosed: true,
      agentCommand: () => { providerStarts++; throw new Error("Source calibration starts no provider"); },
      toolProbe: scriptedToolProbe({ git: { status: "ready" }, gh: { status: "unknown" },
        "claude-code": { status: "not-installed" }, codex: { status: "not-installed" }, grok: { status: "not-installed" }, antigravity: { status: "not-installed" }, opencode: { status: "not-installed" }, pi: { status: "not-installed" } }),
    });
    engine.schedule = () => {};
    await owner.run(engine, async () => {
      await engine.waitUntilReady(); owner.check();
      const productId = installPreparedProduct(engine, privateCloneProduct(repository.path));
      const task = (title: string) => engine.task(engine.addTask({ productId, title, backlog: true }))!;
      const observed = task("Native initial source"), declared = task("Declared initial source");
      await localFixtureSource(engine, observed);
      await localFixtureSource(engine, declared, { initial: repository, check: () => owner.check() });
      const declaredWork = executionFor(declared).work;
      expect(declaredWork.source).toEqual(executionFor(observed).work.source);
      expect(declaredWork.source?.initialSha).toBe(await git(repository.path, "rev-parse", "HEAD"));
      expect(declared.plan).toBeUndefined();
      expect(declared.journey ?? []).toEqual([]);
      expect(declaredWork.savedVersion).toBeUndefined();
      expect(declaredWork.checks).toBeUndefined();
      expect(declaredWork.checkSetup).toBeUndefined();
      expect(declaredWork.builderSession).toBeUndefined();
      expect(declared.reviewSessions).toBeUndefined();

      for (const input of [
        { name: "wrong private path", initial: { ...repository, path: owner.root }, lostOwner: false },
        { name: "incomplete commit", initial: { ...repository, initialSha: repository.initialSha.slice(0, -1) }, lostOwner: false },
        { name: "lost task owner", initial: repository, lostOwner: true },
      ]) {
        const refused = task(input.name), work = executionFor(refused).work, index = engine.s.tasks.indexOf(refused);
        try {
          await expectRejection(localFixtureSource(engine, refused, { initial: input.initial, check: () => {
            owner.check();
            if (input.lostOwner) engine.s.tasks.splice(index, 1);
          } }), input.lostOwner ? "lost its captured owner" : "unchanged private main");
        } finally {
          if (input.lostOwner) engine.s.tasks.splice(index, 0, refused);
        }
        expect(work.source).toBeUndefined();
      }

      writeFileSync(join(repository.path, "later.txt"), "An actual change on main\n");
      await git(repository.path, "add", "."); owner.check();
      await git(repository.path, "commit", "-qm", "Advance the source after initial calibration"); owner.check();
      const current = await git(repository.path, "rev-parse", "HEAD"), later = task("Native current source");
      await localFixtureSource(engine, later);
      expect(current).not.toBe(repository.initialSha);
      expect(executionFor(later).work.source?.initialSha).toBe(current);
      expect(providerStarts).toBe(0);
    });
  });
});
