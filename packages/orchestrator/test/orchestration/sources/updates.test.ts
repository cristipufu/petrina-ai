import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceUpdateFixture } from "../../fixtures/source-update.js";

const fixtures: ReturnType<typeof sourceUpdateFixture>[] = [];
const fixture = (...args: Parameters<typeof sourceUpdateFixture>) => {
  const f = sourceUpdateFixture(...args); fixtures.push(f); return f;
};
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.useRealTimers(); });

describe("source update observations and their canonical transitions", () => {
  for (const kind of ["default", "branch", "pull-request"] as const) it(`moves the ${kind} base while retaining its initial source and the same task change`, async () => {
    const f = fixture(kind); f.fold(); f.fetched(); f.incoming();
    f.reads.commitTree.expect(["combined-tree", "latest", f.controller.message(f.scope)], "new-task-commit");
    f.reads.moveTo.expect(["new-task-commit"], undefined); f.reads.rememberVersion.expect([{ head: "new-task-commit", tree: "combined-tree" }], undefined);
    expect(await f.update(true)).toBe("moved");
    expect(f.scope.work.baseSha).toBe("latest");
    expect(f.scope.work.source?.initialSha).toBe("initial-source");
    expect(f.scope.work.base).toBe(kind === "pull-request" ? `origin/${f.branch}` : f.branch);
    expect(f.notes).toEqual([`Brought up to date with ${kind === "pull-request" ? "PR #7" : f.branch} (1 new commit there), with no conflicts`]);
    expect(f.task.stageIndex).toBe(1);
    expect(f.scope.work.updating).toBeUndefined();
    f.consumed();
  });

  for (const kind of ["branch", "pull-request"] as const) it(`refuses a failed explicit ${kind} fetch without observing local fallback or changing the source`, async () => {
    const f = fixture(kind); f.fold();
    const before = structuredClone(f.scope.work.source), failure = new Error("Could not fetch the approved starting point");
    f.reads.fetchSource.effect([], async () => { throw failure; });
    await expect(f.update()).rejects.toBe(failure);
    expect(f.scope.work.source).toEqual(before); expect(f.scope.work.baseSha).toBe("base");
    expect(f.calls.map(call => call.name)).toEqual(["sourceRef", "observeFold", "squash", "rememberVersion", "fetchSource"]);
    f.consumed();
  });

  for (const required of [false, true]) it(`keeps unavailable default-source policy distinct for publication and prerequisite release (${required})`, async () => {
    const f = fixture(); f.scope.work.delivery = "pull-request"; f.fold();
    f.reads.fetchDefault.expect([], { ok: false, error: "Offline" });
    await expect(f.update(!required, required)).rejects.toThrow(required ? "latest starting code" : "published nothing");
    expect(f.scope.work.baseSha).toBe("base"); expect(f.scope.work.source?.initialSha).toBe("initial-source");
    f.consumed();
  });

  it("allows the ordinary pre-delivery fallback and reports the failed fetch without declaring new evidence", async () => {
    const f = fixture(); f.scope.work.delivery = "pull-request"; f.fold();
    f.reads.fetchDefault.expect([], { ok: false, error: "Offline" });
    f.reads.sourceRef.expect(["refs/remotes/origin/main"], "base");
    expect(await f.update()).toBe("current");
    expect(f.notes).toEqual(["Did not update from GitHub: Offline, so Petrina compared the work with the local copy of main"]);
    expect(f.versions).toEqual([{ head: "folded", tree: "own-tree" }]); f.consumed();
  });

  for (const kind of ["default", "branch"] as const) it(`carries remote movement instead of treating its own refused ${kind} placement as new source`, async () => {
    const f = fixture(kind);
    f.scope.work.localUpdate = { branch: f.branch, sha: "unpushed-task", pushed: false };
    f.fold();
    if (kind === "default") f.reads.fetchDefault.expect([], { ok: true, sha: "latest" });
    else f.reads.fetchSource.expect([], { ref: `origin/${f.branch}`, sha: "latest" });
    f.reads.sourceRef.expect([`refs/heads/${f.branch}`], "unpushed-task");
    f.incoming();
    f.reads.commitTree.expect(["combined-tree", "latest", f.controller.message(f.scope)], "new-task-commit");
    f.reads.moveTo.expect(["new-task-commit"], undefined); f.reads.rememberVersion.expect([{ head: "new-task-commit", tree: "combined-tree" }], undefined);
    expect(await f.update(true)).toBe("moved");
    expect(f.scope.work.baseSha).toBe("latest"); expect(f.scope.work.base).toBe(`origin/${f.branch}`);
    expect(f.scope.work.localUpdate).toEqual({ branch: f.branch, sha: "unpushed-task", pushed: false });
    expect(f.calls.some(call => call.name === "sourceContains")).toBe(false); f.consumed();
  });

  for (const ahead of ["local", "remote", "diverged"] as const) it(`selects actual destination ancestry after newer ${ahead} work without rewriting either destination`, async () => {
    const f = fixture("branch"); f.fold();
    f.reads.fetchSource.expect([], { ref: `origin/${f.branch}`, sha: "remote-latest" });
    f.reads.sourceRef.expect([`refs/heads/${f.branch}`], "local-latest");
    f.reads.sourceContains.expect(["local-latest", "remote-latest"], ahead === "local");
    if (ahead !== "local") f.reads.sourceContains.expect(["remote-latest", "local-latest"], ahead === "remote");
    if (ahead === "diverged") await expect(f.update()).rejects.toThrow("divergent history");
    else {
      const latest = `${ahead}-latest`;
      f.reads.contains.expect([latest, "base"], true); f.reads.mergeBase.expect(["HEAD", latest], latest);
      expect(await f.update()).toBe("current");
    }
    expect(f.scope.work.baseSha).toBe("base");
    expect(f.calls.some(call => ["commitTree", "moveTo", "openOn"].includes(call.name))).toBe(false); f.consumed();
  });

  it("rejects replaced history before treating an older source tip as current", async () => {
    const f = fixture("branch"); f.fold(); f.fetched();
    f.reads.contains.expect(["latest", "base"], false);
    await expect(f.update()).rejects.toThrow("history was replaced or diverged");
    expect(f.scope.work.baseSha).toBe("base"); expect(f.scope.work.source?.initialSha).toBe("initial-source");
    expect(f.calls.some(call => call.name === "mergeTree")).toBe(false); f.consumed();
  });

  it("uses the confirmed default branch after the product's default changes", async () => {
    const f = fixture();
    f.product.defaultBranch = "trunk";
    f.fold(); f.fetched("base");
    expect(await f.update()).toBe("current");
    expect(f.scope.work.source?.product.defaultBranch).toBe("main");
    expect(f.scope.work.source?.start.branch).toBe("main");
    expect(f.scope.work.source?.destination.branch).toBe("main");
    expect(f.calls.filter(call => call.name === "sourceRef").map(call => call.args)).toEqual([["refs/heads/main"], ["refs/heads/main"]]);
    f.consumed();
  });

  for (const failure of ["dirty", "unreadable merge"] as const) it(`preserves the change when update observations report ${failure}`, async () => {
    const f = fixture(); f.fold(); f.fetched();
    f.incoming(failure === "dirty" ? { tree: "combined-tree", conflicts: [], notes: [] } : null, failure !== "dirty");
    await expect(f.update()).rejects.toThrow(failure === "dirty" ? "changes Petrina did not commit" : "could not bring the work up to date");
    expect(f.scope.work.baseSha).toBe("base"); expect(f.calls.some(call => call.name === "moveTo")).toBe(false); f.consumed();
  });

  for (const reviewed of [false, true]) it(`routes the observed conflict through SourceConflicts with the actual reviewed status (${reviewed})`, async () => {
    const f = fixture("branch", true), merge = { tree: "conflict-tree", conflicts: ["greeting.txt"], notes: ["Both sides changed the greeting"] };
    if (reviewed) f.scope.work.reviewedTree = "own-tree";
    f.fold(); f.fetched(); f.incoming(merge);
    f.reads.openOn.expect(["latest", "conflict-tree"], undefined);
    expect(await f.update()).toBe("conflict");
    expect(f.scope.work.updating).toMatchObject({ from: "base", onto: "latest", files: ["greeting.txt"] });
    expect(f.scope.work.base).toBe(f.branch);
    expect(f.scope.work.updating?.head).toBe(reviewed ? "folded" : undefined);
    expect(f.task.stageIndex).toBe(0); expect(f.task.repair?.products).toEqual([f.scope.work.productId]);
    expect(f.scope.work.builderSession?.sessionId).toBe("supplied:shop:builder"); f.consumed();
  });

  it("carries only the reviewed tree and invalidates checks that do not describe the resulting tree", async () => {
    const f = fixture(); f.scope.work.reviewedTree = "own-tree"; f.scope.work.reviewedSha = "reviewed-commit";
    f.scope.work.checks = { at: 1, tree: "old-check-tree", current: true, results: [] };
    f.fold(); f.fetched(); f.incoming();
    f.reads.commitTree.expect(["combined-tree", "latest", f.controller.message(f.scope)], "new-task-commit");
    f.reads.moveTo.expect(["new-task-commit"], undefined); f.reads.rememberVersion.expect([{ head: "new-task-commit", tree: "combined-tree" }], undefined);
    f.reads.mergeTree.expect(["latest", "reviewed-commit"], { tree: "carried-tree", conflicts: [], notes: [] });
    f.reads.commitTree.expect(["carried-tree", "latest", "The version the last review round saw, carried onto the latest main (Petrina's reference, on no branch)"], "carried-review");
    expect(await f.update()).toBe("moved");
    expect(f.scope.work.reviewedTree).toBe("combined-tree"); expect(f.scope.work.reviewedSha).toBe("carried-review");
    expect(f.scope.work.checks.current).toBe(false); f.consumed();
  });

  for (const forward of [false, true]) it(`settles an inaccurate base from raw ancestry, not the commit index (${forward})`, async () => {
    const f = fixture();
    f.reads.sourceRef.expect(["refs/heads/main"], "latest");
    f.reads.observeFold.expect([], { kind: "observed", head: "own-head", tree: "own-tree", parents: ["previous"], squash: f.reads.squash.read });
    f.reads.mergeBase.expect(["own-head", "latest"], "indexed-base");
    f.reads.mergeBase.expect(["own-head", "latest", true], "raw-base");
    f.reads.contains.expect(["raw-base", "base", true], forward); f.reads.contains.expect(["own-head", "base", true], false);
    f.reads.squash.expect(["raw-base", f.controller.message(f.scope)], { head: "folded", tree: "own-tree" });
    f.reads.rememberVersion.expect([{ head: "folded", tree: "own-tree" }], undefined);
    expect(await f.controller.fold(f.scope)).toEqual({ fork: "raw-base", version: { head: "folded", tree: "own-tree" } });
    expect(f.scope.work.baseSha).toBe("raw-base");
    expect(f.notes[0]).toContain(forward ? "brought main into the branch itself" : "noted base was not in the branch"); f.consumed();
  });

  it("settles every peer observation before reporting an update read failure", async () => {
    vi.useFakeTimers();
    const f = fixture(), failure = new Error("Status unavailable"), events: string[] = [];
    f.fold(); f.fetched(); f.reads.contains.expect(["latest", "base"], true); f.reads.mergeBase.expect(["HEAD", "latest"], "base");
    f.reads.isClean.effect([], async () => { throw failure; });
    f.reads.mergeTree.effect(["latest"], () => new Promise(resolve => setTimeout(() => { events.push("peer finished"); resolve(undefined); }, 1)));
    f.reads.commitsSince.expect(["base", "latest"], 1);
    const outcome = f.update().then(() => { throw new Error("Expected failed native observation"); }, error => { events.push("failure propagated"); return error; });
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure); expect(events).toEqual(["peer finished", "failure propagated"]); f.consumed();
  });
});
