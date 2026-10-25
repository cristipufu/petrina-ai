
import { afterAll, describe, expect, it } from "bun:test";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
const { fixture } = owners;
afterAll(() => owners.close());

describe("focused coordination and durable decisions", () => {
it("bounds and filters lists before pagination, rejects changed continuations and keeps task queries small", async () => {
    const { e, c, taskId } = await fixture();
    for (let i = 0; i < 130; i++) e.addTask({ productId: "product", title: `Work ${i}`, description: "x".repeat(8000) });
    const page = await c.call("task.list", {});
    expect((page.items as unknown[]).length).toBe(25);
    expect(page.next).toBeString();
    expect((await c.call("task.list", { limit: 100 })).items).toHaveLength(100);
    expect((await c.call("task.list", { limit: 101 })).outcome).toBe("invalid");
    const filtered = await c.call("task.list", { search: "First" });
    expect(filtered.items).toHaveLength(1);
    const next = await c.call("task.list", { cursor: page.next });
    expect((next.items as { id: string }[])[0]!.id).not.toBe((page.items as { id: string }[])[0]!.id);
    e.moveToTop(e.s.tasks.at(-1)!.id);
    expect((await c.call("task.list", { cursor: page.next })).outcome).toBe("changed");
    expect(JSON.stringify(await c.call("task.inspect", { taskId })).length).toBeLessThan(2000);
  });
});

describe("focused coordination and durable decisions", () => {
it("reads and filters paged history without loading archived conversations, and keeps focused waits bounded", async () => {
    const { e, c, taskId } = await fixture();
    const template = structuredClone(e.task(taskId)!);
    e.s.products.push({ id: "other", name: "Other", repo: "local/other", tone: "green" });
    for (let index = 0; index < 150; index++) {
      const product = e.s.products.find((product) => product.id === (index % 2 ? "product" : "other"))!;
      const choice = { productId: product.id, startFrom: { kind: "default" as const }, delivery: "local" as const };
      e.s.tasks.push({
        ...structuredClone(template), id: `history-${String(index).padStart(3, "0")}`, title: `Archived request ${index}`, description: "long request ".repeat(1000),
        productId: product.id, selectedProducts: [choice], workChoice: choice, repository: { productId: product.id, delivery: choice.delivery, workChoice: choice, workProduct: { id: product.id, name: product.name, repo: product.repo } },
        held: index % 3 === 0, state: index % 4 ? "done" : "cancelled", column: "done", finishedAt: index + 1,
      });
    }
    e.save();
    expect(e.activeState().tasks).toHaveLength(1);
    e.getState = () => { throw new Error("A focused read must not load the full archive"); };
    e.store.history.all = () => { throw new Error("A focused read must not load every conversation"); };
    expect((await c.call("task.list", {})).items).toHaveLength(1);
    const page = await c.call("task.history", {});
    expect(page.items).toHaveLength(25);
    expect(page.total).toBe(150);
    expect((page.items as { id: string }[])[0]!.id).toBe("history-149");
    expect(JSON.stringify(page)).not.toContain("long request");
    expect((await c.call("task.history", { limit: 100 })).items).toHaveLength(100);
    expect((await c.call("task.history", { limit: 101 })).outcome).toBe("invalid");
    const next = await c.call("task.history", { cursor: page.next });
    expect((next.items as { id: string }[])[0]!.id).toBe("history-124");
    expect((await c.call("task.history", { productId: "other", states: ["cancelled"], held: true, search: "arch req" })).total).toBe(13);
    expect((await c.call("task.list", { states: ["cancelled"] })).total).toBe(38);
    expect((await c.call("task.list", { states: ["queued", "done"] })).outcome).toBe("invalid");
    expect((await c.call("task.history", { states: [] })).total).toBe(0);
    e.s.inbox.push({ id: "archived-offer", taskId: "history-148", kind: "learnings", title: "Saved learning offer", body: "A lesson", at: 1, blocking: false });
    const readBody = e.store.history.get.bind(e.store.history);
    try {
      e.store.history.get = () => { throw new Error("Filtering inbox requests must only read history summaries"); };
      expect((await c.call("inbox.list", { productId: "other" })).items).toHaveLength(1);
      expect((await c.call("inbox.list", { productId: "product" })).items).toHaveLength(0);
    } finally { e.store.history.get = readBody; }
    expect(JSON.stringify(await c.call("task.inspect", { taskId: "history-149" })).length).toBeLessThan(2000);
    expect((await c.call("task.read", { taskId: "history-149", section: "request" })).shortened).toBe(true);
    expect((await c.call("watch.wait", { target: "task", taskId: "history-149", condition: "state", states: ["done"], timeoutMs: 0 })).outcome).toBe("completed");
    expect((await c.call("engine.status", {})).outcome).toBe("completed");
    expect((await c.call("pool.inspect", {})).outcome).toBe("completed");
    e.s.tasks.push({ ...structuredClone(template), id: "another-finished", state: "done", column: "done", finishedAt: 200 });
    e.save();
    expect((await c.call("task.history", { cursor: page.next })).outcome).toBe("changed");
  });
});

