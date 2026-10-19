import { describe, expect, it } from "vitest";
import { createDemoState } from "../src/demo.js";
import { assignedProducts, companionPreview, companionText, involvesProduct, landingState, repairOrder, taskProductIds, withoutProduct } from "../src/repositories.js";
import { Simulator } from "../src/sim.js";
import type { Task, TaskRepository } from "../src/model.js";
import { productHistory } from "../src/products.js";

const original = createDemoState(1_000_000_000).tasks[0]!;
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
    expect(retained.repositories!.find((work) => work.productId === "lead")!.removed).toBe(true);
    expect(retained.selectedProducts!.map((choice) => choice.productId)).toEqual(["last"]);
    expect(retained.session).toBe(saved.session);
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

  it("shows the same shared companion preview in the demo and needs only one delivery decision", () => {
    const initial = createDemoState(1_000_000_000);
    const products = initial.products.slice(0, 2).map((product) => ({ ...product, approveDelivery: true, shipLowRisk: false }));
    const simulator = new Simulator({ ...initial, products, tasks: [], inbox: [], pool: { ...initial.pool, paused: false } });
    const id = simulator.addTask({ productId: products[0]!.id, worksOn: products.map((product) => ({ productId: product.id, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "One approved linked delivery", kind: "chore", approvePlan: true, approveDelivery: true });
    let decisions = 0;
    for (let tick = 0; tick < 300 && !["done", "pr-open"].includes(simulator.getState().tasks[0]!.state); tick += 1) {
      for (const item of simulator.getState().inbox) if (["plan", "design", "delivery"].includes(item.kind)) {
        if (item.kind === "delivery") {
          decisions++;
          for (const product of products) expect(item.body).toContain(`${product.repo}; link pending`);
          expect(item.body).toContain("visible to anyone who can read it");
        }
        simulator.approve(item.id);
      }
      simulator.tick();
    }
    expect(simulator.getState().tasks.find((task) => task.id === id)?.state).toBe("pr-open");
    expect(decisions).toBe(1);
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
  it("keeps shared history when the first product is removed and deletes it only with the last product", () => {
    const initial = createDemoState(1_000_000_000);
    const simulator = new Simulator({ ...initial, tasks: [], inbox: [], pool: { ...initial.pool, paused: false } });
    const products = initial.products.slice(0, 2);
    const id = simulator.addTask({ productId: products[0]!.id, worksOn: products.map((product) => ({ productId: product.id, startFrom: { kind: "default" }, delivery: "local" })), title: "Keep shared history", kind: "chore", approvePlan: true, approveDelivery: true });
    for (let tick = 0; tick < 300 && simulator.getState().tasks[0]?.state !== "done"; tick += 1) {
      for (const item of simulator.getState().inbox) if (["plan", "design", "delivery"].includes(item.kind)) simulator.approve(item.id);
      simulator.tick();
    }
    const done = simulator.getState().tasks[0]!;
    expect(done.state).toBe("done");
    expect(done.repositories).toHaveLength(2);
    const history = done.timeline;
    simulator.removeProduct(products[0]!.id);
    const retained = simulator.getState().tasks.find((entry) => entry.id === id)!;
    expect(retained.timeline).toEqual(history);
    expect(taskProductIds(retained)).toEqual([products[1]!.id]);
    expect(retained.repositories![0]!.source!.product.name).toBe(products[0]!.name);
    simulator.removeProduct(products[1]!.id);
    expect(simulator.getState().tasks).toHaveLength(0);
    expect(simulator.getState().inbox).toHaveLength(0);
  });

});
