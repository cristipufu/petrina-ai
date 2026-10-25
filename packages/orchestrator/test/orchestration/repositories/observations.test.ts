import { expect, it } from "vitest";
import { sameVersions } from "@petrina/core";
import { observeCommittedCode } from "../../../src/index.js";
import { observationFixture } from "../../fixtures/repository-observations.js";

it.each([false, true])("pairs every committed tree with the change of that same head (shared: %s)", async shared => {
  const f = observationFixture(shared);
  expect(await observeCommittedCode(f.task, f.queries)).toEqual(shared
    ? { versions: { a: "tree-a", b: "tree-b" }, changes: { a: "change-a", b: "change-b" } }
    : { versions: { a: "tree-a" }, changes: { a: "change-a" } });
  expect(f.calls.filter(call => call.kind === "change")).toEqual((shared ? ["a", "b"] : ["a"]).map(productId => ({ kind: "change", productId, base: `base-${productId}`, head: `head-${productId}` })));
});

it("pins the head and starting base before a later query or metadata change", async () => {
  const f = observationFixture(false), read = f.readers.get("a")!;
  const original = read.committed;
  read.committed = async () => {
    const version = await original();
    f.versions.set("a", { head: "later-head", tree: "later-tree" });
    f.task.repository!.baseSha = "later-base";
    return version;
  };
  expect(await observeCommittedCode(f.task, f.queries)).toEqual({ versions: { a: "tree-a" }, changes: { a: "change-a" } });
  expect(f.calls.at(-1)).toEqual({ kind: "change", productId: "a", base: "base-a", head: "head-a" });
});

it("observes fresh data again after code changes without rewriting a previous result", async () => {
  const f = observationFixture(false), first = await observeCommittedCode(f.task, f.queries);
  f.versions.set("a", { head: "new-head", tree: "new-tree" });
  f.changes.set(f.key("a", "base-a", "new-head"), "new-change");
  expect(await observeCommittedCode(f.task, f.queries)).toEqual({ versions: { a: "new-tree" }, changes: { a: "new-change" } });
  expect(first).toEqual({ versions: { a: "tree-a" }, changes: { a: "change-a" } });
  expect(f.calls.filter(call => call.kind === "committed")).toHaveLength(2);
});

it.each(["workspace", "commit", "base", "change"] as const)("keeps an unavailable %s explicit without inventing unchanged code", async missing => {
  const f = observationFixture(false);
  if (missing === "workspace") f.readers.set("a", undefined);
  if (missing === "commit") f.versions.set("a", undefined);
  if (missing === "base") delete f.task.repository!.baseSha;
  if (missing === "change") f.changes.set(f.key("a", "base-a", "head-a"), undefined);
  const result = await observeCommittedCode(f.task, f.queries);
  expect(result).toEqual({ versions: { a: missing === "workspace" || missing === "commit" ? "unavailable" : "tree-a" }, changes: { a: "unavailable" } });
  if (missing !== "change") expect(f.calls.some(call => call.kind === "change")).toBe(false);
  if (missing === "workspace" || missing === "commit") expect(sameVersions(result.versions, result.versions)).toBe(false);
});

it("keeps empty changes distinct from an unavailable fingerprint", async () => {
  const f = observationFixture(false); f.changes.set(f.key("a", "base-a", "head-a"), "empty");
  expect((await observeCommittedCode(f.task, f.queries)).changes).toEqual({ a: "empty" });
});

it("does not turn an empty approved map or excluded owners into observable work", async () => {
  const f = observationFixture(); f.task.repositories = []; f.task.repository = { productId: "a", delivery: "local" };
  f.task.excludedRepositories = [{ productId: "excluded", delivery: "local", completedStages: [] }];
  expect(await observeCommittedCode(f.task, f.queries)).toEqual({ versions: {}, changes: {} }); expect(f.calls).toEqual([]);
});

it.each(["bind", "committed", "change"] as const)("settles a pending peer before propagating an owner's %s failure", async phase => {
  const f = observationFixture(), failure = new Error("Could not read a");
  let enter!: () => void, release!: () => void, settled = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (phase === "bind") {
    const bind = f.queries.bind;
    f.queries.bind = scope => { if (scope.work.productId === "a") throw failure; return bind(scope); };
  } else if (phase === "committed") f.readers.get("a")!.committed = async () => { throw failure; };
  else f.readers.get("a")!.change = async () => { throw failure; };
  const original = f.readers.get("b")!.committed;
  f.readers.get("b")!.committed = async () => { enter(); await gate; return original(); };
  const outcome = observeCommittedCode(f.task, f.queries).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await Promise.race([entered, outcome.then(() => { throw new Error("The group returned while its peer was pending"); })]);
    expect(settled).toBe(false); release(); expect(await outcome).toEqual({ error: failure });
    expect(f.calls.at(-1)).toEqual({ kind: "change", productId: "b", base: "base-b", head: "head-b" });
  } finally { release(); await outcome; }
});

it("preserves approved order when readers finish in the opposite order", async () => {
  const f = observationFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = f.readers.get("a")!.committed, second = f.readers.get("b")!.committed;
  f.readers.get("a")!.committed = async () => { await gate; return first(); };
  f.readers.get("b")!.committed = async () => { const result = await second(); release(); return result; };
  const result = await observeCommittedCode(f.task, f.queries);
  expect(Object.keys(result.versions)).toEqual(["a", "b"]); expect(Object.keys(result.changes)).toEqual(["a", "b"]);
});
