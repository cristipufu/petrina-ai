import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoOrientation } from "@petrina/repositories/navigation";
import { git } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";
import { tempDir } from "@petrina/test-support/fixtures";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { SLOW } from "@petrina/test-support/slow";

const root = tempDir("petrina-navigation-packets-");
registerFixtureRoot(root);
const owner = new FixtureOperations({ label: `Git navigation at ${root}`, stop() {},
  dispose: () => removeFixtureRoot(root), allowanceMs: CLEANUP_MS * SLOW,
  arm: (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); } });
afterAll(() => owner.close());
it("reuses navigation for one committed tree and refreshes it when that tree changes", () => owner.run(async () => {
  const folder = join(root, "refresh"); mkdirSync(folder);
  const path = await makeProduct(folder), product = { id: "p", name: "Product", repo: "local/p", path, defaultBranch: "main", tone: "blue" as const };
  const navigation = new RepoOrientation();
  const first = await navigation.read(product);
  expect(first!.body).toContain("Navigation only");
  expect(await navigation.read(product)).toBe(first);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "new-test-command" } }));
  expect(await navigation.read(product)).toBe(first);
  await git(path, "add", "."); await git(path, "commit", "-qm", "Record the new package");
  const changed = await navigation.read(product);
  expect(changed).not.toBe(first);
  expect(changed!.body).toContain("new-test-command");
}));

it("batches root documents and workspace manifests without reading uncommitted replacements", () => owner.run(async () => {
  const folder = join(root, "batch"); mkdirSync(folder);
  const path = await makeProduct(folder), product = { id: "p", name: "Product", repo: "local/p", path, defaultBranch: "main", tone: "blue" as const };
  for (const folder of ["packages/a space", "packages/ü", "apps/app"]) {
    mkdirSync(join(path, folder), { recursive: true });
    writeFileSync(join(path, folder, "package.json"), JSON.stringify({ name: folder, scripts: { test: "declared-test" } }));
  }
  writeFileSync(join(path, "AGENTS.md"), "Pinned agent instructions\n");
  writeFileSync(join(path, "README.md"), "Pinned introduction\n");
  if (process.platform !== "win32") writeFileSync(join(path, "line\nbreak.txt"), "A path is one navigation entry\n");
  await git(path, "add", "."); await git(path, "commit", "-qm", "Committed navigation");
  writeFileSync(join(path, "AGENTS.md"), "An uncommitted replacement\n");
  const spawn = Bun.spawn; let calls = 0;
  const watch = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    if (args[0][0] === "git" && args[1]?.cwd === path) calls++;
    return Reflect.apply(spawn, Bun, args);
  }) as typeof Bun.spawn);
  try {
    const packet = await new RepoOrientation().read(product);
    expect(packet!.body).toContain("Pinned agent instructions");
    expect(packet!.body).toContain("Pinned introduction");
    expect(packet!.body).not.toContain("An uncommitted replacement");
    if (process.platform !== "win32") {
      expect(packet!.body).toContain(JSON.stringify("line\nbreak.txt"));
      expect(packet!.body).not.toContain("line\nbreak.txt");
    }
    for (const folder of ["packages/a space", "packages/ü", "apps/app"]) expect(packet!.body).toContain(`${folder}:`);
    expect(calls).toBe(4); // live tree, root packet, workspace trees, workspace manifests
  } finally { watch.mockRestore(); }
}));
