import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { executionFor } from "@petrina/orchestrator";
import { serviceExtraFixture } from "../../extra-fixtures.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
for (const route of ["no version change", "working edits"] as const) it(`pins the restored saved work after ${route}`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await serviceExtraFixture(owner, async f => {
    const scope = executionFor(f.task), path = scope.work.worktree!, shipping = f.engine["shipping"];
    scope.work.branch = await gitOps.currentBranch(path);
    scope.work.delivery = "release";
    writeFileSync(join(path, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await gitOps.commitChanges(path, "Declare the release version");
    await f.engine.rememberVersion(scope);
    const saved = structuredClone(scope.work.savedVersion!);
    scope.work.shipping = { start: saved.commit, moves: 0, failures: 0, version: route === "no version change" ? "1.0.0" : "1.0.1", tag: "v1.0.1" };
    const tested = await shipping.releases.setVersion(scope, await shipping.releases["declaredVersions"](path, saved.commit));
    expect(scope.work.savedVersion!.commit).toBe(tested);
    if (route !== "no version change") expect(tested).not.toBe(saved.commit);
    f.task.plan = { rationale: "Deliver the reviewed work", plannerProfileId: "sol-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "delivery", title: "Approve delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: ["sol-high"] },
      { id: "ship", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    f.task.stageIndex = 2;
    await shipping.clearUnpublishedVersion(scope);
    expect(await gitOps.head(path)).toBe(saved.commit);
    expect(await gitOps.isClean(path)).toBe(true);
    expect(scope.work.savedVersion).toEqual(saved);
    f.engine.commitNow();
    const stored = f.engine.store.load()!.tasks.find(task => task.id === f.task.id)!;
    expect((stored.repositories?.[0] ?? stored.repository)!.savedVersion).toEqual(saved);
    if (route === "working edits") writeFileSync(join(path, "unrecorded-work.txt"), "New work awaiting handoff\n");
    const reply = await f.coordination.call("validation.run", f.request("restored-release-work"));
    const record = reply.validation as ExtraValidation;
    expect(reply.outcome).toBe("pending");
    expect(record.commit).toBe(saved.commit); expect(record.tree).toBe(saved.tree);
    expect(record.workingEdits).toBe(route === "working edits");
    expect(reply.message!.includes("The working copy currently has changes that are excluded")).toBe(route === "working edits");
    await owner.stop(f.engine);

  }, {}, { actorLease: false, commandLease: false });

  });
});

it("keeps an already queued release snapshot when restoring the saved work", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await serviceExtraFixture(owner, async f => {const scope = executionFor(f.task), path = scope.work.worktree!;

    scope.work.branch = await gitOps.currentBranch(path);
    writeFileSync(join(path, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await gitOps.commitChanges(path, "Declare the release version");
    await f.engine.rememberVersion(scope);
    const saved = structuredClone(scope.work.savedVersion!);
    scope.work.shipping = { start: saved.commit, moves: 0, failures: 0, version: "1.0.1", tag: "v1.0.1" };
    const release = f.engine["shipping"].releases;
    await release.setVersion(scope, await release["declaredVersions"](path, saved.commit));
    const queued = await f.submit("version-before-rollback");
    await f.engine["shipping"].clearUnpublishedVersion(scope);
    expect(scope.work.savedVersion).toEqual(saved);
    const retry = await f.coordination.call("validation.run", f.request(queued.requestId));
    expect(retry.validation).toEqual(queued);
    f.engine.setPoolPaused(false);
    await f.started(queued);
    expect(await gitOps.head(queued.snapshot)).toBe(queued.commit);
    expect(await gitOps.treeOf(queued.snapshot)).toBe(queued.tree);
    f.release(queued);
    const result = await f.finished(queued);
    expect(result.result).toBe("passed");
    expect(result.commit).toBe(queued.commit); expect(result.tree).toBe(queued.tree);
    expect(result.commit).not.toBe(saved.commit);
    await owner.stop(f.engine);

  }, {}, { fastClientStop: true, actorLease: false });

  });
});
});
