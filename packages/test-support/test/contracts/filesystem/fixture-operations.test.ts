import { expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDir, tempDir } from "../../../src/fixtures.js";
import { fixtureOperationControl, flushOperations } from "../../fixtures/fixture-operations.js";

it("retains the real private folder until an operation omitted by stop finishes its actual final write", async () => {
  const root = tempDir("petrina-fixture-operations-"), file = join(root, "unwound"), release = Promise.withResolvers<void>(), f = fixtureOperationControl();
  let closed = false, disposedText: string | undefined;
  f.effects.disposeEffect = () => {
    disposedText = readFileSync(file, "utf8");
    removeDir(root);
    if (existsSync(root)) throw new Error("The actual private fixture folder remains");
  };
  const running = f.owner.run(async () => { await release.promise; writeFileSync(file, "The owned operation actually settled"); });
  const closing = f.owner.close().then(() => { closed = true; });
  try {
    await flushOperations();
    expect(f.effects.events).toEqual(["stop"]); expect(existsSync(root)).toBe(true); expect(closed).toBe(false);
    expect(existsSync(file)).toBe(false);
    release.resolve(); await Promise.all([running, closing]);
    expect(disposedText).toBe("The owned operation actually settled"); expect(existsSync(root)).toBe(false); expect(closed).toBe(true);
    expect(f.effects.timers.size).toBe(0);
  } finally { release.resolve(); await Promise.allSettled([running, closing]); removeDir(root); }
});