describe("focused coordination and durable decisions", () => {
it("lists shared current work, history and inbox requests under each product without reading archived bodies", async () => {
    const { e, c, taskId } = await fixture();
    e.s.products.push({ id: "other", name: "Other", repo: "local/other", tone: "green" });
    const sharedId = e.addTask({ productId: "product", title: "Shared transfer", worksOn: ["product", "other"].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "local" })) });
    const otherId = e.addTask({ productId: "other", title: "Other transfer" });
    const ids = async (name: string, args: Record<string, unknown>) => ((await c.call(name, args)).items as { id: string }[]).map((item) => item.id).sort();
    expect(await ids("task.list", { productId: "product" })).toEqual([taskId, sharedId].sort());
    expect(await ids("task.list", { productId: "other" })).toEqual([sharedId, otherId].sort());
    expect((await c.call("task.list", {})).total).toBe(3);
    const shared = e.task(sharedId)!, other = e.task(otherId)!;
    shared.held = true;
    // Once planning records ownership, the selected repository still does not narrow membership.
    shared.repositories = ["product", "other"].map((productId) => ({ productId, delivery: "local", completedStages: [] }));
    shared.activeProductId = "product";
    shared.activeProductId = "other";
    expect(await ids("task.list", { productId: "product", taskId: sharedId, states: ["queued"], held: true, search: "SHARED" })).toEqual([sharedId]);
    expect(await ids("task.list", { productId: "other", held: false })).toEqual([otherId]);
    expect(await ids("task.list", { productId: "other", taskId })).toEqual([]);
    expect(await ids("task.list", { productId: "other", states: ["backlog"] })).toEqual([]);
    e.s.inbox.push(
      { id: "shared-request", taskId: sharedId, kind: "question", title: "Shared question", body: "Details", at: 1, blocking: true },
      { id: "first-request", taskId, kind: "permission", title: "First permission", body: "Details", at: 2, blocking: true },
      { id: "other-request", taskId: otherId, kind: "permission", title: "Other permission", body: "Details", at: 3, blocking: true },
    );
    expect(await ids("inbox.list", { productId: "product" })).toEqual(["first-request", "shared-request"]);
    expect(await ids("inbox.list", { productId: "other" })).toEqual(["other-request", "shared-request"]);
    expect(await ids("inbox.list", { productId: "other", taskId: sharedId, kinds: ["question"], blocking: true, search: "SHARED" })).toEqual(["shared-request"]);
    expect(await ids("inbox.list", { productId: "other", taskId })).toEqual([]);
    e.s.inbox = e.s.inbox.map((item) => ({ ...item, kind: "learnings", blocking: false }));
    Object.assign(shared, { state: "done", column: "done", finishedAt: 200 });
    Object.assign(other, { state: "cancelled", column: "done", finishedAt: 100 });
    e.save();
    expect(e.activeState().tasks.map((task) => task.id)).toEqual([taskId]);
    e.getState = () => { throw new Error("A product filter must not reconstruct history"); };
    e.store.history.all = () => { throw new Error("A product filter must not load the archive"); };
    const readBody = e.store.history.get.bind(e.store.history);
    try {
      e.store.history.get = () => { throw new Error("A product filter must only read history summaries"); };
      expect(await ids("task.history", { productId: "product" })).toEqual([sharedId]);
      expect(await ids("task.history", { productId: "other" })).toEqual([otherId, sharedId].sort());
      expect((await c.call("task.history", {})).total).toBe(2);
      expect(await ids("task.history", { productId: "other", taskId: sharedId, states: ["done"], held: true, search: "sha tra" })).toEqual([sharedId]);
      expect(await ids("task.history", { productId: "other", states: ["cancelled"], held: false })).toEqual([otherId]);
      expect(await ids("task.history", { productId: "product", taskId: otherId })).toEqual([]);
      expect(await ids("inbox.list", { productId: "product" })).toEqual(["first-request", "shared-request"]);
      expect(await ids("inbox.list", { productId: "other" })).toEqual(["other-request", "shared-request"]);
      expect(await ids("inbox.list", { productId: "other", taskId: sharedId, kinds: ["learnings"], blocking: false, search: "SHARED" })).toEqual(["shared-request"]);
      expect(await ids("inbox.list", { productId: "product", taskId: otherId })).toEqual([]);
      expect((await c.call("inbox.list", { taskId: "missing" })).outcome).toBe("missing");
    } finally { e.store.history.get = readBody; }
  });
});
