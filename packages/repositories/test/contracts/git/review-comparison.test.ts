import { afterAll, expect, it, spyOn } from "bun:test";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, CLEANUP_MS } from "@petrina/test-support/commands";
import { tempDir } from "@petrina/test-support/fixtures";
import { headNow } from "@petrina/test-support/repository-head";
import { repositorySeed } from "@petrina/test-support/repositories";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { SLOW } from "@petrina/test-support/slow";
import { expectRejection } from "@petrina/test-support/rejections";
import { run } from "../../../src/git.js";
import { EXCLUDE_LOCKS, ONLY_LOCKS, readReviewComparison } from "../../../src/review-comparison.js";

const root = tempDir("petrina-review-packets-");
registerFixtureRoot(root);
const owner = new FixtureOperations({ label: `Review comparisons at ${root}`, stop() {},
  dispose: () => rmSync(root, { recursive: true, force: true }), allowanceMs: CLEANUP_MS * SLOW,
  arm: (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); } });
afterAll(() => owner.close());

for (const format of ["sha1", "sha256"] as const) it(`batches ${format} review reads without losing literal paths, lockfiles, renames or binary changes`, () => owner.run(async () => {
  const folder = join(root, format); mkdirSync(folder);
  const seed = await repositorySeed(undefined, false, format);
  const repo = join(folder, "repo");
  cpSync(seed.clone, repo, { recursive: true });
  const base = seed.head;
  const name = process.platform === "win32" ? "space ü.txt" : "line\n\tü.txt";
  const commit = async () => { await git(repo, "add", "-A"); await git(repo, "commit", "-qm", "Prepare comparison"); };
  const legacy = async (from: string, files?: string[]) => {
    const range = `${from}...HEAD`, selected = files?.map(file => `:(literal)${file}`) ?? ["."];
    const read = async (flags: string[], paths: string[]) => {
      const result = await run(["git", "diff", "--no-ext-diff", ...flags, range, "--", ...paths], repo, undefined, { rawOutput: true });
      expect(result.code).toBe(0); return result.stdout;
    };
    return { stat: await read(["--stat"], selected),
      patch: await read(["--no-textconv", "--no-color"], [...selected, ...EXCLUDE_LOCKS]),
      locks: await read(["--no-textconv", "--no-color"], files ? files.filter(file => file.endsWith("/bun.lock") || file === "bun.lock").map(file => `:(literal)${file}`) : ONLY_LOCKS) };
  };
  const measured = async (from: string, expectedCalls: number, files?: string[]) => {
    const native = Bun.spawn; let calls = 0;
    const watch = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      if (args[0][0] === "git" && args[1]?.cwd === repo) calls++;
      return Reflect.apply(native, Bun, args);
    }) as typeof Bun.spawn);
    try { const result = await readReviewComparison(repo, `${from}...HEAD`, files); expect(calls).toBe(expectedCalls); return result; }
    finally { watch.mockRestore(); }
  };
  writeFileSync(join(repo, name), "first\n");
  writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 255, 42]));
  await commit();
  expect(await measured(base, 1)).toEqual(await legacy(base));
  const first = headNow(repo);
  await git(repo, "mv", name, "renamed.txt");
  await commit();
  expect(await measured(first, 1)).toEqual(await legacy(first));
  expect(await measured(headNow(repo), 1)).toEqual({ stat: "", patch: "", locks: "" });
  expect(await measured(base, 0, [])).toEqual({ stat: "", patch: "", locks: "" });
  mkdirSync(join(repo, "nested"));
  writeFileSync(join(repo, "nested", "bun.lock"), "lock v1\n");
  writeFileSync(join(repo, "renamed.txt"), "second\n");
  await commit();
  expect(await measured(base, 3)).toEqual(await legacy(base));
  expect(await measured(base, 3, ["nested/bun.lock", "renamed.txt"])).toEqual(
    await legacy(base, ["nested/bun.lock", "renamed.txt"]),
  );
  const locked = headNow(repo);
  await git(repo, "mv", "nested/bun.lock", "ordinary.txt");
  await commit();
  expect(await measured(locked, 3)).toEqual(await legacy(locked));
  const module = join(repo, "module");
  cpSync(seed.clone, module, { recursive: true });
  writeFileSync(join(repo, ".gitmodules"), '[submodule "module"]\n\tpath = module\n\turl = ./module\n');
  await commit();
  const linked = headNow(repo);
  writeFileSync(join(module, "nested.txt"), "Nested change\n");
  await git(module, "add", "."); await git(module, "commit", "-qm", "Changed nested content");
  await commit();
  for (const mode of ["log", "diff", "short"]) {
    await git(repo, "config", "diff.submodule", mode);
    const expected = await legacy(linked);
    if (mode === "log") expect(expected.patch.startsWith("Submodule ")).toBe(true);
    expect(await measured(linked, 1)).toEqual(expected);
  }
  await expectRejection(readReviewComparison(repo, "missing...HEAD"), "Could not prepare");
}));
