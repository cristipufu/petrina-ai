import { workflowFixture } from "../../fixtures/workflow.js";

import { describe, expect, it } from "vitest";

import { assignedProducts, companionPreview, companionText, involvesProduct, landingState, repairOrder, taskProductIds, withoutProduct } from "../../../src/repositories.js";

import type { Task, TaskRepository } from "../../../src/model.js";
import { workSummary } from "../../../src/source.js";
import { productHistory } from "../../../src/products.js";

const original = { ...workflowFixture().task, selectedProducts: undefined };

const work = (productId: string): TaskRepository => ({ productId, delivery: "pull-request", completedStages: [] });

const task: Task = { ...original, productId: "lead", repositories: [work("first"), work("lead"), work("last")], leadProductId: "lead" };

describe("shared task ownership and landing", () => {
  it("removes membership without changing the saved task or its nested history", () => {
    const saved: Task = { ...task, repositories: task.repositories!.map((work) => ({ ...work })), activeProductId: "lead", selectedProducts: [{ productId: "lead", startFrom: { kind: "default" }, delivery: "local" }, { productId: "last", startFrom: { kind: "default" }, delivery: "local" }] };
    const before = JSON.stringify(saved);
    Object.freeze(saved);
    Object.freeze(saved.repositories);
    for (const work of saved.repositories!) Object.freeze(work);
    const retained = withoutProduct(saved, "lead")!;
    expect(taskProductIds(retained)).toEqual(["first", "last"]);
    expect(retained.productId).toBe("first");
    expect(retained.activeProductId).toBe("first");
    expect(retained.leadProductId).toBe("first");
    expect(retained.repositories!.find((work) => work.productId === "lead")!.removed).toBe(true);
    expect(retained.selectedProducts!.map((choice) => choice.productId)).toEqual(["last"]);
    expect(retained.session).toBe(saved.session);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("takes a remaining starting point from its row and clears the removed product's execution state", () => {
    const source = { product: { id: "last", name: "Last", repo: "acme/last", defaultBranch: "main" }, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: "acme/last", branch: "main" }, confirmed: false };
    const choice = { productId: "last", startFrom: { kind: "default" as const }, delivery: "local" as const };
    const saved: Task = { ...original, productId: "lead", activeProductId: "lead", leadProductId: "lead", selectedProducts: undefined, repositories: undefined,
      repository: { productId: "lead", delivery: "release", branch: "old", checks: { at: 1, results: [] } }, branch: "old", checks: { at: 1, results: [] },
      plan: { ...original.plan!, leadProductId: "lead" },
      workRows: [{ choice: { ...choice, productId: "lead" } }, { choice, source }] };
    const before = JSON.stringify(saved);
    const kept = withoutProduct(saved, "lead")!;
    expect(kept).toMatchObject({ productId: "last", activeProductId: "last", leadProductId: "last", workChoice: choice, source, delivery: "local", plan: { leadProductId: "last" }, repository: { productId: "last", source, delivery: "local" } });
    expect(kept.branch).toBeUndefined(); expect(kept.checks).toBeUndefined(); expect(kept.repository!.branch).toBeUndefined();
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("shows one task under every retained product and keeps explicit ownership", () => {
    expect(taskProductIds(task)).toEqual(["first", "lead", "last"]);
    expect(involvesProduct(task, "first")).toBe(true);
    expect(assignedProducts(task, undefined)).toEqual([]);
    expect(assignedProducts(task, ["first", "missing"])).toEqual([]);
    expect(assignedProducts(task, ["last", "first", "first"])).toEqual(["last", "first"]);
    expect(assignedProducts({ ...original, productId: "first", repositories: undefined }, undefined)).toEqual(["first"]);
  });

  it("routes only affected owners, lead first when affected, otherwise plan order", () => {
    expect(repairOrder(task, [{ productIds: ["last", "first"] }])).toEqual(["first", "last"]);
    expect(repairOrder(task, [{ productIds: ["last", "lead", "first"] }])).toEqual(["lead", "first", "last"]);
    expect(repairOrder(task, [{}, { productIds: ["missing"] }])).toEqual([]);
  });

  it("waits for every published repository, including mixed delivery choices", () => {
    const pr = { number: 1, url: "https://github.com/acme/shop/pull/1", state: "open" as const, openedAt: 1 };
    const release = { tag: "v1.2.3", url: "https://github.com/acme/api/releases/tag/v1.2.3" };
    expect(landingState([{ ...work("first"), pr: { ...pr, state: "merged" } }, { ...work("lead"), pr }])).toBe("waiting");
    expect(landingState([{ ...work("first"), release }, { ...work("lead"), pr }])).toBe("waiting");
    expect(landingState([{ ...work("first"), release }, { ...work("lead"), pr: { ...pr, state: "closed" } }])).toBe("decision");
    expect(landingState([{ ...work("first"), release }, { ...work("lead"), landed: { branch: "main", sha: "abc" }, localUpdate: { branch: "main", sha: "abc", pushed: false } }])).toBe("unfinished");
    expect(landingState([{ ...work("first"), release }, { ...work("lead"), nothingToPublish: true }])).toBe("landed");
  });

  it("previews pending companion links and omits unchanged products", () => {
    expect(companionText([{ ...work("first"), landed: { branch: "main", sha: "abc" } }, work("lead"), { ...work("last"), nothingToPublish: true }])).toBe("Part of a change across: first (local delivery), lead (link pending).");
    expect(companionText([{ ...work("first"), nothingToPublish: true }, work("lead")])).toBe("");
  });

  it("names pending repositories and makes every companion PR's readership explicit in one preview", () => {
    const works = ["public-web", "private-api"].map((id) => ({ ...work(id), workProduct: { id, name: id === "public-web" ? "Web app" : "Payment logic", repo: `acme/${id}` } }));
    expect(companionText(works)).toBe("Part of a change across: Web app (acme/public-web; link pending), Payment logic (acme/private-api; link pending).");
    expect(companionPreview(works)).toContain("visible to anyone who can read it");
    const published = works.map((entry, index) => ({ ...entry, pr: { number: index + 1, url: `https://github.com/${entry.workProduct.repo}/pull/${index + 1}`, state: "open" as const, openedAt: 1 } }));
    expect(companionText(published)).toBe("Part of a change across: [Web app](https://github.com/acme/public-web/pull/1), [Payment logic](https://github.com/acme/private-api/pull/2).");
    expect(companionPreview([{ ...works[0]!, nothingToPublish: true }, works[1]!])).toBe("");
    expect(companionPreview(works.map((entry) => ({ ...entry, delivery: "local" })))).not.toContain("pull request");
    expect(companionPreview(works.map((entry) => ({ ...entry, delivery: "release" })))).not.toContain("pull request");
  });

  it("names the approved repositories behind pending PR and release links", () => {
    const repository = (id: string, repo: string): TaskRepository => ({ ...work(id), workProduct: { id, name: id, repo, defaultBranch: "main" } });
    const shop = repository("Shop", "acme/shop");
    const api = repository("API", "private/api");
    const local = { ...repository("Tools", "acme/tools"), delivery: "local" as const };
    expect(companionText([shop, api, local])).toBe("Part of a change across: Shop (acme/shop; link pending), API (private/api; link pending), Tools (local delivery).");
    const fork: TaskRepository = { ...shop, workProduct: { ...shop.workProduct!, repo: "changed/settings" }, source: { product: shop.workProduct!, start: { kind: "pull-request", number: 7, url: "https://github.com/acme/shop/pull/7", branch: "review-work", headRepo: "contributor/shop" }, destination: { kind: "update-pr", mode: "pull-request", repo: "contributor/shop", branch: "review-work" }, confirmed: true } };
    expect(companionText([fork, api])).toBe("Part of a change across: Shop (acme/shop; link pending), API (private/api; link pending).");
    const linked = companionText([{ ...shop, pr: { number: 7, url: "https://github.com/acme/shop/pull/7", state: "open", openedAt: 1 } }, { ...api, release: { tag: "v1.0.0", url: "https://github.com/private/api/releases/tag/v1.0.0" } }, local]);
    expect(linked).toBe("Part of a change across: [Shop](https://github.com/acme/shop/pull/7), [API](https://github.com/private/api/releases/tag/v1.0.0), Tools (local delivery).");
  });

  it("blocks removal with open or unresolved publications, including cancelled tasks", () => {
    const open = { ...task, state: "cancelled" as const, repositories: [{ ...work("first"), pr: { number: 1, url: "", state: "open" as const, openedAt: 1 } }] };
    expect(productHistory([open], "first")).toEqual({ unfinished: 1, finished: 0 });
    expect(taskProductIds({ ...task, repositories: task.repositories!.map((entry) => ({ ...entry, removed: entry.productId === "first" })) })).toEqual(["lead", "last"]);
  });
});

for (const mode of ["local", "release", "mixed", "unchanged-pr"] as const)
it(`omits pull-request publication wording when ${mode} deliveries publish no pull requests`, () => {
  const products = ["shop", "api", "third"].map(id => ({ id, name: id, repo: `acme/${id}` }));
  const works: TaskRepository[] = products.slice(0, mode === "unchanged-pr" ? 3 : 2).map((product, index) => {
    const delivery = mode === "unchanged-pr" && index === 2 ? "pull-request" : mode === "release" || mode === "mixed" && index === 1 ? "release" : "local";
    return { productId: product.id, delivery, completedStages: [], ...(delivery === "pull-request" ? { nothingToPublish: true } : {}),
      source: { product, start: { kind: "default", branch: "main" }, destination: { kind: delivery === "pull-request" ? "new-pr" : delivery === "release" ? "release" : "branch", mode: delivery, repo: product.repo, branch: "main" }, confirmed: true } };
  });
  const body = companionPreview(works);
  for (const work of works) expect(workSummary(work.source!)).toContain(work.source!.product.repo);
  // The Engine gate's retained composition case checks its single Inbox item/kind and
  // complete product summary; this rule owns only the companion text appended there.
  expect(body).toContain("Part of a change across:");
  for (const work of works.filter(work => !work.nothingToPublish && work.delivery !== "local")) expect(body).toContain(work.source!.product.repo);
  expect(body).not.toContain("every companion pull request"); expect(body).not.toContain("Pending links");
});

for (const mode of ["local", "release"] as const)
it(`previews companion wording on an existing pull request beside a ${mode} delivery`, () => {
  const works: TaskRepository[] = ["shop", "api"].map((id, index) => {
    const product = { id, name: id, repo: `acme/${id}` };
    return { productId: id, delivery: index ? mode : "local", completedStages: [], source: { product,
      start: index ? { kind: "default", branch: "main" } : { kind: "pull-request", number: 7, url: `https://github.com/${product.repo}/pull/7`, headRepo: product.repo, branch: "feature" },
      destination: { kind: index ? mode === "release" ? "release" : "branch" : "update-pr", mode: index ? mode : "local", repo: product.repo, branch: index ? "main" : "feature" }, confirmed: true } };
  });
  const body = companionPreview(works);
  expect(body).toContain("Part of a change across:"); expect(body).toContain("visible to anyone who can read it"); expect(body).toContain("Pending links will become");
});
