import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coordinator, git, itemOf, removeDir, taskOf, until, type World } from "../../support.js";
import { sharedWorld } from "../../fixtures/shared-world.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const setup = (name: string) => sharedWorld(name, worlds);

describe.concurrent("one task across products", () => {
  it("retains a coordinator row omitted by the planner until the coordinator removes it", async () => {
    const { shop, api, start, fakes } = await setup("omitted"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const worksOn = [first, second].map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "pull-request" as const }));
      fakes.scenario({ planner: "short", builder: "plain", worksOn: [worksOn[0]!] });
      const id = engine.addTask({ productId: first, worksOn, title: "Keep my choices", approveDelivery: false });
      const state = await until(engine, (state) => !!itemOf(state, id, "plan"), coordinator([]));
      expect(taskOf(state, id).workRows).toHaveLength(2);
      expect(taskOf(state, id).workRows![1]!.change).toBe("omitted");
      expect(taskOf(state, id).workRows![1]!.choice.startFrom).toEqual({ kind: "default" });
      expect(taskOf(state, id).approveDelivery).toBe(false);
      await engine.setTaskProducts(id, [worksOn[0]!]);
      expect(taskOf(engine.getState(), id).workRows).toHaveLength(1);
      expect(taskOf(engine.getState(), id).approveDelivery).toBe(false);
    } finally { await engine.shutdown(); }
  });

  for (const saved of ["approved", "approved SSH", "other repository", "other GitHub repository", "no origin", "empty other repository"] as const) it(`checks the saved clone's remote before retrying an addition with ${saved}`, async () => {
    const { shop, api, remotes, start } = await setup(`clone-identity-${saved.replaceAll(" ", "-")}`);
    if (saved === "approved SSH" || saved === "other GitHub repository") delete (remotes as Record<string, string>)["acme/api"];
    const engine = start({ remote: undefined }); engine.setPoolPaused(true);
    await engine.waitUntilReady();
    const products = engine.s.products, sources = engine["sources"];
    products.push({ id: "pending", name: "Original", repo: "acme/demo", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "pending", title: "Validate an approved clone", backlog: true }))!;
    try {
    const folder = join(shop.dir, "saved-addition");
    if (saved === "empty other repository") {
      await git(shop.dir, "init", "-q", "--initial-branch=main", folder);
      await git(folder, "remote", "add", "origin", shop.remote);
    } else {
      await git(shop.dir, "clone", "-q", saved === "other repository" ? shop.remote : api.remote, folder);
      if (saved === "no origin") await git(folder, "remote", "remove", "origin");
      if (saved === "approved SSH" || saved === "other GitHub repository") await git(folder, "remote", "set-url", "origin", saved === "approved SSH" ? "git@github.com:acme/api.git" : "https://github.com/other/repository.git");
    }
    writeFileSync(join(folder, ".git", "keep.txt"), "Keep this repository metadata");
    const before = await git(folder, "config", "--local", "--list");
    task.workRows = [{ choice: { productId: "addition", repo: "acme/api", startFrom: { kind: "default" }, delivery: "pull-request" }, source: { product: { id: "addition", name: "API", repo: "acme/api", path: folder, defaultBranch: "main", remote: "https://github.com/acme/api.git" }, start: { kind: "default", branch: "main" }, destination: { kind: "new-pr", mode: "pull-request", repo: "acme/api", branch: "main" }, confirmed: true }, addition: { productId: "addition", name: "API", path: folder, created: true } }];
    const add = () => sources.addApproved(task, "addition", new AbortController().signal);
    if (saved === "approved" || saved === "approved SSH") {
      await add();
      expect(task.workRows![0]!.addition!.ready).toBe(true);
      expect(products.some((product) => product.id === "addition")).toBe(true);
    } else {
      await expectRejection(add(), "different repository. Change folder");
      expect(task.workRows![0]!.addition!.ready).not.toBe(true);
      expect(products.some((product) => product.id === "addition")).toBe(false);
    }
    expect(await git(folder, "config", "--local", "--list")).toBe(before);
    expect(existsSync(join(folder, ".git", "keep.txt"))).toBe(true);
    } finally { await engine.shutdown(); }
  });
});
