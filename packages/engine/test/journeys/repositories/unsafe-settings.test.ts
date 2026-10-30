import { afterAll, expect, it } from "bun:test";
import { finish, git, remoteRef, taskOf } from "../../support.js";
import { nativeWorldFixtures } from "../../fixtures/native-worlds.js";
import { installPreparedProduct, acmeDemoProduct } from "../../fixtures/prepared-product.js";
import { plantedGitProgram } from "@petrina/test-support/git-program";
import { unsafeGitSettings } from "@petrina/test-support/git-safety";

const fixtures = nativeWorldFixtures();
afterAll(fixtures.close);

it("refuses to fetch or publish once unsafe settings are planted after setup, and runs none of them", async () => {
  await fixtures.world("planted", async ({ world: w, engine: ownedEngine }) => {
  const program = plantedGitProgram(w.dir, "evil");
  await ownedEngine(async engine => {
  try {
    await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
    const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
    engine.setProductDelivery(productId, "pull-request", false);
    // The native adapter tests cover all seven settings; this journey proves task failure and warning routing.
    const { key, configure } = unsafeGitSettings[0]!;
    const setting = configure(w.dir, program.command);
    await git(w.clone, "config", ...setting);
    const taskId = engine.addTask({ productId, title: `Planted ${key}`, description: "A greeting file. [quick]" });
    const task = taskOf(await finish(engine, taskId), taskId);
    expect(task.state).toBe("failed");
    expect(task.error).toContain("could not get the latest main from GitHub (the repository's git settings include");
    expect(task.error).toContain(key);
    expect(task.timeline.some((entry) => entry.tone === "warn" && entry.text.includes("could misuse your GitHub login"))).toBe(true);
    expect(await remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();
    await git(w.clone, "config", "--unset-all", setting[0]!);
    engine.cancel(taskId);
    expect(program.marks()).toEqual([]);
    expect(w.github().calls).toEqual([]);
  } finally {
    await engine.shutdown();
  }
  });
  });
});
