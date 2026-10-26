import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { basename, dirname } from "node:path";
import { rejectionOf } from "@petrina/test-support/rejections";
import { releaseVersionFixtures } from "../../fixtures/release-versions.js";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import type { Engine } from "../../engine.js";

function contains(error: unknown, expected: unknown): boolean {
  return error === expected || error instanceof AggregateError && error.errors.some(part => contains(part, expected));
}

it("owns a release world's failed native copy before handing the fixture back", async () => {
  const fixtures = releaseVersionFixtures(), failure = new Error("The private clone could not be copied");
  const copy = fs.cpSync;
  let spy: ReturnType<typeof spyOn<typeof fs, "cpSync">> | undefined, root: string | undefined, handedBack = false;
  try {
    spy = spyOn(fs, "cpSync");
    spy.mockImplementation((source, destination, options) => {
      if (basename(String(destination)) === "clone" && basename(dirname(String(destination))).startsWith("petrina-release-setup-rejection-")) {
        root = dirname(String(destination));
        throw failure;
      }
      return copy(source, destination, options);
    });
    const error = await rejectionOf(fixtures.world("setup-rejection", {}, async () => { handedBack = true; }));
    expect(contains(error, failure)).toBe(true);
    expect(handedBack).toBe(false);
    expect(root).toBeDefined();
    expect(fs.statSync(root!).isDirectory()).toBe(true);
    expect(contains(await rejectionOf(fixtures.close()), failure)).toBe(true);
  } finally {
    try { spy?.mockRestore(); }
    finally { if (root) removeFixtureRoot(root); }
  }
});

it("stops the actual release Engine after a body rejection and preserves that failure", async () => {
  const fixtures = releaseVersionFixtures(), failure = new Error("The release assertion failed");
  let current: Engine | undefined, root: string | undefined;
  try {
    const error = await rejectionOf(fixtures.world("body-rejection", {}, async fixture => {
      root = fixture.world.dir;
      await fixture.engine(async engine => { current = engine; throw failure; });
    }));
    expect(contains(error, failure)).toBe(true);
    expect(current).toBeDefined();
    expect(current!.stopped).toBe(true);
    expect(fs.statSync(root!).isDirectory()).toBe(true);
    expect(contains(await rejectionOf(fixtures.close()), failure)).toBe(true);
  } finally {
    // This control intentionally owns a rejected operation. Confirm the actual Engine's shutdown
    // separately before removing its deliberately retained root; never infer it from the flag.
    await current?.shutdown();
    if (root) removeFixtureRoot(root);
  }
});

it("rejects a late release Engine start after the case owner has closed", async () => {
  const fixtures = releaseVersionFixtures();
  let late: (() => Promise<void>) | undefined, root: string | undefined, ran = false;
  try {
    await fixtures.world("late-start", {}, async fixture => {
      root = fixture.world.dir;
      late = () => fixture.engine(async () => { ran = true; });
    });
    expect(root).toBeDefined();
    const lookup = await rejectionOf(Promise.resolve().then(() => fs.lstatSync(root!)));
    expect((lookup as NodeJS.ErrnoException).code).toBe("ENOENT");
    const error = await rejectionOf(late!());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("closing; no Engine may open");
    await fixtures.close();
    const later = await rejectionOf(fixtures.world("after-close", {}, async () => { ran = true; }));
    expect(later).toBeInstanceOf(Error);
    expect((later as Error).message).toContain("closing; no new world may start");
    expect(ran).toBe(false);
  } finally { await fixtures.close(); }
});
