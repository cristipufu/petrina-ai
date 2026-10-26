import { afterEach, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { completeAll } from "@petrina/core";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { tempDir } from "@petrina/test-support/fixtures";
import { directDrivers, closeDirectDrivers } from "../../fixtures/direct-drivers.js";
import { installPreparedProduct, type PreparedProduct } from "../../fixtures/prepared-product.js";
import { makeWorld } from "../../support.js";

const fixtures = new Set<ReturnType<typeof directDrivers>>();
afterEach(async () => { await closeDirectDrivers(fixtures); fixtures.clear(); });

for (const format of ["sha1", "sha256"] as const) it(`prepares known ${format} product records without discovery, matching the actual API and durable history`, async () => {
  const root = tempDir("petrina-prepared-products-"), owner = directDrivers(root);
  fixtures.add(owner);
  await setupWithCleanup(() => owner.prepare(async () => {
    const [shop, api] = await completeAll([
      makeWorld("prepared-shop", { objectFormat: format, owner: { root: join(root, "shop"), open: (data, options) => owner.open(data, options) } }),
      makeWorld("prepared-api", { objectFormat: format, address: "https://github.com/acme/api.git", owner: { root: join(root, "api"), open: (data, options) => owner.open(data, options) } }),
    ]);
    if (!shop || !api) throw new Error("Both actual private product recipes are required");
    const actual = owner.open(join(root, "actual-data"), { agentCommand: () => undefined });
    const expected = await owner.run(actual, async () => {
      await actual.waitUntilReady(); actual.setPoolPaused(true);
      expect(await actual.addProduct(shop.clone)).toBe("demo");
      expect(await actual.addProduct(api.clone, "API")).toBe("api");
      expect(actual.tracking.log.productIdTaken("demo")).toBe(true);
      expect(actual.tracking.log.productIdTaken("api")).toBe(true);
      return structuredClone(actual.s.products);
    });
    await owner.stop(actual);
    const data = join(root, "prepared-data"), prepared = owner.open(data, { agentCommand: () => undefined });
    const recipes: PreparedProduct[] = [
      { id: "demo", name: "Clone", repo: "acme/demo", tone: "blue", path: shop.clone,
        remote: "https://github.com/acme/demo.git", defaultBranch: "main", delivery: "pull-request", approveDelivery: true },
      { id: "api", name: "API", repo: "acme/api", tone: "green", path: api.clone,
        remote: "https://github.com/acme/api.git", defaultBranch: "main", delivery: "pull-request", approveDelivery: true },
    ];
    let watch: ReturnType<typeof spyOn<typeof Bun, "spawn">> | undefined;
    const restore = () => { watch?.mockRestore(); };
    await setupWithCleanup(() => owner.run(prepared, async () => {
      await prepared.waitUntilReady(); prepared.setPoolPaused(true);
      await Promise.all([...prepared.backgroundWork]);
      let reads = 0;
      const native = Bun.spawn, clones = recipes.map(recipe => fixtureFiles.canonical(recipe.path));
      watch = spyOn(Bun, "spawn");
      watch.mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        if (args[0][0] === "git" && clones.includes(String(args[1]?.cwd))) reads++;
        return Reflect.apply(native, Bun, args);
      }) as typeof Bun.spawn);
      expect(recipes.map(recipe => installPreparedProduct(prepared, recipe))).toEqual(["demo", "api"]);
      expect(reads).toBe(0);
      expect(prepared.s.products).toEqual(expected);
      expect(prepared.s.products.every(product => product.checks === undefined && product.checkSetup === undefined)).toBe(true);
      expect(() => installPreparedProduct(prepared, recipes[0]!)).toThrow("already in use");
      expect(prepared.tracking.log.productIdTaken("demo")).toBe(true);
      expect(prepared.tracking.log.productIdTaken("api")).toBe(true);
    }), restore);
    restore();
    await owner.stop(prepared);
    const restarted = owner.open(data, { agentCommand: () => undefined });
    await owner.run(restarted, async () => {
      await restarted.waitUntilReady();
      expect(restarted.s.products).toEqual(expected);
      expect(restarted.tracking.log.productIdTaken("demo")).toBe(true);
      expect(restarted.tracking.log.productIdTaken("api")).toBe(true);
    });
    await owner.stop(restarted);
  }), () => owner.close());
  await owner.close(); fixtures.delete(owner);
});
