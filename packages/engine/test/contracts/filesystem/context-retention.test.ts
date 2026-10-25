import { expectRejection } from "@petrina/test-support/rejections";
import { expect, it } from "bun:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cleanup } from "../../../src/cleanup.js";
import { removeDir, tempDir } from "../../support.js";
import { Engine } from "../../engine.js";

it("removes terminal and orphaned context packets while retaining an unfinished task's fallback", async () => {
  const dir = tempDir("petrina-builder-context-cleanup-");
  const world = { dir, data: join(dir, "data") };
  const engine = new Engine(world.data, { admissionsClosed: true });
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
  } finally { await engine.shutdown(); removeDir(world.dir); }
});
