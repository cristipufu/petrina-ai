import { afterAll, expect, it, spyOn } from "bun:test";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll } from "@petrina/core";
import { git, CLEANUP_MS } from "@petrina/test-support/commands";
import { tempDir } from "@petrina/test-support/fixtures";
import { headNow } from "@petrina/test-support/repository-head";
import { repositorySeed } from "@petrina/test-support/repositories";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { SLOW } from "@petrina/test-support/slow";
import { run, tamperCheck } from "../../../src/git.js";

const root = tempDir("petrina-tamper-packets-");
registerFixtureRoot(root);
const owner = new FixtureOperations({ label: `Tamper packets at ${root}`, stop() {},
  dispose: () => removeFixtureRoot(root), allowanceMs: CLEANUP_MS * SLOW,
  arm: (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); } });
afterAll(() => owner.close());

for (const format of ["sha1", "sha256"] as const) it(`preserves the ${format} tamper observations in one native diff instead of two`, () => owner.run(async () => {
  const folder = join(root, format); mkdirSync(folder);
  const seed = await repositorySeed(undefined, false, format), repo = join(folder, "repo");
  cpSync(seed.clone, repo, { recursive: true }); mkdirSync(join(repo, "tests"));
  const odd = process.platform === "win32" ? "space ü.test.ts" : "line\n\tü.test.ts";
  const original = Array.from({ length: 30 }, (_, index) => `Original line ${index}\n`).join("");
  writeFileSync(join(repo, "rename.test.ts"), original);
  writeFileSync(join(repo, "copy.test.ts"), original + "Copy source\n");
  writeFileSync(join(repo, "tests", "binary.dat"), Buffer.from([0, 255, 42]));
  writeFileSync(join(repo, "tests", odd), "A test\n");
  writeFileSync(join(repo, "  leading.test.ts"), "A leading-space test\n");
  writeFileSync(join(repo, "changed.test.ts"), "it('first')\nit('second')\n");
  const commit = async () => {
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "Prepare tamper observations");
    return headNow(repo);
  };
  const base = await commit();
  await git(repo, "checkout", "-qb", "task");
  // The old two-command implementation is an independent native parity oracle, including its normalization.
  const legacy = async (from: string) => {
    const results = await completeAll([
      run(["git", "diff", "--no-ext-diff", "--name-only", "-z", "--diff-filter=D", `${from}...HEAD`], repo),
      run(["git", "diff", "--no-ext-diff", "--no-textconv", "--unified=0", `${from}...HEAD`], repo),
    ]);
    const problems: string[] = [];
    for (const file of results[0]!.stdout.split("\0").filter(Boolean)) {
      if (/(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$/i.test(file)) problems.push(`A test file was deleted: ${file}`);
    }
    let file = "";
    for (const line of results[1]!.stdout.split("\n")) {
      if (line.startsWith("+++ b/")) file = line.slice(6);
      else if (/^\+.*(\b(it|test|describe)\.(skip|only)\(|\bxit\(|\bxdescribe\(|@(Disabled|Ignore)\b|pytest\.mark\.skip|#\[ignore\]|\.todo\()/.test(line)) problems.push(`A test was skipped or narrowed in ${file}`);
    }
    return [...new Set(problems)];
  };
  const measured = async (read: () => Promise<string[]>, expected: number, refuseStart = false) => {
    const start = Bun.spawn; let calls = 0;
    const watch = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      if (args[0][0] === "git" && args[1]?.cwd === repo) { calls++; if (refuseStart) throw new Error("Supplied launch refusal"); }
      return Reflect.apply(start, Bun, args);
    }) as typeof Bun.spawn);
    try { const result = await read(); expect(calls).toBe(expected); return result; }
    finally { watch.mockRestore(); }
  };
  const compare = async (from: string) => {
    const expected = await measured(() => legacy(from), 2), actual = await measured(() => tamperCheck(repo, from), 1);
    expect(actual).toEqual(expected); return actual;
  };
  expect(await compare(base)).toEqual([]);

  await git(repo, "mv", "rename.test.ts", "renamed.test.ts");
  let previous = await commit();
  expect(await compare(base)).toEqual([]); // A pure rename is not a deletion.

  await git(repo, "config", "diff.renames", "copies");
  cpSync(join(repo, "copy.test.ts"), join(repo, "copied.test.ts"));
  writeFileSync(join(repo, "copy.test.ts"), original + "Copy source\nChanged the source\n");
  const copied = await commit();
  expect((await run(["git", "diff", "--raw", "-z", `${previous}...HEAD`], repo)).stdout).toContain(" C100\0");
  expect(await compare(previous)).toEqual([]);

  previous = copied;
  rmSync(join(repo, "tests", "binary.dat"));
  await commit();
  expect(await compare(previous)).toEqual(["A test file was deleted: tests/binary.dat"]);

  rmSync(join(repo, "tests", odd)); rmSync(join(repo, "  leading.test.ts"));
  writeFileSync(join(repo, "changed.test.ts"), "it.skip('first')\nit.only('second')\n");
  writeFileSync(join(repo, ".gitattributes"), "*.test.ts diff=forbidden\n");
  await git(repo, "config", "diff.forbidden.textconv", "a-text-converter-that-must-never-run");
  const current = await commit();
  // Advancing the named starting branch cannot replace the caller's pinned comparison base.
  await git(repo, "update-ref", "refs/heads/main", current);
  const problems = await compare(base);
  expect(problems).toContain("A test file was deleted: leading.test.ts");
  expect(problems).toContain(`A test file was deleted: tests/${odd}`);
  expect(problems).toContain("A test file was deleted: tests/binary.dat");
  expect(problems.filter(problem => problem === "A test was skipped or narrowed in changed.test.ts")).toHaveLength(1);
  expect(await compare("main")).toEqual([]);
  await git(repo, "config", "diff.renames", "false");
  expect(await compare(base)).toContain("A test file was deleted: rename.test.ts");
  expect(await compare("unavailable-ref")).toEqual([]); // Preserve the established command-error result.
  expect(await measured(() => legacy(base), 2, true)).toEqual([]);
  expect(await measured(() => tamperCheck(repo, base), 1, true)).toEqual([]);
  expect(existsSync(repo)).toBe(true);
}));
