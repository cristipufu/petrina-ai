import { expect, it } from "bun:test";
import { finish, git, makeWorld, removeDir, remoteRef, taskOf } from "../../support.js";
import { plantedGitProgram } from "../../fixtures/git-program.js";
import { unsafeGitSettings } from "../../fixtures/git-safety.js";

it("refuses to fetch or publish once unsafe settings are planted after setup, and runs none of them", async () => {
  const w = await makeWorld("planted");
  const program = plantedGitProgram(w.dir, "evil");
  const engine = w.start();
  try {
    const productId = await engine.addProduct(w.clone);
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
    removeDir(w.dir);
  }
});
