import { afterAll, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fakes, git, tempDir } from "../../fixtures.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { roots, signal, fixture, testerSteps, close } = proofRequestFixtures();
afterAll(close);
for (const converted of [false, true]) for (const committed of [false, true]) it(`restores the file behind an undone ${committed ? "commit" : "tracked edit"} ${converted ? "with the line endings its repository converts to" : "exactly as written"}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-line-endings-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const worktree = f.scope.work.worktree!, edited = join(worktree, "tester-edit.txt");
    // The task's linked working copy shares the product's settings.
    if (converted) await git(f.products[0]!.path!, "config", "core.autocrlf", "true");
    writeFileSync(edited, "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    f.task.stageIndex = 1;
    fakes.scenario({ testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Changed during acceptance\n", commit: committed }] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(testerSteps(f).at(-1)!.proofRun!.restored!.products).toEqual([{ productId: f.task.productId, ...(committed ? { commits: true } : { edits: true }), files: ["tester-edit.txt"] }]);
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    const restored = readFileSync(edited, "utf8"), expected = converted ? "Saved before acceptance\r\n" : "Saved before acceptance\n";
    // Bun's diff shows both line endings alike: the escaped text gets a line of its own.
    if (restored !== expected) console.error(`Restored ${JSON.stringify(restored)} where ${JSON.stringify(expected)} was expected`);
    expect(restored).toBe(expected);
  } finally { await f.engine.shutdown(); }
});
