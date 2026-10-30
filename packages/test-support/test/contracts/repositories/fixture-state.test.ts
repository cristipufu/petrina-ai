import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../src/commands.js";
import { headNow } from "../../../src/repository-head.js";
import { createProductRepository, makeProduct, repositorySeed } from "../../../src/repositories.js";
import { removeDir, tempDir } from "../../../src/fixtures.js";
import { rejectionOf } from "../../../src/rejections.js";
import { FixtureOperations } from "../../../src/fixture-operations.js";
import { registerFixtureRoot } from "../../../src/fixture-retention.js";
import { CLEANUP_MS } from "../../../src/command-budgets.js";
import { SLOW } from "../../../src/slow.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const copiesRoot = tempDir("petrina-private-origin-");
registerFixtureRoot(copiesRoot);
const copies = new FixtureOperations({ label: `Private origins at ${copiesRoot}`, stop() {},
  dispose: () => rmSync(copiesRoot, { recursive: true, force: true }), allowanceMs: CLEANUP_MS * SLOW,
  arm: (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); } });
afterAll(() => copies.close());

it("leaves no reusable seed or partial folder behind when preparing one fails, and prepares it afresh", async () => {
  // Git refuses an unknown object format, so this recipe's preparation fails.
  const broken = "sha999" as "sha1";
  const folderOf = (error: unknown) => /starting repository in (.+?): /.exec((error as Error).message)?.[1];
  const together = await Promise.all([rejectionOf(repositorySeed(undefined, false, broken)), rejectionOf(repositorySeed(undefined, false, broken))]);
  expect(together[1]).toBe(together[0]);
  expect((together[0] as Error).message).toContain("sha999");
  const failed = folderOf(together[0]);
  expect(failed).toBeDefined();
  expect(existsSync(failed!)).toBe(false);
  const again = await rejectionOf(repositorySeed(undefined, false, broken));
  expect(folderOf(again)).toBeDefined();
  expect(folderOf(again)).not.toBe(failed);
  expect(existsSync(folderOf(again)!)).toBe(false);
});

it("reads a working copy's HEAD from Git's files as Git itself does, for callbacks that cannot wait", async () => {
  const root = tempDir("petrina-head-now-"); roots.push(root);
  const clone = await makeProduct(root);
  expect(headNow(clone)).toBe(await git(clone, "rev-parse", "HEAD"));
  // An engine-style linked working copy on its own branch, then moved by a commit.
  const copy = join(root, "copy");
  await git(clone, "worktree", "add", "-q", "-b", "task", copy);
  writeFileSync(join(copy, "change.txt"), "A change\n");
  await git(copy, "add", "."); await git(copy, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "A change");
  expect(headNow(copy)).toBe(await git(copy, "rev-parse", "HEAD"));
  expect(headNow(copy)).not.toBe(headNow(clone));
  // Packed branch refs, and a detached head.
  await git(clone, "pack-refs", "--all");
  expect(existsSync(join(clone, ".git", "refs", "heads", "task"))).toBe(false);
  expect(headNow(copy)).toBe(await git(copy, "rev-parse", "HEAD"));
  await git(copy, "switch", "-q", "--detach", "HEAD~1");
  expect(headNow(copy)).toBe(await git(clone, "rev-parse", "main"));
  expect(() => headNow(join(root, "missing"))).toThrow();
});


