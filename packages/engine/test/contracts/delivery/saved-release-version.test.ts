import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";

import { git } from "../../fixtures.js";

import { executionFor } from "@petrina/orchestrator";


import { ExtraFixtures } from "../../extra-fixtures.js";

const owned = new ExtraFixtures();
const {  } = owned;
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
for (const route of ["failed preparation", "shared needs-you", "shared paused", "shared failed", "delivery retry", "proof decision", "acceptance decision", "no version change", "working edits"] as const) it(`pins the restored saved work after ${route}`, async () => {
    const f = await fixture();
    const scope = executionFor(f.task), path = scope.work.worktree!, shipping = f.engine["shipping"];
    scope.work.branch = await git(path, "branch", "--show-current");
    scope.work.delivery = "release";
    writeFileSync(join(path, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await git(path, "add", "."); await git(path, "commit", "-qm", "Declare the release version");
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
    if (route.startsWith("shared ")) {
      f.task.repositories = [Object.assign(f.task.repository!, { completedStages: [] })]; delete f.task.repository;
      const state = route.slice("shared ".length) as "needs-you" | "paused" | "failed";
      // Control the shared driver's outcome; its real finalizer must restore unpublished work.
      const deliverMany = shipping["deliverMany"];
      shipping["deliverMany"] = async () => {
        f.task.state = state;
        if (state === "failed") throw new Error("Delivery stopped before publication");
        return "stop";
      };
      try {
        const outcome = await shipping.deliver(f.task, f.task.plan.stages[2]!, new AbortController().signal).then(value => value, error => error.message);
        expect(outcome).toBe(state === "failed" ? "Delivery stopped before publication" : "stop");
        expect(f.task.state).toBe(state);
      } finally { shipping["deliverMany"] = deliverMany; }
      f.task.state = "waiting"; // The coordinator can resume the task before requesting validation.
    } else if (route === "failed preparation") {
      expect(await shipping["preparationFailed"](scope, "Release checks failed", new AbortController().signal)).toBe("continue");
    } else if (route === "delivery retry") {
      expect(await shipping["prepareAgain"](scope, "Main moved before publication")).toBe("again");
    } else if (route === "proof decision" || route === "acceptance decision") {
      await shipping["returnForDecision"](f.task, route === "proof decision" ? "proof" : "acceptance");
      expect(f.task.stageIndex).toBe(1);
    } else {
      await shipping.clearUnpublishedVersion(scope);
    }
    expect(await git(path, "rev-parse", "HEAD")).toBe(saved.commit);
    expect(await git(path, "status", "--porcelain")).toBe("");
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
    await f.engine.shutdown();
  });

it("keeps an already queued release snapshot when restoring the saved work", async () => {
    const f = await fixture(), scope = executionFor(f.task), path = scope.work.worktree!;
    scope.work.branch = await git(path, "branch", "--show-current");
    writeFileSync(join(path, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await git(path, "add", "."); await git(path, "commit", "-qm", "Declare the release version");
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
    expect(await git(queued.snapshot, "rev-parse", "HEAD")).toBe(queued.commit);
    expect(await git(queued.snapshot, "rev-parse", "HEAD^{tree}")).toBe(queued.tree);
    f.release(queued);
    const result = await f.finished(queued);
    expect(result.result).toBe("passed");
    expect(result.commit).toBe(queued.commit); expect(result.tree).toBe(queued.tree);
    expect(result.commit).not.toBe(saved.commit);
    await f.engine.shutdown();
  });
});
