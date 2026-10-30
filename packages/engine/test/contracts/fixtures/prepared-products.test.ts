import { afterEach, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { completeAll } from "@petrina/core";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { tempDir } from "@petrina/test-support/fixtures";
import { directDrivers, closeDirectDrivers } from "../../fixtures/direct-drivers.js";
import { installPreparedProduct, privateCloneProduct, type PreparedProduct } from "../../fixtures/prepared-product.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { makeWorld } from "../../support.js";
import { makeProduct } from "@petrina/test-support/repositories";

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
    const probe = privateAgentToolProbe();
    const actual = owner.open(join(root, "actual-data"), { agentCommand: () => undefined, toolProbe: probe });
    const expected = await owner.run(actual, async () => {
      await actual.waitUntilReady(); actual.setPoolPaused(true);
      expect(await actual.addProduct(shop.clone)).toBe("demo");
      expect(await actual.addProduct(api.clone, "API")).toBe("api");
      expect(actual.tracking.log.productIdTaken("demo")).toBe(true);
      expect(actual.tracking.log.productIdTaken("api")).toBe(true);
      return structuredClone(actual.s.products);
    });
    await owner.stop(actual);
    const data = join(root, "prepared-data"), prepared = owner.open(data, { agentCommand: () => undefined, toolProbe: probe });
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
    const restarted = owner.open(data, { agentCommand: () => undefined, toolProbe: probe });
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


for (const format of ["sha1", "sha256"] as const) it(`calibrates declared ${format} local catalog recipes against real discovery and durable restart`, async () => {
  const root = tempDir(`petrina-prepared-local-${format}-`), owner = directDrivers(root); fixtures.add(owner);
  await setupWithCleanup(() => owner.prepare(async () => {
    const path = await makeProduct(join(root, "product"), { origin: "none", objectFormat: format });
    const privatePath = await makeProduct(join(root, "private-product"), { objectFormat: format });
    const probe = privateAgentToolProbe();
    const actual = owner.open(join(root, "actual-data"), { agentCommand: () => undefined, toolProbe: probe });
    const expected = await owner.run(actual, async () => {
      await actual.waitUntilReady(); actual.setPoolPaused(true);
      expect(await actual.addProduct(path, "Local product")).toBe("clone");
      expect(Object.hasOwn(actual.s.products[0]!, "remote")).toBe(false);
      expect(await actual.addProduct(privatePath, "Private copy")).toBe("clone-2");
      return structuredClone(actual.s.products);
    });
    await owner.stop(actual);
    const data = join(root, "prepared-data"), prepared = owner.open(data, { agentCommand: () => undefined, toolProbe: probe });
    await owner.run(prepared, async () => {
      await prepared.waitUntilReady(); prepared.setPoolPaused(true); await Promise.all([...prepared.backgroundWork]);
      const native = Bun.spawn;
      let calls = 0;
      const watch = spyOn(Bun, "spawn");
      try {
        watch.mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
          if (args[0][0] === "git" && [path, privatePath].includes(String(args[1]?.cwd))) calls++;
          return Reflect.apply(native, Bun, args);
        }) as typeof Bun.spawn);
        expect(installPreparedProduct(prepared, { id: "clone", name: "Local product", repo: "local/clone", tone: "blue", path,
          defaultBranch: "main", delivery: "local", approveDelivery: true })).toBe("clone");
        expect(installPreparedProduct(prepared, { ...privateCloneProduct(privatePath), id: "clone-2", name: "Private copy", tone: "green" })).toBe("clone-2");
        expect(calls).toBe(0);
      } finally { watch.mockRestore(); }
      expect(prepared.s.products).toEqual(expected);
      expect(prepared.tracking.log.productIdTaken("clone")).toBe(true);
      expect(prepared.tracking.log.productIdTaken("clone-2")).toBe(true);
      expect(prepared.s.products[0]!.checks).toBeUndefined(); expect(prepared.s.products[0]!.checkSetup).toBeUndefined();
    });
    await owner.stop(prepared);
    const reopened = owner.open(data, { agentCommand: () => undefined, toolProbe: probe });
    await owner.run(reopened, async () => {
      await reopened.waitUntilReady();
      expect(reopened.s.products).toEqual(expected);
      expect(reopened.tracking.log.productIdTaken("clone")).toBe(true);
      expect(reopened.tracking.log.productIdTaken("clone-2")).toBe(true);
    });
    await owner.stop(reopened);
  }), () => owner.close());
  await owner.close(); fixtures.delete(owner);
});