for (const format of ["sha1", "sha256"] as const) it(`copies declared ${format} no-origin recipes without discovery or per-copy Git and keeps writes private`, async () => {
  const root = tempDir(`petrina-no-origin-${format}-`); roots.push(root);
  const firstProduct = await createProductRepository(join(root, "first"), { origin: "none", objectFormat: format }), first = firstProduct.path;
  const baseline = await git(first, "rev-parse", "HEAD");
  expect(firstProduct.initialSha).toBe(baseline);
  expect(baseline).toHaveLength(format === "sha1" ? 40 : 64);
  expect(await git(first, "remote")).toBe("");
  expect(existsSync(join(root, "first", "origin.git"))).toBe(false);
  // The resource observer measures the command helper's captured starter; a later Bun.spawn spy cannot.
  const secondProduct = await createProductRepository(join(root, "second"), { origin: "none", objectFormat: format }), second = secondProduct.path;
  expect(secondProduct.initialSha).toBe(baseline);
  expect(await git(second, "remote")).toBe("");
  expect(await git(second, "rev-parse", "HEAD")).toBe(baseline);
  expect(await git(first, "config", "--local", "--list")).toBe(await git(second, "config", "--local", "--list"));
  writeFileSync(join(first, "README.md"), "Private mutable first copy\n");
  await git(first, "add", "."); await git(first, "commit", "-qm", "Only the first changes");
  expect(await git(first, "rev-parse", "HEAD")).not.toBe(baseline);
  expect(firstProduct.initialSha).toBe(baseline);
  expect(await git(second, "rev-parse", "HEAD")).toBe(baseline);
  expect(readFileSync(join(second, "README.md"), "utf8")).toBe("# Demo\n");
  const third = await makeProduct(join(root, "third"), { origin: "none", objectFormat: format });
  expect(await git(third, "rev-parse", "HEAD")).toBe(baseline);
  // The existing default still owns its actual private remote and tracking configuration.
  const ordinary = await makeProduct(join(root, "ordinary"), { objectFormat: format });
  expect(await git(ordinary, "remote", "get-url", "origin")).toBe(join(root, "ordinary", "origin.git"));
  expect(existsSync(join(root, "ordinary", "origin.git"))).toBe(true);
});

for (const format of ["sha1", "sha256"] as const) it(`binds a private ${format} origin without changing the seed or another copy, including literal Git-config characters`, () => copies.run(async () => {
  const folder = join(copiesRoot, format); mkdirSync(folder);
  const seed = await repositorySeed(undefined, true, format);
  const originalConfig = readFileSync(join(seed.clone, ".git", "config"), "utf8");
  const literal = process.platform === "win32" ? "space ; # $& ü" : 'space ; # $& " \\ \t\nü';
  const firstRoot = join(folder, literal), peerRoot = join(folder, "peer");
  const first = await makeProduct(firstRoot, { objectFormat: format });
  const peer = await makeProduct(peerRoot, { objectFormat: format });
  const firstOrigin = join(firstRoot, "origin.git"), peerOrigin = join(peerRoot, "origin.git");
  expect(await git(first, "config", "--local", "--get", "remote.origin.url")).toBe(firstOrigin);
  expect(await git(peer, "remote", "get-url", "origin")).toBe(peerOrigin);
  expect(await git(first, "config", "--local", "--get", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
  expect(await git(first, "config", "--local", "--get", "branch.main.remote")).toBe("origin");
  expect(await git(first, "rev-parse", "HEAD")).toBe(seed.head);
  expect(seed.head).toHaveLength(format === "sha1" ? 40 : 64);
  writeFileSync(join(first, "README.md"), "Only this private copy changes\n");
  await git(first, "add", "."); await git(first, "commit", "-qm", "Private change");
  const changed = await git(first, "rev-parse", "HEAD");
  await git(first, "push", "-q", "origin", "main");
  expect(await git(firstOrigin, "rev-parse", "main")).toBe(changed);
  expect(await git(peerOrigin, "rev-parse", "main")).toBe(seed.head);
  expect(await git(peer, "rev-parse", "HEAD")).toBe(seed.head);
  expect(readFileSync(join(peer, "README.md"), "utf8")).toBe("# Demo\n");
  await git(peer, "fetch", "-q", firstOrigin, "main");
  expect(await git(peer, "rev-parse", "FETCH_HEAD")).toBe(changed);
  expect(await git(peer, "rev-parse", "HEAD")).toBe(seed.head);
  await git(first, "config", "user.name", "Only this private config");
  expect(await git(peer, "config", "--local", "user.name")).toBe("Test");
  expect(readFileSync(join(seed.clone, ".git", "config"), "utf8")).toBe(originalConfig);
  expect(await git(seed.origin, "rev-parse", "main")).toBe(seed.head);
}));
