import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLEANUP_MS, runCommand } from "@petrina/test-support/commands";
import { createTestRun } from "@petrina/test-support/environment";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { SLOW } from "@petrina/test-support/slow";

const runs = new Set<ReturnType<typeof createTestRun>>(), abort = new AbortController();
const owner = new FixtureOperations({
  label: "Repository seed workers", allowanceMs: CLEANUP_MS * SLOW,
  arm(expired, ms) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  stop() { abort.abort(); },
  dispose() { for (const run of runs) if (!run.close()) throw new Error("Repository workers retained fixture evidence"); },
});
afterAll(() => owner.close());
const repositories = JSON.stringify(import.meta.resolve("@petrina/test-support/repositories"));
const commands = JSON.stringify(import.meta.resolve("@petrina/test-support/commands"));
const environment = JSON.stringify(import.meta.resolve("@petrina/test-support/environment"));
const seedEnvironment = JSON.stringify(import.meta.resolve("../../../src/repository-seed-environment.js"));
const observer = `
  let gitLaunches = 0;
  const nativeSpawn = Bun.spawn.bind(Bun);
  Bun.spawn = (...args) => { if (args[0][0] === "git") gitLaunches++; return nativeSpawn(...args); };
  const { repositorySeed, makeProduct } = await import(${repositories});
  const { git } = await import(${commands});
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join, delimiter } = await import("node:path");
`;
const worker = <T>(env: NodeJS.ProcessEnv, body: string): Promise<T> => owner.run(async () => {
  const result = await runCommand([process.execPath, "-e", observer + body], { env, cwd: env.TMPDIR, signal: abort.signal, timeoutMs: 30_000 * SLOW });
  if (result.code !== 0) throw new Error(`Repository worker failed (${result.code}): ${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout) as T;
});
const withRun = (body: (env: NodeJS.ProcessEnv) => Promise<void>) => owner.run(async () => {
  const run = createTestRun(); runs.add(run);
  await body(run.env);
  if (!run.close()) throw new Error("Repository workers retained fixture evidence");
  runs.delete(run);
});

it("publishes one completed seed across workers, preserves it on worker exit, and copies private writable repositories", () => withRun(async env => {
  type Copy = { path: string; head: string; clone: string; calls: number };
  const outcomes = await Promise.allSettled(["first", "second"].map(name => worker<Copy>(env, `
    const pending = repositorySeed(undefined, true);
    if (pending !== repositorySeed(undefined, true)) throw new Error("Concurrent callers lost their shared preparation");
    const seed = await pending;
    const clone = await makeProduct(join(process.env.TMPDIR, ${JSON.stringify(name)}));
    ${name === "first" ? `writeFileSync(join(clone, "README.md"), "Only the first copy changes\\n");
    await git(clone, "add", "."); await git(clone, "commit", "-qm", "Private first copy");` : ""}
    console.log(JSON.stringify({ path: seed.path, head: seed.head, clone, calls: gitLaunches }));
  `)));
  const copies = outcomes.map(result => { if (result.status === "rejected") throw result.reason; return result.value; });
  const [first, second] = copies as [Copy, Copy];
  expect(first.path).toBe(second.path);
  expect(first.path.startsWith(env.PETRINA_TEST_REPOSITORY_SEEDS!)).toBe(true);
  expect(first.head).toBe(second.head);
  expect(first.calls + second.calls).toBeGreaterThan(0);
  expect(readFileSync(join(first.clone, "README.md"), "utf8")).toBe("Only the first copy changes\n");
  expect(readFileSync(join(second.clone, "README.md"), "utf8")).toBe("# Demo\n");
  const object = join(".git", "objects", first.head.slice(0, 2), first.head.slice(2));
  for (const file of [object, join(".git", "index"), join(".git", "config")]) {
    expect(statSync(join(first.clone, file)).ino).not.toBe(statSync(join(second.clone, file)).ino);
    expect(statSync(join(first.path, "clone", file)).ino).not.toBe(statSync(join(second.clone, file)).ino);
  }
  const reused = await worker<{ path: string; head: string; calls: number }>(env, `
    const seed = await repositorySeed(undefined, true);
    console.log(JSON.stringify({ path: seed.path, head: seed.head, calls: gitLaunches }));
  `);
  expect(reused).toEqual({ path: first.path, head: first.head, calls: 0 });
  expect(readdirSync(env.PETRINA_TEST_REPOSITORY_SEEDS!).filter(name => name.startsWith(".prepare-"))).toEqual([]);
  expect(readFileSync(join(first.path, "clone", "README.md"), "utf8")).toBe("# Demo\n");
}));

it("rechecks changed Git config, environment and PATH before reusing an earlier promise", () => withRun(async env => {
  const result = await worker<{ paths: string[]; lengths: number[]; samePromise: boolean; restored: boolean; calls: number[]; fallbackPromiseReused: boolean; fallbackPathReused: boolean; includedPaths: string[]; includedLengths: number[]; conditionalReusable: boolean }>(env, `
    const firstPromise = repositorySeed("configuration-control");
    const file = process.env.GIT_CONFIG_GLOBAL, original = readFileSync(file, "utf8");
    // Change the live file while the first preparation is still running. Its snapshot stays immutable.
    writeFileSync(file, original + "\\n[init]\\n defaultObjectFormat = sha256\\n");
    const first = await firstPromise, paths = [first.path], lengths = [first.head.length], calls = [gitLaunches];
    const changedPromise = repositorySeed("configuration-control"), changed = await changedPromise;
    paths.push(changed.path); lengths.push(changed.head.length); calls.push(gitLaunches);
    const repeatedFallback = repositorySeed("configuration-control"), repeated = await repeatedFallback;
    const fallbackPromiseReused = repeatedFallback === changedPromise, fallbackPathReused = repeated.path === changed.path;
    writeFileSync(file, original);
    const oldPath = process.env.PATH;
    process.env.PATH = oldPath + delimiter + process.env.TMPDIR;
    const changedPath = await repositorySeed("configuration-control"); paths.push(changedPath.path); calls.push(gitLaunches);
    process.env.PATH = oldPath;
    process.env.GIT_AUTHOR_NAME = "Different fixture author";
    const changedAuthor = await repositorySeed("configuration-control"); paths.push(changedAuthor.path); calls.push(gitLaunches);
    if (await git(join(changedAuthor.path, "source"), "show", "-s", "--format=%an") !== "Different fixture author") throw new Error("Changed author was ignored");
    delete process.env.GIT_AUTHOR_NAME;
    const included = join(process.env.TMPDIR, "included.gitconfig");
    writeFileSync(file, original + "\\n[include]\\n path = " + JSON.stringify(included) + "\\n");
    const includedPaths = [], includedLengths = [];
    for (const format of ["sha1", "sha256"]) {
      writeFileSync(included, "[init]\\n defaultObjectFormat = " + format + "\\n");
      const seed = await repositorySeed("included-control");
      includedPaths.push(seed.path); includedLengths.push(seed.head.length);
    }
    writeFileSync(file, original + "\\n[InClUdEiF \\"gitdir:**\\"]\\n path = " + JSON.stringify(included) + "\\n");
    const { repositorySeedEnvironment } = await import(${seedEnvironment});
    const conditionalReusable = repositorySeedEnvironment(process.env).identity !== undefined;
    writeFileSync(file, original);
    console.log(JSON.stringify({ paths, lengths, calls, fallbackPromiseReused, fallbackPathReused, includedPaths, includedLengths, conditionalReusable, samePromise: changedPromise === firstPromise, restored: repositorySeed("configuration-control") === firstPromise }));
  `);
  expect(new Set(result.paths).size).toBe(4);
  expect(result.paths[0]!.startsWith(env.PETRINA_TEST_REPOSITORY_SEEDS!)).toBe(true);
  for (const path of result.paths.slice(1)) expect(path.startsWith(env.PETRINA_TEST_REPOSITORY_SEEDS!)).toBe(false);
  expect(result.lengths).toEqual([40, 64]);
  expect(result.samePromise).toBe(false);
  expect(result.fallbackPromiseReused).toBe(false);
  expect(result.fallbackPathReused).toBe(false);
  expect(result.restored).toBe(true);
  expect(result.includedPaths[0]).not.toBe(result.includedPaths[1]);
  expect(result.includedPaths.every(path => !path.startsWith(env.PETRINA_TEST_REPOSITORY_SEEDS!))).toBe(true);
  expect(result.includedLengths).toEqual([40, 64]);
  expect(result.conditionalReusable).toBe(false);
  for (let index = 1; index < result.calls.length; index++) expect(result.calls[index]!).toBeGreaterThan(result.calls[index - 1]!);
}));

it("gives a nested runner its own seed cache and removes only that runner's published repositories", () => withRun(async env => {
  const result = await worker<{ parent: string; nested: string; closed: boolean; parentRemains: boolean; nestedRemains: boolean }>(env, `
    const parent = await repositorySeed("nested-control");
    const { createTestRun } = await import(${environment});
    const { runCommand } = await import(${commands});
    const nested = createTestRun();
    const result = await runCommand([process.execPath, "-e", ${JSON.stringify(`const { repositorySeed } = await import(${repositories}); console.log(JSON.stringify((await repositorySeed("nested-control")).path));`)}], { env: nested.env, cwd: nested.env.TMPDIR });
    if (result.code !== 0) throw new Error(result.stderr);
    const path = JSON.parse(result.stdout), closed = nested.close();
    console.log(JSON.stringify({ parent: parent.path, nested: path, closed, parentRemains: existsSync(parent.path), nestedRemains: existsSync(path) }));
  `);
  expect(result.parent).not.toBe(result.nested);
  expect(result.closed).toBe(true);
  expect(result.parentRemains).toBe(true);
  expect(result.nestedRemains).toBe(false);
  expect(existsSync(result.parent)).toBe(true);
}));
