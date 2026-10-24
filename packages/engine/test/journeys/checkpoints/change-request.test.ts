import { expect, it } from "bun:test";
import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";

it("refuses a change request for a check that is no longer waiting, so the window keeps the note", async () => {
  const dir = tempDir("petrina-changes-");
  let engine: Engine | undefined;
  try {
    engine = new Engine(dir);
    expect(() => engine!.requestChanges("inbox-gone", "Make it friendlier")).toThrow("isn't waiting any more");
  } finally {
    await engine?.shutdown();
    removeDir(dir);
  }
});
