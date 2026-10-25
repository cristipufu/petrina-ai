import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { checkContext } from "../../fixtures/check-context.js";
import { git, removeDir, tempDir } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("tells acceptance testing whether saved checks really cover the code and required commands", async () => {
  const root = tempDir("check-evidence-context-"); roots.push(root);
  const f = await checkContext(root);
  try {
    f.setCheck("--pass");
    await f.check();
    const task = f.engine.task(f.taskId)!;
    const saved = structuredClone(executionFor(task).work.checks!);
    const evidence = async () => (await f.engine["context"].sectionsFor(executionFor(task), "tester")).find((section) => section.title.includes("product checks"));
    expect(await evidence()).toEqual(expect.objectContaining({ title: "Current product checks, run by Petrina itself", body: expect.stringContaining("do not rerun the full checks") }));

    writeFileSync(join(executionFor(task).work.worktree!, "greeting.txt"), "Uncommitted change\n");
    expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
    await git(executionFor(task).work.worktree!, "add", "greeting.txt");
    await git(executionFor(task).work.worktree!, "commit", "-q", "-m", "A real change");
    expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
    await git(executionFor(task).work.worktree!, "reset", "--hard", saved.sha!);
    expect((await evidence())?.title).toBe("Current product checks, run by Petrina itself");

    f.setCheck("--pass", "--changed");
    expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
    f.setCheck("--pass");
    executionFor(task).work.checks!.results = [{ ...saved.results[0]!, ok: false, timedOut: true }];
    expect((await evidence())?.body).toContain("not passing acceptance evidence");
    expect((await evidence())?.body).not.toContain("Use them for automated acceptance");
    executionFor(task).work.checks!.results = [];
    expect(await evidence()).toBeUndefined();
    executionFor(task).work.checks = structuredClone(saved);
    f.engine.setProductChecks(f.productId, [
      { name: "Welcome", command: f.command("--pass") },
      { name: "Extra", command: f.command("--pass", "--extra") },
    ]);
    expect((await evidence())?.title).toBe("Historical product checks, run by Petrina itself");
    // Building context reads evidence; it never runs checks to make the evidence current.
    expect(f.runs()).toEqual(["passed"]);
  } finally { await f.engine.shutdown(); }
});
