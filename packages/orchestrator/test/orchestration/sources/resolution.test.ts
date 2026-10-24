import { expect, it } from "vitest";
import { executionFor, resolveSource } from "../../../src/index.js";
import { pending, sourceChoice, sourceFixture, sourceTask } from "../../fixtures/sources.js";

it.each(["local", "pull-request", "release"] as const)("resolves default %s delivery without discovering unrelated branches", async delivery => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async name => name === "main";
  const before = structuredClone(task);
  const result = await resolveSource(executionFor(task), { ...sourceChoice(), delivery }, f.products, f.queries);
  expect(result).toEqual({ product: { id: "shop", name: "Shop", repo: "acme/shop", remote: "https://github.com/acme/shop.git", defaultBranch: "main", path: undefined },
    start: { kind: "default", branch: "main" }, destination: { mode: delivery, kind: delivery === "local" ? "branch" : delivery === "release" ? "release" : "new-pr", repo: "acme/shop", branch: "main", remote: "https://github.com/acme/shop.git" }, confirmed: false });
  expect(task).toEqual(before); expect(f.calls).toEqual(["valid:main"]);
});

it.each(["release/été+2", "feature.with-dots"])("validates the exact named branch %s", async name => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async branch => branch === name;
  f.scripts.requireBranch = async (repo, branch) => { expect([repo, branch]).toEqual(["acme/shop", name]); };
  const result = await resolveSource(executionFor(task), sourceChoice("shop", name), f.products, f.queries);
  expect(result.start).toEqual({ kind: "branch", branch: name });
  expect(result.destination.branch).toBe(name); expect(f.calls).toEqual([`valid:${name}`, `exists:acme/shop:${name}`]);
});

it.each(["closed", "merged"] as const)("stops a %s pull request", async state => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.pullRequest = async () => ({ number: 7, url: "https://github.com/acme/shop/pull/7", state, branch: "work", headRepo: "acme/shop" });
  await expect(resolveSource(executionFor(task), { ...sourceChoice(), startFrom: { kind: "pull-request", value: "7" } }, f.products, f.queries)).rejects.toThrow(`PR #7 is ${state}`);
  expect(f.calls).toEqual(["pr:acme/shop:7"]);
});

it.each(["acme/shop", "ACME/SHOP", "contributor/fork"])("pins the PR working identity %s", async headRepo => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.pullRequest = async () => ({ number: 7, url: "https://github.com/acme/shop/pull/7", state: "open", branch: "work", headRepo });
  const result = await resolveSource(executionFor(task), { ...sourceChoice(), delivery: "pull-request", startFrom: { kind: "pull-request", value: "#7" } }, f.products, f.queries);
  expect(result.start).toEqual({ kind: "pull-request", number: 7, url: "https://github.com/acme/shop/pull/7", branch: "work", headRepo });
  expect(result.destination).toEqual({ mode: "pull-request", kind: "update-pr", repo: headRepo, branch: "work", remote: headRepo === "contributor/fork" ? "https://github.com/contributor/fork.git" : "https://github.com/acme/shop.git" });
  expect(f.calls).toEqual(["pr:acme/shop:7"]);
});

it.each([{ kind: "branch", name: "other" }, { kind: "pull-request", value: "7" }] as const)("rejects release from $kind before requesting any effects", async startFrom => {
  const task = sourceTask(), f = sourceFixture();
  await expect(resolveSource(executionFor(task), { ...sourceChoice(), delivery: "release", startFrom }, f.products, f.queries)).rejects.toThrow("Releases start from the default branch");
  expect(f.calls).toEqual([]);
});

it.each(["invalid", "unavailable"])("preserves a branch %s outcome", async failure => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async () => failure !== "invalid";
  f.scripts.requireBranch = async () => { throw new Error("The remote branch could not be checked"); };
  await expect(resolveSource(executionFor(task), sourceChoice("shop", "other"), f.products, f.queries)).rejects.toThrow(failure === "invalid" ? "Enter an exact, valid branch name" : "The remote branch could not be checked");
  expect(f.calls).toEqual(failure === "invalid" ? ["valid:other"] : ["valid:other", "exists:acme/shop:other"]);
});

it("requires shared default branches but never remote existence for a local repository", async () => {
  const task = sourceTask(), f = sourceFixture();
  task.workRows = [];
  f.scripts.validBranch = async () => true;
  f.scripts.requireBranch = async () => {};
  await resolveSource(executionFor(task), sourceChoice(), f.products, f.queries);
  f.products[0] = { ...f.products[0]!, repo: "local/shop" };
  await resolveSource(executionFor(task), sourceChoice("shop", "topic"), f.products, f.queries);
  expect(f.calls).toEqual(["valid:main", "exists:acme/shop:main", "valid:topic"]);
});

it("retains a saved product identity while accepting its current display name", async () => {
  const task = sourceTask(), f = sourceFixture(), scope = executionFor(task);
  scope.work.workProduct = { id: "shop", name: "Old name", repo: "old/shop", remote: "saved-remote", defaultBranch: "saved" };
  f.products[0] = { ...f.products[0]!, name: "New name" };
  f.scripts.validBranch = async () => true;
  const result = await resolveSource(scope, sourceChoice(), f.products, f.queries);
  expect(result.product).toEqual({ ...scope.work.workProduct, name: "New name" });
  expect(result.destination).toMatchObject({ repo: "old/shop", remote: "saved-remote", branch: "saved" });
  expect(f.calls).toEqual(["valid:saved"]);
});

it("keeps the operation bound while the visible repository changes", async () => {
  const task = sourceTask(), f = sourceFixture(), wait = pending<boolean>();
  task.repositories = [{ productId: "shop", delivery: "local", completedStages: [] }, { productId: "api", delivery: "local", completedStages: [] }];
  task.activeProductId = "shop";
  const scope = executionFor(task);
  scope.work.workProduct = { ...f.products[0]!, defaultBranch: "saved" };
  f.scripts.validBranch = () => wait.promise;
  const result = resolveSource(scope, sourceChoice(), f.products, f.queries);
  task.activeProductId = "api";
  wait.resolve(true);
  expect((await result).destination.branch).toBe("saved");
  expect(task.activeProductId).toBe("api"); expect(f.calls).toEqual(["valid:saved"]);
});

it("resolves aliases and coordinator additions without silently accepting an unknown product", async () => {
  const task = sourceTask(), f = sourceFixture();
  f.scripts.validBranch = async () => true;
  const alias = await resolveSource(executionFor(task), { ...sourceChoice("unregistered"), repo: "ACME/SHOP" }, f.products, f.queries);
  expect(alias.product.id).toBe("shop");
  const candidate = { id: "new", name: "New", repo: "acme/new", defaultBranch: "main" };
  expect((await resolveSource(executionFor(task), sourceChoice("new"), f.products, f.queries, candidate)).product).toMatchObject(candidate);
  const before = f.calls.length;
  await expect(resolveSource(executionFor(task), sourceChoice("missing"), f.products, f.queries)).rejects.toThrow("Needs adding: missing");
  expect(f.calls).toHaveLength(before);
});
