import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";
import { expect, it } from "bun:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cleanup } from "../../../src/cleanup.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


it("removes terminal and orphaned context packets while retaining an unfinished task's fallback", async () => {
  return cases.use("petrina-builder-context-cleanup-", async owner => {
  const dir = owner.root;
  const world = { dir, data: join(dir, "data") };
  const engine = owner.open(world.data, { admissionsClosed: true });
  try {
    engine.setPoolPaused(true);
    const productId = "product";
    engine.s.products.push({ id: productId, name: "Product", repo: "local/product", tone: "blue" });
    const active = engine.addTask({ productId, title: "An unfinished builder", backlog: true });
    const finished = engine.addTask({ productId, title: "A finished builder", backlog: true });
    engine.task(finished)!.state = "done";
    engine.commitNow();
    for (const id of [active, finished, "orphaned-context"]) {
      await mkdir(join(world.data, "contexts", id), { recursive: true });
      await writeFile(join(world.data, "contexts", id, "context.md"), "Authoritative context");
    }
    await new Cleanup(engine).sweep();
    expect(await readFile(join(world.data, "contexts", active, "context.md"), "utf8")).toBe("Authoritative context");
    await expectRejection(access(join(world.data, "contexts", finished)));
    await expectRejection(access(join(world.data, "contexts", "orphaned-context")));
  } finally { await owner.stop(engine); }

  });
});
